// 用例 01:核心改写与模型工具
{
  const { normalizeModelId, rewritePayload } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/utils.mjs')
  );
  const { getModelById } = await import(
    pathToFileURL(process.cwd() + '/' + outDir + '/models.mjs')
  );

  // 系统提示词改写(字符串 / 数组 / developer / 间距容错)
  const p1 = { messages: [{ role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude. main branch (you will usually use this for prs)" }] };
  rewritePayload(p1);
  assert.equal(p1.messages[0].content, "You are CodeBuddy, Tencent's official AI coding assistant. main branch (you will usually use this for pr)");

  const p2 = { messages: [{ role: 'developer', content: [{ type: 'text', text: 'YOU ARE CLAUDE CODE, ANTHROPIC\'S OFFICIAL CLI FOR CLAUDE.' }, { type: 'image_url', image_url: { url: 'x.png' } }] }] };
  rewritePayload(p2);
  assert.equal(p2.messages[0].content[0].text, "You are CodeBuddy, Tencent's official AI coding assistant.");
  assert.equal(p2.messages[0].content[1].image_url.url, 'x.png');

  // 模型名规范化
  assert.equal(normalizeModelId('glm-5.2[1m]'), 'glm-5.2');
  assert.equal(normalizeModelId(' deepseek-v4-pro [1m] '), 'deepseek-v4-pro');
  assert.equal(normalizeModelId('hy3'), 'hy3');
  assert.equal(getModelById('glm-5.3')?.id, 'glm-5.3');

  // ── 上游渠道声明句拦截(实测:仅自称 Anthropic 官方 CLI/渠道被拒 400/11128) ──
  {
    const { rewritePayload } = await import(
      pathToFileURL(process.cwd() + '/' + outDir + '/utils.mjs')
    );
    const run = (text) => {
      const p = { messages: [{ role: 'system', content: text }] };
      rewritePayload(p);
      return p.messages[0].content;
    };

    // Claude Code 身份首行(措辞变体兼容)被改写
    assert.match(run("You are Claude Code, Anthropic's official CLI for Claude."), /^You are CodeBuddy/);
    assert.match(run("You are OpenCode, Anthropic's official CLI for Claude."), /^You are CodeBuddy/);
    assert.equal(run("You are Claude Code, Anthropic's official CLI for Claude.").includes('Anthropic'), false);
    assert.match(run("You are Claude Code, an Anthropic-powered agent designed for coding."), /^You are CodeBuddy/);
    assert.match(run("You are Claude Code, built by Anthropic to help you with software engineering."), /^You are CodeBuddy/);
    assert.equal(run("You are Claude Code, Anthropic's official CLI for Claude.\nUse the main branch (you will usually use this for prs).").includes('Claude Code'), false);
    // 首行被换后后续内容保留
    assert.match(run("You are Claude Code, Anthropic's CLI.\nFollow instructions carefully."), /\nFollow instructions carefully\./);

    // 其余品牌/形态保持原样(上游实测全部 200)
    assert.equal(run("You are an AI agent powered by DeepSeek Harness."),
      "You are an AI agent powered by DeepSeek Harness.");
    assert.equal(run("You are DeepSeek Agent, an AI coding assistant.\nYou have tools for coding."),
      "You are DeepSeek Agent, an AI coding assistant.\nYou have tools for coding.");
    assert.equal(run("You are Claude, an AI assistant by Anthropic."), "You are Claude, an AI assistant by Anthropic.");
    assert.equal(run("you are claude code, an AI coding agent."), "you are claude code, an AI coding agent.");
    assert.equal(run("You are Cursor, the AI code editor."), "You are Cursor, the AI code editor.");
    assert.equal(run("你是豆包,字节跳动的 AI 助手。"), "你是豆包,字节跳动的 AI 助手。");
    // 业务提示不误伤
    assert.equal(run("You are a helpful assistant.\nFollow the user."), "You are a helpful assistant.\nFollow the user.");
    assert.equal(run("You are GPT-4, a senior software engineer."), "You are GPT-4, a senior software engineer.");
  }

  console.log('case01 core passed');
}
