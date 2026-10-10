// 用例 24:区域档案（国内版 / 国际版）
//
// 锁定三件事：
//   ① 档案是端点与渠道指纹的**单一真相源**，两区取值互不串味
//   ② 国际版无「每日签到」能力（该活动为国内版专属）
//   ③ 从 JWT 的 iss 可推断区域 —— 国际版令牌由 Keycloak 签发
{
  const region = await import(pathToFileURL(process.cwd() + '/' + outDir + '/region.mjs'));

  // ── ① 端点 ──
  const cn = region.profileFor('cn');
  const intl = region.profileFor('intl');

  assert.equal(region.endpointUrl(cn, 'chatCompletions'), 'https://copilot.tencent.com/v2/chat/completions');
  assert.equal(region.endpointUrl(intl, 'chatCompletions'), 'https://www.codebuddy.ai/v2/chat/completions');

  // 刷新端点：两区**路径同名**（实测 200），仅域名不同 —— 这是最容易
  // 想当然写错的一处（见 24c 的背景说明）
  assert.equal(region.endpointUrl(cn, 'refresh'), 'https://copilot.tencent.com/v2/plugin/auth/token/refresh');
  assert.equal(region.endpointUrl(intl, 'refresh'), 'https://www.codebuddy.ai/v2/plugin/auth/token/refresh');
  assert.equal(cn.paths.refresh, intl.paths.refresh, '刷新路径两区一致');
  assert.notEqual(cn.apiBase, intl.apiBase, '差异在域名');

  // 额度：国际版无 /v2 前缀（实测差异，最容易照抄错的一处）
  assert.equal(cn.paths.quota, '/v2/billing/meter/get-user-resource');
  assert.equal(intl.paths.quota, '/billing/meter/get-user-resource');

  // 缺省（存量凭证无 region 字段）必须落国内版，保证向后兼容
  assert.equal(region.profileFor(undefined), cn);

  // ── ② 能力开关 ──
  assert.equal(cn.features.dailyCheckin, true, '国内版有每日签到');
  assert.equal(intl.features.dailyCheckin, false, '国际版无每日签到');

  // ── ③ 区域推断 ──
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const intlJwt = `${b64({ alg: 'HS512', typ: 'JWT' })}.${b64({
    iss: 'https://www.codebuddy.ai/auth/realms/copilot',
    azp: 'console',
  })}.sig`;
  const cnJwt = `${b64({ alg: 'HS512' })}.${b64({ sub: 'u-1', typ: 'Offline' })}.sig`;

  assert.equal(region.detectRegionFromToken(intlJwt), 'intl', 'iss 含 codebuddy.ai → 国际版');
  // 无国际版特征时返回 undefined 而非 'cn'：推断不出就说"不知道"，
  // 由调用方按缺省口径处理，不在这里伪造结论
  assert.equal(region.detectRegionFromToken(cnJwt), undefined, '无国际版 iss → 不推断');
  assert.equal(region.detectRegionFromToken('ck_not-a-jwt'), undefined, '非 JWT 不推断');
  assert.equal(region.detectRegionFromToken(undefined), undefined);
  assert.equal(region.detectRegionFromToken('eyJbroken.sig.here'), undefined, '载荷损坏不抛异常');

  // ── 渠道指纹：ck_ 不得冒充 CLI 会话 ──
  // sessionFingerprint 仅 CLI 会话可带；clientUserAgent 两类都要带
  assert.ok(cn.fingerprint.sessionFingerprint['x-ide-type'] === 'CLI');
  assert.equal(intl.fingerprint.sessionFingerprint['x-ide-type'], undefined,
    '国际版不发国内版的 x-ide-* 渠道指纹');
  assert.ok(cn.fingerprint.clientUserAgent, '国内版两类凭证都需 UA（缺失即 403）');

  console.log('case24 region profile passed');
}

