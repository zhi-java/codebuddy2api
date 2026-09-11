// 用例 19:token 消耗统计
//
// 覆盖三条采集路径:
//   A 非流式聚合 —— 整条 SSE 已读进内存,顺带提取 usage
//   B 流式透传   —— usage 在流末尾,由 usageTap 在流结束后回填
//   C 协议转换   —— 旁路必须挂在协议转换之前,否则 usage 会随转换丢失
// 另覆盖「无 usage 不误计」与「重复上报不重复累加」两个边界。
{
  const metricsMod = await import(
    pathToFileURL(process.cwd() + '/.tmp-test/metrics.mjs').href
  );
  metricsMod.resetMetrics();

  const makeChatRequest = (stream) => new Request('https://w.example/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ck_token_test',
      'X-Forwarded-For': nextIp(),
    },
    body: JSON.stringify({ model: 'hy3', stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

  const USAGE_SSE =
    'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45,"total_tokens":165}}\n\n' +
    'data: [DONE]\n\n';
  const NO_USAGE_SSE =
    'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n';

  const originalFetch = globalThis.fetch;
  const sse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  // A. 非流式:聚合时提取 usage
  globalThis.fetch = async () => sse(USAGE_SSE);
  try {
    const res = await callFetch(makeChatRequest(false), baseEnv);
    assert.equal(res.status, 200);
    const snap = metricsMod.metricsSnapshot();
    assert.equal(snap.totals.promptTokens, 120, '非流式应采集 prompt tokens');
    assert.equal(snap.totals.completionTokens, 45);
    assert.equal(snap.totals.totalTokens, 165);
    assert.equal(snap.totals.tokenReported, 1);
    assert.equal(snap.recent[0].totalTokens, 165, '明细里应带单次 token');
    assert.equal(snap.recent[0].promptTokens, 120);
  } finally { globalThis.fetch = originalFetch; }

  // B. 流式透传:必须把流读干才会在 flush 时回填
  globalThis.fetch = async () => sse(USAGE_SSE);
  try {
    const res = await callFetch(makeChatRequest(true), baseEnv);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /hi/, '旁路不得破坏透传内容');
    const snap = metricsMod.metricsSnapshot();
    assert.equal(snap.totals.promptTokens, 240, '流式应在流结束后补齐 token');
    assert.equal(snap.totals.completionTokens, 90);
    assert.equal(snap.totals.tokenReported, 2);
    // 极短的流会在 recordRequest 之前就结束(pipeThrough 立即抽取上游),
    // 这里同时守住「提前到达的 usage 也不重复入桶」
    const lastBucket = snap.series[snap.series.length - 1];
    assert.equal(lastBucket.totalTokens, 330, '分钟序列应带 token 供前端画趋势');
    assert.equal(lastBucket.total, 2);
  } finally { globalThis.fetch = originalFetch; }

  // C. Anthropic 协议流式:旁路挂在协议转换之前
  globalThis.fetch = async () => sse(USAGE_SSE);
  try {
    const res = await callFetch(new Request('https://w.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ck_token_test', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }), baseEnv);
    assert.equal(res.status, 200);
    await res.text();
    const snap = metricsMod.metricsSnapshot();
    assert.equal(snap.totals.promptTokens, 360, 'Anthropic 协议也应采集 token');
    assert.equal(snap.totals.tokenReported, 3);
  } finally { globalThis.fetch = originalFetch; }

  // D. 上游未返回 usage:不误计,但请求数照常
  globalThis.fetch = async () => sse(NO_USAGE_SSE);
  try {
    const res = await callFetch(makeChatRequest(false), baseEnv);
    assert.equal(res.status, 200);
    const snap = metricsMod.metricsSnapshot();
    assert.equal(snap.totals.totalTokens, 495, '无 usage 的请求不应改变 token 合计');
    assert.equal(snap.totals.tokenReported, 3, '无 usage 不应计入上报数');
    assert.equal(snap.totals.total, 4, '请求数照常累计');
    assert.equal(snap.recent[0].totalTokens, undefined);
  } finally { globalThis.fetch = originalFetch; }

  // E. attachTokenUsage 幂等:重复上报不重复累加
  const record = { at: Date.now(), path: '/x', model: 'm', status: 200, durationMs: 1 };
  metricsMod.attachTokenUsage(record, { promptTokens: 10, completionTokens: 5 });
  metricsMod.attachTokenUsage(record, { promptTokens: 10, completionTokens: 5 });
  assert.equal(record.totalTokens, 15);
  assert.equal(metricsMod.metricsSnapshot().totals.totalTokens, 510, '重复上报不得重复累加');

  // F. 平均速率:按进程实际运行分钟数计算(刚启动时为 1 分钟,不做 60 分钟稀释)
  const rateSnap = metricsMod.metricsSnapshot();
  const rate = rateSnap.totals.avgTokensPerMinute;
  assert.ok(
    rate > 0 && rate <= 510,
    `速率应在 (0, 总量] 区间内,实际 ${rate}`,
  );

  console.log('case19 token metrics passed');
}
