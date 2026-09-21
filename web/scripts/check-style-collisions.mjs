/**
 * 全局工具类与组件 scoped 样式的重名检查。
 *
 * styles.css 里的 .stack / .panel / .toolbar 等是**全局**工具类，任何组件的
 * scoped 样式块都会叠加在它们之上。若组件内部恰好用了同名类，就会静默继承
 * 全局规则——曾经出现过的真实故障：趋势柱内部的 .stack 继承了全局 .stack 的
 * gap:16px，「失败段」被从柱身顶到画布顶端，看起来像图表算错了。
 *
 * 这里只对**布局类**工具做检查：像 .sub / .bad / .mono 这类文本级工具，
 * 组件按同样语义追加字号、边距是合理的，不拦截。
 *
 * 运行：node scripts/check-style-collisions.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

/** 全局**布局**工具类：语义强，组件内不得复用同名类 */
const LAYOUT_UTILITIES = [
  'page',
  'stack',
  'grid-auto',
  'toolbar',
  'panel',
  'panel-head',
  'panel-title',
  'panel-head-extra',
  'panel-body',
  'panel-note',
];

/**
 * 收集一个 CSS 片段里**被赋声明**的类名。
 *
 * 只看每个选择器的最后一个复合选择器：`.panel-head .foo` 是把 .panel-head 当
 * 祖先用（合法），而 `.panel-head { ... }` 才会真的把布局属性加到全局元素上。
 */
function selectorsIn(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();

  for (const block of withoutComments.matchAll(/([^{}]+)\{/g)) {
    for (const selector of block[1].split(',')) {
      const trimmed = selector.trim();
      // 跳过 at-rule 前导（@media (...) 后跟的 `{`）
      if (!trimmed || trimmed.startsWith('@')) continue;
      // 取最后一个复合选择器，去掉伪类/伪元素与 :deep() 包裹
      const lastCompound = trimmed.split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
      const cleaned = lastCompound.replace(/:deep\(|\)/g, '').replace(/::?[\w-]+.*$/, '');
      for (const match of cleaned.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
        names.add(match[1]);
      }
    }
  }
  return names;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.vue') || entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/** 取出 <style scoped> 块；无 scoped 的 <style> 视为全局样式，不参与检查 */
function scopedBlocks(source) {
  const blocks = [];
  for (const match of source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
    if (/\bscoped\b/.test(match[1])) blocks.push(match[2]);
  }
  return blocks;
}

const problems = [];

for (const file of walk(srcDir)) {
  // styles.css 是全局工具类的定义处，跳过
  if (file.endsWith('styles.css')) continue;
  const source = readFileSync(file, 'utf8');
  const blocks = file.endsWith('.vue') ? scopedBlocks(source) : [source];
  const seen = new Set();
  for (const block of blocks) {
    for (const name of selectorsIn(block)) {
      if (LAYOUT_UTILITIES.includes(name) && !seen.has(name)) {
        seen.add(name);
        problems.push({
          file: relative(root, file).replace(/\\/g, '/'),
          name,
        });
      }
    }
  }
}

if (problems.length > 0) {
  console.error('组件 scoped 样式与全局布局工具类重名：\n');
  for (const { file, name } of problems) {
    console.error(`  ${file}  ->  .${name}`);
  }
  console.error(
    '\n这些类名由 styles.css 全局定义，组件内的同名规则会叠加其布局属性。' +
      '\n请改用组件内前缀（如 .col-stack）或直接复用全局类。',
  );
  process.exit(1);
}

console.log(`样式冲突检查通过（全局布局工具类 ${LAYOUT_UTILITIES.length} 个）`);
