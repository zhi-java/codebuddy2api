/**
 * 服务端渲染的公开页面（落地页 / 登录页 / 模型目录 / 健康检查）。
 *
 * 管理控制台本体由 Vue 3 + Naive UI 实现（web/），由 static.ts 托管构建产物；
 * 这里只保留无需前端构建、且必须在不带 JS 或未登录时可用的轻量页面。
 *
 * 安全边界：落地页与健康页对外**不鉴权**，因此只呈现粗粒度状态。
 * 请求量、Token/积分消耗、凭证数量等运营口径一律不出现（见 LandingStatus 的
 * 设计：凭证池被压缩成三档枚举，渲染层拿不到原始计数，从结构上杜绝泄漏）。
 */

const escapeHtml = (value: string | undefined): string =>
  String(value ?? '').replace(/[&<>"']/g, (c): string =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** 落地页所需的运行时状态（已做脱敏，不含任何计数口径） */
export interface LandingStatus {
  /** 进程启动时间戳 */
  startedAt: number;
  uptimeMs: number;
  /** 模型目录规模（与公开的 GET /v1/models 同源） */
  modelCount: number;
  /** curl 示例里引用的模型：取自真实目录，示例可直接复制执行 */
  sampleModel: string;
  /** 凭证池健康度：粗粒度三档，刻意不传原始计数 */
  credentialPool: 'good' | 'partial' | 'none' | 'unknown';
}

/** 运行时长：`3 天 4 小时` / `12 分钟` / `不到 1 分钟` */
function formatUptime(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${rest} 分钟`;
  return `${minutes} 分钟`;
}

/** `YYYY-MM-DD HH:mm:ss`（本地时区，页脚展示检查时刻） */
function formatCheckedAt(date: Date): string {
  const pad = (v: number): string => String(v).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// ── 品牌图形 ──────────────────────────────────────────────────────────────

const LOGO_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

const COPY_SCRIPT = `
/**
 * 复制调用示例。
 *
 * 必须带 execCommand 回退：navigator.clipboard 只在安全上下文（HTTPS 或
 * localhost）存在，而公开页最常见的访问方式是局域网明文 HTTP——此时它是
 * undefined，直接调用会**同步**抛 TypeError，.catch() 接不住，点击毫无反应。
 * execCommand('copy') 不要求安全上下文，但要求处于用户手势内，故此处同步执行。
 */
function legacyCopy(text) {
  try {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    var ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (err) {
    return false;
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(
      function () { return true; },
      function () { return legacyCopy(text); },
    );
  }
  return Promise.resolve(legacyCopy(text));
}

document.addEventListener('click', function (event) {
  // 协议 tab 切换：同时更新 aria-selected，保证读屏可用
  var tab = event.target.closest('.code-tab');
  if (tab) {
    var scope = tab.closest('[data-code-scope]');
    var index = tab.getAttribute('data-proto');
    scope.querySelectorAll('.code-tab').forEach(function (t) {
      var on = t.getAttribute('data-proto') === index;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    scope.querySelectorAll('.code-view').forEach(function (v) {
      v.classList.toggle('active', v.getAttribute('data-proto') === index);
    });
    return;
  }

  var button = event.target.closest('[data-copy]');
  if (!button) return;
  var scope = button.closest('[data-code-scope]') || document;
  // 只复制当前可见的示例，避免复制到用户没看到的协议
  var view = scope.querySelector('.code-view.active') || scope.querySelector('.code-view');
  var code = view && view.querySelector('code');
  if (!code) return;
  var label = button.textContent;
  copyText(code.textContent.trim()).then(function (ok) {
    button.textContent = ok ? '已复制' : '请手动复制';
    if (ok) button.classList.add('done');
    setTimeout(function () {
      button.textContent = label;
      button.classList.remove('done');
    }, 1400);
  });
});
`;

// ── 共享样式 ──────────────────────────────────────────────────────────────

const PUBLIC_CSS = `
  /* 浅色令牌：与 web/src/tokens.css 同源（公开页不走前端构建，只能内联一份）。
     一致性由 scripts/check-tokens.mjs 在构建前校验，漂移会导致构建失败。 */
  :root {
    --bg:#eef1f6; --surface:#ffffff; --surface-2:#f6f8fb; --surface-3:#f1f4f8; --inset:#f6f8fb;
    --border:#cbd5e1; --border-soft:#e4e9f0;
    --text:#0f172a; --text-2:#475569; --text-3:#526074;
    --accent:#14793a; --accent-hover:#127336; --accent-ink:#ffffff;
    --accent-soft:#e3f3e8;
    --warn:#9a5b08; --danger:#c81e1e; --info:#0369a1;
    --radius-page:14px; --radius-page-sm:9px;
    --ease:cubic-bezier(.16,1,.3,1);
    --shadow-sm:0 1px 2px rgba(15,23,42,.06);
    --shadow-card:0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.04);
    --shadow-raised:0 4px 12px -2px rgba(15,23,42,.08), 0 2px 4px -2px rgba(15,23,42,.05);
    --shadow-pop:0 12px 32px -8px rgba(15,23,42,.16), 0 4px 8px -4px rgba(15,23,42,.08);
    --shadow:var(--shadow-card);
    color-scheme:light;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:15px/1.65 Inter,ui-sans-serif,system-ui,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;
    display:flex; flex-direction:column; min-height:100vh;
  }
  a { color:inherit; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-variant-ligatures:none; }

  /* ── 顶栏 ── */
  .nav {
    position:sticky; top:0; z-index:20;
    display:flex; align-items:center; justify-content:space-between; gap:16px;
    padding:12px 24px;
    background:color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
    border-bottom:1px solid var(--border-soft);
  }
  .nav-brand { display:flex; align-items:center; gap:10px; text-decoration:none; }
  .logo {
    width:32px; height:32px; flex:none; border-radius:9px; display:grid; place-items:center;
    /* 渐变两端都用达标绿：#14793a 上白图标 5.49:1，#0f6b32 更深 */
    color:var(--accent-ink); background:linear-gradient(180deg,#178a43,#0f6b32);
    box-shadow:0 0 0 1px rgba(20,121,58,.3), 0 8px 18px -8px rgba(20,121,58,.55);
  }
  .nav-brand b { display:block; font-size:14px; font-weight:650; letter-spacing:-.01em; }
  .nav-links { display:flex; align-items:center; gap:4px; }
  .nav-link {
    padding:7px 12px; border-radius:var(--radius-page-sm); font-size:13.5px; color:var(--text-2);
    text-decoration:none; cursor:pointer; transition:color .18s var(--ease), background .18s var(--ease);
  }
  .nav-link:hover { color:var(--text); background:var(--surface-2); }
  .nav-link:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

  /* ── 布局 ── */
  .wrap { width:min(1120px,100%); margin:0 auto; padding:0 24px; flex:1; }
  .section { margin-top:64px; }
  .section-head { margin-bottom:20px; }
  .section-head h2 { margin:0; font-size:19px; font-weight:650; letter-spacing:-.02em; }

  /* ── Hero ── */
  .hero { position:relative; padding:72px 0 8px; }
  .hero::before {
    content:''; position:absolute; inset:-72px -24px auto -24px; height:420px; z-index:-1;
    background:
      radial-gradient(620px 300px at 78% -12%, var(--accent-soft), transparent 62%),
      radial-gradient(520px 280px at 4% 8%, rgba(56,189,248,.10), transparent 60%);
    pointer-events:none;
  }
  .hero h1 {
    margin:18px 0 0; font-size:clamp(30px,5.2vw,50px); line-height:1.1;
    letter-spacing:-.035em; font-weight:680;
  }
  .hero h1 em { font-style:normal; color:var(--accent); }
  .hero p { margin:16px 0 0; max-width:64ch; color:var(--text-2); font-size:16px; }
  .hero-cta { display:flex; gap:10px; flex-wrap:wrap; margin-top:28px; }

  .pill {
    display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:999px;
    font-size:12.5px; font-weight:550; border:1px solid var(--border);
    background:var(--surface); color:var(--text-2);
  }
  .pill .dot { width:7px; height:7px; border-radius:50%; background:var(--text-3); flex:none; }
  .pill.good { border-color:color-mix(in srgb, var(--accent) 40%, transparent); color:var(--accent); }
  .pill.good .dot { background:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); animation:pulse 2.6s var(--ease) infinite; }
  .pill.warn { border-color:color-mix(in srgb, var(--warn) 40%, transparent); color:var(--warn); }
  .pill.warn .dot { background:var(--warn); }
  .pill.bad { border-color:color-mix(in srgb, var(--danger) 40%, transparent); color:var(--danger); }
  .pill.bad .dot { background:var(--danger); }
  @keyframes pulse { 0%,100% { box-shadow:0 0 0 4px var(--accent-soft); } 50% { box-shadow:0 0 0 9px transparent; } }

  /* ── 按钮 ── */
  .btn {
    display:inline-flex; align-items:center; gap:8px; padding:10px 18px; border-radius:var(--radius-page-sm);
    font:inherit; font-size:14px; font-weight:600; text-decoration:none; cursor:pointer;
    border:1px solid transparent; transition:background .18s var(--ease), border-color .18s var(--ease), color .18s var(--ease);
  }
  .btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .btn-primary { background:var(--accent); color:var(--accent-ink); }
  .btn-primary:hover { background:var(--accent-hover); }

  /* ── 状态指标条 ── */
  /* 弹性行而非栅格：数据点只有 2 个，不需要列数自适应。
     margin 与 .section 统一为 64px，避免 hero→stats 44px、其余 64px 的参差。 */
  .stats {
    display:flex; align-items:stretch; gap:28px; margin-top:64px;
    flex-wrap:wrap;
  }
  .stat-divider { width:1px; background:var(--border-soft); flex:none; }
  .stat {
    background:var(--surface); border:1px solid var(--border-soft); border-radius:var(--radius-page);
    padding:16px 18px; display:flex; flex-direction:column; gap:5px;
    /* 内容决定宽度并设下限：避免又扁又宽（此前每项被拉到 530px） */
    flex:0 1 auto; min-width:190px;
  }
  .stat-label { font-size:12px; color:var(--text-3); }
  .stat-value { font-size:22px; font-weight:650; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .stat-value.ok { color:var(--accent); }
  .stat-value.warn { color:var(--warn); }
  .stat-value.bad { color:var(--danger); }
  .stat-hint { font-size:11.5px; color:var(--text-3); }

  /* ── 协议卡（只放名称/端点/鉴权头，代码示例见下方全宽面板） ── */
  .cards { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); }
  .card {
    background:var(--surface); border:1px solid var(--border-soft); border-radius:var(--radius-page);
    padding:18px 20px; display:flex; flex-direction:column; gap:8px;
    transition:border-color .2s var(--ease), transform .2s var(--ease), box-shadow .2s var(--ease);
  }
  .card:hover { border-color:var(--border); transform:translateY(-2px); box-shadow:var(--shadow-raised); }
  .card-top { display:flex; align-items:center; gap:10px; }
  .tag {
    font-size:10.5px; font-weight:650; letter-spacing:.09em; text-transform:uppercase;
    color:var(--accent); background:var(--accent-soft); border-radius:999px; padding:3px 9px;
  }
  .card h3 { margin:0; font-size:15.5px; font-weight:650; }
  .endpoint { font-size:12px; color:var(--text-2); }
  .endpoint b { color:var(--accent); font-weight:650; }
  .auth { font-size:11px; color:var(--text-3); }

  /* ── 全宽代码面板（tab 切换协议）──
     实测 curl 命令最长需 ~660px，3 列卡内可用仅 ~304px（54% 被截断）。
     提到全宽后单行可完整显示，无需横向滚动。 */
  .code-panel {
    margin-top:14px; background:var(--surface); border:1px solid var(--border-soft);
    border-radius:var(--radius-page); overflow:hidden;
  }
  .code-head {
    display:flex; align-items:center; justify-content:space-between; gap:12px;
    padding:8px 10px 8px 12px; border-bottom:1px solid var(--border-soft);
  }
  .code-tabs { display:flex; gap:4px; flex-wrap:wrap; }
  .code-tab {
    padding:6px 12px; font:inherit; font-size:12.5px; font-weight:550;
    color:var(--text-2); background:transparent; border:1px solid transparent;
    border-radius:var(--radius-page-sm); cursor:pointer;
    transition:color .18s var(--ease), background .18s var(--ease), border-color .18s var(--ease);
  }
  .code-tab:hover { color:var(--text); background:var(--surface-2); }
  .code-tab.active { color:var(--accent); background:var(--accent-soft); border-color:transparent; }
  .code-tab:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .code-view { display:none; }
  .code-view.active { display:block; }
  .code-panel pre { margin:0; padding:14px 16px; overflow-x:auto; }
  .code-panel code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-size:12.5px; line-height:1.8; color:var(--text-2); white-space:pre; }
  .copy {
    padding:5px 12px; font:inherit; font-size:12px; white-space:nowrap;
    color:var(--text-2); background:var(--surface-2); border:1px solid var(--border);
    border-radius:var(--radius-page-sm); cursor:pointer;
    transition:color .18s var(--ease), border-color .18s var(--ease), background .18s var(--ease);
  }
  .copy:hover { color:var(--text); border-color:var(--accent); }
  .copy.done { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); }

  /* ── 接入步骤 ── */
  .steps { list-style:none; margin:0; padding:0; display:grid; gap:12px;
    grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); counter-reset:step; }
  .step {
    display:flex; gap:14px; padding:18px 20px; background:var(--surface);
    border:1px solid var(--border-soft); border-radius:var(--radius-page);
  }
  .step-no {
    width:26px; height:26px; flex:none; border-radius:50%; display:grid; place-items:center;
    font-size:12.5px; font-weight:650; color:var(--accent); background:var(--accent-soft);
  }
  .step b { display:block; font-size:14px; font-weight:600; margin-bottom:3px; }
  .step span { color:var(--text-2); font-size:13px; }

  /* ── 页脚 ── */
  .foot {
    width:min(1120px,100%); margin:64px auto 0; padding:20px 24px calc(28px + env(safe-area-inset-bottom));
    border-top:1px solid var(--border-soft); color:var(--text-3); font-size:12.5px;
    display:flex; gap:8px 20px; flex-wrap:wrap; align-items:center;
  }
  .foot a { color:var(--text-3); text-decoration:none; }
  .foot a:hover { color:var(--accent); }

  /* ── 简单页头(模型目录 / 健康页) ── */
  .page-head { padding:44px 0 24px; }
  .page-head h1 { margin:0 0 8px; font-size:clamp(24px,3.6vw,32px); font-weight:680; letter-spacing:-.03em; }
  .page-head p { margin:0; color:var(--text-2); font-size:14px; }

  /* ── 模型目录 ── */
  .model-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); }
  .model {
    background:var(--surface); border:1px solid var(--border-soft); border-radius:var(--radius-page-sm);
    padding:14px 16px; transition:border-color .2s var(--ease);
  }
  .model:hover { border-color:var(--border); }
  .model-id { font-size:13px; font-weight:600; word-break:break-all; }
  .model-name { font-size:12px; color:var(--text-3); margin:3px 0 9px; }
  .model-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:11.5px; }
  .model-meta .num { color:var(--text-3); font-variant-numeric:tabular-nums; }

  /* ── 健康面板 ── */
  .health {
    display:flex; align-items:center; gap:18px; background:var(--surface);
    border:1px solid var(--border-soft); border-radius:var(--radius-page); padding:28px 30px;
  }
  .health-dot {
    width:14px; height:14px; flex:none; border-radius:50%; background:var(--accent);
    box-shadow:0 0 0 5px var(--accent-soft); animation:pulse 2.6s var(--ease) infinite;
  }
  .health b { display:block; font-size:18px; font-weight:650; }
  .health span { color:var(--text-2); font-size:13.5px; }

  @media (max-width:640px) {
    .nav { padding:10px 16px; }
    .nav-link { padding:7px 9px; font-size:13px; }
    .wrap { padding:0 16px; }
    .hero { padding:44px 0 0; }
    .section { margin-top:48px; }
    .foot { padding:18px 16px calc(24px + env(safe-area-inset-bottom)); }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration:.01ms !important; transition-duration:.01ms !important; }
  }
