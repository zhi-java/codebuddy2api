// 用例 17:管理端新增能力(运行配置 / 日志过滤 / 流式试跑)
{
  const { resetTokenStore, getTokenStore } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs')
  );
  const { handleAdmin } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs'));
  const logsMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/logs.mjs'));
  logsMod.resetLogs();
  resetTokenStore();

  const adminEnv = {
    ...baseEnv,
    ADMIN_PASSWORD: 'pw-ext',
    ADMIN_SESSION_SECRET: 'sess-ext',
    CREDENTIALS_ENC_SECRET: 'enc-ext',
    EMIT_THINKING: 'thinking',
    RATE_LIMIT_PER_MINUTE: '120',
    RATE_LIMIT_BURST: '30',
    UPSTREAM_TIMEOUT_SECONDS: '300',
    UPSTREAM_CONNECT_TIMEOUT_SECONDS: '15',
  };

  const login = await handleAdmin(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw-ext' }),
  }), adminEnv, '/admin/login');
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { cookie: 'cb_admin=' + cookie, origin: 'https://w.example', 'X-Forwarded-For': nextIp() };

  // 1. 运行配置:只读、不含密钥
  const configRes = await handleAdmin(new Request('https://w.example/admin/api/config', { headers: auth }), adminEnv, '/admin/api/config');
  assert.equal(configRes.status, 200);
  const config = (await configRes.json()).data;
  assert.equal(config.thinkingMode, 'thinking');
  assert.equal(config.rateLimit.perMinute, 120);
  assert.equal(config.rateLimit.burst, 30);
  assert.equal(config.timeout.totalSeconds, 300);
  assert.equal(config.timeout.connectSeconds, 15);
  assert.equal(config.checkinSchedule, 'UTC 03:17');
  assert.match(config.upstream.chat, /^https:\/\//);
  const serialized = JSON.stringify(config);
  for (const leaked of ['pw-ext', 'sess-ext', 'enc-ext', 'ADMIN_PASSWORD']) {
    assert.equal(serialized.includes(leaked), false, '配置接口不得泄漏密钥');
  }

  // 2. 日志过滤:级别 / 关键词 / 上限
  logsMod.pushLog('info', 'auto_checkin', '自动签到完成', { ok: 2 });
  logsMod.pushLog('warn', 'credential_failover', '凭证 c1 返回 429，切换到下一个', { credentialId: 'c1' });
  logsMod.pushLog('error', 'upstream_failure', '上游 500', { status: 500 });

  const levelRes = await handleAdmin(new Request('https://w.example/admin/api/logs?level=warn', { headers: auth }), adminEnv, '/admin/api/logs');
  const levelLogs = (await levelRes.json()).data;
  assert.equal(levelLogs.length, 1);
  assert.equal(levelLogs[0].event, 'credential_failover');

  const queryRes = await handleAdmin(new Request('https://w.example/admin/api/logs?q=c1', { headers: auth }), adminEnv, '/admin/api/logs');
  const queryLogs = (await queryRes.json()).data;
  assert.equal(queryLogs.length, 1);
  assert.equal(queryLogs[0].event, 'credential_failover');

  const limitRes = await handleAdmin(new Request('https://w.example/admin/api/logs?limit=1', { headers: auth }), adminEnv, '/admin/api/logs');
  assert.equal((await limitRes.json()).data.length, 1);

  // 3. 流式试跑:逐事件转发思考与正文
  // 注:admin.mjs 持有独立 store 单例,凭证必须经管理 API 创建才能被它读到
  const createdRes = await handleAdmin(new Request('https://w.example/admin/api/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth, origin: 'https://w.example' },
    body: JSON.stringify({ name: '流式', kind: 'ck_apikey', apiKey: 'ck_stream' }),
  }), adminEnv, '/admin/api/credentials');
  assert.equal(createdRes.status, 201);
  const streamCredId = (await createdRes.json()).data.id;

  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  globalThis.fetch = async (_url, init) => {
    upstreamBody = JSON.parse(init.body);
    const sse = [
      'data: {"model":"hy4-preview","choices":[{"index":0,"delta":{"reasoning_content":"想一想"},"finish_reason":null}]}',
      'data: {"model":"hy4-preview","choices":[{"index":0,"delta":{"content":"答案是"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"42"},"finish_reason":"stop"}]}',
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const streamRes = await handleAdmin(new Request('https://w.example/admin/api/chat-test/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth, origin: 'https://w.example' },
      body: JSON.stringify({
        credentialId: streamCredId, model: 'hy4-preview', message: '6*7?',
        temperature: 0.5, maxTokens: 256,
      }),
    }), adminEnv, '/admin/api/chat-test/stream');
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type'), /text\/event-stream/);

    const text = await streamRes.text();
    assert.match(text, /"type":"reasoning","delta":"想一想"/);
    assert.match(text, /"type":"content","delta":"答案是"/);
    assert.match(text, /"type":"content","delta":"42"/);
    assert.match(text, /"type":"usage"/);
    assert.match(text, /"type":"done","model":"hy4-preview","finishReason":"stop"/);
    // 参数确实透传到上游
    assert.equal(upstreamBody.temperature, 0.5);
    assert.equal(upstreamBody.max_tokens, 256);
    assert.equal(upstreamBody.stream, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  logsMod.resetLogs();
  resetTokenStore();
  console.log('case17 admin extensions passed');
}
