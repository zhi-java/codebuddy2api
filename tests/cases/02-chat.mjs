// 用例 02:chat 端点(透传 / 非流式聚合 / 空流兜底 / 心跳挂载)
{
  const originalFetch = globalThis.fetch;
  const CHUNK_A = 'data: {"id":"chatcmpl-1","model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}';
  const CHUNK_B = 'data: {"id":"chatcmpl-1","model":"glm-5.2","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}';

  // 1. 流式透传:保留 text/event-stream,含 [DONE]
  globalThis.fetch = async () =>
    new Response([CHUNK_A, '', CHUNK_B, '', 'data: [DONE]', ''].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /data: \{"id":"chatcmpl-1"/);
    assert.match(text, /data: \[DONE\]/);
  } finally { globalThis.fetch = originalFetch; }

  // 2. 非流式聚合:组装 chat.completion,usage 保留
  globalThis.fetch = async () =>
    new Response([CHUNK_A, '', CHUNK_B, '', 'data: [DONE]', ''].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Hello world');
    assert.equal(body.usage.total_tokens, 3);
  } finally { globalThis.fetch = originalFetch; }

  // 3. 空流兜底:200 无事件 → 502
  globalThis.fetch = async () =>
    new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    assert.equal(res.status, 502);
  } finally { globalThis.fetch = originalFetch; }

  // 4. 上游错误透传
  globalThis.fetch = async () => new Response('{"error":"up" }', { status: 502 });
  try {
    const res = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    assert.equal(res.status, 502);
  } finally { globalThis.fetch = originalFetch; }

  // 5. DeepSeek Harness:无 /v1 前缀 + 尾斜杠 + OpenAI 扩展字段清洗
  let captured = null;
  globalThis.fetch = async (_u, init) => {
    captured = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return new Response([CHUNK_A, '', CHUNK_B, '', 'data: [DONE]', ''].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const res = await callFetch(new Request('https://w.example/chat/completions/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ck_x',
        'user-agent': 'deepseek-harness/0.1.2 (+https://github.com/deepseek-ai/deepseek-harness)',
        'x-stainless-lang': 'js',
        'x-stainless-package-version': '6.40.0',
        'x-openai-client': 'openai-node',
        'x-title': 'DeepSeek Harness',
        'http-referer': 'http://127.0.0.1:43120/',
        origin: 'http://127.0.0.1:43120',
        referer: 'http://127.0.0.1:43120/',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        stream: true,
        messages: [{ role: 'developer', content: '你是助手' }, { role: 'user', content: 'hi' }],
        max_completion_tokens: 1_000_000,
        enable_thinking: true,
        thinking_mode: 'enabled',
        stream_options: { include_usage: true },
        extra_body: { foo: 1 },
        reasoning: { effort: 'high' },
      }),
    }), baseEnv);
    assert.equal(res.status, 200);
    assert.equal(captured.headers.get('user-agent'), 'CLI/2.107.0 CodeBuddy/2.107.0');
    assert.equal(captured.headers.get('x-ide-type'), 'CLI');
    // 客户端身份指纹一律不得泄漏到上游(否则上游判定未授权渠道)
    for (const leaked of [
      'x-stainless-lang', 'x-stainless-package-version', 'x-openai-client',
      'x-title', 'http-referer', 'origin', 'referer',
    ]) {
      assert.equal(captured.headers.get(leaked), null, '不应转发客户端头: ' + leaked);
    }
    assert.equal(captured.body.max_tokens, 32768);
    // developer 角色必须归一化为 system(上游拒绝 developer,返回 400 未授权渠道)
    assert.equal(captured.body.messages[0].role, 'system');
    assert.equal(captured.body.messages[1].role, 'user');
    assert.equal(captured.body.max_completion_tokens, undefined);
    assert.equal(captured.body.enable_thinking, undefined);
    assert.equal(captured.body.thinking_mode, undefined);
    assert.equal(captured.body.stream_options, undefined);
    assert.equal(captured.body.extra_body, undefined);
    assert.equal(captured.body.reasoning, undefined);
    // 思考档位映射到上游字段(deepseek-v4-pro 需要显式 reasoning_effort 才会吐 reasoning)
    assert.equal(captured.body.reasoning_effort, 'high');
    assert.equal(captured.body.stream, true);
  } finally { globalThis.fetch = originalFetch; }

  // 6. 思考默认下发(独立 reasoning_content 字段),EMIT_THINKING=off 才剥离
  const REASONING_SERIES = [
    'data: {"id":"chat-r","model":"hy4-preview","choices":[{"index":0,"delta":{"reasoning_content":"内部思考"},"finish_reason":null}]}',
    'data: {"id":"chat-r","model":"hy4-preview","choices":[{"index":0,"delta":{"content":"最终答案"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  globalThis.fetch = async () => new Response(REASONING_SERIES, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  try {
    const defaulted = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    const defaultText = await defaulted.text();
    // 思考走独立字段,客户端可自行渲染;正文仍是纯答案
    assert.match(defaultText, /"reasoning_content":"内部思考"/);
    assert.match(defaultText, /最终答案/);
    assert.equal(/"content":"[^"]*内部思考/.test(defaultText), false, '思考不得混入 content');

    const stripped = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ck_x', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy4-preview', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }), { ...baseEnv, EMIT_THINKING: 'off' });
    const strippedText = await stripped.text();
    assert.equal(strippedText.includes('内部思考'), false);
    assert.match(strippedText, /最终答案/);
  } finally { globalThis.fetch = originalFetch; }

  console.log('case02 chat passed');
}