`;

// ── 登录页 ────────────────────────────────────────────────────────────────

/**
 * 登录页（未登录时由 /admin 返回）。
 *
 * 保持服务端渲染：登录只需一次表单提交，避免为了一个密码框加载整个 SPA。
 */
export function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>登录 · CodeBuddy Gateway</title>
<style>
  ${PUBLIC_CSS}
  body { display:grid; place-items:center; padding:24px; }
  .login {
    width:min(400px,100%); background:var(--surface); border:1px solid var(--border-soft);
    border-radius:18px; padding:32px 30px; box-shadow:var(--shadow);
  }
  .login .logo { width:42px; height:42px; border-radius:11px; margin-bottom:20px; }
  .login h1 { margin:0 0 6px; font-size:19px; font-weight:680; letter-spacing:-.02em; }
  .login .sub { margin:0 0 24px; color:var(--text-2); font-size:13px; }
  .field { margin-bottom:16px; }
  .field label { display:block; font-size:12.5px; font-weight:550; color:var(--text-2); margin-bottom:7px; }
  .field input {
    width:100%; padding:10px 12px; font:inherit; font-size:14px; color:var(--text);
    background:var(--inset); border:1px solid var(--border); border-radius:var(--radius-page-sm);
    transition:border-color .18s var(--ease), box-shadow .18s var(--ease);
  }
  .field input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .login button[type=submit] { width:100%; justify-content:center; margin-top:4px; }
  .login button[type=submit]:disabled { opacity:.6; cursor:not-allowed; }
  .hint { margin-top:16px; font-size:12px; color:var(--text-3); }
  .hint.bad { color:var(--danger); }
</style>
</head>
<body>
  <div class="login">
    <div class="logo">${LOGO_SVG}</div>
    <h1>CodeBuddy Gateway</h1>
    <p class="sub">管理控制台</p>
    <form id="login-form">
      <div class="field">
        <label for="pw">密码</label>
        <input id="pw" type="password" placeholder="管理员密码" autocomplete="current-password" required autofocus>
      </div>
      <button class="btn btn-primary" type="submit">登录</button>
      <div class="hint" id="hint">会话超时自动失效</div>
    </form>
  </div>
<script>
  var form = document.getElementById('login-form');
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var button = form.querySelector('button');
    var hint = document.getElementById('hint');
    button.disabled = true;
    button.textContent = '验证中…';
    try {
      var res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: document.getElementById('pw').value }),
      });
      if (res.status === 401) throw new Error('密码错误');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      location.href = '/admin';
    } catch (err) {
      hint.classList.add('bad');
      hint.textContent = '登录失败：' + err.message;
      button.disabled = false;
      button.textContent = '登录';
    }
  });
</script>
</body>
</html>`;
}

