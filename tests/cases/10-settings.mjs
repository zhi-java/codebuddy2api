// 用例 10:签到设置 / 自动签到执行 / 接口内容协商
{
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  const { resetTokenStore, getTokenStore } = storeMod;
  const { performAutoCheckins } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/scheduled.mjs')
  );

  const kvData = new Map();
  const kv = {
    async get(k) { return kvData.has(k) ? kvData.get(k) : null; },
    async put(k, v) { kvData.set(k, v); },
    async delete(k) { kvData.delete(k); },
  };
  resetTokenStore();
  const st = getTokenStore({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });

  // 1. settings 默认关闭并可持久化
  assert.deepEqual(await st.getSettings(), { autoCheckin: false });
  await st.putSettings({ autoCheckin: true });
  assert.equal((await st.getSettings()).autoCheckin, true);

  // 2. 自动签到:开关关闭 → 不触发;开启 → 逐个凭证签到
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    // 首个凭证成功 +100,其余报"已签到"
    const ok = calls.length === 1;
    return new Response(JSON.stringify(
      ok
        ? { code: 0, data: { credit: 100, streak_days: 2, is_streak_day: false } }
        : { code: 12150, msg: '今日已签到' },
    ), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await st.putSettings({ autoCheckin: false });
    await st.saveCredential({ id: 'a1', name: 'A', kind: 'ck_apikey', enabled: true, apiKey: 'ck1', createdAt: 1, updatedAt: 1 });
    const off = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(off.triggered, true);
    assert.equal(off.total, 0, '关闭时不执行');

    await st.putSettings({ autoCheckin: true });
    await st.saveCredential({ id: 'a2', name: 'B', kind: 'ck_apikey', enabled: true, apiKey: 'ck2', createdAt: 1, updatedAt: 1 });
    await st.saveCredential({ id: 'a3', name: '停用', kind: 'ck_apikey', enabled: false, apiKey: 'ck3', createdAt: 1, updatedAt: 1 });
    const report = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(report.total, 2, '仅统计启用凭证');
    assert.equal(report.ok, 1);
    assert.ok(calls.length >= 2);
  } finally { globalThis.fetch = originalFetch; }

  // 3. 管理 API:settings 读写 + 界面开关元素
  const { handleAdmin } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs'));
  const adminEnv = { ...baseEnv, ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'ss' };
  const login = await handleAdmin(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw' }),
  }), adminEnv, '/admin/login');
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { 'content-type': 'application/json', cookie: 'cb_admin=' + cookie, origin: 'https://w.example', 'X-Forwarded-For': nextIp() };

  const putRes = await handleAdmin(new Request('https://w.example/admin/api/settings', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ autoCheckin: false }),
  }), adminEnv, '/admin/api/settings');
  assert.equal(putRes.status, 200);

  const getRes = await handleAdmin(new Request('https://w.example/admin/api/settings', {
    method: 'GET', headers: auth,
  }), adminEnv, '/admin/api/settings');
  assert.equal((await getRes.json()).data.autoCheckin, false);

  // 4. 内容协商:浏览器访问 /v1/models、/health → HTML;API → JSON
  const browserHeaders = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'X-Forwarded-For': nextIp() };
  const modelsHtml = await callFetch(new Request('https://w.example/v1/models', { headers: browserHeaders }), baseEnv);
  assert.equal(modelsHtml.status, 200);
  assert.match(modelsHtml.headers.get('content-type'), /text\/html/);
  const modelsBody = await modelsHtml.text();
  assert.match(modelsBody, /模型目录/);
  assert.match(modelsBody, /glm-5\.3/);

  const healthHtml = await callFetch(new Request('https://w.example/health', { headers: browserHeaders }), baseEnv);
  assert.match(healthHtml.headers.get('content-type'), /text\/html/);
  assert.match(await healthHtml.text(), /网关运行正常/);

  const apiHeaders = { accept: 'application/json', 'X-Forwarded-For': nextIp() };
  const healthJson = await callFetch(new Request('https://w.example/health', { headers: apiHeaders }), baseEnv);
  assert.match(healthJson.headers.get('content-type'), /application\/json/);
  assert.equal((await healthJson.json()).status, 'ok');

  // 5. 控制台入口:未登录渲染登录页;已登录返回 SPA 入口(或未构建提示)
  const { handleAdmin: handleAdminConsole } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs'));
  const consoleEnv = { ...baseEnv, ADMIN_PASSWORD: 'pw-console', ADMIN_SESSION_SECRET: 'ss-console' };

  const anon = await handleAdminConsole(new Request('https://w.example/admin', {
    headers: { 'X-Forwarded-For': nextIp() },
  }), consoleEnv, '/admin');
  assert.equal(anon.status, 200);
  const anonHtml = await anon.text();
  assert.match(anonHtml, /login-form/, '未登录应返回登录页');
  assert.match(anonHtml, /type="password"/);

  const consoleLogin = await handleAdminConsole(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw-console' }),
  }), consoleEnv, '/admin/login');
  const consoleCookie = /cb_admin=([^;]+)/.exec(consoleLogin.headers.get('set-cookie'))[1];

  const consoleAuthed = await handleAdminConsole(new Request('https://w.example/admin', {
    headers: { cookie: 'cb_admin=' + consoleCookie, 'X-Forwarded-For': nextIp() },
  }), consoleEnv, '/admin');
  assert.equal(consoleAuthed.status, 200);
  const authedHtml = await consoleAuthed.text();
  assert.ok(
    authedHtml.includes('id="app"') || authedHtml.includes('控制台前端尚未构建'),
    '已登录应返回 SPA 入口或未构建提示',
  );

  // 目录穿越:不得读到产物目录之外的文件
  const traversalPath = '/admin/%2e%2e/package.json';
  const consoleTraversal = await handleAdminConsole(new Request('https://w.example' + traversalPath, {
    headers: { cookie: 'cb_admin=' + consoleCookie, 'X-Forwarded-For': nextIp() },
  }), consoleEnv, traversalPath);
  const traversalText = await consoleTraversal.text();
  assert.equal(traversalText.includes('codebuddy-gateway'), false, '目录穿越不得读取仓库文件');

  resetTokenStore();
  console.log('case10 settings & negotiation passed');
}
