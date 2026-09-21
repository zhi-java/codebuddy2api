// 用例 20:请求量的日/月归档(持久化滚动统计)
//
// 全程走 index 的 worker,保证 metrics 事件出口与归档模块在同一份 bundle 内,
// 与生产链路一致(单独 import metrics.mjs 会拿到另一份模块实例,测不到联动)。
{
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  const { resetTokenStore, getTokenStore, hashApiKey } = storeMod;

  const kvData = new Map();
  const kv = {
    async get(k) { return kvData.has(k) ? kvData.get(k) : null; },
    async put(k, v) { kvData.set(k, v); },
    async delete(k) { kvData.delete(k); },
  };

  resetTokenStore();
  const env = {
    ...baseEnv,
    ADMIN_PASSWORD: 'pw-history',
    ADMIN_SESSION_SECRET: 'sess-history',
    CREDENTIALS_KV: kv,
    CREDENTIALS_ENC_SECRET: 'e',
  };

  const st = getTokenStore(env);
  await st.saveCredential({
    id: 'h1', name: '归档上游', kind: 'ck_apikey', enabled: true,
    apiKey: 'ck_hist', createdAt: 1, updatedAt: 1,
  });
  const plain = 'sk-cb-history-e2e';
  await st.saveKey({
    id: 'kh', name: 'KH', keyHash: await hashApiKey(plain),
    credentialIds: ['h1'], enabled: true, createdAt: 1,
  });

  // ── 预置历史归档:昨天有流量、前天没有(验证补零)、上月有流量 ──
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const yKey = dayKey(yesterday);
  const mKey = dayKey(lastMonth);
  const dayRecord = (day, total, error) => JSON.stringify({
    day, total, success: total - error, error,
    durationSumMs: total * 100, promptTokens: total * 10,
    completionTokens: total * 5, credit: total * 0.5,
  });
  kvData.set('metrics:day:' + yKey, dayRecord(yKey, 12, 2));
  kvData.set('metrics:day:' + mKey, dayRecord(mKey, 40, 0));
  kvData.set('metrics:index', JSON.stringify([mKey, yKey].sort()));

  // ── 登录(与生产同一条链路) ──
  const login = await callFetch(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw-history' }),
  }), env);
  assert.equal(login.status, 200);
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { cookie: 'cb_admin=' + cookie, 'X-Forwarded-For': nextIp() };

  const readHistory = async (query) => {
    const res = await callFetch(
      new Request('https://w.example/admin/api/metrics/history' + (query ?? ''), { headers: auth }),
      env,
    );
    assert.equal(res.status, 200);
    return (await res.json()).data;
  };

  // 未登录不得读取
  const unauth = await callFetch(new Request('https://w.example/admin/api/metrics/history', {
    headers: { 'X-Forwarded-For': nextIp() },
  }), env);
  assert.equal(unauth.status, 401, '归档接口需登录');

  // ── 读取归档:补零 + 月桶派生 ──
  const snap = await readHistory('?days=3&months=2');
  assert.equal(snap.enabled, true, '注入了 CREDENTIALS_KV 时归档应可用');
  assert.equal(snap.days.length, 3, '日序列按请求长度补零');
  assert.equal(snap.days[1].day, yKey);
  assert.equal(snap.days[1].total, 12);
  assert.equal(snap.days[1].error, 2);
  assert.equal(snap.days[1].credit, 6);
  assert.equal(snap.days[0].total, 0, '无数据的日期补零');
  assert.equal(snap.days[2].total, 0, '今日尚无流量');

  assert.equal(snap.months.length, 2);
  const seededTotal = 12 + 40;
  assert.equal(
    snap.months.reduce((sum, m) => sum + m.total, 0),
    seededTotal,
    '月桶应等于其覆盖的日桶之和',
  );
  const lastMonthBucket = snap.months.find((m) => m.month === mKey.slice(0, 7));
  assert.ok(lastMonthBucket, '上月桶必须出现在月序列中');
  assert.ok(lastMonthBucket.total >= 40, '上月聚合不得丢失已归档的日桶');

  // ── 真实请求累加进当日桶 ──
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    const chat = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + plain, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    }), env);
    assert.equal(chat.status, 200);
    await chat.text();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const afterChat = await readHistory('?days=3&months=2');
  assert.equal(afterChat.days[2].day, dayKey(now));
  assert.equal(afterChat.days[2].total, 1, '完成的请求应计入当日桶');
  assert.equal(afterChat.days[2].success, 1);
  assert.equal(afterChat.days[2].error, 0);

  // ── 落盘:节流窗口内应写回存储(进程重启后仍可读) ──
  const todayRecordKey = 'metrics:day:' + dayKey(now);
  const deadline = Date.now() + 9_000;
  let persisted = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const raw = kvData.get(todayRecordKey);
    if (raw) {
      persisted = JSON.parse(raw);
      if (persisted.total >= 1) break;
    }
  }
  assert.ok(persisted, '当日归档应在节流窗口内落盘');
  assert.equal(persisted.total, 1);
  assert.match(kvData.get('metrics:index'), new RegExp(dayKey(now)), '日期索引需包含当日');

  // ── 模拟进程重启:换一份已含「今日」桶的存储,验证加载后继续累加而非覆盖 ──
  const todayKey = dayKey(now);
  const kvData2 = new Map();
  const kv2 = {
    async get(k) { return kvData2.has(k) ? kvData2.get(k) : null; },
    async put(k, v) { kvData2.set(k, v); },
    async delete(k) { kvData2.delete(k); },
  };
  // 重启前今日已有 7 次请求、14+7 token、3.5 积分
  kvData2.set('metrics:day:' + todayKey, JSON.stringify({
    day: todayKey, total: 7, success: 7, error: 0,
    durationSumMs: 700, promptTokens: 14, completionTokens: 7, credit: 3.5,
  }));
  kvData2.set('metrics:index', JSON.stringify([todayKey]));

  const env2 = { ...env, CREDENTIALS_KV: kv2 };
  const st2 = getTokenStore(env2);
  await st2.saveCredential({
    id: 'h2', name: '重启后上游', kind: 'ck_apikey', enabled: true,
    apiKey: 'ck_hist2', createdAt: 1, updatedAt: 1,
  });
  const plain2 = 'sk-cb-history-restart';
  await st2.saveKey({
    id: 'kh2', name: 'KH2', keyHash: await hashApiKey(plain2),
    credentialIds: ['h2'], enabled: true, createdAt: 1,
  });

  // 一次读取即触发按 env 重新接入存储(等价于进程重启后的首次加载)
  const reload = await callFetch(
    new Request('https://w.example/admin/api/metrics/history?days=1&months=1', { headers: auth }),
    env2,
  );
  assert.equal(reload.status, 200);
  const reloaded = (await reload.json()).data;
  assert.equal(reloaded.days[0].day, todayKey);
  assert.equal(reloaded.days[0].total, 7, '重启后应读回已落盘的今日桶');
  assert.equal(reloaded.days[0].credit, 3.5);
  assert.equal(reloaded.months[0].total, 7, '月桶应包含重启前已归档的今日数据');

  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    const chat2 = await callFetch(new Request('https://w.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + plain2, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    }), env2);
    assert.equal(chat2.status, 200);
    await chat2.text();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const merged = await callFetch(
    new Request('https://w.example/admin/api/metrics/history?days=1&months=1', { headers: auth }),
    env2,
  );
  const mergedData = (await merged.json()).data;
  assert.equal(mergedData.days[0].total, 8, '重启后新请求应叠加在已有今日桶之上');
  assert.equal(mergedData.days[0].credit, 3.5, '未被新请求改写的字段应原样保留');

  console.log('case20 metrics history passed');
}
