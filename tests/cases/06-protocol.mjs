// 用例 06:Anthropic / Responses 协议转换
{
  const { anthropicRequestToChat, AnthropicConverter } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/anthropic.mjs')
  );
  const { responsesRequestToChat, ResponsesConverter } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/responses.mjs')
  );

  // ── 请求转换 ──
  const chat = anthropicRequestToChat({
    model: 'glm-5.3', max_tokens: 100,
    system: [{ type: 'text', text: '系统' }],
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: [{ type: 'text', text: '查' }, { type: 'tool_use', id: 't1', name: 'w', input: { c: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '晴' }, { type: 'text', text: '然后' }] },
    ],
    tools: [{ name: 'w', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  });
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.messages[0], { role: 'system', content: '系统' });
  assert.equal(chat.messages[2].tool_calls[0].id, 't1');
  // tool_result 先于文本(OpenAI 顺序约束)
  assert.equal(chat.messages[3].role, 'tool');
  assert.equal(chat.messages[4].role, 'user');
  assert.deepEqual(chat.tool_choice, { type: 'required' });

  const resp = responsesRequestToChat({
    model: 'hy4-preview', instructions: '系统',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      '尾问',
    ],
    tools: [{ type: 'function', name: 'f', parameters: {} }, { type: 'web_search' }],
    max_output_tokens: 99,
  });
  assert.equal(resp.messages[1].content, 'hi');
  assert.equal(resp.messages[2].tool_calls[0].function.name, 'f');
  assert.equal(resp.messages[3].role, 'tool');
  assert.equal(resp.messages[4].content, '尾问');
  assert.equal(resp.tools.length, 1, 'web_search 应被忽略');
  assert.equal(resp.max_tokens, 99);

  // 顶层字符串 input
  const respStr = responsesRequestToChat({ model: 'hy3', input: '直接文本' });
  assert.equal(respStr.messages[0].content, '直接文本');

  // ── Anthropic 流式事件序列 ──
  const upstream = [
    { model: 'glm-5.3' },
    { choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ];
  const conv = new AnthropicConverter({ model: 'glm-5.3' });
  const sse = conv.feedAll(upstream) + conv.finish();
  const events = sse.split('\n\n').filter(Boolean);
  assert.match(events[0], /^event: message_start/);
  const textDeltas = events.filter((e) => e.startsWith('event: content_block_delta') && e.includes('text_delta'));
  assert.equal(textDeltas.length, 2);
  assert.match(textDeltas[0], /"text":"你"/);
  assert.match(textDeltas[1], /"text":"好"/);
  const last = events[events.length - 1];
  assert.match(last, /^event: message_stop/);
  const deltaEv = events.find((e) => e.startsWith('event: message_delta'));
  assert.match(deltaEv, /"stop_reason":"end_turn"/);
  assert.match(deltaEv, /"input_tokens":10/);

  // 工具调用 → tool_use 块(最终对象 input 完整解析)
  const toolUpstream = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"深' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '圳"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const conv2 = new AnthropicConverter({ model: 'hy3' });
  conv2.feedAll(toolUpstream);
  const msg = conv2.buildMessage();
  assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.content[0].input, { city: '深圳' });

  // ── Responses 流式与聚合 ──
  const rup = [
    { model: 'hy4-preview' },
    { choices: [{ index: 0, delta: { content: '答案' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
  ];
  const rc = new ResponsesConverter({ model: 'hy4-preview' });
  const rSse = rc.feedAll(rup) + rc.finish();
  assert.match(rSse, /^event: response\.created/);
  assert.match(rSse, /event: response\.output_text\.delta/);
  const revs = rSse.split('\n\n').filter(Boolean);
  assert.match(revs[revs.length - 1], /^event: response\.completed/);

  // Responses reasoning:上游 reasoning_content → 原生 reasoning summary item/events
  {
    const reasoningUpstream = [
      { model: 'deepseek-v4-pro' },
      { choices: [{ index: 0, delta: { reasoning_content: '先分析' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: '再判断' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '结论' }, finish_reason: 'stop' }] },
    ];
    const reasoningConv = new ResponsesConverter({ model: 'deepseek-v4-pro', emitReasoning: true });
    const reasoningSse = reasoningConv.feedAll(reasoningUpstream) + reasoningConv.finish();
    assert.match(reasoningSse, /response\.reasoning_summary_text\.delta/);
    assert.match(reasoningSse, /response\.reasoning_summary_text\.done/);
    const reasoningObj = ResponsesConverter.fromUpstreamText(
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"思考","content":"答案"},"finish_reason":"stop"}]}\n\n',
      { model: 'deepseek-v4-pro', emitReasoning: true },
    ).buildResponse();
    assert.equal(reasoningObj.output[0].type, 'reasoning');
    assert.equal(reasoningObj.output[0].summary[0].text, '思考');
    assert.equal(reasoningObj.output[1].content[0].text, '答案');
  }

  // ── carryReasoning:未开 thinking 时 reasoning 并入 text 正文 ──
  {
    const carryUpstream = [
      { model: 'hy4-preview' },
      { choices: [{ index: 0, delta: { reasoning_content: '先思考一下' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: '再想想' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '2' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    const carry = new AnthropicConverter({ model: 'hy4-preview', carryReasoning: true });
    const cSse = carry.feedAll(carryUpstream) + carry.finish();
    const cEvents = cSse.split('\n\n').filter(Boolean);
    // 思考并入 text 块(而非 thinking 块)
    assert.equal(cEvents.some((e) => e.includes('"type":"thinking"')), false, '不应有 thinking 块');
    const textDeltasC = cEvents.filter((e) => e.startsWith('event: content_block_delta') && e.includes('text_delta'));
    assert.ok(textDeltasC.length >= 3, '思考与正文都作为 text delta 输出');
    const msgC = carry.buildMessage();
    assert.equal(msgC.content.some((b) => b.type === 'thinking'), false);
    const textBlockC = msgC.content.find((b) => b.type === 'text');
    assert.match(textBlockC.text, /先思考一下再想想/);
    assert.match(textBlockC.text, /2$/);
  }

  const rText = [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    '',
  ].join('\n\n');
  const robj = ResponsesConverter.fromUpstreamText(rText, { model: 'hy3' }).buildResponse();
  assert.equal(robj.object, 'response');
  assert.equal(robj.output[0].content[0].text, 'ok');
  assert.equal(robj.usage.output_tokens, 1);

  console.log('case06 protocol passed');
}
