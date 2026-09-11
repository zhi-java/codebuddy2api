// 用例 16:实时监控统计 + 日志缓冲 + 管理端监控接口
{
  const metricsMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/metrics.mjs'));
  const logsMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/logs.mjs'));

  metricsMod.resetMetrics();
  logsMod.resetLogs();

  const now = Date.now();
  metricsMod.recordRequest({ at: now - 120_000, path: '/v1/chat/completions', model: 'glm-5.3', status: 200, durationMs: 1200, credentialId: 'c1' });
  metricsMod.recordRequest({ at: now - 60_000, path: '/v1/chat/completions', model: 'glm-5.3', status: 200, durationMs: 800, credentialId: 'c1' });
  metricsMod.recordRequest({ at: now - 1_000, path: '/v1/messages', model: 'hy4-preview', status: 502, durationMs: 300, credentialId: 'c2', retried: true });

  const snap = metricsMod.metricsSnapshot(now);
  assert.equal(snap.totals.total, 3);
  // 延迟分位与聚合维度(总览页 KPI/分布图依赖)
  assert.equal(typeof snap.totals.p50Ms, 'number');
  assert.ok(snap.totals.p95Ms >= snap.totals.p50Ms);
  assert.ok(snap.totals.p99Ms >= snap.totals.p95Ms);
  assert.ok(snap.uptime.startedAt > 0 && snap.uptime.uptimeMs >= 0);
  assert.equal(snap.series[0].durationSumMs, 0);
  assert.equal(snap.byPath[0].key, '/v1/chat/completions');
  assert.equal(snap.byPath[0].total, 2);
  assert.equal(snap.byModel.length, 2);
  assert.equal(snap.statusBuckets.class2xx + snap.statusBuckets.class4xx + snap.statusBuckets.class5xx, 3);
  assert.equal(snap.recentErrors.length, 1);
  assert.equal(snap.recentErrors[0].status, 502);
  assert.equal(snap.totals.success, 2);
  assert.equal(snap.totals.error, 1);
  assert.equal(snap.totals.avgDurationMs, 767);
  assert.equal(snap.totals.successRate, 66.7);
  assert.equal(snap.totals.lastMinute, 1);
  // 60 分钟连续序列,便于直接画图
  assert.equal(snap.series.length, 60);
  assert.equal(snap.series[snap.series.length - 1].total, 1);
  assert.equal(snap.series[snap.series.length - 1].errors, 1);
  // 明细新的在前
  assert.equal(snap.recent[0].path, '/v1/messages');
  assert.equal(snap.recent[0].retried, true);

  // 超过 60 分钟的旧数据被裁剪
  metricsMod.recordRequest({ at: now, path: '/quota', model: '', status: 200, durationMs: 10 });
  const snap2 = metricsMod.metricsSnapshot(now + 61 * 60_000);
  assert.equal(snap2.series.length, 60);
  assert.equal(snap2.series[snap2.series.length - 1].total, 0, '61 分钟前的记录不应落在当前窗口');

  // 日志环形缓冲:新的在前,超出上限裁剪,且不写入正文类字段
  logsMod.pushLog('info', 'auto_checkin', '自动签到完成', { ok: 2, total: 3 });
  logsMod.pushLog('warn', 'credential_failover', '凭证 c1 返回 429，切换到下一个', { credentialId: 'c1' });
  logsMod.pushLog('error', 'upstream_failure', '上游 500', { status: 500 });
  const logs = logsMod.logSnapshot(10);
  assert.equal(logs.length, 3);
  assert.equal(logs[0].event, 'upstream_failure');
  assert.equal(logs[0].level, 'error');
  assert.equal(logs[1].event, 'credential_failover');
  assert.equal(logs[2].data.ok, 2);
  for (const entry of logs) {
    assert.equal(typeof entry.at, 'number');
    assert.equal(typeof entry.message, 'string');
  }

  // 管理接口:监控与日志(需登录)
  const { handleAdmin } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/admin.mjs'));
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  storeMod.resetTokenStore();
  const adminEnv = { ...baseEnv, ADMIN_PASSWORD: 'pw-metrics', ADMIN_SESSION_SECRET: 'sess-metrics' };
  const login = await handleAdmin(new Request('https://w.example/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ password: 'pw-metrics' }),
  }), adminEnv, '/admin/login');
  const cookie = /cb_admin=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
  const auth = { cookie: 'cb_admin=' + cookie, origin: 'https://w.example', 'X-Forwarded-For': nextIp() };

  const unauth = await handleAdmin(new Request('https://w.example/admin/api/metrics', {
    headers: { 'X-Forwarded-For': nextIp() },
  }), adminEnv, '/admin/api/metrics');
  assert.equal(unauth.status, 401);

  const metricsRes = await handleAdmin(new Request('https://w.example/admin/api/metrics', { headers: auth }), adminEnv, '/admin/api/metrics');
  assert.equal(metricsRes.status, 200);
  const metricsBody = await metricsRes.json();
  assert.equal(metricsBody.data.series.length, 60);
  assert.equal(typeof metricsBody.data.totals.total, 'number');

  const logsRes = await handleAdmin(new Request('https://w.example/admin/api/logs?limit=2', { headers: auth }), adminEnv, '/admin/api/logs');
  assert.equal(logsRes.status, 200);
  const logsBody = await logsRes.json();
  assert.equal(logsBody.data.length, 2);
  assert.equal(logsBody.data[0].event, 'upstream_failure');

  metricsMod.resetMetrics();
  logsMod.resetLogs();
  storeMod.resetTokenStore();

  console.log('case16 monitoring passed');
}
