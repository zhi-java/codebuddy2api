// 用例 04:凭证解析 / 刷新 / 故障转移
{
  const credMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/credentials.mjs'));
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));
  const { resetTokenStore, getTokenStore, hashApiKey } = storeMod;

  const kvData = new Map();
  const kv = {
    async get(k) { return kvData.has(k) ? kvData.get(k) : null; },
    async put(k, v) { kvData.set(k, v); },
    async delete(k) { kvData.delete(k); },
  };
  const env = { CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'enc' };

  // 1. 透传模式:ck_ / JWT 原样
  const r1 = await credMod.resolveUpstreamCredential('Bearer ck_direct', env);
  assert.equal(r1.credential.token, 'ck_direct');
  assert.equal(r1.credential.kind, 'passthrough');
  const r2 = await credMod.resolveUpstreamCredential('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTk5OSJ9.sig', env);
  assert.equal(r2.credential.userId, 'u-999');

  // 2. 网关 key:未登记 → 401 语义
  resetTokenStore();
  await assert.rejects(
    () => credMod.resolveUpstreamCredential('Bearer sk-cb-unknown', env),
    credMod.UnauthorizedError,
  );

  // 3. 网关 key + 绑定凭证:正常解析;越权刷新跳过(expiresAt 充足)
  const st = getTokenStore(env);
  await st.saveCredential({
    id: 'cc1', name: '主', kind: 'ck_apikey', enabled: true,
    apiKey: 'ck_upstream_main', createdAt: 1, updatedAt: 1,
  });
  await st.saveCredential({
    id: 'cc2', name: '备', kind: 'cli_oauth', enabled: true,
    accessToken: 'jwt-main', refreshToken: 'rt-main',
    expiresAt: Date.now() + 3600_000, refreshExpiresAt: Date.now() + 86_400_000,
    createdAt: 1, updatedAt: 1,
  });
  await st.saveKey({
    id: 'kk1', name: 'Client', keyHash: await hashApiKey('sk-cb-good'),
    credentialIds: ['cc1', 'cc2'], enabled: true, createdAt: 1,
  });

  // 同级候选按过期时间最晚优先(cli_oauth 带远期 expiresAt)
  const ok = await credMod.resolveUpstreamCredential('Bearer sk-cb-good', env);
  assert.equal(ok.credential.token, 'jwt-main');
  assert.equal(ok.clientKey?.id, 'kk1');

  // 4. 停用首选 → 故障转移到 ck 凭证
  await st.saveCredential({
    id: 'cc2', name: '备', kind: 'cli_oauth', enabled: false,
    accessToken: 'jwt-main', refreshToken: 'rt-main',
    expiresAt: Date.now() + 3600_000, refreshExpiresAt: Date.now() + 86_400_000,
    createdAt: 1, updatedAt: 1,
  });
  const failover = await credMod.resolveUpstreamCredential('Bearer sk-cb-good', env);
  assert.equal(failover.credential.token, 'ck_upstream_main');

  // 5. 全部不可用 → UpstreamCredentialError
  await st.saveCredential({
    id: 'cc1', name: '主', kind: 'ck_apikey', enabled: false,
    apiKey: 'ck_upstream_main', createdAt: 1, updatedAt: 1,
  });
  await assert.rejects(
    () => credMod.resolveUpstreamCredential('Bearer sk-cb-good', env),
    credMod.UpstreamCredentialError,
  );

  // 6. 刷新:refreshToken 换新(带并发去重不影响结果正确性)
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0,
    data: { accessToken: 'jwt-new', refreshToken: 'rt-new', expiresIn: 5184000, refreshExpiresIn: 7776000 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const refreshed = await credMod.refreshCredential({
      id: 'cc9', name: 'R', kind: 'cli_oauth', enabled: true,
      accessToken: 'jwt-old', refreshToken: 'rt-old',
      expiresAt: 1, createdAt: 1, updatedAt: 1,
    }, env);
    assert.equal(refreshed.accessToken, 'jwt-new');
    assert.equal(refreshed.refreshToken, 'rt-new');
  } finally { globalThis.fetch = originalFetch; }

  resetTokenStore();
  console.log('case04 credentials passed');
}
