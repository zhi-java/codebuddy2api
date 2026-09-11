/**
 * 服务端渲染的公开页面（登录页 / 落地页 / 模型目录 / 健康检查）。
 *
 * 管理控制台本体已迁移到 Vue 3 + Naive UI（web/），由 static.ts 托管构建产物；
 * 这里只保留无需前端构建、且必须在不带 JS 或未登录时可用的轻量页面。
 */

const escapeHtml = (value: string | undefined): string =>
  String(value ?? '').replace(/[&<>"']/g, (c): string =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

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
  :root {
    --bg: #070b14; --surface: #0d1320; --border: #1e293b;
    --text: #f1f5f9; --text-2: #94a3b8; --text-3: #64748b;
    --brand: #22c55e; --brand-ink: #052e16; --red: #f87171;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f4f6f8; --surface: #fff; --border: #e2e8f0;
      --text: #0f172a; --text-2: #475569; --text-3: #94a3b8;
      --brand: #16a34a; --brand-ink: #fff; --red: #dc2626; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; color: var(--text);
    background: radial-gradient(900px 480px at 80% -10%, rgba(34,197,94,.12), transparent 50%), var(--bg);
    font: 14px/1.5 Inter, ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(400px, calc(100vw - 40px)); padding: 32px 30px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
  }
  .logo {
    width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center;
    color: var(--brand-ink); margin-bottom: 18px;
    background: linear-gradient(180deg, #4ade80, #16a34a);
    box-shadow: 0 8px 20px rgba(22,163,74,.28);
  }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 700; }
  .sub { color: var(--text-2); font-size: 13px; margin-bottom: 22px; }
  label { display: block; font-size: 12px; font-weight: 550; color: var(--text-2); margin-bottom: 6px; }
  input {
    width: 100%; padding: 9px 11px; font: inherit; color: var(--text);
    background: rgba(127,127,127,.08); border: 1px solid var(--border); border-radius: 8px;
  }
  input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(34,197,94,.16); }
  button {
    width: 100%; margin-top: 16px; padding: 10px; font: inherit; font-weight: 600; cursor: pointer;
    color: var(--brand-ink); background: var(--brand); border: none; border-radius: 8px;
  }
  button:hover { background: #4ade80; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .hint { margin-top: 14px; font-size: 12px; color: var(--text-3); }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <h1>CodeBuddy Gateway</h1>
    <div class="sub">生产控制台 · 使用管理员密码登录</div>
    <form id="login-form">
      <label for="pw">密码</label>
      <input id="pw" type="password" placeholder="管理员密码" autocomplete="current-password" required autofocus>
      <button type="submit">登录</button>
      <div class="hint">会话经 HMAC 签名，超时自动失效</div>
    </form>
  </div>
<script>
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const hint = document.querySelector('.hint');
    btn.disabled = true; btn.textContent = '验证中…';
    try {
      const res = await fetch('/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ password: document.getElementById('pw').value }),
      });
      if (res.status === 401) throw new Error('密码错误');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      location.href = '/admin';
    } catch (err) {
      hint.style.color = 'var(--red)'; hint.textContent = '登录失败：' + err.message;
      btn.disabled = false; btn.textContent = '登录';
    }
  });