// ── 落地页 ────────────────────────────────────────────────────────────────

interface ProtocolSpec {
  tag: string;
  name: string;
  /** 端点说明行里的鉴权头 */
  auth: string;
  method: string;
  path: string;
  /** 请求体生成器：模型名由调用方注入，保证示例与真实目录一致 */
  body: (model: string) => string;
}

const PROTOCOLS: ProtocolSpec[] = [
  {
    tag: 'OpenAI',
    name: 'Chat Completions',
    auth: 'Authorization: Bearer',
    method: 'POST',
    path: '/v1/chat/completions',
    body: (model) => `{"model":"${model}","messages":[{"role":"user","content":"hi"}]}`,
  },
  {
    tag: 'Anthropic',
    name: 'Messages',
    auth: 'x-api-key',
    method: 'POST',
    path: '/v1/messages',
    body: (model) => `{"model":"${model}","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}`,
  },
  {
    tag: 'OpenAI',
    name: 'Responses',
    auth: 'Authorization: Bearer',
    method: 'POST',
    path: '/v1/responses',
    body: (model) => `{"model":"${model}","input":"hi"}`,
  },
];

/**
 * 把 curl 示例折成多行，避免在卡片里横向溢出。
 * 每一行（除最后一行）都必须以 `\` 结尾，否则复制出去是几条独立命令。
 */
