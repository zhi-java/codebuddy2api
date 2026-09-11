/**
 * 测试入口:先打包全部 src 入口为 ESM,再把 tests/cases/*.mjs 拼接为单一模块执行。
 *
 * cases 内可直接引用顶层绑定:assert / baseEnv / callFetch / nextIp / outDir。
 * 各用例自行处理全局 fetch 的替换与还原。
 */
import assert from 'node:assert/strict';
import { rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const outDir = '.tmp-test';

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entries = [
  'src/utils.ts', 'src/index.ts', 'src/models.ts', 'src/rate-limiter.ts',
  'src/crypto.ts', 'src/store.ts', 'src/credentials.ts', 'src/admin.ts',
  'src/protocol/sse.ts', 'src/protocol/anthropic.ts', 'src/protocol/responses.ts',
  'src/upstream-billing.ts', 'src/admin-ui.ts', 'src/scheduled.ts',
  'src/metrics.ts', 'src/logs.ts', 'src/static.ts',
];

await Promise.all(
  entries.map((entry) =>
    build({
      entryPoints: [entry],
      outfile: `${outDir}/${path.basename(entry).replace(/\.ts$/, '.mjs')}`,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      // Node 内置模块交给运行时解析(测试本身跑在 Node 上)
      external: ['node:*'],
    }),
  ),
);

// ── 顶层绑定(cases 内直接引用) ──────────────────────────────────────────
const { default: worker } = await import(pathToFileURL(`${process.cwd()}/${outDir}/index.mjs`));

const baseEnv = {
  UPSTREAM_CHAT_COMPLETIONS_URL: 'https://copilot.tencent.com/v2/chat/completions',
  UPSTREAM_TIMEOUT_SECONDS: '600',
  UPSTREAM_CONNECT_TIMEOUT_SECONDS: '30',
  CORS_ALLOW_ORIGINS: '*',
  CORS_ALLOW_CREDENTIALS: 'false',
};

async function callFetch(request, env) {
  return worker.fetch(request, env);
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 65536) % 256}.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

// ── 收集并拼接用例(combined.mjs 自带绑定头,独立模块执行) ──────────────
const casesDir = path.join(process.cwd(), 'tests', 'cases');
const files = (await readdir(casesDir)).filter((f) => f.endsWith('.mjs')).sort();
if (files.length === 0) throw new Error('no test cases found');

const header = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { default: worker } = await import(
  pathToFileURL(process.cwd() + '/${outDir}/index.mjs')
);
const baseEnv = {
  UPSTREAM_CHAT_COMPLETIONS_URL: 'https://copilot.tencent.com/v2/chat/completions',
  UPSTREAM_TIMEOUT_SECONDS: '600',
  UPSTREAM_CONNECT_TIMEOUT_SECONDS: '30',
  CORS_ALLOW_ORIGINS: '*',
  CORS_ALLOW_CREDENTIALS: 'false',
};
async function callFetch(request, env) { return worker.fetch(request, env); }
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.' + Math.floor(ipCounter / 65536) % 256 + '.' + Math.floor(ipCounter / 256) % 256 + '.' + ipCounter % 256;
}
const outDir = '${outDir}';
`;

const bodies = [];
for (const file of files) {
  bodies.push(await readFile(path.join(casesDir, file), 'utf8'));
}
const combined = header + bodies.join('\n\n');

await writeFile(`${outDir}/combined.mjs`, combined, 'utf8');
await import(pathToFileURL(`${process.cwd()}/${outDir}/combined.mjs`));

console.log(`\nAll ${files.length} test case groups passed`);
