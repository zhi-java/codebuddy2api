// 用例 05:管理鉴权与 API(登录/CSRF/CRUD/计费路由)
{
  const { handleAdmin, isAdminEnabled } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs')
  );
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  const { resetTokenStore, getTokenStore, hashApiKey } = storeMod;

  // 注:admin.mjs 持有独立 store 单例,以下全程使用管理 API 自身读写
  resetTokenStore();
  const adminEnv = {
    ...baseEnv,
    ADMIN_PASSWORD: 'pw-123',
    ADMIN_SESSION_SECRET: 'sess-secret',
  };
  const noAdminEnv = { ...baseEnv };
  assert.equal(isAdminEnabled(noAdminEnv), false);
  assert.equal((await handleAdmin(new Request('https://w.example/admin'), noAdminEnv, '/admin')).status, 404);

  const adminReq = (path, init, method, extra) =>
    new Request('https://w.example' + path, Object.assign({
      method: method || 'GET',
      headers: Object.assign({
        'content-type': 'application/json',
        'X-Forwarded-For': nextIp(),
      }, extra || {}),
    }, init || {}));

  // 未登录 → 登录页
  const page = await handleAdmin(adminReq('/admin'), adminEnv, '/admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CodeBuddy Gateway/);

  // 未登录 API → 401
  assert.equal((await handleAdmin(adminReq('/admin/api/state'), adminEnv, '/admin/api/state')).status, 401);

  // 错误密码 → 401;正确 → cookie
  const bad = await handleAdmin(adminReq('/admin/login', {
    body: JSON.stringify({ password: 'nope' }),
  }, 'POST'), adminEnv, '/admin/login');
  assert.equal(bad.status, 401);

  const login = await handleAdmin(adminReq('/admin/login', {
    body: JSON.stringify({ password: 'pw-123' }),
  }, 'POST'), adminEnv, '/admin/login');
  assert.equal(login.status, 200);
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { cookie: 'cb_admin=' + cookie, origin: 'https://w.example', 'X-Forwarded-For': nextIp() };

  // ── Secure 属性按协议条件化 ──
  // 浏览器只在 HTTPS(或可信源 localhost)下保存 Secure cookie。通过明文 HTTP 访问
  // 内网地址时若仍带 Secure,cookie 被静默丢弃 → 「密码正确却登录不上」。
  {
    // HTTPS 源 → 必须带 Secure
    assert.match(
      login.headers.get('set-cookie'), /;\s*Secure/,
      'HTTPS 登录的会话 cookie 须带 Secure',
    );

    // 明文 HTTP 源 → 不得带 Secure(否则 cookie 存不下)
    const httpLogin = await handleAdmin(new Request('http://192.168.1.246:8787/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ password: 'pw-123' }),
    }), adminEnv, '/admin/login');
    assert.equal(httpLogin.status, 200);
    const httpCookie = httpLogin.headers.get('set-cookie');
    assert.doesNotMatch(httpCookie, /;\s*Secure/, '明文 HTTP 登录的 cookie 不得带 Secure');
    assert.match(httpCookie, /HttpOnly/, 'HttpOnly 与协议无关,必须保留');
    assert.match(httpCookie, /SameSite=Lax/, 'SameSite 与协议无关,必须保留');

    // 反向代理终结 TLS:按 X-Forwarded-Proto 判定
    const proxied = await handleAdmin(new Request('http://gw.internal/admin/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ password: 'pw-123' }),
    }), adminEnv, '/admin/login');
    assert.match(proxied.headers.get('set-cookie'), /;\s*Secure/, '反代标记 https 时须带 Secure');

    // 显式开关优先于自动判断
    const forcedOff = await handleAdmin(new Request('https://w.example/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ password: 'pw-123' }),
    }), { ...adminEnv, ADMIN_COOKIE_SECURE: 'false' }, '/admin/login');
    assert.doesNotMatch(forcedOff.headers.get('set-cookie'), /;\s*Secure/, 'ADMIN_COOKIE_SECURE=false 须强制关闭');

    const forcedOn = await handleAdmin(new Request('http://192.168.1.246:8787/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ password: 'pw-123' }),
    }), { ...adminEnv, ADMIN_COOKIE_SECURE: 'true' }, '/admin/login');
    assert.match(forcedOn.headers.get('set-cookie'), /;\s*Secure/, 'ADMIN_COOKIE_SECURE=true 须强制开启');

    // 登出清除 cookie 同样遵循协议(否则 HTTP 下登出无效)
    const logout = await handleAdmin(new Request('http://192.168.1.246:8787/admin/logout', {
      method: 'POST',
      headers: { 'X-Forwarded-For': nextIp() },
    }), adminEnv, '/admin/logout');
    const logoutCookie = logout.headers.get('set-cookie');
    assert.doesNotMatch(logoutCookie, /;\s*Secure/, '明文 HTTP 登出 cookie 不得带 Secure');
    assert.match(logoutCookie, /Max-Age=0/, '登出须清空 cookie');
  }

  // 已登录:创建凭证 → 创建 Key → 状态
  const created = await handleAdmin(adminReq('/admin/api/credentials', {
    body: JSON.stringify({ name: '主账号', kind: 'ck_apikey', apiKey: 'ck_sec' }),
  }, 'POST', auth), adminEnv, '/admin/api/credentials');
  assert.equal(created.status, 201);
  const cred = await created.json();
  assert.equal(cred.data.name, '主账号');
  assert.equal(cred.data.hasApiKey, true);
  assert.equal(cred.data.apiKey, undefined);

  const keyRes = await handleAdmin(adminReq('/admin/api/keys', {
    body: JSON.stringify({ name: 'Claude', credentialIds: [cred.data.id] }),
  }, 'POST', auth), adminEnv, '/admin/api/keys');
  assert.equal(keyRes.status, 201);
  const key = await keyRes.json();
  assert.match(key.data.plaintext, /^sk-cb-/);
  assert.equal(key.data.keyHash, undefined);

  const state = await (await handleAdmin(adminReq('/admin/api/state', null, 'GET', auth), adminEnv, '/admin/api/state')).json();
  assert.equal(state.counts.credentials, 1);
  assert.equal(state.counts.keys, 1);

  // 跨站写 → 403
  const csrf = await handleAdmin(adminReq('/admin/api/credentials', {
    body: JSON.stringify({ name: 'x', kind: 'ck_apikey', apiKey: 'y' }),
  }, 'POST', { cookie: 'cb_admin=' + cookie, origin: 'https://evil.example', 'X-Forwarded-For': nextIp() }), adminEnv, '/admin/api/credentials');
  assert.equal(csrf.status, 403);

  // 启停:凭证/Key 双向切换并回读
  const offCred = await handleAdmin(adminReq('/admin/api/credentials/' + cred.data.id, {
    body: JSON.stringify({ enabled: false }),
  }, 'PUT', auth), adminEnv, '/admin/api/credentials/' + cred.data.id);
  assert.equal((await offCred.json()).data.enabled, false);
  const listOff = await (await handleAdmin(adminReq('/admin/api/credentials', null, 'GET', auth), adminEnv, '/admin/api/credentials')).json();
  assert.equal(listOff.data.find((x) => x.id === cred.data.id).status, 'disabled');

  const onCred = await handleAdmin(adminReq('/admin/api/credentials/' + cred.data.id, {
    body: JSON.stringify({ enabled: true }),
  }, 'PUT', auth), adminEnv, '/admin/api/credentials/' + cred.data.id);
  assert.equal((await onCred.json()).data.enabled, true);

  const offKey = await handleAdmin(adminReq('/admin/api/keys/' + key.data.id, {
    body: JSON.stringify({ enabled: false }),
  }, 'PUT', auth), adminEnv, '/admin/api/keys/' + key.data.id);
  assert.equal((await offKey.json()).data.enabled, false);

  // 模型别名保存与回显
  const aliasPut = await handleAdmin(adminReq('/admin/api/keys/' + key.data.id, {
    body: JSON.stringify({ modelAliases: { 'glm-5.2': 'hy4-preview' } }),
  }, 'PUT', auth), adminEnv, '/admin/api/keys/' + key.data.id);
  assert.equal(aliasPut.status, 200);
  assert.equal((await aliasPut.json()).data.modelAliases['glm-5.2'], 'hy4-preview');

  // 计费路由:quota(需授权上游调用,mock fetch)
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0, data: { Response: { Data: { Accounts: [{
      PackageName: '体验版', CapacitySize: 500, CapacityRemain: 300,
      CycleStartTime: '2026-09-01 00:00:00', CycleEndTime: '2026-09-30 00:00:00',
    }] } } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const quotaRes = await handleAdmin(
      adminReq('/admin/api/credentials/' + cred.data.id + '/quota', null, 'GET', auth),
      adminEnv,
      '/admin/api/credentials/' + cred.data.id + '/quota',
    );
    assert.equal(quotaRes.status, 200);
    assert.equal((await quotaRes.json()).data.remaining, 300);
  } finally { globalThis.fetch = originalFetch; }

  // chat-test 未授权上游为空流 → 502(路由存在性)
  globalThis.fetch = async () => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const ct = await handleAdmin(
      adminReq('/admin/api/chat-test', {
        body: JSON.stringify({ credentialId: cred.data.id, model: 'hy3', message: 'hi' }),
      }, 'POST', auth),
      adminEnv,
      '/admin/api/chat-test',
    );
    assert.equal(ct.status, 200);
    assert.equal((await ct.json()).content, '');
  } finally { globalThis.fetch = originalFetch; }

  console.log('case05 admin passed');
}