// 用例 24b:计费与签到按区域路由
{
  const billMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/upstream-billing.mjs'));

  const intlCred = {
    id: 'i1', name: 'Intl', kind: 'cli_oauth', enabled: true, region: 'intl',
    accessToken: 'jwt-intl', userId: 'u-1',
    refreshExpiresAt: Date.now() + 86400000, expiresAt: Date.now() + 86400000,
    createdAt: 1, updatedAt: 1,
  };

  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    // 国际版额度：走无 /v2 前缀的路径，且 host/x-domain 跟随门户 origin
    await billMod.fetchCredentialQuota(intlCred, {});
    assert.equal(seen[0].url, 'https://www.codebuddy.ai/billing/meter/get-user-resource');
    assert.equal(seen[0].headers.get('host'), 'www.codebuddy.ai');
    assert.equal(seen[0].headers.get('x-domain'), 'www.codebuddy.ai');
    // 国际版不应携带国内版的 CLI 会话指纹
    assert.equal(seen[0].headers.get('x-ide-type'), null, '国际版不应发 x-ide-* 指纹');
    // 但 UA 必须带（缺失会被上游拒）
    assert.ok(seen[0].headers.get('user-agent'), '国际版同样需要 UA');

    // 国际版签到：明确拒绝，且不得发出注定失败的请求
    seen.length = 0;
    await assert.rejects(
      () => billMod.fetchCheckinStatus(intlCred, {}),
      /国际版无每日签到/,
      '国际版签到应给出明确错误',
    );
    await assert.rejects(() => billMod.fetchDailyCheckin(intlCred, {}), /国际版无每日签到/);
    assert.equal(seen.length, 0, '国际版签到不应向上游发请求');

    // UPSTREAM_BILLING_BASE 不得污染国际版基址
    seen.length = 0;
    await billMod.fetchCredentialQuota(intlCred, { UPSTREAM_BILLING_BASE: 'https://copilot.tencent.com' });
    assert.equal(seen[0].url, 'https://www.codebuddy.ai/billing/meter/get-user-resource',
      'UPSTREAM_BILLING_BASE 只覆盖国内版');
  } finally { globalThis.fetch = originalFetch; }

  console.log('case24b billing region routing passed');
}

// 用例 24c:刷新链路（端点路由 / 请求形态 / 响应兼容 / 存量环境变量隔离）
//
// 背景订正：最初的档案把国际版刷新端点设为 /v2/auth/token/refresh ——
// 该路径取自官方 CLI 分发包，实际属于**企业微信插件**链路
// （WxAuthenticationProvider），在网页版域名下恒 404。真实链路测试发现后
// 改为 /v2/plugin/auth/token/refresh（与国内版同名，仅域名不同）。
{
  const credMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/credentials.mjs'));

  const intlCred = {
    id: 'i1', name: 'Intl', kind: 'cli_oauth', enabled: true, region: 'intl',
    accessToken: 'old', refreshToken: 'rt-intl', userId: 'u-1',
    refreshExpiresAt: Date.now() + 86400000, expiresAt: Date.now() + 86400000,
    createdAt: 1, updatedAt: 1,
  };

  const originalFetch = globalThis.fetch;
  const seen = [];
  let responseBody = { code: 0, data: { accessToken: 'new-intl', expiresIn: 3600 } };
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response(JSON.stringify(responseBody),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    // 端点：与国内版同名，域名不同（实测 200）
    const updated = await credMod.refreshCredential(intlCred, {});
    assert.equal(seen[0].url, 'https://www.codebuddy.ai/v2/plugin/auth/token/refresh',
      '国际版刷新端点为 /v2/plugin/auth/token/refresh');
    // 请求形态与国内版一致
    assert.equal(seen[0].headers.get('x-refresh-token'), 'rt-intl');
    assert.equal(seen[0].headers.get('x-auth-refresh-source'), 'plugin');
    assert.equal(updated.accessToken, 'new-intl');
    assert.ok(updated.expiresAt > Date.now(), 'expiresIn 应换算为绝对时间');

    // 响应体缺少 code 时不得误判为失败（字段存在才校验）
    seen.length = 0;
    responseBody = { data: { accessToken: 'new-nocode', expiresIn: 3600 } };
    const noCode = await credMod.refreshCredential(intlCred, {});
    assert.equal(noCode.accessToken, 'new-nocode', '缺少 code 字段不应导致失败');

    // code 非 0 时仍须判为失败
    seen.length = 0;
    responseBody = { code: 1, msg: 'invalid', data: { accessToken: 'x' } };
    await assert.rejects(() => credMod.refreshCredential(intlCred, {}), /refresh rejected/);

    // 存量环境变量隔离：UPSTREAM_REFRESH_URL 只覆盖国内版
    responseBody = { code: 0, data: { accessToken: 'ok', expiresIn: 3600 } };
    seen.length = 0;
    await credMod.refreshCredential(intlCred, { UPSTREAM_REFRESH_URL: 'https://cn.example.com/refresh' });
    assert.equal(seen[0].url, 'https://www.codebuddy.ai/v2/plugin/auth/token/refresh',
      '国际版刷新端点恒取档案，不被存量环境变量覆盖');

    // 国内版仍走存量环境变量（向后兼容）
    seen.length = 0;
    const cnCred = { ...intlCred, region: 'cn' };
    await credMod.refreshCredential(cnCred, { UPSTREAM_REFRESH_URL: 'https://cn.example.com/refresh' });
    assert.equal(seen[0].url, 'https://cn.example.com/refresh', '国内版刷新端点仍可被覆盖');
  } finally { globalThis.fetch = originalFetch; }

  console.log('case24c refresh chain passed');
}

