// 用例 23:计费基址真正生效(UPSTREAM_BILLING_BASE 注入 + host/x-domain 派生)
//
// 回归背景:UPSTREAM_BILLING_BASE 此前在 upstream-billing 中被读取,但
// buildNodeEnv 未注入、Env 未声明,且 host/x-domain 硬编码国内版——
// 该配置项形同虚设。这里锁死「改基址 → URL 与身份头同步变化」。
{
  const billMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/upstream-billing.mjs'));

  const cred = { id: 'x1', name: 'CK', kind: 'ck_apikey', enabled: true, apiKey: 'ck-live', createdAt: 1, updatedAt: 1 };

  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    // 默认:国内版基址与身份头
    await billMod.fetchCredentialQuota(cred, {});
    assert.equal(seen[0].url, 'https://copilot.tencent.com/v2/billing/meter/get-user-resource');
    assert.equal(seen[0].headers.get('host'), 'copilot.tencent.com');
    assert.equal(seen[0].headers.get('x-domain'), 'copilot.tencent.com');

    // 覆盖基址:请求地址与 host/x-domain 必须同步切换
    await billMod.fetchCredentialQuota(cred, { UPSTREAM_BILLING_BASE: 'https://copilot.tencent.com/intl/' });
    assert.equal(
      seen[1].url,
      'https://copilot.tencent.com/intl/v2/billing/meter/get-user-resource',
      '自定义基址应生效(尾斜杠需被规整)',
    );
    assert.equal(seen[1].headers.get('host'), 'copilot.tencent.com');
    assert.equal(seen[1].headers.get('x-domain'), 'copilot.tencent.com');

    // 换域:host/x-domain 必须跟随,否则上游按渠道准入拒绝
    await billMod.fetchCredentialQuota(cred, { UPSTREAM_BILLING_BASE: 'https://intl.example.com' });
    assert.equal(seen[2].url, 'https://intl.example.com/v2/billing/meter/get-user-resource');
    assert.equal(seen[2].headers.get('host'), 'intl.example.com', 'host 必须从基址派生');
    assert.equal(seen[2].headers.get('x-domain'), 'intl.example.com', 'x-domain 必须从基址派生');
  } finally { globalThis.fetch = originalFetch; }

  console.log('case23 billing base config passed');
}

// 用例 23b:buildNodeEnv 把 UPSTREAM_BILLING_BASE 注入 Env
//
// 该字段此前未注入 Node 环境,导致所有自定义基址在 Node/Docker 部署下失效。
{
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');

  const serverSrc = fsMod.readFileSync(pathMod.join(process.cwd(), 'src', 'server.ts'), 'utf8');

  // 注入语句必须存在,且取值来自进程环境
  assert.match(
    serverSrc,
    /UPSTREAM_BILLING_BASE\s*\?\s*\{\s*UPSTREAM_BILLING_BASE:\s*env\.UPSTREAM_BILLING_BASE\s*\}/,
    'buildNodeEnv 必须注入 UPSTREAM_BILLING_BASE',
  );

  // Env 接口须声明该字段(否则注入会被 tsc 拒绝)
  const utilsSrc = fsMod.readFileSync(pathMod.join(process.cwd(), 'src', 'utils.ts'), 'utf8');
  assert.match(utilsSrc, /UPSTREAM_BILLING_BASE\?:/, 'Env 必须声明 UPSTREAM_BILLING_BASE');

  console.log('case23b billing base env injection passed');
}