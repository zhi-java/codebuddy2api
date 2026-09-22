/**
 * Naive UI 主题覆写（浅色）。
 *
 * 本项目**只支持浅色**：不再有深色主题、不再有主题切换器。
 * 此前同时维护 dark/light 两套覆写，且切换器只驱动本文件、不驱动
 * styles.css 的 CSS 变量，导致手动选「浅色」时页面底色仍是深色。
 *
 * 取值口径：语义色与 tokens.css 保持一致（同一套色板，两处消费）。
 * 具体对比度实测值见 tokens.css 注释。
 */

import type { GlobalThemeOverrides } from 'naive-ui';

/** 与 tokens.css 同步的调色板 */
const palette = {
  bg: '#eef1f6',
  surface: '#ffffff',
  surface2: '#f6f8fb',
  inset: '#f6f8fb',
  border: '#cbd5e1',
  borderSoft: '#e4e9f0',
  text: '#0f172a',
  text2: '#475569',
  text3: '#526074',
  accent: '#14793a',
  accentHover: '#127336',
  danger: '#c81e1e',
  warn: '#9a5b08',
  info: '#0369a1',
  hover: '#f6f8fb',
} as const;

const shadowCard = '0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.04)';
const shadowPop = '0 12px 32px -8px rgba(15, 23, 42, 0.16), 0 4px 8px -4px rgba(15, 23, 42, 0.08)';

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
    infoColor: palette.info,
    successColor: palette.accent,
    warningColor: palette.warn,
    errorColor: palette.danger,
    textColorBase: palette.text,
    textColor1: palette.text,
    textColor2: palette.text2,
    textColor3: palette.text3,
    borderColor: palette.border,
    dividerColor: palette.borderSoft,
    bodyColor: palette.bg,
    cardColor: palette.surface,
    modalColor: palette.surface,
    popoverColor: palette.surface,
    tableColor: palette.surface,
    inputColor: palette.surface,
    tableHeaderColor: palette.surface2,
    hoverColor: palette.hover,
    boxShadow1: shadowCard,
    boxShadow2: shadowPop,
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontSize: '13.5px',
    fontSizeSmall: '12.5px',
    // 与 styles.css 的 body 字体栈保持一致，否则 Naive 组件（按钮/表格/下拉）
    // 会各自回退到系统中文字体，与自绘部分产生肉眼可见的字形差异
    fontFamily:
      "'Inter Variable', Inter, ui-sans-serif, system-ui, 'Segoe UI', 'PingFang SC', " +
      "'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    fontWeightStrong: '600',
    heightMedium: '34px',
    heightSmall: '28px',
    lineHeight: '1.5',
  },
  Layout: {
    siderColor: palette.surface,
    headerColor: palette.surface,
    bodyColor: palette.bg,
    siderBorderColor: palette.borderSoft,
  },
  Card: {
    borderColor: palette.borderSoft,
    color: palette.surface,
    paddingMedium: '16px 18px',
    titleFontSizeMedium: '13.5px',
    titleFontWeight: '600',
  },
  DataTable: {
    thColor: palette.surface2,
    tdColor: palette.surface,
    tdColorHover: palette.surface2,
    borderColor: palette.borderSoft,
    thTextColor: palette.text3,
    thFontWeight: '600',
    tdTextColor: palette.text,
    thPaddingMedium: '10px 12px',
    tdPaddingMedium: '11px 12px',
  },
  Menu: {
    itemTextColor: palette.text2,
    itemTextColorHover: palette.text,
    itemTextColorActive: palette.accent,
    itemTextColorActiveHover: palette.accent,
    itemColorHover: palette.hover,
    itemColorActive: accentAlpha(0.1),
    itemColorActiveHover: accentAlpha(0.14),
    itemIconColor: palette.text3,
    itemIconColorActive: palette.accent,
    itemIconColorHover: palette.text,
    itemIconColorActiveHover: palette.accent,
    itemHeight: '36px',
    borderRadius: '7px',
    groupTextColor: palette.text3,
  },
  Button: {
    textColorGhost: palette.text2,
    textColorGhostHover: palette.text,
    borderGhost: palette.border,
    borderGhostHover: palette.border,
  },
  Tag: {
    borderRadius: '999px',
    heightSmall: '20px',
    fontSizeSmall: '11.5px',
  },
  Input: {
    border: `1px solid ${palette.border}`,
    borderHover: `1px solid ${palette.accent}`,
    borderFocus: `1px solid ${palette.accent}`,
    boxShadowFocus: `0 0 0 3px ${accentAlpha(0.16)}`,
    color: palette.surface,
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
    titleFontSize: '15px',
    titleFontWeight: '600',
  },
  Modal: {
    color: palette.surface,
    titleFontSize: '15px',
    titleFontWeight: '600',
  },
  Progress: {
    railColor: palette.inset,
  },
  Tooltip: {
    color: '#1e293b',
    textColor: '#ffffff',
    padding: '6px 10px',
  },
  Popover: {
    color: palette.surface,
  },
};
