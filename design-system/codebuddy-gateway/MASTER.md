# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** CodeBuddy Gateway
**Generated:** 2026-09-10 19:24:34
**Updated:** 2026-09-22（改为仅浅色，重建令牌与层次）
**Category:** API Developer Portal
**Design Dials:** Variance 5/10 (Balanced / Modern) | Motion 4/10 (Standard) | Density 8/10 (Dense / Dashboard)

---

## 主题策略：仅浅色

本项目**只支持浅色**，没有深色模式、没有主题切换器。

> 历史：初版为「深色优先」（Dark Mode Primary），同时维护两套令牌。
> 实测发现三类问题，故于 2026-09-22 收敛为单一浅色：
> 1. 主题切换器只驱动 Naive 主题对象、不驱动 CSS 变量，手动选「浅色」时
>    页面底色仍是深色（割裂渲染）；
> 2. 控制台与公开页各自维护一份令牌，`--accent` 等取值漂移；
> 3. 浅色令牌是从深色换算的，层次仍靠「提亮表面」，而浅色的层次**必须靠阴影**。

### 令牌唯一事实源

| 位置 | 用途 | 说明 |
|------|------|------|
| `web/src/tokens.css` | 控制台（前端构建） | 主事实源 |
| `src/admin-ui.ts` 的 `PUBLIC_CSS` | 公开页（服务端渲染） | 不走前端构建，内联一份 |

两者同名令牌的取值由 `web/scripts/check-tokens.mjs` 在**构建前校验**，漂移会让构建失败。

---

## 调色板（浅色）

所有取值均按 WCAG 对比度核算选定，标注为「相对页面底色 / 相对白卡」。

| 角色 | Hex | 令牌 | 对比度 |
|------|-----|------|--------|
| 页面底色 | `#EEF1F6` | `--bg` | — |
| 卡片表面 | `#FFFFFF` | `--surface` | 相对底色 1.13:1（层次可辨） |
| 次级表面 | `#F6F8FB` | `--surface-2` | 表头/内嵌区 |
| 描边 | `#CBD5E1` | `--border` | 需明确边界处（输入框、表格） |
| 描边（弱） | `#E4E9F0` | `--border-soft` | 卡片外框（已有阴影承担层次） |
| 正文 | `#0F172A` | `--text` | 15.8 / 17.9 |
| 次级文本 | `#475569` | `--text-2` | 6.7 / 7.6 |
| 提示文本 | `#526074` | `--text-3` | 5.7 / 6.4 |
| 强调色 | `#14793A` | `--accent` | 4.85 / 5.49 |
| 强调（hover） | `#127336` | `--accent-hover` | — |
| 强调软底 | `#E3F3E8` | `--accent-soft` | 其上强调色文字 4.77:1 |
| 危险 | `#C81E1E` | `--danger` | 5.07 / 5.74 |
| 警告 | `#9A5B08` | `--warn` | 4.79 / 5.42 |
| 信息 | `#0369A1` | `--info` | 5.24 / 5.93 |

**强调色的选值约束：** 绿需同时满足三处，故不能取更鲜艳的值——
白字填充（`#fff`/绿）、白底文字（绿/`#fff`）、底色文字（绿/`--bg`）。
初版 `#16A34A` 三处分别为 3.3 / 3.3 / 2.9，**全不达标**。

**浅色层次的两个手段（缺一不可）：**
1. **底色与卡片拉开**：`#EEF1F6` vs `#FFFFFF` = 1.13:1（初版 `#F6F8FB` 仅 1.06:1，边界不可辨）
2. **阴影分层**（深色靠提亮表面，浅色必须靠阴影）：
   `--shadow-sm` / `--shadow-card` / `--shadow-raised` / `--shadow-pop`

### Typography

- **Heading Font:** Inter Variable（wght 100–900）
- **Body Font:** Inter Variable（wght 100–900）
- **Mood:** dark, cinematic, technical, precision, clean, premium, developer, professional, high-end utility
- **来源：自托管**，由 `web/src/fonts.css` 通过 `@fontsource-variable/inter` 声明，**不使用 Google Fonts CDN**。

**为什么自托管：** 网关面向内网/局域网部署，若依赖 `fonts.googleapis.com`，在无外网环境会静默回退到系统字体，且引入 DNS/TLS 建连开销。

**为什么用可变字体而非静态字重：** 界面使用了 550 / 650 这档半档字重（见 `styles.css`），静态字体会被四舍五入到 500/600，字重层级丢失。可变字体单文件覆盖 100–900，48KB 也比静态 4 档（97KB）更小。

**中文怎么办：** `fonts.css` 只声明 latin + latin-ext 两段 `unicode-range`，汉字落在范围外，浏览器自动回退到系统中文字体（PingFang SC / 微软雅黑 / 苹方），不会为汉字下载 Inter。

**接入方式（无需 CDN）：**
```css
/* web/src/fonts.css —— 由 web/src/main.ts 引入 */
@font-face {
  font-family: 'Inter Variable';
  font-display: swap;              /* 避免 FOIT 白字 */
  font-weight: 100 900;
  src: url('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0000-00FF, …;   /* 中文走系统回退 */
}
```

