// 用例 07:三协议端点端到端(路由/鉴权头/别名/空流/落地页)
{
  const UP_SERIES = [
    'data: {"model":"hy4-preview"}',
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_u, init) => {
    captured = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return new Response(UP_SERIES, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  // 1. Anthropic 端点:x-api-key → 流式 Anthropic 事件
  try {
    const res = await callFetch(new Request('https://w.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ck_ant', 'anthropic-version': '2023-06-01', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', max_tokens: 10, system: '系统', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }), baseEnv);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: message_stop/);
    // x-api-key 转为上游凭证,管理头不外泄
    assert.equal(captured.headers.get('authorization'), 'Bearer ck_ant');
    assert.equal(captured.headers.get('x-api-key'), null);
    assert.equal(captured.body.messages[0].content, '系统');
  } finally { globalThis.fetch = originalFetch; }

  // 2. Anthropic 非流式 → message 对象
  globalThis.fetch = async () => new Response(UP_SERIES, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const res = await callFetch(new Request('https://w.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ck_ant', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    const body = await res.json();
    assert.equal(body.type, 'message');
    assert.equal(body.content[0].text, '你好');
  } finally { globalThis.fetch = originalFetch; }

  // 3. Anthropic thinking 策略:默认输出独立 thinking block,绝不混入正文
  const THINKING_SERIES = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"内部思考"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"最终答案"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  globalThis.fetch = async () => new Response(THINKING_SERIES, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    // 默认(auto):思考以 thinking block 下发,正文不含推理内容
    const defaulted = await callFetch(new Request('https://w.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ck_ant', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }), baseEnv);
    const defaultText = await defaulted.text();
    assert.match(defaultText, /thinking_delta/);
    assert.match(defaultText, /内部思考/);
    assert.equal(/"type":"text_delta","text":"[^"]*内部思考/.test(defaultText), false, '思考不得混入 text_delta');

    const withThinking = await callFetch(new Request('https://w.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ck_ant', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', max_tokens: 10, thinking: { type: 'enabled' }, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }), baseEnv);
    const withThinkingText = await withThinking.text();
    assert.match(withThinkingText, /thinking_delta/);
    assert.match(withThinkingText, /内部思考/);

    // EMIT_THINKING=off:彻底剥离思考
    const off = await callFetch(new Request('https://w.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ck_ant', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }), { ...baseEnv, EMIT_THINKING: 'off' });
    const offText = await off.text();
    assert.equal(offText.includes('内部思考'), false);
    assert.match(offText, /最终答案/);
  } finally { globalThis.fetch = originalFetch; }

  // 4. Responses 端点(Authorization)→ 聚合 response
  globalThis.fetch = async () => new Response(UP_SERIES, { status: 200, headers: { 'content-type': 'text/event-stream' } });  try {
    const res = await callFetch(new Request('https://w.example/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_rsp', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', input: '你好' }),
    }), baseEnv);
    const body = await res.json();
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.equal(body.output[0].content[0].text, '你好');
  } finally { globalThis.fetch = originalFetch; }

  // 4b. Responses 端点默认下发 reasoning summary(emitReasoning 接线)
  const RSP_REASONING = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"推理中"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"答案"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  globalThis.fetch = async () => new Response(RSP_REASONING, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const streamed = await callFetch(new Request('https://w.example/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_rsp', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', input: '你好', stream: true }),
    }), baseEnv);
    const streamedText = await streamed.text();
    assert.match(streamedText, /response\.reasoning_summary_text\.delta/);
    assert.match(streamedText, /推理中/);
    assert.match(streamedText, /response\.output_text\.delta/);

    const aggregated = await callFetch(new Request('https://w.example/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_rsp', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', input: '你好' }),
    }), baseEnv);
    const aggregatedBody = await aggregated.json();
    assert.equal(aggregatedBody.output[0].type, 'reasoning');
    assert.equal(aggregatedBody.output[1].content[0].text, '答案');
  } finally { globalThis.fetch = originalFetch; }

  // 5. 无凭证 → 401
  globalThis.fetch = originalFetch;
  const noAuth = await callFetch(new Request('https://w.example/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ model: 'hy3', max_tokens: 5, messages: [] }),
  }), baseEnv);
  assert.equal(noAuth.status, 401);

  // 5. 落地页与健康检查
  const root = await callFetch(new Request('https://w.example/', {
    headers: { 'X-Forwarded-For': nextIp() },
  }), baseEnv);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.match(await root.text(), /CodeBuddy Gateway/);

  const health = await callFetch(new Request('https://w.example/health', {
    headers: { 'X-Forwarded-For': nextIp() },
  }), baseEnv);
  assert.equal((await health.json()).status, 'ok');

  // 6. DeepSeek Harness:GET /models(无 /v1)回退快照 JSON
  globalThis.fetch = async () => new Response('fail', { status: 500 });
  try {
    const res = await callFetch(new Request('https://w.example/models', {
      headers: { authorization: 'Bearer ck_x', accept: 'application/json', 'X-Forwarded-For': nextIp() },
    }), baseEnv);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data) && body.data.length > 0);
  } finally { globalThis.fetch = originalFetch; }

  console.log('case07 endpoints passed');
}
