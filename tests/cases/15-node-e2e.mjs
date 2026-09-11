// 用例 15:Node 部署端到端(子进程跑 dist/server.cjs:健康/登录/管理/持久化)
{
  const { execSync, spawn } = await import('node:child_process');
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');

  const root = process.cwd();
  const distCjs = pathMod.join(root, 'dist', 'server.cjs');
  if (!fsMod.existsSync(distCjs)) {
    execSync('npx esbuild src/server.ts --bundle --platform=node --format=cjs --outfile=dist/server.cjs', { stdio: 'ignore' });
  }

  const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'cbgw-'));
  const dbFile = pathMod.join(tmpDir, 'codebuddy.db');
  const port = 19800 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_FILE: dbFile,
    ADMIN_PASSWORD: 'pw-e2e',
    ADMIN_SESSION_SECRET: 'sess-e2e',
    CREDENTIALS_ENC_SECRET: 'enc-e2e',
  };

  const waitHealthy = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok) return;
      } catch { /* retry */ }
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('node server did not become healthy');
  };

  const loginCookie = async () => {
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw-e2e' }),
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') || '';
    return /cb_admin=([^;]+)/.exec(setCookie)?.[1] || '';
  };

  let credId = '';
  let child = spawn('node', [distCjs], { env, stdio: 'ignore' });
  try {
    await waitHealthy();

    // 登录并创建凭证
    const cookie = await loginCookie();
    assert.ok(cookie.length > 0, '应获得会话 cookie');
    const created = await fetch(`${base}/admin/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `cb_admin=${cookie}`, origin: base },
      body: JSON.stringify({ name: '持久化测试', kind: 'ck_apikey', apiKey: 'ck_demo' }),
    });
    assert.equal(created.status, 201);
    credId = (await created.json()).data.id;

    // 管理界面可访问
    const page = await fetch(`${base}/admin`, { headers: { cookie: `cb_admin=${cookie}` } });
    assert.match(await page.text(), /CodeBuddy Gateway/);

    // 优雅停止
    child.kill('SIGTERM');
    await new Promise((res) => setTimeout(res, 1200));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // 重启 → 数据持久化(SQLite)
  child = spawn('node', [distCjs], { env, stdio: 'ignore' });
  try {
    await waitHealthy();
    const cookie = await loginCookie();
    const listRes = await fetch(`${base}/admin/api/credentials`, {
      headers: { cookie: `cb_admin=${cookie}` },
    });
    const list = (await listRes.json()).data;
    assert.ok(list.some((c) => c.id === credId), '重启后凭证应持久化');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    // Windows 下 sqlite 句柄释放有延迟,延时后重试清理
    await new Promise((res) => setTimeout(res, 600));
    for (let i = 0; i < 3; i++) {
      try { fsMod.rmSync(tmpDir, { recursive: true, force: true }); break; }
      catch { await new Promise((res) => setTimeout(res, 500)); }
    }
  }

  console.log('case15 node e2e passed');
}
