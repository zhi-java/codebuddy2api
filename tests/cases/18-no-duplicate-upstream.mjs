// 用例 18:凭证故障转移不得在「上游已生成内容」后重放请求(否则同一条 prompt 重复扣积分)
//
// 背景:RETRYABLE_UPSTREAM_STATUSES 含 502/504,而网关自身的读取失败/空流兜底
// 也返回这两个码。若不加区分,一次已完成计费的非流式调用会被换凭证重发。
// 判定依据改为「网关自产失败」的内部标记(x-gateway-local-failure)。
{
  const dupEnv = {
    ...baseEnv,
    ADMIN_PASSWORD: 'pw-dup',
    ADMIN_SESSION_SECRET: 'session-dup',
    CREDENTIALS_ENC_SECRET: 'enc-dup',
  };
  const adminRequest = (path, init = {}, method = 'GET', extra = {}) => new Request(
    'https://w.example' + path,
    Object.assign({
      method,
      headers: Object.assign({ 'content-type': 'application/json', 'X-Forwarded-For': nextIp() }, extra),
    }, init),
  );
  const login = await callFetch(adminRequest('/admin/login', {
    body: JSON.stringify({ password: 'pw-dup' }),
  }, 'POST'), dupEnv);
  assert.equal(login.status, 200);
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { cookie: 'cb_admin=' + cookie, origin: 'https://w.example' };
  const createCred = async (name, apiKey) => {
    const res = await callFetch(adminRequest('/admin/api/credentials', {
      body: JSON.stringify({ name, kind: 'ck_apikey', apiKey }),
    }, 'POST', auth), dupEnv);
    assert.equal(res.status, 201);
    return (await res.json()).data.id;
  };
  const credA = await createCred('重复计费-甲', 'ck_dup_a');
  const credB = await createCred('重复计费-乙', 'ck_dup_b');
  const keyRes = await callFetch(adminRequest('/admin/api/keys', {
    body: JSON.stringify({ name: 'no-dup', credentialIds: [credA, credB] }),
  }, 'POST', auth), dupEnv);
  assert.equal(keyRes.status, 201);
  const gatewayKey = (await keyRes.json()).data.plaintext;

  // 非流式请求:网关会读完上游整条 SSE 再聚合 —— 读取完成即上游已计费。
  const chatRequest = () => new Request('https://w.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gatewayKey, 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ model: 'hy3', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });

  const originalFetch = globalThis.fetch;

  // A. 上游请求阶段抛出(连接中断/断流)→ 502,且绝不重放。
  //
  // 这条与「非流式读到一半失败」共用 handleChatCompletions 的同一个 catch 块
  // (catch → localFailureResponse),断言等价于覆盖读取中断路径。
  // 不在此处用 ReadableStream 模拟断流:同步 throw / controller.error() 在
  // 多层 async 包装下的错误传播会逃逸成 unhandledRejection 直接杀掉测试进程。
  // 真实断流行为由本文件 D 段(本地 HTTP 服务器)做端到端验证。
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error('socket hang up');
  };
  try {
    const res = await callFetch(chatRequest(), dupEnv);
    assert.equal(res.status, 502);
    assert.equal(attempts, 1, '网关侧异常后不得重放上游请求');
    assert.equal(res.headers.get('x-gateway-local-failure'), null, '内部标记不得泄漏给客户端');
  } finally { globalThis.fetch = originalFetch; }

  // B. 上游 200 但空流 → 兜底 502,同样不重放
  attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const res = await callFetch(chatRequest(), dupEnv);
    assert.equal(res.status, 502);
    assert.equal(attempts, 1, '空流兜底不得重放上游请求');
    assert.equal(res.headers.get('x-gateway-local-failure'), null);
  } finally { globalThis.fetch = originalFetch; }

  // C. 回归:上游真实返回 429(未生成内容)仍应故障转移到下一个凭证
  attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    const res = await callFetch(chatRequest(), dupEnv);
    assert.equal(res.status, 200);
    assert.equal(attempts, 2, '上游真实限流仍应切换到下一个凭证');
    assert.equal((await res.json()).choices[0].message.content, 'ok');
  } finally { globalThis.fetch = originalFetch; }

  // D. 端到端(不 mock fetch):真实 HTTP 上游写出部分 SSE 后断开连接。
  //    这是「上游已生成并计费、网关侧读取失败」的真实形态,必须 502 且只打上游一次。
  //    绑定两个凭证,修复前会打第二次(重复扣费),修复后恒为一次。
  //
  //    真实断流还会触发 undici 把 TypeError: terminated 抛到事件循环顶层,
  //    故这里装上与生产同源的进程兜底(installProcessGuards),否则测试进程直接被杀掉。
  const guardsMod = await import(
    pathToFileURL(process.cwd() + '/.tmp-test/process-guards.mjs').href
  );
  const uninstallGuards = guardsMod.installProcessGuards();
  const http = await import('node:http');
  let upstreamHits = 0;
  const server = http.createServer((req, res) => {
    upstreamHits++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"部分"},"finish_reason":null}]}\n\n');
      // 留一点时间让响应头与首个分片送达,再模拟上游断流
      setTimeout(() => res.socket.destroy(), 10);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const e2eEnv = {
    ...dupEnv,
    UPSTREAM_CHAT_COMPLETIONS_URL: `http://127.0.0.1:${server.address().port}/v2/chat/completions`,
    UPSTREAM_CONNECT_TIMEOUT_SECONDS: '5',
    UPSTREAM_TIMEOUT_SECONDS: '10',
  };
  try {
    const res = await callFetch(chatRequest(), e2eEnv);
    assert.equal(res.status, 502);
    assert.equal(upstreamHits, 1, '真实断流后不得重放上游请求(否则重复扣积分)');
    assert.equal(res.headers.get('x-gateway-local-failure'), null, '内部标记不得泄漏给客户端');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    // 让 socket 关闭引发的延迟错误先落地,再撤掉兜底
    await new Promise((resolve) => setTimeout(resolve, 100));
    uninstallGuards();
  }

  // E. 兜底判定:网络层噪音可忽略,业务缺陷仍必须让进程退出(不被吞掉)
  const { isRecoverableUpstreamError: isNoise } = guardsMod;
  assert.equal(
    isNoise(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })),
    true,
    'undici 断流错误应被识别为可恢复',
  );
  assert.equal(isNoise(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })), true);
  assert.equal(isNoise(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(
    isNoise(new TypeError("Cannot read properties of undefined (reading 'choices')")),
    false,
    '业务缺陷不得被进程兜底吞掉',
  );
  assert.equal(isNoise(new Error('Invalid API key')), false);
  assert.equal(isNoise(null), false);

  console.log('case18 no duplicate upstream passed');
}
