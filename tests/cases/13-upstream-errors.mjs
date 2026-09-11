// 用例 13:上游错误透传可诊断化(空 body 回填 JSON;有 body 原样保留)
{
  const originalFetch = globalThis.fetch;

  // 1. chat 非流式:上游 400 空 body → 网关回填可读 JSON(而非 400 no body)
  globalThis.fetch = async () =>
    new Response('', { status: 400, headers: { 'content-type': 'text/plain' } });
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.type, 'upstream_error');
    assert.equal(body.error.status, 400);
    assert.match(body.error.message, /max_tokens|字段|窗口|上游拒绝/);
  } finally { globalThis.fetch = originalFetch; }

  // 2. Anthropic 流式请求上游错误:同样回填
  globalThis.fetch = async () =>
    new Response('', { status: 400 });
  try {
    const res = await callFetch(new Request('https://w.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'upstream_http_400');
  } finally { globalThis.fetch = originalFetch; }

  // 3. 上游带 body 的错误:原样透传(不吞内容)
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'real upstream msg', code: 'CONTEXT_WINDOW_EXCEEDED' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    assert.equal(res.status, 400);
    const raw = await res.json();
    assert.equal(raw.error.message, 'real upstream msg');
    assert.equal(raw.error.code, 'CONTEXT_WINDOW_EXCEEDED');
  } finally { globalThis.fetch = originalFetch; }

  // 4. 托管多 Key:上游 400 空 body → 自动切换到下一个凭证
  // 通过 worker 自己的管理路由写入数据,避免测试模块与 worker 各自持有
  // 一份 bundled store 单例而导致假阳性 401。
  const failoverEnv = {
    ...baseEnv,
    ADMIN_PASSWORD: 'pw-failover',
    ADMIN_SESSION_SECRET: 'session-failover',
    CREDENTIALS_ENC_SECRET: 'enc-failover',
  };
  const adminRequest = (path, init = {}, method = 'GET', extra = {}) => new Request(
    'https://w.example' + path,
    Object.assign({
      method,
      headers: Object.assign({ 'content-type': 'application/json', 'X-Forwarded-For': nextIp() }, extra),
    }, init),
  );
  const login = await callFetch(adminRequest('/admin/login', {
    body: JSON.stringify({ password: 'pw-failover' }),
  }, 'POST'), failoverEnv);
  assert.equal(login.status, 200);
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { cookie: 'cb_admin=' + cookie, origin: 'https://w.example' };
  const createCred = async (name, apiKey) => {
    const res = await callFetch(adminRequest('/admin/api/credentials', {
      body: JSON.stringify({ name, kind: 'ck_apikey', apiKey }),
    }, 'POST', auth), failoverEnv);
    assert.equal(res.status, 201);
    return (await res.json()).data.id;
  };
  const badId = await createCred('坏凭证', 'ck_bad');
  const goodId = await createCred('好凭证', 'ck_good');
  const keyRes = await callFetch(adminRequest('/admin/api/keys', {
    body: JSON.stringify({ name: 'failover', credentialIds: [badId, goodId] }),
  }, 'POST', auth), failoverEnv);
  assert.equal(keyRes.status, 201);
  const gatewayKey = (await keyRes.json()).data.plaintext;
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    attempts++;
    if (attempts === 1) return new Response('', { status: 400 });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gatewayKey, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }), failoverEnv);
    assert.equal(res.status, 200);
    assert.equal(attempts, 2);
    assert.equal(res.headers.get('x-gateway-empty-upstream'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('case13 upstream errors passed');
}