// 用例 24d:国际版两条硬约束（真实链路实测确认）
//
//   ① 强制流式：非流式请求返回 400「Non-stream chat request is currently
//      not supported」
//   ② 首条消息必须是 system prompt，否则 400「first message is not system
//      prompt」
//
// 两条都只对国际版生效，国内版不受影响。
{
  const region = await import(pathToFileURL(process.cwd() + '/' + outDir + '/region.mjs'));

  assert.equal(region.CN_PROFILE.features.requireLeadingSystem, false, '国内版无首条 system 约束');
  assert.equal(region.INTL_PROFILE.features.requireLeadingSystem, true, '国际版要求首条 system');

  // 档案来源订正：国际版刷新端点与国内版同名，仅域名不同。
  // 最初误采了官方 CLI 里的 /v2/auth/token/refresh —— 那条路径属于企业微信
  // 插件链路（WxAuthenticationProvider），在网页版域名下恒 404，
  // 由真实链路测试发现。
  assert.equal(
    region.INTL_PROFILE.paths.refresh,
    '/v2/plugin/auth/token/refresh',
    '国际版刷新端点应为 /v2/plugin/auth/token/refresh',
  );
  assert.notEqual(region.INTL_PROFILE.apiBase, region.CN_PROFILE.apiBase);

  // 国际版模型目录实测含国内混元系模型（hy4-preview / hy3），
  // 因此静态快照「国际版返回空列表」的保守策略虽不致错，但确实偏保守：
  // 上游可达时走实时目录，不受影响。
  assert.equal(region.INTL_PROFILE.paths.config, '/v3/config');

  console.log('case24d intl hard constraints passed');
}

// 用例 24e:prepareChatPayload 按区域适配（首条 system 补齐）
{
  const payloadMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/payload.mjs'));

  const env = { EMIT_THINKING: 'off' };
  const intlCred = { token: 't', kind: 'cli_oauth', region: 'intl' };
  const cnCred = { token: 't', kind: 'cli_oauth', region: 'cn' };

  // 国际版：首条 user → 补一条 system 占位
  const intlOut = await payloadMod.prepareChatPayload(
    { model: 'hy3', messages: [{ role: 'user', content: 'hi' }], stream: false },
    env,
    intlCred,
  );
  assert.equal(intlOut['messages'][0].role, 'system', '国际版应补首条 system');
  assert.equal(intlOut['messages'].length, 2, '补占位不应丢原消息');
  assert.equal(intlOut['messages'][1].role, 'user');
  assert.equal(intlOut['stream'], true, '国际版强制流式');

  // 已有 system → 不重复插入
  const intlWithSystem = await payloadMod.prepareChatPayload(
    { model: 'hy3', messages: [{ role: 'system', content: 'you are x' }, { role: 'user', content: 'hi' }] },
    env,
    intlCred,
  );
  assert.equal(
    intlWithSystem['messages'].filter((m) => m.role === 'system').length,
    1,
    '已有 system 时不应再插入',
  );

  // 国内版：不得插入（保持既有行为）
  const cnOut = await payloadMod.prepareChatPayload(
    { model: 'hy3', messages: [{ role: 'user', content: 'hi' }] },
    env,
    cnCred,
  );
  assert.equal(cnOut['messages'][0].role, 'user', '国内版不应补 system');

  console.log('case24e region payload adaptation passed');
}

