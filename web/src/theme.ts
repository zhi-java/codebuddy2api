/**
 * Naive UI 主题覆写（浅色 · 极简）。
 *
 * 本项目**只支持浅色**：没有深色主题、没有主题切换器。
 * 取值口径与 tokens.css 完全一致（同一套色板，两处消费）。
 *
 * 极简口径下与上一版的三处差别：
 *   1. 圆角收敛：10px → 8px，小号 8px → 6px
 *   2. 阴影移除：卡片/表格一律无阴影，层次由发丝线与留白承担；
 *      仅浮层（modal/popover）保留一层阴影
 *   3. 强调色从绿改为蓝（#2563eb）：蓝色只用于「可点击」与「当前选中」，
 *      不再作为品牌装饰色；状态色另用绿/黄/红
 */

import type { GlobalThemeOverrides } from 'naive-ui';

/** 与 tokens.css 同步的调色板 */
const palette = {
  bg: '#fafafa',
  surface: '#ffffff',
  surface2: '#fafafa',
  surface3: '#f4f4f5',
  line: '#ededed',
  lineStrong: '#dcdcdc',
  text: '#18181b',
  text2: '#52525b',
  text3: '#6b6b74',
  accent: '#2563eb',
  accentHover: '#1d4ed8',
  ok: '#15803d',
  warn: '#a16207',
  bad: '#b91c1c',
} as const;

/** 极简下唯一的阴影：仅浮层使用 */
const shadowPop = '0 8px 28px -8px rgba(24, 24, 27, 0.16)';

const a = palette.accent;
/** 强调色的半透明变体（rgba 需要数值，不能直接拼接 hex） */
const accentAlpha = (alpha: number): string => {
  const n = parseInt(a.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: palette.accent,
    primaryColorHover: palette.accentHover,
    primaryColorPressed: palette.accentHover,
    primaryColorSuppl: palette.accent,
    infoColor: palette.accent,
    successColor: palette.ok,
    warningColor: palette.warn,
    errorColor: palette.bad,
    textColorBase: palette.text,
    textColor1: palette.text,
    textColor2: palette.text2,
    textColor3: palette.text3,
    borderColor: palette.lineStrong,
    dividerColor: palette.line,
    bodyColor: palette.bg,
    cardColor: palette.surface,
    modalColor: palette.surface,
    popoverColor: palette.surface,
    tableColor: palette.surface,
    inputColor: palette.surface,
    tableHeaderColor: palette.surface,
    hoverColor: palette.surface2,
    // 极简下组件层不用阴影；浮层给一层
    boxShadow1: 'none',
    boxShadow2: shadowPop,
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontSize: '13px',
    fontSizeSmall: '12px',
    // 与 styles.css 的 body 字体栈保持一致，否则 Naive 组件（按钮/表格/下拉）
    // 会各自回退到系统中文字体，与自绘部分产生肉眼可见的字形差异
    fontFamily:
      "'Inter Variable', Inter, ui-sans-serif, system-ui, 'Segoe UI', 'PingFang SC', " +
      "'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    fontWeightStrong: '600',
    heightMedium: '32px',
    heightSmall: '26px',
    lineHeight: '1.6',
  },
  Layout: {
    siderColor: palette.surface,
    headerColor: palette.surface,
    bodyColor: palette.bg,
    siderBorderColor: palette.line,
  },
  Card: {
    borderColor: palette.line,
    color: palette.surface,
    paddingMedium: '18px 20px',
    titleFontSizeMedium: '13px',
    titleFontWeight: '600',
  },
  DataTable: {
    // 极简表格：表头无底色，只靠一条发丝下线分隔；行悬停用极淡底
    thColor: palette.surface,
    tdColor: palette.surface,
    tdColorHover: 'rgba(0,0,0,0.014)',
    thColorHover: palette.surface,
    borderColor: palette.line,
    thTextColor: palette.text3,
    thFontWeight: '600',
    tdTextColor: palette.text,
    thPaddingMedium: '0px 16px 11px',
    tdPaddingMedium: '15px 16px',
    borderRadius: '0',
  },
  Menu: {
    itemTextColor: palette.text2,
    itemTextColorHover: palette.text,
    itemTextColorActive: palette.text,
    itemTextColorActiveHover: palette.text,
    itemColorHover: palette.surface2,
    itemColorActive: 'transparent',
    itemColorActiveHover: 'transparent',
    itemIconColor: palette.text3,
    itemIconColorActive: palette.text,
    itemIconColorHover: palette.text,
    itemIconColorActiveHover: palette.text,
    itemHeight: '34px',
    borderRadius: '6px',
    groupTextColor: palette.text3,
  },
  Button: {
    textColorGhost: palette.text2,
    textColorGhostHover: palette.text,
    borderGhost: palette.lineStrong,
    borderGhostHover: palette.lineStrong,
    // 极简按钮：无阴影
    boxShadow: 'none',
    boxShadowHover: 'none',
    boxShadowPressed: 'none',
    boxShadowFocus: 'none',
  },
  Tag: {
    borderRadius: '4px',
    heightSmall: '20px',
    fontSizeSmall: '11.5px',
  },
  Input: {
    border: `1px solid ${palette.lineStrong}`,
    borderHover: `1px solid ${palette.text3}`,
    borderFocus: `1px solid ${palette.accent}`,
    boxShadowFocus: `0 0 0 3px ${accentAlpha(0.16)}`,
    color: palette.surface,
  },
  Select: {
    peers: {
      InternalSelection: {
        border: `1px solid ${palette.lineStrong}`,
        borderHover: `1px solid ${palette.text3}`,
        borderFocus: `1px solid ${palette.accent}`,
        borderActive: `1px solid ${palette.accent}`,
        boxShadowFocus: `0 0 0 3px ${accentAlpha(0.16)}`,
        boxShadowActive: `0 0 0 3px ${accentAlpha(0.16)}`,
      },
    },
  },
  Switch: {
    railColorActive: palette.accent,
  },
  Statistic: {
    labelTextColor: palette.text3,
    valueTextColor: palette.text,
  },
  Drawer: {
    color: palette.surface,
    titleFontSize: '14px',
    titleFontWeight: '640',
    // 抽屉是浮层，保留一层阴影与页面分离
    boxShadow: shadowPop,
  },
  Modal: {
    color: palette.surface,
    titleFontSize: '14px',
    titleFontWeight: '640',
  },
  Progress: {
    railColor: palette.surface3,
  },
  Tooltip: {
    color: palette.text,
    textColor: '#ffffff',
    padding: '6px 10px',
    borderRadius: '6px',
  },
  Popover: {
    color: palette.surface,
    boxShadow: shadowPop,
  },
  Dropdown: {
    color: palette.surface,
    boxShadow: shadowPop,
  },
  Skeleton: {
    color: palette.surface3,
    colorEnd: palette.surface2,
  },
  Empty: {
    iconColor: palette.lineStrong,
    textColor: palette.text3,
  },
  Checkbox: {
    border: `1px solid ${palette.lineStrong}`,
    borderFocus: `1px solid ${palette.accent}`,
    boxShadowFocus: `0 0 0 3px ${accentAlpha(0.16)}`,
  },
  Radio: {
    buttonBorderColor: palette.lineStrong,
    buttonTextColor: palette.text2,
  },
  Message: {
    color: palette.text,
    textColor: '#ffffff',
    boxShadow: shadowPop,
  },
  Notification: {
    color: palette.surface,
    boxShadow: shadowPop,
  },
};
