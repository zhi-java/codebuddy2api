// 用例 14:签到业务语义(HTTP 400+code10001=今日已签到,非失败)与包名去重
{
  const billMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/upstream-billing.mjs'));
  const ckCred = { id: 'x', name: 'CK', kind: 'ck_apikey', enabled: true, apiKey: 'ck-live', createdAt: 1, updatedAt: 1 };

  const originalFetch = globalThis.fetch;

  // 1. 上游 HTTP 400 + code 10001 "今天已签到" → 视为正常结果(不抛错),message 返回
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
  try {
    const r = await billMod.fetchDailyCheckin(ckCred, {});
    assert.equal(r.credit, 0);
    assert.match(r.message, /已签到/);
  } finally { globalThis.fetch = originalFetch; }

  // 2. 其它业务错误带上游原文
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: 5200, msg: '活动未开始' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
  try {
    await assert.rejects(() => billMod.fetchDailyCheckin(ckCred, {}), /活动未开始/);
  } finally { globalThis.fetch = originalFetch; }

  // 3. 鉴权类错误保留可读文案
  globalThis.fetch = async () => new Response('', { status: 403 });
  try {
    await assert.rejects(() => billMod.fetchDailyCheckin(ckCred, {}), /上游鉴权失败/);
  } finally { globalThis.fetch = originalFetch; }

  // 4. 多个同名裂变包 → 包名去重计数
  const mk = (name, rem) => ({ PackageName: name, CapacitySize: 100, CapacityRemain: rem, CapacityUsed: 100 - rem });
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0, data: { Response: { Data: { Accounts: [
      mk('体验版', 50),
      mk('裂变包', 30), mk('裂变包', 20), mk('裂变包', 10),
    ] } } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const q = await billMod.fetchCredentialQuota(ckCred, {});
    assert.equal(q.total, 400);
    assert.equal(q.remaining, 110);
    assert.equal(q.packageName, '体验版 + 裂变包 ×3');
  } finally { globalThis.fetch = originalFetch; }

  console.log('case14 checkin semantics passed');
}
