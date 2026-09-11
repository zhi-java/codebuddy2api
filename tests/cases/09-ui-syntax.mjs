// 用例 09:服务端页面渲染回归 + 控制台静态托管安全
{
  const { renderLoginPage, renderLandingPage, renderPublicModelsPage, renderHealthPage } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/admin-ui.mjs')
  );
  const { serveStaticFile, serveAppShell } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/static.mjs')
  );

  const pages = [
    ['登录页', renderLoginPage()],
    ['落地页', renderLandingPage()],
    ['模型目录', renderPublicModelsPage([{ id: 'hy4-preview', _name: 'Hy4 preview' }])],
    ['健康页', renderHealthPage()],
  ];

  for (const [label, html] of pages) {
    // 内嵌脚本必须语法合法(登录页有表单脚本,其余为纯静态)
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    scripts.forEach((code, index) => {
      try {
        new Function(code);
      } catch (err) {
        assert.fail(label + ' script' + index + ' 语法错误: ' + err.message);
      }
    });

    if (label === '登录页') {
      assert.ok(html.includes('type="password"'), '登录页需含密码输入框');
      assert.ok(html.includes('login-form'), '登录页需含 login-form 钩子');
      assert.ok(html.includes('/admin/login'), '登录页需提交到 /admin/login');
    }
    if (label === '落地页') {
      assert.ok(html.includes('/v1/messages'));
      assert.ok(html.includes('/admin'));
    }
  }

  // 静态托管:正常命中 + 目录穿越必须被拒绝
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const root = await mkdtemp(pathMod.join(osMod.tmpdir(), 'cb-static-'));
  await mkdir(pathMod.join(root, 'assets'), { recursive: true });
  await writeFile(pathMod.join(root, 'index.html'), '<!DOCTYPE html><div id="app"></div>');
  await writeFile(pathMod.join(root, 'assets', 'index-abc12345.js'), 'export const a = 1;');
  await writeFile(pathMod.join(root, 'outside.txt'), 'secret');

  const assetRes = await serveStaticFile(root, '/admin/assets/index-abc12345.js', '/admin');
  assert.ok(assetRes, '命中的静态资源应返回响应');
  assert.match(assetRes.headers.get('content-type'), /javascript/);
  assert.match(assetRes.headers.get('cache-control'), /immutable/, '带 hash 的资源应长缓存');

  const shellRes = await serveAppShell(root);
  assert.ok(shellRes, '应能读取 SPA 入口');
  assert.equal(shellRes.headers.get('cache-control'), 'no-store', '入口文件不缓存');
  assert.match(await shellRes.text(), /id="app"/);

  const missed = await serveStaticFile(root, '/admin/assets/missing.js', '/admin');
  assert.equal(missed, null, '未命中返回 null 交给调用方降级');

  const traversal = await serveStaticFile(root, '/admin/../outside.txt', '/admin');
  if (traversal) {
    assert.equal(await traversal.text(), 'secret', '路径未出目录时属于正常读取');
  }
  const encodedTraversal = await serveStaticFile(root, '/admin/%2e%2e/outside.txt', '/admin');
  assert.equal(encodedTraversal, null, '编码后的目录穿越必须被拒绝');

  console.log('case09 ui syntax passed');
}