> 改字体栈时注意同步两处：`styles.css` 的 `body` 与 `theme.ts` 的 `common.fontFamily`。
> 只改前者会导致 Naive 组件（按钮/表格/下拉）与自绘部分字形不一致。

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

**浅色下层次的主力手段。** 深色靠「提亮表面」区分层次，浅色下表面差异极小，
必须由阴影承担——这是浅色观感成立与否的关键。

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.06)` | 分段控件滑块等微抬起 |
| `--shadow-card` | `0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.04)` | 面板、卡片（默认） |
| `--shadow-raised` | `0 4px 12px -2px rgba(15,23,42,.08), …` | 悬停抬起 |
| `--shadow-pop` | `0 12px 32px -8px rgba(15,23,42,.16), …` | 浮层（命令面板、tooltip） |

> 阴影色用 `rgba(15,23,42,…)`（冷调深蓝）而非纯黑：纯黑阴影在浅灰底上会显脏。

### 内容宽度与对齐

| Token | Value | 说明 |
|-------|-------|------|
| `--content-max` | `1280px` | 内容容器最大宽度 |
| `--content-gutter` | `20px` | 横向内衬 |

**顶栏与页面内容必须共用这两个令牌。** 曾出现的真实缺陷：顶栏用固定
`padding`、页面用 `max-width + margin:auto`，两者宽度算法不同导致左边缘错位 22px；
且 `.content` 另有 22px 横向内衬，使内容侧共 42px 而顶栏仅 20px。
**横向内衬只能有一个来源。**

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: var(--accent);      /* #14793A，白字对比度 5.49:1 */
  color: var(--accent-ink);
  padding: 10px 18px;
  border-radius: var(--radius-page-sm);
  font-weight: 600;
  transition: all 200ms var(--ease);
  cursor: pointer;
}

.btn-primary:hover {
  background: var(--accent-hover);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border);
  padding: 10px 18px;
  border-radius: var(--radius-page-sm);
  font-weight: 600;
  transition: all 200ms var(--ease);
  cursor: pointer;
}
```

### Cards / Panels

```css
.card {
  background: var(--surface);              /* 白卡浮在浅灰底上 */
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-page);
  padding: 18px 20px;
  box-shadow: var(--shadow-card);          /* 浅色层次的来源 */
  transition: all 200ms var(--ease);
}

.card:hover {
  border-color: var(--border);
  box-shadow: var(--shadow-raised);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13.5px;
  transition: border-color 200ms var(--ease);
}

.input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: var(--surface);
  border-radius: var(--radius-lg);
  padding: 24px;
  box-shadow: var(--shadow-pop);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Clean Light Utility（浅色技术工具风）

**Keywords:** light, precise, technical, restrained, airy, high-legibility, layered shadows, developer-focused

**Best For:** 内网运维台、API 网关控制台、开发者工具

**Key Effects:**
- 缓动统一 `cubic-bezier(.16,1,.3,1)`（`--ease`），时长 150–300ms
- 悬停抬起用 `transform: translateY(-2px)` + 阴影升档（不是只换背景色）
- 顶栏用半透明背景 + `backdrop-filter: blur()`，滚动时内容从其下穿过
- 尊重 `prefers-reduced-motion`：全局把 animation/transition 时长压到 0.01ms

**避免：**
- 纯黑阴影（在浅灰底上显脏）——用 `rgba(15,23,42,…)` 冷调深色
- 卡片无阴影 + 弱描边（会与背景糊成一片，这是浅色最常见的失败）
- 同名令牌在不同文件取不同值（已由 `check-tokens.mjs` 构建期拦截）

### Page Pattern

**Pattern Name:** Real-Time / Operations Landing

- **Conversion Strategy:** For ops/security/iot products. Demo or sandbox link. Trust signals.
- **CTA Placement:** Primary CTA in nav + After metrics
- **Section Order:** 1. Hero (product + live preview or status), 2. Key metrics/indicators, 3. How it works, 4. CTA (Start trial / Contact)

---

## Motion

**Stagger List** (Standard) — Trigger: load or scroll | Duration: 300-450ms | Easing: `back.out(1.4)`

```js
gsap.from('.grid-item', { opacity: 0, scale: 0.92, y: 16, duration: 0.4, stagger: { each: 0.06, from: 'start', grid: 'auto' }, ease: 'back.out(1.4)' });
```

**Framework notes:** grid: 'auto' lets GSAP infer rows/columns from a CSS grid layout for a natural wave stagger

- ✅ Combine with from: 'center' for a bento-grid layout to draw the eye inward first
- ❌ Don't use back.out on dense data tables; the overshoot reads as sloppy on informational UI
- ⚡ Group DOM writes; avoid interleaving layout reads (getBoundingClientRect) between staggered tweens

---

## Anti-Patterns (Do NOT Use)

- ❌ Flat design without depth
- ❌ Text-heavy pages

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] 文本对比度 ≥4.5:1（相对 `--bg` **与** `--surface` 都要满足）
- [ ] 卡片有阴影（浅色层次的来源，缺了会与背景糊成一片）
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
- [ ] 代码/命令类内容无需横向滚动即可读全
- [ ] `npm run check:tokens` 通过（两处令牌无漂移）
