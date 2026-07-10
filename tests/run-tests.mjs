import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outDir = '.tmp-test';

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await Promise.all([
  build({
    entryPoints: ['src/utils.ts'],
    outfile: `${outDir}/utils.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
  }),
  build({
    entryPoints: ['src/index.ts'],
    outfile: `${outDir}/index.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
  }),
  build({
    entryPoints: ['src/models.ts'],
    outfile: `${outDir}/models.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
  }),
  build({
    entryPoints: ['src/observability.ts'],
    outfile: `${outDir}/observability.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
  }),
  build({
    entryPoints: ['src/rate-limiter.ts'],
    outfile: `${outDir}/rate-limiter.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
  }),
]);

const { normalizeModelId, rewritePayload } = await import(pathToFileURL(`${process.cwd()}/${outDir}/utils.mjs`));
const { buildCorsHeaders, buildUpstreamUrl, default: worker } = await import(pathToFileURL(`${process.cwd()}/${outDir}/index.mjs`));
const { getModelById } = await import(pathToFileURL(`${process.cwd()}/${outDir}/models.mjs`));
const { redactApiKey, extractUserInput, extractAssistantOutput } = await import(pathToFileURL(`${process.cwd()}/${outDir}/observability.mjs`));

const baseEnv = {
  UPSTREAM_CHAT_COMPLETIONS_URL: 'https://copilot.tencent.com/v2/chat/completions',
  UPSTREAM_TIMEOUT_SECONDS: '600',
  UPSTREAM_CONNECT_TIMEOUT_SECONDS: '30',
  CORS_ALLOW_ORIGINS: '*',
  CORS_ALLOW_CREDENTIALS: 'false',
  DEBUG: 'false',
};

{
  const payload = {
    messages: [
      {
        role: 'system',
        content: "You are Claude Code, Anthropic's official CLI for Claude. Use the main branch (you will usually use this for prs).",
      },
      {
        role: 'user',
        content: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ],
  };

  rewritePayload(payload);

  assert.equal(
    payload.messages[0].content,
    "You are CodeBuddy, Tencent's official CLI. Use the main branch (you will usually use this for pr).",
  );
  assert.equal(
    payload.messages[1].content,
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
}

{
  const payload = {
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: "YOU ARE CLAUDE CODE, ANTHROPIC'S OFFICIAL CLI FOR CLAUDE.",
          },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image.png' },
          },
        ],
      },
    ],
  };

  rewritePayload(payload);

  assert.equal(
    payload.messages[0].content[0].text,
    "You are CodeBuddy, Tencent's official CLI.",
  );
  assert.equal(payload.messages[0].content[1].image_url.url, 'https://example.com/image.png');
}

{
  const payload = {
    messages: [
      {
        role: 'developer',
        content: "You are Claude Code, Anthropic’s official CLI for Claude\nmain branch (you will usually use this for prs)",
      },
    ],
  };

  rewritePayload(payload);

  assert.equal(
    payload.messages[0].content,
    "You are CodeBuddy, Tencent's official CLI.\nmain branch (you will usually use this for pr)",
  );
}

{
  const payload = {
    messages: [
      {
        role: 'system',
        content: 'You   are   Claude Code,   Anthropic\'s official CLI for Claude.',
      },
    ],
  };

  rewritePayload(payload);

  assert.equal(payload.messages[0].content, "You are CodeBuddy, Tencent's official CLI.");
}

{
  assert.equal(normalizeModelId('glm-5.2[1m]'), 'glm-5.2');
  assert.equal(normalizeModelId(' deepseek-v4-pro [1m] '), 'deepseek-v4-pro');
  assert.equal(normalizeModelId('hy3'), 'hy3');
}

{
  const payload = {
    model: 'glm-5.2[1m]',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  };

  rewritePayload(payload);

  assert.equal(payload.model, 'glm-5.2');
}

{
  assert.equal(getModelById('glm-5.2[1m]')?.id, 'glm-5.2');
  assert.equal(getModelById('deepseek-v4-pro[1m]')?.id, 'deepseek-v4-pro');
}

{
  const originalFetch = globalThis.fetch;
  let upstreamPayload;

  globalThis.fetch = async (_url, init) => {
    upstreamPayload = JSON.parse(init.body);
    return new Response(
      [
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1719360000,"model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1719360000,"model":"glm-5.2","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'glm-5.2[1m]',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
      baseEnv,
    );
    const body = await response.json();

    assert.equal(upstreamPayload.model, 'glm-5.2');
    assert.equal(upstreamPayload.stream, true);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'glm-5.2');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'Hello world');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.usage.total_tokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  assert.equal(
    buildUpstreamUrl(
      baseEnv,
      'https://worker.example/v1/chat/completions?stream=true&model=hy3',
    ),
    'https://copilot.tencent.com/v2/chat/completions?stream=true&model=hy3',
  );

  assert.equal(
    buildUpstreamUrl(
      {
        ...baseEnv,
        UPSTREAM_CHAT_COMPLETIONS_URL: 'https://upstream.example/chat?api-version=1',
      },
      'https://worker.example/v1/chat/completions?stream=true',
    ),
    'https://upstream.example/chat?api-version=1&stream=true',
  );
}

{
  const env = {
    ...baseEnv,
    CORS_ALLOW_ORIGINS: 'https://app.example, https://admin.example',
    CORS_ALLOW_CREDENTIALS: 'true',
  };
  const headers = buildCorsHeaders(
    env,
    new Request('https://worker.example/v1/chat/completions', {
      headers: { origin: 'https://admin.example' },
    }),
  );

  assert.equal(headers.get('access-control-allow-origin'), 'https://admin.example');
  assert.equal(headers.get('access-control-allow-credentials'), 'true');
  assert.equal(headers.get('vary'), 'Origin');
}

{
  const headers = buildCorsHeaders(
    { ...baseEnv, CORS_ALLOW_CREDENTIALS: 'true' },
    new Request('https://worker.example/v1/chat/completions', {
      headers: { origin: 'https://client.example' },
    }),
  );

  assert.equal(headers.get('access-control-allow-origin'), 'https://client.example');
  assert.equal(headers.get('access-control-allow-credentials'), 'true');
  assert.equal(headers.get('vary'), 'Origin');
}

console.log('All tests passed');

// ── 边界测试：模型ID规范化 ─────────────────────────────────────────────────
{
  assert.equal(normalizeModelId(''), '');
  assert.equal(normalizeModelId('  '), '');
  assert.equal(normalizeModelId('model[invalid]extra'), 'model[invalid]extra'); // 不匹配模式，保持原值
  assert.equal(normalizeModelId('deepseek-v4-pro[1m]'), 'deepseek-v4-pro');
  assert.equal(normalizeModelId('model[1m][2m]'), 'model[1m]');
}

// ── 边界测试：rewritePayload 处理非标准输入 ──────────────────────────────────
{
  // 空 messages
  const payload = { messages: [] };
  const result = rewritePayload(payload);
  assert.deepStrictEqual(result, { messages: [] });
}

{
  // 非数组 messages
  const payload = { messages: 'not-an-array' };
  const result = rewritePayload(payload);
  assert.equal(result.messages, 'not-an-array');
}

{
  // 无 messages
  const payload = { model: 'glm-5.2[1m]' };
  const result = rewritePayload(payload);
  assert.equal(result.model, 'glm-5.2');
}

{
  // null message
  const payload = { messages: [null] };
  const result = rewritePayload(payload);
  assert.equal(result.messages[0], null);
}

{
  // content 为数组但元素无 type
  const payload = {
    messages: [{ role: 'system', content: [{ text: 'hello' }] }],
  };
  rewritePayload(payload);
  assert.equal(payload.messages[0].content[0].text, 'hello');
}

// ── 边界测试：超时与502错误处理 ──────────────────────────────────────────────
{
  const originalFetch = globalThis.fetch;

  // 模拟上游超时
  globalThis.fetch = async () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    throw err;
  };

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'glm-5.2',
          stream: false,
          messages: [{ role: 'user', content: 'test' }],
        }),
      }),
      baseEnv,
    );
    assert.equal(response.status, 504);
    const body = await response.text();
    assert.ok(body.includes('timeout'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;

  // 模拟上游 502 错误
  globalThis.fetch = async () =>
    new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } });

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'glm-5.2',
          stream: false,
          messages: [{ role: 'user', content: 'test' }],
        }),
      }),
      baseEnv,
    );
    // 上游 502 应该透传
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 边界测试：请求体大小限制 ────────────────────────────────────────────────
{
  const response = await worker.fetch(
    new Request('https://worker.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-length': `${11 * 1024 * 1024}` }, // 11MB > 10MB
      body: 'x'.repeat(100),
    }),
    baseEnv,
  );
  assert.equal(response.status, 413);
}

// ── 边界测试：无效 JSON ──────────────────────────────────────────────────────
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('ok', { status: 200 });

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-valid-json',
      }),
      baseEnv,
    );
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.ok(body.includes('Invalid JSON'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 边界测试：速率限制 ──────────────────────────────────────────────────────
{
  const { checkRateLimit } = await import(pathToFileURL(`${process.cwd()}/${outDir}/rate-limiter.mjs`));

  // 快速消耗全部令牌
  const key = 'test-rate-limit-key';
  for (let i = 0; i < 10; i++) {
    assert.ok(checkRateLimit(key, 60, 60000, 10), `Request ${i} should pass`);
  }
  // 第 11 次应该被限流
  assert.equal(checkRateLimit(key, 60, 60000, 10), false, '11th request should be rate limited');
}

{
  const { getRateLimitKey } = await import(pathToFileURL(`${process.cwd()}/${outDir}/rate-limiter.mjs`));

  // CF-Connecting-IP 优先
  const req1 = new Request('https://worker.example/test', {
    headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '10.0.0.1' },
  });
  assert.equal(getRateLimitKey(req1), 'ip:1.2.3.4');

  // X-Forwarded-For 回退
  const req2 = new Request('https://worker.example/test', {
    headers: { 'X-Forwarded-For': '10.0.0.1, 10.0.0.2' },
  });
  assert.equal(getRateLimitKey(req2), 'ip:10.0.0.1');

  // 匿名回退
  const req3 = new Request('https://worker.example/test');
  assert.equal(getRateLimitKey(req3), 'anonymous');
}

// ── 边界测试：超大 SSE 响应 ──────────────────────────────────────────────────
{
  const originalFetch = globalThis.fetch;
  const chunkCount = 500;
  const sseLines = [];
  for (let i = 0; i < chunkCount; i++) {
    sseLines.push(`data: {"id":"chatcmpl-big","object":"chat.completion.chunk","created":1719360000,"model":"glm-5.2","choices":[{"index":0,"delta":{"content":"chunk${i}"},"finish_reason":null}]}`);
    sseLines.push('');
  }
  sseLines.push('data: {"id":"chatcmpl-big","object":"chat.completion.chunk","created":1719360000,"model":"glm-5.2","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":500,"total_tokens":510}}');
  sseLines.push('');
  sseLines.push('data: [DONE]');
  sseLines.push('');

  globalThis.fetch = async () =>
    new Response(sseLines.join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'glm-5.2',
          stream: false,
          messages: [{ role: 'user', content: 'big test' }],
        }),
      }),
      baseEnv,
    );
    const body = await response.json();
    assert.equal(body.choices[0].message.content.length > 0, true);
    assert.equal(body.usage.total_tokens, 510);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('All boundary tests passed');

// ── Observability 模块测试 ─────────────────────────────────────────────────

{
  // redactApiKey: 正常 token 部分脱敏
  assert.equal(redactApiKey('Bearer sk-1234567890abcdef'), 'Bearer sk-1***cdef');
  assert.equal(redactApiKey('Bearer abcdefghijklmnop'), 'Bearer abcd***mnop');
}

{
  // redactApiKey: 短 token
  assert.equal(redactApiKey('Bearer short'), 'Bearer <too-short>');
}

{
  // redactApiKey: null / 格式异常
  assert.equal(redactApiKey(null), '<none>');
  assert.equal(redactApiKey('Basic invalid'), 'Basic <too-short>');
}

{
  // extractUserInput: 正常消息提取
  const payload = {
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello, how are you?' },
      { role: 'user', content: 'Tell me about TypeScript.' },
    ],
  };
  assert.equal(
    extractUserInput(payload),
    'Hello, how are you? | Tell me about TypeScript.',
  );
}

{
  // extractUserInput: content 为数组格式
  const payload = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this image?' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
        ],
      },
    ],
  };
  assert.equal(extractUserInput(payload), 'What is this image?');
}

{
  // extractUserInput: 无 payload
  assert.equal(extractUserInput(undefined), '<no payload>');
}

{
  // extractUserInput: 无 user 消息
  const payload = {
    messages: [{ role: 'system', content: 'system prompt' }],
  };
  assert.equal(extractUserInput(payload), '<no user messages>');
}

{
  // extractAssistantOutput: 正常输出提取
  const responseBody = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    model: 'glm-5.2',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
        finish_reason: 'stop',
      },
    ],
  };
  assert.equal(
    extractAssistantOutput(responseBody),
    'TypeScript is a typed superset of JavaScript.',
  );
}

{
  // extractAssistantOutput: 无 choices
  const responseBody = { id: 'chatcmpl-123', object: 'chat.completion', model: 'glm-5.2' };
  assert.equal(extractAssistantOutput(responseBody), '<no output>');
}

console.log('All observability tests passed');
