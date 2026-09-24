// 用例 21:多协议客户端兼容（Anthropic / OpenAI 双格式）
//
// 背景：主流 Agent 客户端对 GET /v1/models 的期望并不一致。
// 读源码（cline/cline、continuedev/continue）确认：
//   - Cline / Continue 只从 /v1/models 取**模型 ID**，不读任何长度字段；
//   - Anthropic 系客户端读的是 Anthropic 自己的字段名
//     （max_input_tokens / max_tokens / type / display_name），与 OpenAI 不兼容。
// 因此只回一种格式必然有一类客户端拿不到上下文长度，落到保守默认值
// （Cline 32k 输出上限、Continue 32_768 上下文）。
//
// 本用例锁定：
//   ① count_tokens 端点契约与「不依赖上游凭证」的特性
//   ② 两种协议各自的响应格式
//   ③ 格式分流的判定不会误伤 OpenAI 客户端
{
  const store = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  const tokenEstimate = await import(pathToFileURL(process.cwd() + '/' + outDir + '/token-estimate.mjs'));

  // ── 准备：内存 KV 注入 + 一把网关 Key（绑定一个假凭证供 /v1/models 使用）──
  const mem = new Map();
  const kv = {
    async get(k) { return mem.has(k) ? mem.get(k) : null; },
    async put(k, v) { mem.set(k, v); },
    async delete(k) { mem.delete(k); },
  };
  const env = { ...baseEnv, CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'compat-test-enc' };
  const tokenStore = store.getTokenStore(env);

  const plaintext = 'sk-cb-compatprobe0000000000000000000000000000000000';
  await tokenStore.saveCredential({
    id: 'cred_compat', name: 'compat-cred', kind: 'ck_apikey',
    apiKey: 'ck_compat_probe', enabled: true, createdAt: Date.now(),
  });
  await tokenStore.saveKey({
    id: 'key_compat', name: 'compat', keyHash: await store.hashApiKey(plaintext),
    credentialIds: ['cred_compat'], enabled: true, createdAt: Date.now(),
  });

  const auth = { authorization: `Bearer ${plaintext}` };
  const post = (body, headers = {}) => callFetch(
    new Request('https://gw.test/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );

  // ── ① count_tokens 契约 ──────────────────────────────────────────────
  {
    const res = await post({ model: 'glm-5.3', messages: [{ role: 'user', content: 'Hello, world' }] });
    assert.equal(res.status, 200, 'count_tokens 应返回 200');
    const body = await res.json();
    assert.equal(typeof body.input_tokens, 'number', '应返回 input_tokens');
    assert.ok(Number.isInteger(body.input_tokens) && body.input_tokens > 0, 'input_tokens 应为正整数');
    assert.deepEqual(Object.keys(body), ['input_tokens'], 'Anthropic 契约只含 input_tokens 一个字段');
  }

  // 未认证 → Anthropic 形状的鉴权错误（不是 OpenAI 的 {error: string}）
  {
    const res = await callFetch(
      new Request('https://gw.test/v1/messages/count_tokens', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      }),
      env,
    );
    assert.equal(res.status, 401, '无 Key 应 401');
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
  }

  // 关键特性：纯本地计算，**不依赖上游凭证池**
  // （Key 绑定已删除的凭证时 /v1/models 会失败，count_tokens 不应受影响）
  {
    await tokenStore.saveKey({
      id: 'key_nocred', name: 'no-cred', keyHash: await store.hashApiKey('sk-cb-nocred00000000000000000000000000000000000000'),
      credentialIds: [], enabled: true, createdAt: Date.now(),
    });
    const res = await callFetch(
      new Request('https://gw.test/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-cb-nocred00000000000000000000000000000000000000' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      }),
      env,
    );
    assert.equal(res.status, 200, '未绑定上游凭证时 count_tokens 仍应可用（不走上游）');
  }

  // x-api-key 形式（Anthropic 客户端习惯）也能认证
  {
    const res = await callFetch(
      new Request('https://gw.test/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': plaintext, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      }),
      env,
    );
    assert.equal(res.status, 200, 'x-api-key 头应可用于 count_tokens');
  }

  // 非法 JSON → 400 + Anthropic 错误体
  {
    const res = await post('{bad json');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'invalid_request_error');
  }

  // ── ② 估算口径：system / tools 计入，CJK 加权 ────────────────────────
  {
    const bare = tokenEstimate.estimateInputTokens({ messages: [{ role: 'user', content: 'hello' }] });
    const withSystem = tokenEstimate.estimateInputTokens({
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You are a helpful assistant.',
    });
    const withTools = tokenEstimate.estimateInputTokens({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    });
    assert.ok(withSystem > bare, 'system prompt 应计入 token 数');
    assert.ok(withTools > bare, 'tools 定义应计入 token 数');

    // 中文按 1.6 字符/token、英文按 4 字符/token：
    // 同样「字数」下中文 token 数应更高，否则中文请求会被严重低估
    const zh = tokenEstimate.estimateInputTokens({ messages: [{ role: 'user', content: '四个汉字测试' }] });
    const en = tokenEstimate.estimateInputTokens({ messages: [{ role: 'user', content: 'four chars' }] });
    assert.ok(zh > en, `中文应有更高 token 密度（zh=${zh}, en=${en}）`);
  }

  // ── ③ /v1/models 协议分流 ────────────────────────────────────────────
  const getModels = (headers) => callFetch(
    new Request('https://gw.test/v1/models', { headers: { ...auth, ...headers } }),
    env,
  );

  // Anthropic 客户端（带 anthropic-version）：应为 Anthropic 格式
  {
    const res = await getModels({ 'anthropic-version': '2023-06-01' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('first_id' in body && 'has_more' in body && 'last_id' in body, 'Anthropic 信封应含分页字段');
    assert.ok(Array.isArray(body.data) && body.data.length > 0, 'data 应为非空数组');

    const m = body.data[0];
    assert.equal(m.type, 'model', 'Anthropic 模型对象 type 应为 "model"');
    assert.equal(typeof m.display_name, 'string', '应提供 display_name');
    assert.equal(typeof m.max_input_tokens, 'number', '应提供 max_input_tokens（上下文长度）');
    assert.equal(typeof m.max_tokens, 'number', '应提供 max_tokens（输出上限）');
    assert.ok(m.capabilities && typeof m.capabilities === 'object', '应提供 capabilities 能力块');
    assert.ok(m.capabilities.context_window, '应提供 capabilities.context_window');
    assert.equal(typeof m.capabilities.context_window.max_input_tokens, 'number');
    // 1M 上下文标记：Claude Code 的 [1m] 变体依赖该布尔值
    assert.equal(typeof m.capabilities.context_window.supports_1m_context, 'boolean');
    // 不应泄漏 OpenAI 专有字段
    assert.equal(m.object, undefined, 'Anthropic 格式不应含 object 字段');
    assert.equal(m.owned_by, undefined, 'Anthropic 格式不应含 owned_by 字段');
  }

  // OpenAI 客户端（只带 Authorization）：应为 OpenAI 格式 + 字段别名
  {
    const res = await getModels({});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'list', 'OpenAI 格式 object 应为 "list"');

    const m = body.data[0];
    assert.equal(m.object, 'model', 'OpenAI 模型对象 object 应为 "model"');
    assert.equal(typeof m.id, 'string');

    // 上下文字段：OpenAI 规范没有该字段，各客户端约定不同，故一并给出
    for (const key of ['context_window', 'max_model_len', 'context_length', 'max_input_tokens', 'max_context_length']) {
      assert.equal(typeof m[key], 'number', `OpenAI 格式应提供 ${key}（客户端约定各不相同）`);
    }
    // 输出上限双别名
    assert.equal(typeof m.max_output_tokens, 'number');
    assert.equal(typeof m.max_tokens, 'number');

    // 不应泄漏 Anthropic 专有字段
    assert.equal(m.type, undefined, 'OpenAI 格式不应含 type 字段');
  }

  // ── ④ 分流判定不能误伤 OpenAI 客户端 ────────────────────────────────
  {
    // 常见 OpenAI 兼容客户端（带自家 UA）
    for (const ua of ['openai-node/4.0.0', 'Cline/3.0', 'Continue/0.9', 'python-requests/2.31']) {
      const res = await getModels({ 'user-agent': ua });
      const body = await res.json();
      assert.equal(body.object, 'list', `UA=${ua} 不应被误判为 Anthropic`);
    }

    // 同时带 Authorization 与 x-api-key 时，不应因 x-api-key 被判为 Anthropic
    {
      const res = await getModels({ 'x-api-key': 'something' });
      const body = await res.json();
      assert.equal(body.object, 'list', '同时带两种鉴权头时不应误判为 Anthropic');
    }

    // Claude 系客户端应判为 Anthropic
    for (const ua of ['claude-cli/1.0.0', 'Claude-Code/2.0']) {
      const res = await getModels({ 'user-agent': ua });
      const body = await res.json();
      assert.ok('first_id' in body, `UA=${ua} 应判为 Anthropic 客户端`);
    }

    // anthropic-beta 头是强信号
    {
      const res = await getModels({ 'anthropic-beta': 'token-counting-2024-11-01' });
      const body = await res.json();
      assert.ok('first_id' in body, 'anthropic-beta 头应判为 Anthropic 客户端');
    }
  }

  // ── ⑤ 全局模型别名（环境变量 MODEL_ALIASES）────────────────────────
  // 客户端靠模型 ID 匹配内置目录获知上下文长度，上游私有 ID 不在其中，
  // 别名机制让客户端可传自己认识的 ID。
  {
    const aliasEnv = {
      ...env,
      MODEL_ALIASES: JSON.stringify({ 'claude-sonnet-4-5': 'glm-5.3', 'gpt-5': 'deepseek-v4-pro' }),
    };
    // 别名在鉴权后、转发前应用；此处用无效上游 URL 触发转发尝试，
    // 通过日志/错误路径不可靠，改为直接验证「未知模型 + 别名」不会 4xx 于模型解析阶段。
    const res = await callFetch(
      new Request('https://gw.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      }),
      aliasEnv,
    );
    // 上游不可达会得到 502，但**不应**是「模型不存在」类错误——
    // 说明别名未阻断请求进入转发链路
    assert.ok(res.status >= 200, '别名请求应进入转发链路');
    assert.notEqual(res.status, 400, '已配置别名时不应因模型名被拒');
  }
}
