// 用例 10:签到设置 / 自动签到执行 / 接口内容协商
{
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  const { resetTokenStore, getTokenStore } = storeMod;
  const { performAutoCheckins } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/scheduled.mjs')
  );

  const kvData = new Map();
  const kv = {
    async get(k) { return kvData.has(k) ? kvData.get(k) : null; },
    async put(k, v) { kvData.set(k, v); },
    async delete(k) { kvData.delete(k); },
  };
  resetTokenStore();
  const st = getTokenStore({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });

  // 1. settings 默认关闭并可持久化
  assert.deepEqual(await st.getSettings(), { autoCheckin: false });
  await st.putSettings({ autoCheckin: true });
  assert.equal((await st.getSettings()).autoCheckin, true);

  // 2. 自动签到:开关关闭 → 不触发;开启 → 先查状态再按权限领取
  const originalFetch = globalThis.fetch;
  const calls = [];
  const statusBody = (season) => ({
    code: 0,
    data: {
      active: true, today_checked_in: false, streak_days: 2,
      daily_credit: 100, today_credit: 0, total_credits: 200, season,
    },
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    // 状态查询:活动进行中
    if (/checkin-activity-status/.test(u)) {
      return new Response(JSON.stringify(statusBody(8)), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // 领取:首个凭证成功 +100,其余报"已签到"
    const claimCount = calls.filter((c) => /daily-checkin/.test(c)).length;
    return new Response(JSON.stringify(
      claimCount === 1
        ? { code: 0, data: { credit: 100, streak_days: 3, is_streak_day: false } }
        : { code: 10001, msg: '今天已签到，请明天再来' },
    ), { status: claimCount === 1 ? 200 : 400, headers: { 'content-type': 'application/json' } });
  };
  try {
    await st.putSettings({ autoCheckin: false });
    await st.saveCredential({ id: 'a1', name: 'A', kind: 'ck_apikey', enabled: true, apiKey: 'ck1', createdAt: 1, updatedAt: 1 });
    const off = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(off.triggered, true);
    assert.equal(off.total, 0, '关闭时不执行');

    await st.putSettings({ autoCheckin: true });
    // JWT 形态凭证:具备领取权限
    await st.saveCredential({
      id: 'a2', name: 'B', kind: 'cli_oauth', enabled: true,
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig', createdAt: 1, updatedAt: 1,
    });
    await st.saveCredential({ id: 'a3', name: '停用', kind: 'ck_apikey', enabled: false, apiKey: 'ck3', createdAt: 1, updatedAt: 1 });
    // a1 的 apiKey('ck1')非 JWT → 会被判为无领取权限而跳过(见下方 blocked 断言)
    const report = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(report.total, 2, '仅统计启用凭证');
    assert.equal(report.ok, 1, '具备权限的凭证完成领取');
    assert.equal(report.blocked, 1, 'ck_ 两段式 Key 因无领取权限被跳过');
    assert.equal(report.season, 8, '期次由状态接口下发');
    assert.equal(report.pending, 0, '全部处理完毕时无需补签');
    assert.ok(calls.some((c) => /checkin-activity-status/.test(c)), '领取前须先查状态');

    // 2b. 活动未开放 → 不产生任何领取调用
    const before = calls.length;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ code: 0, data: { active: false, season: 9 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const idle = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(idle.inactive, 2, '活动未开放时全部跳过');
    assert.equal(idle.ok, 0);
    assert.equal(idle.pending, 0, '活动未开放不算待补签');
    assert.equal(
      calls.slice(before).filter((c) => /daily-checkin/.test(c)).length, 0,
      '活动未开放时不应产生领取调用',
    );

    // 2c. 今日已签到 → 跳过领取调用,只做只读查询
    const before2 = calls.length;
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      return new Response(JSON.stringify({
        code: 0,
        data: { active: true, today_checked_in: true, streak_days: 5, total_credits: 500, season: 8 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const done = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    // a1 是非 JWT 的控制台 Key → 无领取权限(blocked);a2 有权限且今日已签到 → already
    assert.equal(done.already, 1, '已签到的凭证计入 already');
    assert.equal(done.blocked, 1, '无权限凭证仍计入 blocked');
    assert.equal(done.ok, 0);
    assert.equal(done.pending, 0, '已签到不算待补签');
    assert.equal(
      calls.slice(before2).filter((c) => /daily-checkin/.test(c)).length, 0,
      '今日已签到不应重复调用领取接口',
    );

    // 2d. 领取遇到瞬时故障 → 记入 pending,驱动补签
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (/checkin-activity-status/.test(u)) {
        return new Response(JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: false, streak_days: 5, season: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // 领取:上游 500,业务码非 0 → 归类为"签到失败",待补签
      return new Response(JSON.stringify({ code: 5000, msg: '上游开小差了' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    };
    const flaky = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(flaky.ok, 0);
    assert.equal(flaky.blocked, 1, '无权限凭证不参与领取');
    assert.equal(flaky.pending, 1, '可领取凭证失败后须进入待补签');
    assert.equal(flaky.failures.length, 1, '失败留痕');

    // 2e. 权限类拒绝(403 策略拒绝)是持久状态 → 留痕但不进入补签
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (/checkin-activity-status/.test(u)) {
        return new Response(JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: false, streak_days: 5, season: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'API key not allowed for this path or method' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    };
    const denied = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(denied.pending, 0, '权限拒绝是持久状态,补签无意义');
    assert.ok(denied.failures.length > 0, '权限拒绝须留痕');

    // 2f. 领取时发现已被其他端签到(10001)→ 视为正常结果,不进入补签
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (/checkin-activity-status/.test(u)) {
        return new Response(JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: false, streak_days: 5, season: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    };
    const race = await performAutoCheckins({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'e' });
    assert.equal(race.pending, 0, '领取时发现已签到(10001)不应进入补签');
  } finally { globalThis.fetch = originalFetch; }

  // 2f. 补签调度:纯函数,覆盖递增间隔与用尽后回落到次日主时点
  {
    const { planNextCheckinRun, CATCHUP_DELAYS_MIN, CHECKIN_UTC_HOUR } = await import(
      pathToFileURL(process.cwd() + '/' + outDir + '/scheduled.mjs')
    );
    const now = new Date('2026-09-11T04:00:00Z'); // 主时点(03:17 UTC)之后

    // 有 pending:按递增间隔补签,索引前进
    let p = planNextCheckinRun(2, 0, now);
    assert.equal(p.delayMs, CATCHUP_DELAYS_MIN[0] * 60_000);
    assert.equal(p.catchupIndex, 1);
    p = planNextCheckinRun(2, 1, now);
    assert.equal(p.delayMs, CATCHUP_DELAYS_MIN[1] * 60_000);
    assert.equal(p.catchupIndex, 2);

    // 补签用尽:回落到次日主时点,计数归零
    const exhausted = planNextCheckinRun(2, CATCHUP_DELAYS_MIN.length, now);
    assert.equal(exhausted.catchupIndex, 0, '补签用尽后计数归零');
    const nextDay = new Date('2026-09-12T03:17:00Z');
    assert.ok(
      Math.abs(exhausted.delayMs - (nextDay.getTime() - now.getTime())) < 1000,
      '补签用尽后应等到次日主时点',
    );

    // 无 pending:直接排到次日主时点
    const idle = planNextCheckinRun(0, 0, now);
    assert.equal(idle.catchupIndex, 0);
    assert.ok(Math.abs(idle.delayMs - (nextDay.getTime() - now.getTime())) < 1000);

    // 主时点之前:排到当天的主时点
    const beforeMain = new Date('2026-09-11T01:00:00Z');
    const sameDay = planNextCheckinRun(0, 0, beforeMain);
    const todayMain = new Date('2026-09-11T03:17:00Z');
    assert.ok(
      Math.abs(sameDay.delayMs - (todayMain.getTime() - beforeMain.getTime())) < 1000,
      '主时点之前应排到当天主时点',
    );
    assert.equal(todayMain.getUTCHours(), CHECKIN_UTC_HOUR, '主时点为 UTC 03:17');
  }

  // 3. 管理 API:settings 读写 + 界面开关元素
  const { handleAdmin } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs'));
  const adminEnv = { ...baseEnv, ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'ss' };
  const login = await handleAdmin(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw' }),
  }), adminEnv, '/admin/login');
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { 'content-type': 'application/json', cookie: 'cb_admin=' + cookie, origin: 'https://w.example', 'X-Forwarded-For': nextIp() };

  const putRes = await handleAdmin(new Request('https://w.example/admin/api/settings', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ autoCheckin: false }),
  }), adminEnv, '/admin/api/settings');
  assert.equal(putRes.status, 200);

  const getRes = await handleAdmin(new Request('https://w.example/admin/api/settings', {
    method: 'GET', headers: auth,
  }), adminEnv, '/admin/api/settings');
  assert.equal((await getRes.json()).data.autoCheckin, false);

  // 4. 内容协商:浏览器访问 /v1/models、/health → HTML;API → JSON
  const browserHeaders = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'X-Forwarded-For': nextIp() };
  const modelsHtml = await callFetch(new Request('https://w.example/v1/models', { headers: browserHeaders }), baseEnv);
  assert.equal(modelsHtml.status, 200);
  assert.match(modelsHtml.headers.get('content-type'), /text\/html/);
  const modelsBody = await modelsHtml.text();
  assert.match(modelsBody, /模型目录/);
  assert.match(modelsBody, /glm-5\.3/);

  const healthHtml = await callFetch(new Request('https://w.example/health', { headers: browserHeaders }), baseEnv);
  assert.match(healthHtml.headers.get('content-type'), /text\/html/);
  assert.match(await healthHtml.text(), /网关运行正常/);

  const apiHeaders = { accept: 'application/json', 'X-Forwarded-For': nextIp() };
  const healthJson = await callFetch(new Request('https://w.example/health', { headers: apiHeaders }), baseEnv);
  assert.match(healthJson.headers.get('content-type'), /application\/json/);
  assert.equal((await healthJson.json()).status, 'ok');

  // 5. 控制台入口:未登录渲染登录页;已登录返回 SPA 入口(或未构建提示)
  const { handleAdmin: handleAdminConsole } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs'));
  const consoleEnv = { ...baseEnv, ADMIN_PASSWORD: 'pw-console', ADMIN_SESSION_SECRET: 'ss-console' };

  const anon = await handleAdminConsole(new Request('https://w.example/admin', {
    headers: { 'X-Forwarded-For': nextIp() },
  }), consoleEnv, '/admin');
  assert.equal(anon.status, 200);
  const anonHtml = await anon.text();
  assert.match(anonHtml, /login-form/, '未登录应返回登录页');
  assert.match(anonHtml, /type="password"/);

  const consoleLogin = await handleAdminConsole(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw-console' }),
  }), consoleEnv, '/admin/login');
  const consoleCookie = /cb_admin=([^;]+)/.exec(consoleLogin.headers.get('set-cookie'))[1];

  const consoleAuthed = await handleAdminConsole(new Request('https://w.example/admin', {
    headers: { cookie: 'cb_admin=' + consoleCookie, 'X-Forwarded-For': nextIp() },
  }), consoleEnv, '/admin');
  assert.equal(consoleAuthed.status, 200);
  const authedHtml = await consoleAuthed.text();
  assert.ok(
    authedHtml.includes('id="app"') || authedHtml.includes('控制台前端尚未构建'),
    '已登录应返回 SPA 入口或未构建提示',
  );

  // 目录穿越:不得读到产物目录之外的文件
  const traversalPath = '/admin/%2e%2e/package.json';
  const consoleTraversal = await handleAdminConsole(new Request('https://w.example' + traversalPath, {
    headers: { cookie: 'cb_admin=' + consoleCookie, 'X-Forwarded-For': nextIp() },
  }), consoleEnv, traversalPath);
  const traversalText = await consoleTraversal.text();
  assert.equal(traversalText.includes('codebuddy-gateway'), false, '目录穿越不得读取仓库文件');

  resetTokenStore();
  console.log('case10 settings & negotiation passed');
}
