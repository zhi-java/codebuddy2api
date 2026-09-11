// 用例 12:按凭证类型构造上游计费头(ck_ 轻头 / CLI 会话头)
{
  const billMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/upstream-billing.mjs'));

  const ckCred = { id: 'x1', name: 'CK', kind: 'ck_apikey', enabled: true, apiKey: 'ck-live', createdAt: 1, updatedAt: 1 };
  const cliCred = { id: 'x2', name: 'CLI', kind: 'cli_oauth', enabled: true, accessToken: 'jwt-live', userId: 'u-1', refreshExpiresAt: Date.now() + 86400000, expiresAt: Date.now() + 86400000, createdAt: 1, updatedAt: 1 };

  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(new Headers(init.headers));
    return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await billMod.fetchCredentialQuota(ckCred, {});
    await billMod.fetchCredentialQuota(cliCred, {});

    // ck_:通用客户端形态(不得冒充 CLI 会话,但必须带 UA,否则上游 403)
    const ckHeaders = seen[0];
    assert.equal(ckHeaders.get('authorization'), 'Bearer ck-live');
    assert.ok(ckHeaders.get('user-agent'), 'ck_ 必须显式带 UA(缺失被上游 403)');
    assert.equal(ckHeaders.get('x-ide-type'), null, 'ck_ 不应带 CLI 会话头');
    assert.equal(ckHeaders.get('x-user-id'), null);
    assert.equal(ckHeaders.get('x-codebuddy-request'), null);

    // cli_oauth:完整 CLI 会话形态(签到/额度实测需要)
    const cliHeaders = seen[1];
    assert.equal(cliHeaders.get('authorization'), 'Bearer jwt-live');
    assert.equal(cliHeaders.get('x-ide-type'), 'CLI');
    assert.equal(cliHeaders.get('x-user-id'), 'u-1');
    assert.equal(cliHeaders.get('user-agent'), 'CLI/2.107.0 CodeBuddy/2.107.0');
  } finally { globalThis.fetch = originalFetch; }

  console.log('case12 billing headers passed');
}