</script>
</body>
</html>`;
}

/**
 * 根路径落地页(无鉴权,静态展示,不含任何敏感信息)。
 * 展示品牌、运行状态、三协议接入方式与管理入口;监控请用 GET /health。
 */
export function renderLandingPage(): string {
  const proto = (id: string, name: string, desc: string, sample: string): string =>
    '<div class="lp-card"><div class="lp-proto">' + id + '</div>' +
    '<h3>' + name + '</h3><p>' + desc + '</p>' +
    '<code class="mono">' + sample + '</code></div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CodeBuddy Gateway</title>
<style>
  :root {
    --bg: #070b14; --surface: #0d1320; --border: #1e293b;
    --text: #f1f5f9; --text-2: #94a3b8; --text-3: #64748b;
    --brand: #22c55e; --brand-ink: #052e16; --green: #4ade80;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; color: var(--text);
    background:
      radial-gradient(900px 420px at 80% -8%, rgba(34,197,94,.12), transparent 50%),
      radial-gradient(700px 360px at 0% 110%, rgba(14,165,233,.08), transparent 46%),
      var(--bg);
    font: 14px/1.6 Inter, ui-sans-serif, system-ui, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; align-items: center;
    padding: 48px 20px calc(40px + env(safe-area-inset-bottom));
  }
  .wrap { width: min(960px, 100%); }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand-logo {
    width: 40px; height: 40px; border-radius: 10px; color: #052e16;
    background: linear-gradient(180deg, #4ade80, #16a34a);
    display: grid; place-items: center;
    box-shadow: 0 8px 20px rgba(22,163,74,.28);
  }
  .brand-name { font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
  .brand-sub { font-size: 12px; color: var(--text-3); margin-top: 2px; letter-spacing: .06em; text-transform: uppercase; }
  .hero { margin: 56px 0 8px; }
  .hero h1 { font-size: clamp(26px, 4.6vw, 40px); margin: 0 0 12px; letter-spacing: -.03em; line-height: 1.15; font-weight: 650; }
  .hero p { color: var(--text-2); font-size: 15px; margin: 0; max-width: 640px; }
  .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 18px;
    background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.28); border-radius: 999px;
    padding: 5px 14px; font-size: 12.5px; color: var(--green); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 4px rgba(34,197,94,.16); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 40px; }
  .lp-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 20px; }
  .lp-proto { font-size: 11px; font-weight: 650; letter-spacing: .1em; color: var(--brand);
    text-transform: uppercase; }
  .lp-card h3 { margin: 8px 0 6px; font-size: 15px; }
  .lp-card p { margin: 0 0 14px; color: var(--text-2); font-size: 13px; }
  .lp-card code { display: block; font-size: 12px; color: #cbd5e1;
    background: #101624; border-radius: 8px; padding: 10px 12px; word-break: break-all;
    border: 1px solid var(--border); }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 32px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; padding: 10px 16px; border-radius: 8px;
    font: inherit; font-size: 13.5px; cursor: pointer; text-decoration: none; transition: background .16s, border-color .16s, color .16s; }
  .btn-primary { background: var(--brand); color: var(--brand-ink); font-weight: 600; }
  .btn-primary:hover { background: #4ade80; }
  .btn-ghost { background: transparent; color: var(--text-2); border: 1px solid var(--border); }
  .btn-ghost:hover { color: var(--text); border-color: #334155; }
  .foot { margin-top: 48px; color: var(--text-3); font-size: 12px; display: flex; gap: 16px; flex-wrap: wrap; }
  .foot a { color: var(--text-3); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f6f8; --surface: #fff; --border: #e2e8f0;
      --text: #0f172a; --text-2: #475569; --text-3: #94a3b8;
      --brand: #16a34a; --brand-ink: #fff; --green: #15803d;
    }
    body { background: radial-gradient(900px 420px at 80% -8%, rgba(22,163,74,.10), var(--bg) 55%); }
    .lp-card code { background: #f1f5f9; color: #334155; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div class="brand-logo">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div><div class="brand-name">CodeBuddy Gateway</div><div class="brand-sub">Production API gateway</div></div>
  </div>

  <div class="hero">
    <h1>一套凭证，接入任意主流客户端</h1>
    <p>同时提供 OpenAI Chat Completions、Anthropic Messages 与 OpenAI Responses。
       上游凭证由网关托管并自动续期，客户端只持有网关 Key。</p>
    <span class="status"><span class="dot"></span>服务运行中</span>
  </div>

  <div class="grid">
    ${proto('Chat Completions', 'OpenAI 兼容', '通用对话接口,支持流式与非流式', 'POST /v1/chat/completions')}
    ${proto('Messages', 'Anthropic 兼容', 'Claude Code 等 Anthropic 协议客户端', 'POST /v1/messages · x-api-key')}
    ${proto('Responses', 'OpenAI 新版', 'Agent SDK 等 Responses 客户端', 'POST /v1/responses')}
  </div>

  <div class="actions">
    <a class="btn btn-primary" href="/admin">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
      管理控制台
    </a>
    <a class="btn btn-ghost mono" href="/v1/models">GET /v1/models</a>
    <a class="btn btn-ghost mono" href="/health">GET /health</a>
  </div>

  <div class="foot">
    <span>健康检查 JSON: GET /health</span>
    <span>·</span>
    <a href="/admin">管理入口 /admin</a>
  </div>
</div>
</body>
</html>`;
}

/**
 * 模型目录浏览页(浏览器直接访问 /v1/models 时返回,带设计;API 仍返回 JSON)。
 * 展示内置快照目录,无鉴权、无敏感信息。
 */
