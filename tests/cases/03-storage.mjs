// 用例 03:存储与加密
{
  const { resetTokenStore, getTokenStore, hashApiKey } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs')
  );
  const { sha256Hex } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/crypto.mjs')
  );

  const kvData = new Map();
  const kv = {
    async get(k) { return kvData.has(k) ? kvData.get(k) : null; },
    async put(k, v) { kvData.set(k, v); },
    async delete(k) { kvData.delete(k); },
  };
  resetTokenStore();
  const store = getTokenStore({ CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: 'test-enc' });

  // Key 哈希
  assert.equal(await hashApiKey('sk-cb-abc'), await sha256Hex('sk-cb-abc'));

  // 凭证落盘加密:原始 token 不出现于 KV 原文
  await store.saveCredential({
    id: 'c1', name: 'A', kind: 'ck_apikey', enabled: true,
    apiKey: 'ck_secret_value', createdAt: 1, updatedAt: 1,
  });
  const rawStored = kvData.get('cred:c1') ?? '';
  assert.equal(String(rawStored).includes('ck_secret_value'), false, 'KV 不得存明文 token');

  const loaded = await store.getCredential('c1');
  assert.equal(loaded?.apiKey, 'ck_secret_value');

  // 客户端 key 绑定凭证引用
  await store.saveKey({
    id: 'k1', name: 'K', keyHash: await hashApiKey('sk-cb-k1'),
    credentialIds: ['c1'], enabled: true, createdAt: 1,
    modelAliases: { 'a': 'b' },
  });
  const key = await store.getKeyByHash(await hashApiKey('sk-cb-k1'));
  assert.equal(key?.credentialIds[0], 'c1');
  assert.equal(key?.modelAliases?.a, 'b');

  // 删除凭证清理索引
  await store.deleteCredential('c1');
  assert.equal(await store.getCredential('c1'), undefined);

  resetTokenStore();
  console.log('case03 storage passed');
}