function curlSample(spec: ProtocolSpec, model: string): string {
  const header =
    spec.auth === 'x-api-key'
      ? '  -H "x-api-key: $GATEWAY_KEY"'
      : '  -H "Authorization: Bearer $GATEWAY_KEY"';
  return [
    `curl ${spec.method} "$GATEWAY_BASE${spec.path}" \\`,
    `${header} \\`,
    '  -H "content-type: application/json" \\',
    `  -d '${spec.body(model)}'`,
  ].join('\n');
}

/**
 * 协议卡：只承载「协议名 + 端点 + 鉴权头」。
 *
 * 代码示例**不放在卡内**：实测 curl 命令需 ~660px 才能完整显示，而 3 列栅格
 * 把卡宽锁在 ~348px（可用 304px），Messages 卡的示例有 54% 内容被横向截断。
 * 示例统一提到下方全宽代码区，按协议切换。
 */
function renderProtocolCard(spec: ProtocolSpec): string {
  return `<article class="card">
  <div class="card-top">
    <span class="tag">${escapeHtml(spec.tag)}</span>
    <h3>${escapeHtml(spec.name)}</h3>
  </div>
  <div class="endpoint mono"><b>${escapeHtml(spec.method)}</b> ${escapeHtml(spec.path)}</div>
  <div class="auth mono">鉴权头 ${escapeHtml(spec.auth)}</div>
</article>`;
}

