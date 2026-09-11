// 用例 08:可靠性(心跳/别名 e2e/试跑)
{
  const sseMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/sse.mjs'));
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  const { resetTokenStore, getTokenStore, hashApiKey } = storeMod;

  // 1. 心跳:静默流注入注释行
  const reads = [];
  const silent = new ReadableStream({ start() {} });
  const reader = silent.pipeThrough(sseMod.keepAliveTransform(15)).getReader();
  const started = Date.now();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    reads.push(new TextDecoder().decode(value));
    if (Date.now() - started > 80) break;
  }
  reader.cancel();
  assert.ok(reads.some((r) => r.includes(': keep-alive')));

  // 2. Key 级别名 e2e(网关 key → 上游收到重写 model)
  const kvData = new Map();
  const kv = {
    async get(k) { return kvData.has(k) ? kvData.get(k) : null; },
    async put(k, v) { kvData.set(k, v); },
    async delete(k) { kvData.delete(k); },
  };
  resetTokenStore();
  const st = getTokenStore({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
  await st.saveCredential({
    id: 't1', name: '主上游', kind: 'ck_apikey', enabled: true,
    apiKey: 'ck_up_primary', createdAt: 1, updatedAt: 1,
  });
  await st.saveCredential({
    id: 't2', name: '备用上游', kind: 'ck_apikey', enabled: true,
    apiKey: 'ck_up_backup', createdAt: 1, updatedAt: 1,
  });
  const plain = 'sk-cb-alias-e2e';
  await st.saveKey({
    id: 'kt', name: 'KT', keyHash: await hashApiKey(plain),
    credentialIds: ['t1', 't2'], enabled: true, createdAt: 1,
    modelAliases: { 'glm-5.2': 'hy4-preview' },
  });
  const aliasEnv = { ...baseEnv, CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' };

  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  const upstreamAuth = [];
  let failoverCalls = 0;
  globalThis.fetch = async (_u, init) => {
    upstreamBodies.push(JSON.parse(init.body));
    upstreamAuth.push(new Headers(init.headers).get('authorization'));
    failoverCalls += 1;
    if (failoverCalls === 1) return new Response('', { status: 503 });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + plain, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'glm-5.2[1m]', messages: [{ role: 'user', content: 'hi' }] }),
    }), aliasEnv);
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(failoverCalls, 2, '首个上游 503 后应自动切换到备用凭证');
    assert.deepEqual(upstreamAuth, ['Bearer ck_up_primary', 'Bearer ck_up_backup']);
    assert.equal(upstreamBodies[1].model, 'hy4-preview');
  } finally { globalThis.fetch = originalFetch; }

  // 3. 管理侧 Chat 试跑:凭证经管理 API 创建(admin.mjs 独立 store 单例)
  const { handleAdmin } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs'));
  const adminEnv = { ...baseEnv, ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'ss' };
  const login = await handleAdmin(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw' }),
  }), adminEnv, '/admin/login');
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const authHeaders = (extra) => Object.assign({
    'content-type': 'application/json', cookie: 'cb_admin=' + cookie,
    origin: 'https://w.example', 'X-Forwarded-For': nextIp(),
  }, extra || {});

  const created = await handleAdmin(new Request('https://w.example/admin/api/credentials', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ name: '试跑', kind: 'cli_oauth', accessToken: 'jwt', userId: 'u', refreshExpiresAt: Date.now() + 86400000, expiresAt: Date.now() + 86400000 }),
  }), adminEnv, '/admin/api/credentials');
  assert.equal(created.status, 201);
  const credId = (await created.json()).data.id;

  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":"思考"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"结果"},"finish_reason":"stop"}]}',
    'data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}',
    'data: [DONE]', '',
  ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const r = await handleAdmin(new Request('https://w.example/admin/api/chat-test', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ credentialId: credId, model: 'hy3', message: 'x' }),
    }), adminEnv, '/admin/api/chat-test');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.content, '结果');
    assert.equal(body.reasoning, '思考');
  } finally { globalThis.fetch = originalFetch; }

  // 4. 计费解析(独立模块)
  const billMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/upstream-billing.mjs'));
  // 多资源包:额度应为全包汇总
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0, data: { Response: { Data: { Accounts: [
      { PackageName: '订阅包', CapacitySize: 500, CapacityRemain: 300, CapacityUsed: 200,
        CycleStartTime: 's', CycleEndTime: 'e', ResourceId: 'r1' },
      { PackageName: '奖励包', CapacitySize: 200, CapacityRemain: 150, CapacityUsed: 50 },
    ] } } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const q = await billMod.fetchCredentialQuota({
      id: 'b1', name: 'B', kind: 'ck_apikey', enabled: true, apiKey: 'ck',
      createdAt: 1, updatedAt: 1,
    }, {});
    assert.equal(q.total, 700, '汇总总量');
    assert.equal(q.remaining, 450, '汇总剩余');
    assert.equal(q.used, 250, '汇总已用');
    assert.equal(q.percent, Math.round(450 / 700 * 100));
    assert.equal(q.packageName, '订阅包 + 奖励包');
  } finally { globalThis.fetch = originalFetch; }

  resetTokenStore();
  console.log('case08 reliability passed');
}
