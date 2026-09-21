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
document.addEventListener('click', function (event) {
  var button = event.target.closest('[data-copy]');
  if (!button) return;
  var block = button.closest('.code');
  var code = block && block.querySelector('code');
  if (!code) return;
  var label = button.textContent;
  navigator.clipboard.writeText(code.textContent.trim()).then(function () {
    button.textContent = '已复制';
    button.classList.add('done');
    setTimeout(function () {
      button.textContent = label;
      button.classList.remove('done');
    }, 1400);
  }).catch(function () {
    button.textContent = '复制失败';
    setTimeout(function () { button.textContent = label; }, 1400);
  });
});
`;

// ── 共享样式 ──────────────────────────────────────────────────────────────

const PUBLIC_CSS = `
  :root {
    --bg:#020617; --surface:#0f172a; --surface-2:#1e293b; --inset:#0b1220;
    --border:#334155; --border-soft:#1e293b;
    --text:#f8fafc; --text-2:#94a3b8; --text-3:#8494ab;
    --accent:#22c55e; --accent-hover:#4ade80; --accent-ink:#052e16;
    --accent-soft:rgba(34,197,94,.14);
    --warn:#fbbf24; --danger:#f87171;
    --radius:14px; --radius-sm:9px;
    --ease:cubic-bezier(.16,1,.3,1);
    --shadow:0 18px 40px -18px rgba(2,6,23,.9);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg:#f6f8fb; --surface:#ffffff; --surface-2:#f1f5f9; --inset:#f1f5f9;
      --border:#cbd5e1; --border-soft:#e2e8f0;
      --text:#0f172a; --text-2:#475569; --text-3:#64748b;
      --accent:#15803d; --accent-hover:#166534; --accent-ink:#ffffff;
      --accent-soft:#dcfce7;
      --warn:#b45309; --danger:#dc2626;
      --shadow:0 18px 40px -22px rgba(15,23,42,.28);
    }
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
    color:var(--accent-ink); background:linear-gradient(180deg,#4ade80,#16a34a);
    box-shadow:0 0 0 1px rgba(34,197,94,.3), 0 10px 22px -10px rgba(22,163,74,.9);
  }
  .nav-brand b { display:block; font-size:14px; font-weight:650; letter-spacing:-.01em; }
  .nav-brand i { display:block; font-size:10.5px; font-style:normal; color:var(--text-3);
    letter-spacing:.09em; text-transform:uppercase; }
  .nav-links { display:flex; align-items:center; gap:4px; }
  .nav-link {
    padding:7px 12px; border-radius:var(--radius-sm); font-size:13.5px; color:var(--text-2);
    text-decoration:none; cursor:pointer; transition:color .18s var(--ease), background .18s var(--ease);
  }
  .nav-link:hover { color:var(--text); background:var(--surface-2); }
  .nav-link:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

  /* ── 布局 ── */
  .wrap { width:min(1120px,100%); margin:0 auto; padding:0 24px; flex:1; }
  .section { margin-top:64px; }
  .section-head { margin-bottom:20px; }
  .section-head h2 { margin:0 0 6px; font-size:19px; font-weight:650; letter-spacing:-.02em; }
  .section-head p { margin:0; color:var(--text-2); font-size:13.5px; max-width:70ch; }

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
    display:inline-flex; align-items:center; gap:8px; padding:10px 18px; border-radius:var(--radius-sm);
    font:inherit; font-size:14px; font-weight:600; text-decoration:none; cursor:pointer;
    border:1px solid transparent; transition:background .18s var(--ease), border-color .18s var(--ease), color .18s var(--ease);
  }
  .btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .btn-primary { background:var(--accent); color:var(--accent-ink); }
  .btn-primary:hover { background:var(--accent-hover); }
  .btn-ghost { background:transparent; color:var(--text-2); border-color:var(--border); }
  .btn-ghost:hover { color:var(--text); border-color:var(--text-3); }

  /* ── 状态指标条 ── */
  .stats {
    display:grid; gap:12px; margin-top:44px;
    grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  }
  .stat {
    background:var(--surface); border:1px solid var(--border-soft); border-radius:var(--radius);
    padding:16px 18px; display:flex; flex-direction:column; gap:5px;
  }
  .stat-label { font-size:12px; color:var(--text-3); }
  .stat-value { font-size:22px; font-weight:650; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .stat-value.ok { color:var(--accent); }
  .stat-value.warn { color:var(--warn); }
  .stat-value.bad { color:var(--danger); }
  .stat-hint { font-size:11.5px; color:var(--text-3); }

  /* ── 协议卡 ── */
  .cards { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
  .card {
    background:var(--surface); border:1px solid var(--border-soft); border-radius:var(--radius);
    padding:20px; display:flex; flex-direction:column; gap:10px;
    transition:border-color .2s var(--ease), transform .2s var(--ease), box-shadow .2s var(--ease);
  }
  .card:hover { border-color:var(--border); transform:translateY(-2px); box-shadow:var(--shadow); }
  .card-top { display:flex; align-items:center; gap:10px; }
  .tag {
    font-size:10.5px; font-weight:650; letter-spacing:.09em; text-transform:uppercase;
    color:var(--accent); background:var(--accent-soft); border-radius:999px; padding:3px 9px;
  }
  .card h3 { margin:0; font-size:15.5px; font-weight:650; }
  .card p { margin:0; color:var(--text-2); font-size:13px; }
  .endpoint { font-size:12px; color:var(--text-2); }
  .endpoint b { color:var(--accent); font-weight:650; }
  .auth { font-size:11px; color:var(--text-3); }

  /* ── 代码块 ── */
  .code {
    position:relative; margin-top:auto; background:var(--inset);
    border:1px solid var(--border-soft); border-radius:var(--radius-sm); overflow:hidden;
  }
  /* 复制按钮独立成条，不再压在代码首行上 */
  .code-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:5px 6px 5px 12px; border-bottom:1px solid var(--border-soft);
  }
  .code-lang { font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--text-3); }
  .code pre { margin:0; padding:12px 14px; overflow-x:auto; }
  .code code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-size:12px; line-height:1.75; color:var(--text-2); white-space:pre; }
  .copy {
    padding:3px 10px; font:inherit; font-size:11.5px; white-space:nowrap;
    color:var(--text-2); background:var(--surface-2); border:1px solid var(--border);
    border-radius:6px; cursor:pointer; transition:color .18s var(--ease), border-color .18s var(--ease);
  }
  .copy:hover { color:var(--text); border-color:var(--accent); }
  .copy.done { color:var(--accent); border-color:var(--accent); }

  /* ── 接入步骤 ── */
  .steps { list-style:none; margin:0; padding:0; display:grid; gap:12px;
    grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); counter-reset:step; }
  .step {
    display:flex; gap:14px; padding:18px 20px; background:var(--surface);
    border:1px solid var(--border-soft); border-radius:var(--radius);
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
    background:var(--surface); border:1px solid var(--border-soft); border-radius:var(--radius-sm);
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
    border:1px solid var(--border-soft); border-radius:var(--radius); padding:28px 30px;
  }
  .health-dot {
    width:14px; height:14px; flex:none; border-radius:50%; background:var(--accent);
    box-shadow:0 0 0 5px var(--accent-soft); animation:pulse 2.6s var(--ease) infinite;
  }
  .health b { display:block; font-size:18px; font-weight:650; }
  .health span { color:var(--text-2); font-size:13.5px; }

  @media (max-width:640px) {
    .nav { padding:10px 16px; }
    .nav-brand i { display:none; }
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
    background:var(--inset); border:1px solid var(--border); border-radius:var(--radius-sm);
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
    <p class="sub">生产控制台 · 使用管理员密码登录</p>
    <form id="login-form">
      <div class="field">
        <label for="pw">密码</label>
        <input id="pw" type="password" placeholder="管理员密码" autocomplete="current-password" required autofocus>
      </div>
      <button class="btn btn-primary" type="submit">登录</button>
      <div class="hint" id="hint">会话经 HMAC 签名，超时自动失效</div>
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
  desc: string;
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
    desc: '通用对话接口，覆盖绝大多数 OpenAI 兼容客户端，支持流式与非流式。',
    auth: 'Authorization: Bearer',
    method: 'POST',
    path: '/v1/chat/completions',
    body: (model) => `{"model":"${model}","messages":[{"role":"user","content":"hi"}]}`,
  },
  {
    tag: 'Anthropic',
    name: 'Messages',
    desc: 'Anthropic 协议，供 Claude Code 等原生 Anthropic 客户端直接接入。',
    auth: 'x-api-key',
    method: 'POST',
    path: '/v1/messages',
    body: (model) => `{"model":"${model}","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}`,
  },
  {
    tag: 'OpenAI',
    name: 'Responses',
    desc: 'OpenAI 新版响应接口，面向 Agent SDK 等 Responses 协议客户端。',
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

function renderProtocolCard(spec: ProtocolSpec, model: string): string {
  return `<article class="card">
  <div class="card-top">
    <span class="tag">${escapeHtml(spec.tag)}</span>
    <h3>${escapeHtml(spec.name)}</h3>
  </div>
  <p>${escapeHtml(spec.desc)}</p>
  <div class="endpoint mono"><b>${escapeHtml(spec.method)}</b> ${escapeHtml(spec.path)}</div>
  <div class="auth mono">鉴权头 ${escapeHtml(spec.auth)}</div>
  <div class="code">
    <div class="code-head">
      <span class="code-lang">bash</span>
      <button class="copy" type="button" data-copy aria-label="复制 ${escapeHtml(spec.name)} 调用示例">复制</button>
    </div>
    <pre><code>${escapeHtml(curlSample(spec, model))}</code></pre>
  </div>
</article>`;
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
    <span><b>CodeBuddy Gateway</b><i>Production API gateway</i></span>
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
    <p>同时提供 OpenAI Chat Completions、Anthropic Messages 与 OpenAI Responses 三种协议。
       上游凭证由网关托管、自动续期，客户端只需持有网关签发的 Key，模型名无需任何改动。</p>
    <div class="hero-cta">
      <a class="btn btn-primary" href="/admin">进入管理控制台</a>
      <a class="btn btn-ghost" href="#protocols">查看接入方式</a>
    </div>
  </section>

  <section class="stats">
    <div class="stat">
      <span class="stat-label">服务状态</span>
      <b class="stat-value ${running ? 'ok' : 'bad'}">${running ? '运行中' : '未知'}</b>
      <span class="stat-hint">${running ? `持续运行 ${escapeHtml(formatUptime(status.uptimeMs))}` : '未取得运行信息'}</span>
    </div>
    <div class="stat">
      <span class="stat-label">凭证池</span>
      <b class="stat-value ${pool.tone}">${escapeHtml(pool.label)}</b>
      <span class="stat-hint">${escapeHtml(pool.hint)}</span>
    </div>
    <div class="stat">
      <span class="stat-label">模型目录</span>
      <b class="stat-value">${status.modelCount ? status.modelCount.toLocaleString('en-US') : '—'}</b>
      <span class="stat-hint">GET /v1/models 可获取完整列表</span>
    </div>
    <div class="stat">
      <span class="stat-label">协议端点</span>
      <b class="stat-value">${PROTOCOLS.length}</b>
      <span class="stat-hint">Chat Completions · Messages · Responses</span>
    </div>
  </section>

  <section class="section" id="protocols">
    <div class="section-head">
      <h2>三种协议，同一套凭证</h2>
      <p>把客户端的 base_url 指向本网关，鉴权换成网关 Key 即可。协议之间共享同一个上游凭证池与故障转移链路。</p>
    </div>
    <div class="cards">
      ${PROTOCOLS.map((spec) => renderProtocolCard(spec, status.sampleModel)).join('\n')}
    </div>
  </section>

  <section class="section" id="quickstart">
    <div class="section-head">
      <h2>三步接入</h2>
      <p>全流程在管理控制台完成，服务端不需要改一行代码。</p>
    </div>
    <ol class="steps">
      <li class="step">
        <span class="step-no">1</span>
        <div>
          <b>添加上游凭证</b>
          <span>录入 CodeBuddy 凭证，网关负责 Token 刷新、额度查询与每日自动签到。</span>
        </div>
      </li>
      <li class="step">
        <span class="step-no">2</span>
        <div>
          <b>签发网关 Key</b>
          <span>创建 <code class="mono">sk-cb-*</code> Key 并绑定凭证池，客户端只持有它，上游凭证不出网关。</span>
        </div>
      </li>
      <li class="step">
        <span class="step-no">3</span>
        <div>
          <b>切换 base_url</b>
          <span>把客户端指向本网关，模型名与请求体保持原样，即可获得多凭证故障转移。</span>
        </div>
      </li>
    </ol>
  </section>
</main>

<footer class="foot">
  <span>CodeBuddy Gateway · 生产 API 网关</span>
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
    <p>共 ${models.length.toLocaleString('en-US')} 个模型 · 客户端可通过 <code class="mono">GET /v1/models</code> 获取 JSON</p>
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
    <p>监控脚本请调用 JSON 接口 <code class="mono">GET /health</code>，浏览器访问时展示本页。</p>
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
    <span><b>CodeBuddy Gateway</b><i>Production API gateway</i></span>
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