/**
 * 全宽代码区：tab 切换三个协议的调用示例。
 *
 * 用 tab 而非三块并列：用户的实际动作是「先确定用哪个协议 → 复制命令」，
 * 切换比横向扫三块更快，且换来的宽度让命令无需横向滚动即可完整阅读。
 */
function renderCodePanel(model: string): string {
  const tabs = PROTOCOLS.map(
    (spec, i) =>
      `<button class="code-tab${i === 0 ? ' active' : ''}" type="button" role="tab" aria-selected="${i === 0}" data-proto="${i}">${escapeHtml(spec.name)}</button>`,
  ).join('\n      ');

  const views = PROTOCOLS.map(
    (spec, i) =>
      `<div class="code-view${i === 0 ? ' active' : ''}" data-proto="${i}" role="tabpanel">` +
      `<pre><code>${escapeHtml(curlSample(spec, model))}</code></pre></div>`,
  ).join('\n    ');

  return `<div class="code-panel" data-code-scope>
    <div class="code-head">
      <div class="code-tabs" role="tablist">
      ${tabs}
      </div>
      <button class="copy" type="button" data-copy aria-label="复制当前协议的调用示例">复制</button>
    </div>
    <div class="code-views">
    ${views}
    </div>
  </div>`;
}

/** 凭证池状态 → 展示文案与色调 */
function credentialDisplay(pool: LandingStatus['credentialPool']): { tone: string; label: string; hint: string } {
  switch (pool) {
    case 'good':
      return { tone: 'ok', label: '正常', hint: '上游凭证可用' };
    case 'partial':
      return { tone: 'warn', label: '降级', hint: '部分凭证不可用' };
    case 'none':
      return { tone: 'bad', label: '不可用', hint: '暂无可用凭证' };
    default:
      return { tone: '', label: '未知', hint: '尚未配置凭证' };
  }
}