// 用例 24f:故障转移不跨区
//
// 跨区必然 401。若不收敛，一个 Key 同时绑定两区凭证时，每次失败都会把
// 故障转移到另一区凭证，把单区故障放大成全池不可用。
{
  const credMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/credentials.mjs'));
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));

  const mem = new Map();
  const kv = {
    async get(k) { return mem.has(k) ? mem.get(k) : null; },
    async put(k, v) { mem.set(k, v); },
    async delete(k) { mem.delete(k); },
  };
  const env = {
    CREDENTIALS_KV: kv,
    CREDENTIALS_ENC_SECRET: 'test-secret-32-bytes-padding-here!!',
    GATEWAY_KEY_PREFIX: 'sk-cb',
  };

  const store = storeMod.getTokenStore(env);
  await store.saveCredential({
    id: 'c-cn', name: 'CN', kind: 'ck_apikey', enabled: true, region: 'cn',
    apiKey: 'ck-cn', createdAt: 1, updatedAt: 1,
  });
  // 国际版给更晚的 expiresAt，使其在排序中成为首选（锚点）
  await store.saveCredential({
    id: 'c-intl', name: 'INTL', kind: 'ck_apikey', enabled: true, region: 'intl',
    apiKey: 'ck-intl', expiresAt: Date.now() + 3600_000, createdAt: 1, updatedAt: 1,
  });
  await store.saveKey({
    id: 'k-mixed', name: '混合池', keyHash: await storeMod.hashApiKey('sk-cb-mixed'),
    credentialIds: ['c-cn', 'c-intl'], enabled: true, createdAt: 1,
  });

  // ① 混合池：首选不得跨区。两区凭证同级时按过期时间排序，
  //    这里给国际版更晚的 expiresAt 以确保它被选为锚点，
  //    若无区域收敛就会命中国际版凭证。
  const mixed = await credMod.resolveUpstreamCredential('Bearer sk-cb-mixed', env);
  assert.equal(mixed.credential.region, 'intl', '混合池锚点应为国际版');
  assert.equal(mixed.credential.token, 'ck-intl');

  // ② 同区内多凭证：故障转移可跨凭证，但不跨区。