export function renderPublicModelsPage(models: Array<{ id: string; _name?: string; _credits?: string; _vendor?: string; _maxInputTokens?: number; _maxOutputTokens?: number }>): string {
  const cards = models.map(
    (m) => '<div class="pm-card"><div class="pm-id mono">' + escapeHtml(m.id) + '</div>' +
      '<div class="pm-name">' + escapeHtml(m._name || m.id) + '</div>' +
      '<div class="pm-meta">' +
        (m._credits ? '<span class="pill pill-slate">' + escapeHtml(m._credits) + '</span>' : '') +
        (m._vendor ? '<span class="pill pill-blue">' + escapeHtml(m._vendor) + '</span>' : '') +
        (typeof m._maxInputTokens === 'number' ? '<span class="pm-num">in ' + m._maxInputTokens.toLocaleString() + '</span>' : '') +
        (typeof m._maxOutputTokens === 'number' ? '<span class="pm-num">out ' + m._maxOutputTokens.toLocaleString() + '</span>' : '') +
      '</div></div>',
  ).join('');

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>模型目录 · CodeBuddy Gateway</title>' +
    '<style>' + PUBLIC_CSS + '</style></head><body>' +
    publicHeader('模型目录', '共 ' + models.length + ' 个模型 · 客户端可通过 /v1/models 获取 JSON') +
    '<div class="pm-grid">' + cards + '</div>' +
    publicFooter() + '</body></html>';
}

/**
 * 健康状态页(浏览器访问 /health;监控脚本仍拿 JSON)。
 */
export function renderHealthPage(): string {
  const checked = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>健康状态 · CodeBuddy Gateway</title>' +
    '<style>' + PUBLIC_CSS + '</style></head><body>' +
    publicHeader('运行状态', '') +
    '<div class="hp"><span class="dot-lg"></span><div><div class="hp-title">网关运行正常</div>' +
    '<div class="hp-sub">检查时间 ' + checked + ' · 监控请调用 JSON 接口 GET /health</div></div></div>' +
    publicFooter() + '</body></html>';
}

const PUBLIC_CSS = `
  :root { --bg:#070b14; --surface:#0d1320; --border:#1e293b; --text:#f1f5f9; --text-2:#94a3b8; --text-3:#64748b;
    --brand:#22c55e; --brand-weak:rgba(34,197,94,.14); --green:#4ade80; --slate:#94a3b8; --slate-bg:rgba(148,163,184,.12); }
  @media (prefers-color-scheme: light) { :root { --bg:#f4f6f8; --surface:#fff; --border:#e2e8f0;
    --text:#0f172a; --text-2:#475569; --text-3:#94a3b8; --brand:#16a34a; --brand-weak:#dcfce7;
    --green:#15803d; --slate:#64748b; --slate-bg:#eef2f6; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.6 Inter,ui-sans-serif,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    padding:36px 20px calc(40px + env(safe-area-inset-bottom)); -webkit-font-smoothing:antialiased; }
  .ph { max-width:1060px; margin:0 auto 22px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .ph .t { font-size:19px; font-weight:700; }
  .ph .s { color:var(--text-3); font-size:13px; }
  .pf { max-width:1060px; margin:40px auto 0; display:flex; gap:16px; color:var(--text-3); font-size:12.5px; flex-wrap:wrap; }
  .pf a { color:var(--brand); text-decoration:none; }
  .pm-grid { max-width:1060px; margin:0 auto; display:grid; gap:12px;
    grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); }
  .pm-card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
  .pm-id { font-size:13.5px; font-weight:650; word-break:break-all; }
  .pm-name { font-size:12px; color:var(--text-3); margin:2px 0 8px; }
  .pm-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:11.5px; }
  .pm-num { color:var(--text-3); font-variant-numeric:tabular-nums; }
  .pill { display:inline-flex; align-items:center; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:550; }
  .pill-slate { background:var(--slate-bg); color:var(--slate); }
  .pill-blue { background:var(--brand-weak); color:var(--brand); }
  .hp { max-width:1060px; margin:0 auto; background:var(--surface); border:1px solid var(--border);
    border-radius:14px; padding:26px 28px; display:flex; gap:16px; align-items:center; }
  .dot-lg { width:14px; height:14px; border-radius:50%; background:var(--green);
    box-shadow:0 0 0 4px rgba(22,163,74,.16); flex:none; }
  .hp-title { font-size:17px; font-weight:700; }
  .hp-sub { color:var(--text-2); font-size:13px; margin-top:4px; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
`;

function publicHeader(title: string, sub: string): string {
  return '<div class="ph"><div class="t">' + title + '</div>' +
    (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>';
}
function publicFooter(): string {
  return '<div class="pf"><span>CodeBuddy Gateway</span><a href="/">首页</a><a href="/admin">管理控制台</a><a href="/health">JSON 健康检查</a></div>';
}
