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

import type { Region } from './types';

/** 区域显示名（与 region.ts 的档案标签一致，渲染层不重复定义业务语义） */
const REGION_LABEL: Record<Region, string> = { cn: '国内版', intl: '国际版' };

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
  /* 浅色极简令牌：与 web/src/tokens.css 同源（公开页不走前端构建，只能内联一份）。
     一致性由 web/scripts/check-tokens.mjs 在构建前校验，漂移会导致构建失败。

     设计原则与控制台一致：一个强调色（只用于可点击与选中）、层次靠发丝线与留白、
     无装饰性元素、动效只用于状态变化。 */
  :root {
    --bg:#fafafa; --surface:#ffffff; --surface-2:#fafafa; --surface-3:#f4f4f5; --inset:#fafafa;
    --line:#ededed; --line-strong:#dcdcdc;
    --border:var(--line-strong); --border-soft:var(--line);
    --text:#18181b; --text-2:#52525b; --text-3:#6b6b74;
    --accent:#2563eb; --accent-hover:#1d4ed8; --accent-ink:#ffffff; --accent-soft:#eef2ff;
    --ok:#15803d; --warn:#a16207; --bad:#b91c1c;
    --danger:var(--bad); --info:var(--accent);
    --radius:8px; --radius-sm:6px; --radius-lg:10px;
    --ease:cubic-bezier(.16,1,.3,1); --dur:160ms;
    --shadow-sm:none; --shadow-card:none; --shadow-raised:none;
    --shadow-pop:0 8px 28px -8px rgba(24,24,27,.16);
    --shadow:none;
    color-scheme:light;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:13px/1.6 Inter,ui-sans-serif,system-ui,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;
    display:flex; flex-direction:column; min-height:100vh;
  }
  a { color:inherit; text-decoration:none; }
  button { font:inherit; cursor:pointer; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .mono { font-family:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace; font-variant-ligatures:none; }
  .sub { color:var(--text-3); font-size:12px; }
  .label { font-size:10.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--text-3); }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }

  /* ── 顶栏 ──
     纯文字导航，选中态用颜色 + 2px 下划线；不用胶囊背景块。 */
  .nav {
    position:sticky; top:0; z-index:20;
    display:flex; align-items:center; gap:28px;
    width:100%; max-width:1180px; margin:0 auto;
    padding:0 28px; height:52px;
    background:rgba(250,250,250,.86);
    backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
    border-bottom:1px solid var(--line);
  }
  .nav-brand { display:flex; align-items:center; gap:9px; flex:none; }
  .logo {
    width:20px; height:20px; flex:none; border-radius:5px; display:grid; place-items:center;
    color:#fff; background:var(--text);
  }
  .nav-brand b { display:block; font-size:13px; font-weight:640; letter-spacing:-.01em; white-space:nowrap; }
  .nav-links { display:flex; align-items:center; gap:22px; margin-left:auto; }
  .nav-link { font-size:13px; color:var(--text-3); transition:color var(--dur) var(--ease); }
  .nav-link:hover { color:var(--text); }

  /* 按钮：主按钮用强调色，次按钮只用描边 */
  .btn {
    display:inline-flex; align-items:center; gap:6px;
    padding:7px 14px; border-radius:var(--radius-sm);
    border:1px solid var(--line-strong); background:var(--surface);
    color:var(--text-2); font-size:12.5px; font-weight:550; white-space:nowrap;
    transition:border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  .btn:hover { border-color:var(--text-3); color:var(--text); }
  .btn-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn-primary:hover { background:var(--accent-hover); border-color:var(--accent-hover); color:#fff; }
  .btn-sm { padding:4px 10px; font-size:12px; }

  /* ── 布局 ── */
  .wrap { width:100%; max-width:1180px; margin:0 auto; padding:0 28px; flex:1; }
  .section { margin-top:56px; }
  .section-head { margin-bottom:16px; }
  .section-head h2 { margin:0; font-size:13px; font-weight:640; letter-spacing:-.005em; }

  /* ── Banner：一句话，不放大标题、不加装饰 ── */
  .hero { padding:64px 0 52px; max-width:660px; }
  .hero h1 { margin:0 0 14px; font-size:27px; font-weight:620; letter-spacing:-.035em; line-height:1.35; }
  .hero p { margin:0; font-size:14px; line-height:1.75; color:var(--text-3); }

  /* ── 页签：接入方式 / 模型目录 ── */
  .tabs { display:flex; gap:22px; border-bottom:1px solid var(--line); margin-bottom:26px; }
  .tab {
    position:relative; border:none; background:transparent; padding:0 0 12px;
    font-size:13.5px; font-weight:550; color:var(--text-3);
    transition:color var(--dur) var(--ease);
  }
  .tab:hover { color:var(--text); }
  .tab.active { color:var(--text); font-weight:620; }
  .tab.active::after {
    content:''; position:absolute; left:0; right:0; bottom:-1px; height:2px; background:var(--text);
  }
  .tab .n { margin-left:7px; font-size:12px; color:var(--text-3); font-variant-numeric:tabular-nums; }
  .panel { display:none; }
  .panel.active { display:block; }

  /* ── 端点：三行，不用卡片 ── */
  .endpoints { margin-bottom:26px; }
  .ep-row {
    display:flex; align-items:baseline; gap:16px;
    padding:13px 0; border-bottom:1px solid var(--line);
  }
  .ep-row:first-child { border-top:1px solid var(--line); }
  .ep-name { font-size:13px; font-weight:600; flex:none; width:150px; }
  .ep-path { font-family:ui-monospace,"SF Mono",Consolas,monospace; font-size:12px; color:var(--text-2); flex:1; min-width:0; }
  .ep-path b { color:var(--accent); font-weight:620; }
  .ep-auth { font-family:ui-monospace,"SF Mono",Consolas,monospace; font-size:11.5px; color:var(--text-3); flex:none; }

  /* ── 代码面板 ── */
  .code-panel { border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; }
  .code-head {
    display:flex; align-items:center; gap:2px;
    padding:6px 8px; border-bottom:1px solid var(--line);
  }
  .code-tab {
    padding:5px 11px; border:none; background:transparent; border-radius:var(--radius-sm);
    font-size:12px; font-weight:550; color:var(--text-3);
    transition:background var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  .code-tab:hover { color:var(--text); }
  .code-tab.active { background:var(--bg); color:var(--text); font-weight:620; }
  .copy { margin-left:auto; }
  .code-view { display:none; padding:14px 18px; }
  .code-view.active { display:block; }
  .code-view pre { margin:0; overflow-x:auto; }
  .code-view code {
    font-family:ui-monospace,"SF Mono",Consolas,monospace;
    font-size:12px; line-height:1.75; color:var(--text-2); white-space:pre;
  }

  /* ── 模型目录：区域切换 + 密集网格 ──
     区域项是 <a>（服务端渲染，无 JS 也要能切换），故选择器必须用 .region a
     而非 .region button —— 此前写成 button，样式完全没生效，两个区域项
     退化成带下划线的默认链接。 */
  .region { display:flex; gap:2px; margin-bottom:16px; }
  .region a {
    display:inline-block; padding:5px 12px; border-radius:var(--radius-sm);
    font-size:12.5px; font-weight:550; color:var(--text-3); text-decoration:none;
    transition:background var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  .region a:hover { color:var(--text); background:var(--surface-3); }
  .region a.active { background:var(--surface-3); color:var(--text); font-weight:620; }

  .model-grid {
    display:grid; gap:1px;
    grid-template-columns:repeat(auto-fill,minmax(186px,1fr));
    background:var(--line); border:1px solid var(--line);
    border-radius:var(--radius); overflow:hidden;
  }
  .model {
    background:var(--surface); padding:11px 13px;
    display:flex; flex-direction:column; gap:4px; min-width:0;
    transition:background 140ms var(--ease);
  }
  .model:hover { background:var(--bg); }
  .model .nm { font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .model .id { font-family:ui-monospace,"SF Mono",Consolas,monospace; font-size:11px; color:var(--text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .model .meta { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-top:3px; }
  .model .cr { font-family:ui-monospace,"SF Mono",Consolas,monospace; font-size:11px; color:var(--text-2); font-variant-numeric:tabular-nums; }
  .model .ctx { font-family:ui-monospace,"SF Mono",Consolas,monospace; font-size:10.5px; color:var(--text-3); }

  /* ── 空态 ── */
  .empty-state { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:64px 20px; text-align:center; color:var(--text-3); }
  .empty-state p { margin:0; }
  .empty-state .sub { font-size:12.5px; max-width:380px; line-height:1.7; }

  /* ── 健康页 ── */
  .kv { list-style:none; margin:0; padding:0; }
  .kv li { display:flex; justify-content:space-between; gap:20px; padding:12px 0; border-bottom:1px solid var(--line); font-size:13px; }
  .kv li:last-child { border-bottom:none; }
  .kv span { color:var(--text-3); }
  .kv b { font-weight:550; text-align:right; word-break:break-all; }

  /* ── 页脚 ── */
  .foot {
    display:flex; align-items:center; gap:18px; flex-wrap:wrap;
    width:100%; max-width:1180px; margin:56px auto 0;
    padding:20px 28px; border-top:1px solid var(--line);
    font-size:12px; color:var(--text-3);
  }
  .foot a { color:var(--text-3); transition:color var(--dur) var(--ease); }
  .foot a:hover { color:var(--text); }

  @media (max-width:640px) {
    .nav, .wrap, .foot { padding-left:18px; padding-right:18px; }
    .nav { gap:14px; }
    .nav-links { gap:14px; }
    .hero { padding:40px 0 34px; }
    .hero h1 { font-size:21px; }
    .model-grid { grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); }
    .ep-row { flex-wrap:wrap; gap:6px 14px; }
    .ep-name { width:100%; }
    .ep-auth { width:100%; }
  }
  @media (prefers-reduced-motion:reduce) {
    *,*::before,*::after { animation-duration:.01ms !important; transition-duration:.01ms !important; }
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
  /* 极简：卡片用发丝描边而非阴影，圆角收敛到 8px */
  .login {
    width:min(380px,100%); background:var(--surface); border:1px solid var(--line);
    border-radius:var(--radius); padding:30px 28px;
  }
  .login .logo { width:36px; height:36px; border-radius:9px; margin-bottom:18px; }
  .login h1 { margin:0 0 6px; font-size:18px; font-weight:640; letter-spacing:-.02em; }
  .login .sub { margin:0 0 22px; color:var(--text-3); font-size:12.5px; }
  .field { margin-bottom:16px; }
  .field label { display:block; font-size:12.5px; font-weight:550; color:var(--text-2); margin-bottom:7px; }
  .field input {
    width:100%; padding:9px 12px; font:inherit; font-size:13.5px; color:var(--text);
    background:var(--surface); border:1px solid var(--line-strong); border-radius:var(--radius-sm);
    transition:border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
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

  // 外层 .code-head 本身就是 flex 行，tab 直接作为其子元素即可 ——
  // 不再套 .code-tabs / .code-views 两层（新样式表没有它们的规则，
  // 多出来的 div 会让 tab 栏失去布局）。
  return `<div class="code-panel" data-code-scope>
    <div class="code-head">
      ${tabs}
      <button class="copy" type="button" data-copy aria-label="复制当前协议的调用示例">复制</button>
    </div>
    ${views}
  </div>`;
}

/**
 * 根路径落地页（无鉴权）。
 *
 * 只回答两件事：这是什么、怎么接。运行时长与凭证池状态属运维信息，
 * 已收进控制台，不在公开页呈现。
 *//**
 * 根路径落地页（无鉴权）。
 *
 * 承担两件事：对外证明「服务活着」，以及给开发者一份可直接抄走的接入方式。
 * 主体只有三块：一句话 Banner、页签（接入方式 / 模型目录）、页脚。
 *
 * @param status  运行时状态（脱敏）
 * @param models  当前页签为「模型目录」时的模型列表；为 null 表示不展示该页签
 * @param region  模型目录的区域
 */
export function renderLandingPage(
  status: LandingStatus,
  models: PublicModel[] | null = null,
  region: Region = 'cn',
): string {
  const checked = formatCheckedAt(new Date());
  const count = status.modelCount ? status.modelCount.toLocaleString('en-US') : '—';

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
    <a class="btn btn-primary" href="/admin">管理控制台</a>
  </div>
</nav>

<main class="wrap">
  <!-- Banner：一句话说清产品是什么。刻意不放运行时长与凭证健康度 ——
       那是运维信息，属于控制台，访客不关心。 -->
  <section class="hero">
    <h1>一套上游凭证，接入任意主流客户端。</h1>
    <p>把 CodeBuddy 上游转成 OpenAI、Anthropic、Responses 三种标准协议，客户端零改动即可接入。</p>
  </section>

  <!-- 页签：接入方式 / 模型目录。用 query 参数切换，纯服务端渲染，不依赖 JS。 -->
  <div class="tabs" role="tablist">
    <a class="tab ${models ? '' : 'active'}" role="tab" aria-selected="${models ? 'false' : 'true'}" href="/">接入方式</a>
    <a class="tab ${models ? 'active' : ''}" role="tab" aria-selected="${models ? 'true' : 'false'}" href="/?tab=models">模型目录 <span class="n">${escapeHtml(count)}</span></a>
  </div>

  ${models
    ? `<section class="panel active" id="panel-models" role="tabpanel">${renderModelsPanel(models, region)}</section>`
    : `<section class="panel active" id="panel-api" role="tabpanel">
    <div class="endpoints">
      ${PROTOCOLS.map(
        (spec) => `<div class="ep-row">
        <span class="ep-name">${escapeHtml(spec.name)}</span>
        <span class="ep-path"><b>${escapeHtml(spec.method)}</b> ${escapeHtml(spec.path)}</span>
        <span class="ep-auth">${escapeHtml(spec.auth)}</span>
      </div>`,
      ).join('\n      ')}
    </div>
    ${renderCodePanel(status.sampleModel)}
  </section>`}
</main>

<footer class="foot">
  <a href="/admin">管理控制台</a>
  <a href="/?tab=models">模型目录</a>
  <a href="/health">健康检查</a>
  <span style="margin-left:auto">检查时间 ${escapeHtml(checked)}</span>
</footer>
<script>${COPY_SCRIPT}</script>
</body>
</html>`;
}

/**
 * 模型目录面板（并入落地页的「模型目录」页签）。
 *
 * 独立成函数是因为它需要实时向上游拉取目录 —— 落地页渲染时不该为一个
 * 页签阻塞；由调用方按 ?tab=models 决定是否拉取并传入。
 *
 * 区域切换同样用 query 参数，保证无 JS 环境也能切换。
 */
export function renderModelsPanel(models: PublicModel[], region: Region = 'cn'): string {
  // 区域切换用链接而非按钮：纯服务端渲染，无 JS 环境也能切换。
  // 面板在落地页内，故链接带回 ?tab=models，切完区域仍停在模型目录页签。
  const regionTabs = (['cn', 'intl'] as const)
    .map(
      (r) =>
        `<a class="${r === region ? 'active' : ''}" href="/?tab=models&region=${r}">${REGION_LABEL[r]}</a>`,
    )
    .join('');

  // 国际版无内置快照：上游不可用时会是空列表。与其展示空白网格，
  // 不如说明原因并给出配置入口，否则用户会以为是页面坏了。
  const emptyHint =
    models.length === 0
      ? region === 'intl'
        ? `<div class="empty-state">
        <p>国际版目录需实时拉取</p>
        <p class="sub">国际版没有内置快照，需在管理控制台添加国际版上游凭证后，由网关实时向上游获取。</p>
      </div>`
        : '<div class="empty-state"><p>暂无可用模型目录</p></div>'
      : '';

  const cards = models
    .map(
      (m) => `<div class="model">
      <div class="nm" title="${escapeHtml(m._name || m.id)}">${escapeHtml(m._name || m.id)}</div>
      <div class="id" title="${escapeHtml(m.id)}">${escapeHtml(m.id)}</div>
      <div class="meta">
        ${m._credits ? `<span class="cr">${escapeHtml(m._credits.replace(/\s*credits$/i, ''))}</span>` : '<span class="cr">—</span>'}
        <span class="ctx">${typeof m._maxInputTokens === 'number' ? escapeHtml(formatContext(m._maxInputTokens)) : '—'}</span>
      </div>
    </div>`,
    )
    .join('\n    ');

  return `<div class="region">${regionTabs}</div>
    ${emptyHint}
    ${models.length > 0 ? `<div class="model-grid">${cards}</div>` : ''}`;
}

/** 上下文长度：把 1000000 显示成 1M，表格里更好扫读 */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
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
 *
 * `region` 为当前查看的区域：页面以「国内版 / 国际版」标签切换，链接形如
 * /v1/models?region=intl。API 客户端不受影响 —— JSON 分支忽略该参数，
 * 仍按调用方自己的凭证返回对应目录。
 */
export function renderPublicModelsPage(models: PublicModel[], region: Region = 'cn'): string {
  // 区域切换用链接而非按钮：纯服务端渲染，无 JS 环境也能切换。
  const regionTabs = (['cn', 'intl'] as const)
    .map(
      (r) =>
        `<a class="${r === region ? 'active' : ''}" href="/v1/models?region=${r}">${REGION_LABEL[r]}</a>`,
    )
    .join('');

  // 国际版无内置快照：上游不可用时会是空列表。与其展示空白网格，
  // 不如说明原因并给出配置入口，否则用户会以为是页面坏了。
  const emptyHint =
    models.length === 0
      ? region === 'intl'
        ? `<div class="empty-state">
  <p>国际版目录需实时拉取</p>
  <p class="sub">国际版没有内置快照，需在管理控制台添加国际版上游凭证后，由网关实时向上游获取。</p>
</div>`
        : '<div class="empty-state"><p>暂无可用模型目录</p></div>'
      : '';

  const cards = models
    .map(
      (m) => `<div class="model">
  <div class="nm" title="${escapeHtml(m._name || m.id)}">${escapeHtml(m._name || m.id)}</div>
  <div class="id" title="${escapeHtml(m.id)}">${escapeHtml(m.id)}</div>
  <div class="meta">
    ${m._credits ? `<span class="cr">${escapeHtml(m._credits.replace(/\s*credits$/i, ''))}</span>` : '<span class="cr">—</span>'}
    <span class="ctx">${typeof m._maxInputTokens === 'number' ? escapeHtml(formatContext(m._maxInputTokens)) : '—'}</span>
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
  <section class="hero" style="padding-bottom:28px">
    <h1>模型目录</h1>
    <p>${REGION_LABEL[region]} · 共 ${models.length.toLocaleString('en-US')} 个模型</p>
  </section>
  <div class="region">${regionTabs}</div>
  ${emptyHint}
  ${models.length > 0 ? `<div class="model-grid">${cards}</div>` : ''}
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
  <section class="hero" style="padding-bottom:28px">
    <h1>运行状态</h1>
    <p>监控脚本请调用 <code class="mono">GET /health</code></p>
  </section>
  <ul class="kv">
    <li><span>状态</span><b class="ok">网关运行正常</b></li>
    <li><span>检查时间</span><b>${escapeHtml(checked)}</b></li>
  </ul>
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
