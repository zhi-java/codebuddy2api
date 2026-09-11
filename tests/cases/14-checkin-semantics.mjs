// 用例 14:签到业务语义
//
// 实测契约(2026-09-11,三凭据交叉验证):
//   - 状态查询走 /v2/billing/meter/checkin-activity-status(旧的无 /v2 路径恒返回 active=false)
//   - HTTP 400 + code 10001 "今天已签到" = 正常业务状态,不视为失败
//   - HTTP 403 = 网关策略拒绝(如 ck_ 两段式 API Key 无领取权限),须与 401 鉴权失败区分
//   - ck_ 前缀(非 JWT,无第三段)的凭证可读状态但不可领取
{
  const billMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/upstream-billing.mjs'));
  const ckCred = { id: 'x', name: 'CK', kind: 'ck_apikey', enabled: true, apiKey: 'ck-live', createdAt: 1, updatedAt: 1 };
  const jwtCred = {
    id: 'y', name: 'JWT', kind: 'cli_oauth', enabled: true,
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig', createdAt: 1, updatedAt: 1,
  };
  const okJson = (obj) => new Response(JSON.stringify(obj), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  const originalFetch = globalThis.fetch;

  // ── 1. 状态查询:命中 /v2 活动状态路径,解析期次/连续天数/累计积分 ──
  {
    let calledUrl = '';
    globalThis.fetch = async (url) => {
      calledUrl = String(url);
      return okJson({
        code: 0,
        data: {
          active: true, today_checked_in: true, streak_days: 10, daily_credit: 100,
          today_credit: 100, total_credits: 1000, season: 8,
          activity_name: '开学季', theme_name: 'Buddy加油站',
          start_time: '2026-09-01 00:00:00', end_time: '2026-09-15 23:59:59',
          action_button: { show: true, text: '认证领积分', action: 'https://example.test/campus' },
        },
      });
    };
    try {
      const st = await billMod.fetchCheckinStatus(jwtCred, {});
      assert.match(calledUrl, /\/v2\/billing\/meter\/checkin-activity-status$/, '状态查询须走 /v2 活动路径');
      assert.equal(st.active, true);
      assert.equal(st.season, 8);
      assert.equal(st.streakDays, 10);
      assert.equal(st.totalCredits, 1000);
      assert.equal(st.activityName, '开学季');
      assert.equal(st.endTime, '2026-09-15 23:59:59');
      assert.equal(st.canClaim, true, 'JWT 凭证具备领取权限');
      assert.equal(st.actionButton?.action, 'https://example.test/campus');
    } finally { globalThis.fetch = originalFetch; }
  }

  // ── 2. 领取权限预判:以 token 形态(JWT)区分,而非 kind ──
  //     实测:kind=ck_apikey 下既有不可领取的控制台 Key,也有可领取的 JWT。
  {
    globalThis.fetch = async () => okJson({
      code: 0, data: { active: true, streak_days: 3, daily_credit: 100, total_credits: 300, season: 8 },
    });
    try {
      // 2a. 控制台 API Key:形如 `ck_<id>.<secret>`,含点但只有两段 → 不可领取
      const consoleKey = {
        id: 'k', name: 'K', kind: 'ck_apikey', enabled: true,
        apiKey: 'ck_frl3ly203aio.xuMbKx3FieTOG_X4pTHrWRew49ogyBdbL7Juc2orzy0',
        createdAt: 1, updatedAt: 1,
      };
      const stk = await billMod.fetchCheckinStatus(consoleKey, {});
      assert.equal(stk.active, true, '控制台 Key 仍可读取状态');
      assert.equal(stk.canClaim, false, '控制台 Key 不可领取');
      assert.match(stk.claimBlockedReason, /API Key/);

      // 2b. kind=ck_apikey 但 token 是 JWT → 可领取(不能按 kind 一刀切)
      const jwtAsCk = {
        id: 'j', name: 'J', kind: 'ck_apikey', enabled: true,
        apiKey: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig', createdAt: 1, updatedAt: 1,
      };
      const stj = await billMod.fetchCheckinStatus(jwtAsCk, {});
      assert.equal(stj.canClaim, true, 'JWT 形态凭证(即使 kind=ck_apikey)可领取');

      // 2c. 非 JWT 的 cli_oauth(异常数据)同样判为不可领取
      const badOauth = {
        id: 'b', name: 'B', kind: 'cli_oauth', enabled: true,
        accessToken: 'not-a-jwt', createdAt: 1, updatedAt: 1,
      };
      const stb = await billMod.fetchCheckinStatus(badOauth, {});
      assert.equal(stb.canClaim, false, '非 JWT 的 cli_oauth 亦不可领取');
    } finally { globalThis.fetch = originalFetch; }
  }

  // ── 3. 已签到(HTTP 400 + code 10001)→ 正常结果,不抛错 ──
  {
    globalThis.fetch = async (url) => {
      // 领取返回已签到,随后的状态回查返回真实状态
      if (/daily-checkin/.test(String(url))) {
        return new Response(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      return okJson({ code: 0, data: { active: true, streak_days: 7, total_credits: 700, season: 8 } });
    };
    try {
      const r = await billMod.fetchDailyCheckin(jwtCred, {});
      assert.equal(r.credit, 0);
      assert.match(r.message, /已签到/);
      assert.equal(r.streakDays, 7, '已签到时仍回查连续天数');
      assert.equal(r.status?.totalCredits, 700);
    } finally { globalThis.fetch = originalFetch; }
  }

  // ── 4. 其它业务错误带上游原文 ──
  {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: 5200, msg: '活动未开始' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    try {
      await assert.rejects(() => billMod.fetchDailyCheckin(ckCred, {}), /活动未开始/);
    } finally { globalThis.fetch = originalFetch; }
  }

  // ── 5. HTTP 403 = 策略拒绝(非鉴权失败),须给出可操作文案 ──
  {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: 'API key not allowed for this path or method' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
    try {
      await assert.rejects(
        () => billMod.fetchDailyCheckin(ckCred, {}),
        (err) => /签到被拒绝/.test(err.message) && /API key not allowed/.test(err.message),
        '403 须报为权限拒绝并带上游原文,不得与 401 鉴权失败混同',
      );
    } finally { globalThis.fetch = originalFetch; }
  }

  // ── 6. HTTP 401 = 鉴权失败 ──
  {
    globalThis.fetch = async () => new Response('', { status: 401 });
    try {
      await assert.rejects(() => billMod.fetchDailyCheckin(ckCred, {}), /上游鉴权失败/);
    } finally { globalThis.fetch = originalFetch; }
  }

  // ── 7. 多个同名裂变包 → 包名去重计数 ──
  const mk = (name, rem) => ({ PackageName: name, CapacitySize: 100, CapacityRemain: rem, CapacityUsed: 100 - rem });
  globalThis.fetch = async () => okJson({
    code: 0, data: { Response: { Data: { Accounts: [
      mk('体验版', 50),
      mk('裂变包', 30), mk('裂变包', 20), mk('裂变包', 10),
    ] } } },
  });
  try {
    const q = await billMod.fetchCredentialQuota(ckCred, {});
    assert.equal(q.total, 400);
    assert.equal(q.remaining, 110);
    assert.equal(q.packageName, '体验版 + 裂变包 ×3');
  } finally { globalThis.fetch = originalFetch; }

  console.log('case14 checkin semantics passed');
}
