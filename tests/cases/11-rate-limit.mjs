// 用例 11:限流策略(全局桶管 API;admin 免全局桶、走管理守卫)
{
  const { checkRateLimit } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/rate-limiter.mjs')
  );

  // 1. 令牌桶语义:突发 10 内放行,第 11 次起拒绝(确定性单测,不依赖时钟)
  const key = 'rl-unit-' + Math.random().toString(36).slice(2);
  let allowed = 0;
  for (let i = 0; i < 14; i++) {
    if (checkRateLimit(key, 60, 60_000, 10)) allowed += 1;
  }
  assert.equal(allowed, 10, '突发 10 次后应被限流');

  // 2. admin 管理面不被全局桶误伤:启用管理后,同 IP 连续 15 次访问 → 401(未登录)而非 429
  const adminEnvRl = { ...baseEnv, ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 'ss' };
  const adminIp = nextIp();
  const statuses = new Set();
  for (let i = 0; i < 15; i++) {
    const res = await callFetch(new Request('https://w.example/admin/api/state', {
      headers: { 'X-Forwarded-For': adminIp },
    }), adminEnvRl);
    statuses.add(res.status);
  }
  assert.equal(statuses.has(429), false, 'admin 不应被全局 429');
  assert.equal(statuses.has(401), true, '未登录访问管理 API 应 401');

  console.log('case11 rate limit passed');
}