/**
 * 根路径落地页（无鉴权）。
 *
 * 承担两件事：对外证明「服务活着」，以及给开发者一份可直接抄走的接入方式。
 * 因此只呈现运行时长、模型规模、凭证池三档状态这类粗粒度信息。
 */
export function renderLandingPage(status: LandingStatus): string {
  const pool = credentialDisplay(status.credentialPool);
  const running = status.uptimeMs > 0;
  const checked = formatCheckedAt(new Date());

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CodeBuddy Gateway · 生产 API 网关</title>
<meta name="description" content="同时提供 OpenAI Chat Completions、Anthropic Messages 与 OpenAI Responses 三种协议的 API 网关。">
<style>${PUBLIC_CSS}</style>
</head>
<body>
<nav class="nav">
  <a class="nav-brand" href="/">
    <span class="logo">${LOGO_SVG}</span>
    <span><b>CodeBuddy Gateway</b></span>
  </a>
  <div class="nav-links">
    <a class="nav-link" href="/v1/models">模型目录</a>
    <a class="nav-link" href="/health">健康检查</a>
    <a class="btn btn-primary" href="/admin">管理控制台</a>
  </div>
</nav>

<main class="wrap">
  <section class="hero">
    <span class="pill ${running ? 'good' : 'bad'}">
      <i class="dot"></i>${running ? '服务运行中' : '服务状态未知'}${running ? ` · 已运行 ${escapeHtml(formatUptime(status.uptimeMs))}` : ''}
    </span>
    <h1>一套上游凭证<br>接入<em>任意主流客户端</em></h1>
    <p>网关托管上游凭证并自动续期。</p>
    <div class="hero-cta">
      <a class="btn btn-primary" href="/admin">进入管理控制台</a>
    </div>
  </section>

  <!-- 两个数据点用弹性行，不用栅格：auto-fit 会为 2 项建出 5 条轨道，
       每项撑到 530px，内部却只有三个短元素，比例失衡 -->
  <section class="stats">
    <div class="stat">
      <span class="stat-label">凭证池</span>
      <b class="stat-value ${pool.tone}">${escapeHtml(pool.label)}</b>
      <span class="stat-hint">${escapeHtml(pool.hint)}</span>
    </div>
    <span class="stat-divider" aria-hidden="true"></span>
    <div class="stat">
      <span class="stat-label">模型目录</span>
      <b class="stat-value">${status.modelCount ? status.modelCount.toLocaleString('en-US') : '—'}</b>
      <span class="stat-hint">可用模型数</span>
    </div>
  </section>

  <section class="section" id="protocols">
    <div class="section-head">
      <h2>接入方式</h2>
    </div>
    <div class="cards">
      ${PROTOCOLS.map((spec) => renderProtocolCard(spec)).join('\n')}
    </div>
    ${renderCodePanel(status.sampleModel)}
  </section>

  <section class="section" id="quickstart">
    <div class="section-head">
      <h2>三步接入</h2>
    </div>
    <ol class="steps">
      <li class="step">
        <span class="step-no">1</span>
        <div>
          <b>添加上游凭证</b>
          <span>录入 CodeBuddy 凭证，网关负责刷新、额度与签到。</span>
        </div>
      </li>
      <li class="step">
        <span class="step-no">2</span>
        <div>
          <b>签发网关 Key</b>
          <span>创建 <code class="mono">sk-cb-*</code> Key 并绑定凭证池，上游凭证不出网关。</span>
        </div>
      </li>
      <li class="step">
        <span class="step-no">3</span>
        <div>
          <b>切换 base_url</b>
          <span>指向本网关即获得多凭证故障转移。</span>
        </div>
      </li>
    </ol>
  </section>
</main>

<footer class="foot">
  <a href="/admin">管理控制台</a>
  <a href="/v1/models">模型目录</a>
  <a href="/health">健康检查</a>
  <span style="margin-left:auto">检查时间 ${escapeHtml(checked)}</span>
</footer>
<script>${COPY_SCRIPT}</script>
</body>
</html>`;
}

// ── 模型目录 ──────────────────────────────────────────────────────────────

interface PublicModel {
  id: string;
  _name?: string;
  _credits?: string;
  _vendor?: string;
  _maxInputTokens?: number;
  _maxOutputTokens?: number;
}

/**
 * 模型目录浏览页（浏览器直接访问 /v1/models 时返回，带设计；API 仍返回 JSON）。
 * 展示内置快照目录，无鉴权、无敏感信息。
 */
export function renderPublicModelsPage(models: PublicModel[]): string {
  const cards = models
    .map(
      (m) => `<div class="model">
  <div class="model-id mono">${escapeHtml(m.id)}</div>
  <div class="model-name">${escapeHtml(m._name || m.id)}</div>
  <div class="model-meta">
    ${m._credits ? `<span class="tag">${escapeHtml(m._credits)}</span>` : ''}
    ${m._vendor ? `<span class="num">${escapeHtml(m._vendor)}</span>` : ''}
    ${typeof m._maxInputTokens === 'number' ? `<span class="num">in ${m._maxInputTokens.toLocaleString('en-US')}</span>` : ''}
    ${typeof m._maxOutputTokens === 'number' ? `<span class="num">out ${m._maxOutputTokens.toLocaleString('en-US')}</span>` : ''}
  </div>
</div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>模型目录 · CodeBuddy Gateway</title>
<style>${PUBLIC_CSS}</style>
</head>
<body>
${navBar()}
<main class="wrap">
  <header class="page-head">
    <h1>模型目录</h1>
    <p>共 ${models.length.toLocaleString('en-US')} 个模型</p>
  </header>
  <div class="model-grid">${cards}</div>
</main>
${footer('目录快照')}
</body>
</html>`;
}

// ── 健康页 ────────────────────────────────────────────────────────────────

/**
 * 健康状态页（浏览器访问 /health；监控脚本仍拿 JSON）。
 */
export function renderHealthPage(): string {
  const checked = formatCheckedAt(new Date());
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>运行状态 · CodeBuddy Gateway</title>
<style>${PUBLIC_CSS}</style>
</head>
<body>
${navBar()}
<main class="wrap">
  <header class="page-head">
    <h1>运行状态</h1>
    <p>监控脚本请调用 <code class="mono">GET /health</code></p>
  </header>
  <div class="health">
    <span class="health-dot"></span>
    <div>
      <b>网关运行正常</b>
      <span>检查时间 ${escapeHtml(checked)}</span>
    </div>
  </div>
</main>
${footer('健康检查')}
</body>
</html>`;
}

// ── 公开页公共外壳 ────────────────────────────────────────────────────────

function navBar(): string {
  return `<nav class="nav">
  <a class="nav-brand" href="/">
    <span class="logo">${LOGO_SVG}</span>
    <span><b>CodeBuddy Gateway</b></span>
  </a>
  <div class="nav-links">
    <a class="nav-link" href="/v1/models">模型目录</a>
    <a class="nav-link" href="/health">健康检查</a>
    <a class="btn btn-primary" href="/admin">管理控制台</a>
  </div>
</nav>`;
}

function footer(note: string): string {
  return `<footer class="foot">
  <span>CodeBuddy Gateway · ${escapeHtml(note)}</span>
  <a href="/">首页</a>
  <a href="/admin">管理控制台</a>
  <a href="/health">健康检查</a>
</footer>`;
}
