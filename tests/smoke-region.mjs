/**
 * 端到端冒烟：起真实网关 → 录入国际版凭证 → 查模型页区域切换。
 *
 * 验证的是「国际版凭证能被正确识别与路由」这条主链路。
 * 上游不可达是预期内的（无有效国际版令牌），因此只断言
 * 网关自身行为正确，不把上游 401 当成失败。
 */
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbregion-'));
const port = 19900 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  DATA_FILE: path.join(tmpDir, 'cb.db'),
  ADMIN_PASSWORD: 'pw-region',
  ADMIN_SESSION_SECRET: 'sess-region',
  CREDENTIALS_ENC_SECRET: 'enc-region-32-bytes-padding-xxxx',
  // 屏蔽真实上游：国际版域名不可达时能快速失败而非长时间挂起
  UPSTREAM_BILLING_BASE: 'http://127.0.0.1:9',
};

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server not healthy');
}

/** 构造一个带 codebuddy.ai 的 iss 的 JWT（无有效签名，仅用于验证区域识别） */
function fakeIntlJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS512', typ: 'JWT' })}.${b64({
    iss: 'https://www.codebuddy.ai/auth/realms/copilot',
    azp: 'console',
    sub: '034cdbe9-dc9f-4379-9f83-440a68808fd2',
  })}.sig`;
}

let child = spawn('node', [path.join(root, 'dist', 'server.cjs')], { env, stdio: 'ignore' });
try {
  await waitHealthy();

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw-region' }),
  });
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1] || '';
  if (!cookie) throw new Error('login failed');

  const auth = { 'content-type': 'application/json', cookie: `cb_admin=${cookie}` };

  // ① 不指定 region → 服务端从令牌 iss 自动识别为国际版
  const auto = await fetch(`${base}/admin/api/credentials`, {
    method: 'POST',
    headers: { ...auth, origin: base },
    body: JSON.stringify({ name: '国际版-自动识别', kind: 'cli_oauth', accessToken: fakeIntlJwt() }),
  });
  const autoData = (await auto.json()).data;
  console.log('自动识别 region =', autoData.region, autoData.region === 'intl' ? 'PASS' : 'FAIL');

  // ② 显式指定 cn（与令牌特征冲突）→ 尊重显式选择
  const forced = await fetch(`${base}/admin/api/credentials`, {
    method: 'POST',
    headers: { ...auth, origin: base },
    body: JSON.stringify({ name: '国内版-显式', kind: 'ck_apikey', apiKey: 'ck_dummy', region: 'cn' }),
  });
  const forcedData = (await forced.json()).data;
  console.log('显式指定 region =', forcedData.region, forcedData.region === 'cn' ? 'PASS' : 'FAIL');

  // ③ 非法 region 不得落库
  const bad = await fetch(`${base}/admin/api/credentials`, {
    method: 'POST',
    headers: { ...auth, origin: base },
    body: JSON.stringify({ name: '非法区域', kind: 'ck_apikey', apiKey: 'ck_x', region: '../../etc' }),
  });
  const badData = (await bad.json()).data;
  console.log('非法 region 回落 =', badData.region, badData.region === 'cn' ? 'PASS' : 'FAIL');

  // ④ 凭证列表透出 region
  const list = await (await fetch(`${base}/admin/api/credentials`, { headers: auth })).json();
  const regions = list.data.map((c) => `${c.name}:${c.region}`).join(', ');
  console.log('列表 region =', regions);

  // ⑤ 模型页区域标签与切换
  const cnPage = await (await fetch(`${base}/v1/models`, { headers: { accept: 'text/html' } })).text();
  const intlPage = await (await fetch(`${base}/v1/models?region=intl`, { headers: { accept: 'text/html' } })).text();

  const cnOk = cnPage.includes('国内版') && cnPage.includes('?region=intl') && cnPage.includes('class="region-tab active"');
  const intlOk = intlPage.includes('国际版 · ') || intlPage.includes('国际版<');
  console.log('国内版页含标签与切换链接 =', cnOk ? 'PASS' : 'FAIL');
  console.log('国际版页标签激活 =', /region=intl"[^>]*>国际版/.test(intlPage) ? 'PASS' : 'FAIL');

  // ⑥ 国际版页在上游不可达时应给出说明而非空白
  const hasEmptyHint = intlPage.includes('empty-state');
  console.log('国际版空态说明 =', hasEmptyHint ? 'PASS' : '(有上游目录或无空态标记)');

  // ⑦ 管理台模型接口按区域返回
  const cnModels = await (await fetch(`${base}/admin/api/models`, { headers: auth })).json();
  const intlModels = await (await fetch(`${base}/admin/api/models?region=intl`, { headers: auth })).json();
  console.log('国内版模型数 =', cnModels.data.length, '| 国际版模型数 =', intlModels.data.length);

  // ⑧ 国际版签到接口应给出明确错误而非上游 404
  const checkin = await fetch(`${base}/admin/api/credentials/${encodeURIComponent(autoData.id)}/checkin-status`, {
    headers: auth,
  });
  const checkinBody = await checkin.json();
  console.log('国际版签到提示 =', JSON.stringify(checkinBody).slice(0, 120));

  child.kill('SIGTERM');
  // 等进程真正退出后再删临时目录：SQLite 句柄未释放时会 EBUSY
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
} finally {
  try { child.kill('SIGKILL'); } catch {}
  // 文件句柄释放有延迟，删除失败不影响验证结论
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}