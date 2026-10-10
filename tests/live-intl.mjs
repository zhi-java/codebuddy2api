/**
 * 国际版真实链路测试（需要真实 token）。
 *
 * 与 smoke-region.mjs 的区别：那个用假令牌验证网关自身行为，这个用真
 * 令牌打通上游，验证区域档案里的端点/头/路径取值是否真的成立。
 *
 * 用法：
 *   INTL_ACCESS_TOKEN=... INTL_REFRESH_TOKEN=... node tests/live-intl.mjs
 *
 * 注意：token 从环境变量读取，不落盘、不写入代码。
 */
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const AT = process.env.INTL_ACCESS_TOKEN;
const RT = process.env.INTL_REFRESH_TOKEN;
if (!AT) {
  console.error('缺少 INTL_ACCESS_TOKEN 环境变量，跳过真实链路测试');
  process.exit(0);
}

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cblive-'));
const port = 19400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  DATA_FILE: path.join(tmpDir, 'cb.db'),
  ADMIN_PASSWORD: 'pw-live',
  ADMIN_SESSION_SECRET: 'sess-live',
  CREDENTIALS_ENC_SECRET: 'enc-live-32-bytes-padding-xxxxx',
};

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server not healthy');
}

const child = spawn('node', [path.join(root, 'dist', 'server.cjs')], { env, stdio: 'ignore' });

try {
  await waitHealthy();

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw-live' }),
  });
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1] || '';
  const auth = { 'content-type': 'application/json', cookie: `cb_admin=${cookie}` };

  // 录入国际版 CLI OAuth 凭证（不指定 region，交给服务端按 iss 推断）
  const created = await fetch(`${base}/admin/api/credentials`, {
    method: 'POST',
    headers: { ...auth, origin: base },
    body: JSON.stringify({
      name: '国际版实测',
      kind: 'cli_oauth',
      accessToken: AT,
      refreshToken: RT,
      ...(RT ? {} : {}),
    }),
  });
  const cred = (await created.json()).data;
  console.log(`[1] 凭证区域识别: ${cred.region}  ${cred.region === 'intl' ? 'PASS' : 'FAIL'}`);

  // 创建网关 Key 并绑定
  const keyRes = await fetch(`${base}/admin/api/keys`, {
    method: 'POST',
    headers: { ...auth, origin: base },
    body: JSON.stringify({ name: 'intl-key', credentialIds: [cred.id] }),
  });
  const keyResBody = await keyRes.json();
  const apiKey = keyResBody?.data?.plaintext;
  if (!apiKey) {
    console.log('    创建 Key 响应:', JSON.stringify(keyResBody).slice(0, 300));
    throw new Error('未取到网关 Key');
  }
  console.log(`[2] 网关 Key 创建: ${String(apiKey).slice(0, 12)}…`);

  // 国际版模型目录（走 /admin/api/models?region=intl）
  const intlModels = await (await fetch(`${base}/admin/api/models?region=intl`, { headers: auth })).json();
  console.log(`[3] 国际版模型目录: ${intlModels.data.length} 个  ${intlModels.data.length > 0 ? 'PASS' : 'FAIL'}`);
  if (intlModels.data.length) {
    console.log('    样例:', intlModels.data.slice(0, 6).map((m) => m.id).join(', '));
  }

  // 额度查询（走网关的计费链路）
  const quota = await fetch(`${base}/admin/api/credentials/${encodeURIComponent(cred.id)}/quota`, { headers: auth });
  const quotaBody = await quota.json();
  console.log(`[4] 额度查询: HTTP ${quota.status}  ${JSON.stringify(quotaBody).slice(0, 160)}`);

  // 签到：国际版应给出明确提示，而非上游 404
  const checkin = await fetch(`${base}/admin/api/credentials/${encodeURIComponent(cred.id)}/checkin-status`, { headers: auth });
  const checkinBody = await checkin.json();
  console.log(`[5] 签到: HTTP ${checkin.status}  ${JSON.stringify(checkinBody).slice(0, 140)}`);

  // 真实对话（流式）
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: '用一句话说明什么是幂等性' }],
      stream: true,
    }),
  });
  console.log(`[6] 真实对话(流式): HTTP ${chat.status}`);

  if (chat.ok) {
    const raw = await chat.text();
    let text = '';
    let usage = null;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const p = t.slice(5).trim();
      if (p === '[DONE]') break;
      try {
        const o = JSON.parse(p);
        if (o.usage) usage = o.usage;
        for (const c of o.choices ?? []) if (c.delta?.content) text += c.delta.content;
      } catch {}
    }
    console.log(`    回复: ${text.slice(0, 120)}`);
    console.log(`    usage: ${usage ? `total=${usage.total_tokens} completion=${usage.completion_tokens}` : '无'}`);
    console.log('    ' + (text ? 'PASS' : 'FAIL（无内容）'));
  } else {
    console.log('    错误体:', (await chat.text()).slice(0, 300));
  }

  // 非流式：国际版强制流式，这条预期会失败
  const nonStream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  });
  console.log(`[7] 非流式: HTTP ${nonStream.status}  ${(await nonStream.text()).slice(0, 200)}`);

  child.kill('SIGTERM');
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
} finally {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}