//    首选(intl)失效后应改用同区的另一个 intl 凭证，
//    而不是跳到 cn —— cn 凭证虽然健康，但跨区必然 401。
//    c-intl2 需带更晚的 expiresAt 才能在排序中压过 c-cn（ck_ 凭证无过期时间）
  await store.saveCredential({
    id: 'c-intl', name: 'INTL', kind: 'ck_apikey', enabled: true, region: 'intl',
    apiKey: 'ck-intl', expiresAt: Date.now() + 3600_000, createdAt: 1, updatedAt: 1,
  });
  await store.saveCredential({
    id: 'c-intl2', name: 'INTL2', kind: 'ck_apikey', enabled: true, region: 'intl',
    apiKey: 'ck-intl2', expiresAt: Date.now() + 7200_000, createdAt: 1, updatedAt: 1,
  });
  await store.saveKey({
    id: 'k-mixed', name: '混合池', keyHash: await storeMod.hashApiKey('sk-cb-mixed'),
    credentialIds: ['c-cn', 'c-intl', 'c-intl2'], enabled: true, createdAt: 1,
  });
  // 停用首选 intl，剩余 c-intl2(有 expiresAt) 与 c-cn(无)，排序后 intl2 在前
  await store.saveCredential({
    id: 'c-intl', name: 'INTL', kind: 'ck_apikey', enabled: false, region: 'intl',
    apiKey: 'ck-intl', expiresAt: Date.now() + 3600_000, createdAt: 1, updatedAt: 1,
  });

  const failover = await credMod.resolveUpstreamCredential('Bearer sk-cb-mixed', env);
  assert.equal(failover.credential.region, 'intl', '同区故障转移应留在 intl');
  assert.equal(failover.credential.token, 'ck-intl2');

  // ③ 首选区的凭证全部失效 → 重新锚定到另一区是正确行为
  //    （此时 intl 区无可用凭证，选 cn 凭证并非"跨区故障转移"，
  //      而是重新选择；真正的约束是不在健康首选区内乱跳）
  await store.saveCredential({
    id: 'c-intl2', name: 'INTL2', kind: 'ck_apikey', enabled: false, region: 'intl',
    apiKey: 'ck-intl2', createdAt: 1, updatedAt: 1,
  });
  const reanchor = await credMod.resolveUpstreamCredential('Bearer sk-cb-mixed', env);
  assert.equal(reanchor.credential.region, 'cn', '首选区全失效后可回退到另一区');
  assert.equal(reanchor.credential.token, 'ck-cn');

  // ④ 只绑定国内版的 Key 不受该约束影响（不会被误伤）
  await store.saveKey({
    id: 'k-cn', name: '仅国内', keyHash: await storeMod.hashApiKey('sk-cb-cn'),
    credentialIds: ['c-cn'], enabled: true, createdAt: 1,
  });
  const cnOnly = await credMod.resolveUpstreamCredential('Bearer sk-cb-cn', env);
  assert.equal(cnOnly.credential.region, 'cn');
  assert.equal(cnOnly.credential.token, 'ck-cn');

  // ④ 透传凭证的区域由令牌自身推断（国际版 iss 特征）
  const passthrough = await credMod.resolveUpstreamCredential('Bearer ck_plain', env);
  assert.equal(passthrough.credential.region, 'cn', '无法推断时按国内版，保持存量行为');

  console.log('case24f no cross-region failover passed');
}
// 用例 24g:管理端测试链路必须与转发链路一致（都用 refreshToken 换取）
//
// 背景：控制台的「连通测试 / 试跑」此前直接读 accessToken，而转发链路
// 走 ensureValidToken 会自动刷新。导致「只填了 refreshToken」的凭证在
// 测试功能里报 `Credential has no usable token`，但真实请求其实可用 ——
// 同一凭证在两条链路上行为不一致，用户看到的现象是「配了却用不了」。
{
  const credMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/credentials.mjs'));
  const storeMod = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs'));

  const mem = new Map();
  const kv = {
    async get(k) { return mem.has(k) ? mem.get(k) : null; },
    async put(k, v) { mem.set(k, v); },
    async delete(k) { mem.delete(k); },
  };
  const env = {
    CREDENTIALS_KV: kv,
    CREDENTIALS_ENC_SECRET: 'test-secret-32-bytes-padding-here!!',
    GATEWAY_KEY_PREFIX: 'sk-cb',
  };
  const store = storeMod.getTokenStore(env);

  const rtOnly = {
    id: 'rt-only', name: '仅 refreshToken', kind: 'cli_oauth', enabled: true, region: 'intl',
    refreshToken: 'rt-intl', createdAt: 1, updatedAt: 1,
  };
  await store.saveCredential(rtOnly);

  // 只填 refreshToken 的凭证**可以**是 healthy —— 它能靠刷新换取 token。
  // 真正不可用的是「两种 token 都没有」，那种情况才必须判死（见下方断言）。
  const beforeStatus = credMod.getCredentialStatus(rtOnly);
  assert.equal(beforeStatus, 'healthy', '持 refreshToken 的凭证靠刷新即可用，不该判死');

  const originalFetch = globalThis.fetch;
  let refreshed = false;
  globalThis.fetch = async () => {
    refreshed = true;
    return new Response(JSON.stringify({ code: 0, data: { accessToken: 'fresh-at', expiresIn: 3600 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // 管理端路径（修复后）：应先刷新再返回 token
    const { ensureValidToken } = credMod;
    const effective = await ensureValidToken(rtOnly, env);
    assert.ok(refreshed, '仅持 refreshToken 时应先自动刷新');
    assert.equal(effective.accessToken, 'fresh-at', '刷新后应产出 accessToken');
    assert.equal(effective.region, 'intl', '刷新不得丢失区域');

    // 刷新后凭证恢复可选
    const list = await store.listCredentials();
    const found = list.find((c) => c.id === 'rt-only');
    assert.equal(found.accessToken, 'fresh-at', '刷新结果应落库');
    assert.equal(credMod.getCredentialStatus(found), 'healthy', '刷新后应恢复健康');
  } finally { globalThis.fetch = originalFetch; }

  // 两种 token 皆无 → 必须判为不可用，不能报 healthy
  assert.equal(
    credMod.getCredentialStatus({ id: 'empty', kind: 'cli_oauth', enabled: true, createdAt: 1, updatedAt: 1 }),
    'expired',
    '既无 accessToken 也无 refreshToken 应判为 expired',
  );
  assert.equal(
    credMod.getCredentialStatus({ id: 'empty-ck', kind: 'ck_apikey', enabled: true, createdAt: 1, updatedAt: 1 }),
    'expired',
    '空 apiKey 的控制台 Key 应判为 expired',
  );

  console.log('case24g admin test chain parity passed');
}

// 用例 24h:管理端（连通测试 / 试跑）的上游请求必须按区域路由
//
// 背景：这三个入口此前直接取 env.UPSTREAM_CHAT_COMPLETIONS_URL 并裸构请求头，
// 国际版凭证会被打到国内域名(copilot.tencent.com) → 必然 401。
// 控制台上的「测试」正是用户判断凭证可用性的主要入口，报 401 会让人
// 误判为凭证本身失效。同时它们也绕过了 prepareChatPayload，缺少国际版
// 所需的渠道指纹与首条 system 约束。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'admin.ts'), 'utf8');

  // 管理端不得再直连国内版常量（该常量会被 server.ts 注入为国内版地址）
  const directCalls = src.match(/fetchWithTimeout\(env,\s*env\.UPSTREAM_CHAT_COMPLETIONS_URL/g) ?? [];
  assert.equal(directCalls.length, 0, '管理端不得直连 env.UPSTREAM_CHAT_COMPLETIONS_URL');

  const bareFetch = src.match(/fetch\(url,\s*\{[\s\S]{0,400}?authorization:\s*`Bearer/g) ?? [];
  assert.equal(bareFetch.length, 0, '不得绕过共用构造器裸构上游请求');

  // 三处入口都应经由 upstreamTargetFor + prepareChatPayload
  const targetCalls = src.match(/upstreamTargetFor\(/g) ?? [];
  assert.ok(targetCalls.length >= 4, `连通测试/试跑两处 + 定义应共用上游构造（实际 ${targetCalls.length} 处）`);

  // 不得再出现「无可用 token」的裸判断（三处已统一为 usableTokenFor）
  // 只查代码行：注释里会引用该文案说明修复背景
  const codeLines = src.split('\n').filter((l) => !l.trimStart().startsWith('*'));
  assert.equal(
    codeLines.filter((l) => l.includes('Credential has no usable token')).length, 0,
    '管理端应先经 ensureValidToken 刷新再取 token',
  );

  console.log('case24h admin upstream region routing passed');
}

// 用例 24i:凭证区域可修改（选错后有纠正入口）
//
// 区域配错的后果是所有请求 401，而密钥材料与签发方绑定、无法跨区域复用。
// 若 PUT 不支持改 region，用户只能删除凭证后重新粘贴 token —— 正是实际
// 使用中踩到的坑：录入时选错区域 → 测试失败 → 只能重来。
{
  const fs = await import('node:fs');
  const path = await import('node:path');

  const adminSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'admin.ts'), 'utf8');
  // PUT 分支必须处理 region，且用白名单校验（避免任意字符串落库）
  // 断言写成单行形式：源文件为 CRLF，多行正则会因 \n 不匹配而误报
  assert.match(
    adminSrc,
    /isRegion\(body\.region\) && body\.region !== updated\.region/,
    'PUT /credentials 必须支持修改 region',
  );

  const viewSrc = fs.readFileSync(
    path.join(process.cwd(), 'web', 'src', 'views', 'CredentialsView.vue'), 'utf8',
  );
  assert.match(viewSrc, /label: '修改区域'/, '控制台需提供修改区域入口');
  assert.match(viewSrc, /body: \{ region: regionValue\.value \}/, '需提交 region 变更');

  console.log('case24i credential region editable passed');
}
