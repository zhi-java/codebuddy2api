/**
 * 设计令牌一致性校验。
 *
 * 背景：令牌存在两处声明——web/src/tokens.css（前端构建）与
 * src/admin-ui.ts 的 PUBLIC_CSS（公开页服务端渲染，不走前端构建）。
 * 改造前正是这种"两处各写一份"导致了漂移：--accent 出现 #16a34a 与 #15803d
 * 两个值、--shadow 取值也不同，同一个产品出现两套视觉。
 *
 * 这里在构建前比对两处同名令牌的取值，不一致直接失败——把"静默漂移"
 * 变成"构建期报错"，是防止问题复发的唯一可靠手段。
 *
 * 运行：node scripts/check-tokens.mjs（由 npm run build 的 prebuild 触发）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本脚本位于 web/scripts/，项目根在两级之上
const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..');
const repoDir = join(webDir, '..');

/**
 * 归一化取值，消除等价写法差异后再比较。
 *
 * 场景：`rgba(15,23,42,.06)` 与 `rgba(15, 23, 42, 0.06)` 语义完全相同，
 * 若按字面比较会产生假报警，进而诱导把令牌改成不好读的压缩写法。
 * 这里统一：去掉空格、补全小数点前导零。
 */
function normalize(value) {
  return value
    .replace(/\s+/g, '')
    .replace(/(^|[^\d])\.(\d)/g, '$10.$2');
}

/** 从 CSS 文本中抓取 `:root { --x: y; }` 的令牌键值对 */
function parseTokens(css) {
  // 只取第一个 :root 块（两处都只有一个 :root）
  const start = css.indexOf(':root');
  if (start === -1) return {};
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = css.slice(open + 1, end);

  const tokens = {};
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  }
  return tokens;
}

const tokensCss = readFileSync(join(webDir, 'src', 'tokens.css'), 'utf8');
const adminTs = readFileSync(join(repoDir, 'src', 'admin-ui.ts'), 'utf8');

const publicCssStart = adminTs.indexOf('const PUBLIC_CSS');
if (publicCssStart === -1) {
  console.error('未能在 src/admin-ui.ts 中定位 PUBLIC_CSS');
  process.exit(1);
}
const publicCss = adminTs.slice(publicCssStart);

const a = parseTokens(tokensCss);
const b = parseTokens(publicCss);

/**
 * 只校验**两边都声明**的令牌必须取值一致。
 *
 * 不要求两侧令牌集合相同：控制台需要图表令牌（--chart-*）等前端专用项，
 * 公开页不需要；强行对齐会让两侧都背上无用令牌。
 */
const shared = Object.keys(a).filter((k) => k in b);
const drifted = shared.filter((k) => normalize(a[k]) !== normalize(b[k]));

if (drifted.length > 0) {
  console.error('设计令牌漂移：web/src/tokens.css 与 src/admin-ui.ts 的 PUBLIC_CSS 取值不一致\n');
  for (const k of drifted) {
    console.error(`  --${k}`);
    console.error(`      tokens.css : ${a[k]}`);
    console.error(`      PUBLIC_CSS : ${b[k]}`);
  }
  console.error('\n两处必须同源，否则公开页与控制台会出现两套视觉。请同步修改后重试。');
  process.exit(1);
}

console.log(
  `令牌一致性检查通过（共同令牌 ${shared.length} 个；` +
    `tokens.css 共 ${Object.keys(a).length} 个，PUBLIC_CSS 共 ${Object.keys(b).length} 个）`,
);
