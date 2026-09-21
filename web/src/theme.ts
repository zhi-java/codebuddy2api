/**
 * Naive UI 主题：把设计令牌映射到组件库。
 *
 * 深色为默认（MASTER.md：Dark Mode Primary，Light 仅作例外），
 * 语义色与自绘图表共用同一组变量，保证视觉一致。
 * 对比度口径与 styles.css 保持一致：--text-3 两套都按 AA 4.5:1 选定。
 */

import { darkTheme, type GlobalThemeOverrides } from 'naive-ui';

/** 深色主题令牌 */
const dark = {
  bg: '#020617',
  surface: '#0f172a',
  surfaceHover: '#1e293b',
  inset: '#1a1e2f',
  border: '#334155',
  borderSoft: '#1e293b',
  text: '#f8fafc',
  text2: '#94a3b8',
  text3: '#8494ab',
  accent: '#22c55e',
  accentHover: '#4ade80',
  accentInk: '#052e16',
  danger: '#ef4444',
  warn: '#f59e0b',
  info: '#38bdf8',
};

/** 浅色主题令牌（与 styles.css 中的媒体查询保持一致） */
const light = {
  bg: '#f6f8fb',
  surface: '#ffffff',
  surfaceHover: '#f1f5f9',
  inset: '#eef2f7',
  border: '#cbd5e1',
  borderSoft: '#e2e8f0',
  text: '#0f172a',
  text2: '#475569',
  text3: '#64748b',
  accent: '#16a34a',
  accentHover: '#15803d',
  accentInk: '#ffffff',
  danger: '#dc2626',
  warn: '#b45309',
  info: '#0284c7',
};

function overrides(t: typeof dark): GlobalThemeOverrides {
  return {
    common: {
      primaryColor: t.accent,
      primaryColorHover: t.accentHover,
      primaryColorPressed: t.accent,
      primaryColorSuppl: t.accent,
      infoColor: t.info,
      successColor: t.accent,
      warningColor: t.warn,
      errorColor: t.danger,
      textColorBase: t.text,
      textColor1: t.text,
      textColor2: t.text2,
      textColor3: t.text3,
      borderColor: t.border,
      dividerColor: t.borderSoft,
      bodyColor: t.bg,
      cardColor: t.surface,
      modalColor: t.surface,
      popoverColor: t.surface,
      tableColor: t.surface,
      inputColor: t.inset,
      tableHeaderColor: t.surface,
      hoverColor: t.surfaceHover,
      borderRadius: '8px',
      borderRadiusSmall: '6px',
      fontSize: '13.5px',
      fontSizeSmall: '12.5px',
      fontWeightStrong: '600',
      heightMedium: '34px',
      heightSmall: '28px',
      // 密度 8/10：整体收紧一档
      lineHeight: '1.5',
    },
    Layout: {
      siderColor: t.surface,
      headerColor: t.surface,
      bodyColor: t.bg,
      siderBorderColor: t.borderSoft,
    },
    Card: {
      borderColor: t.borderSoft,
      color: t.surface,
      paddingMedium: '16px 18px',
      titleFontSizeMedium: '13.5px',
      titleFontWeight: '600',
    },
    DataTable: {
      thColor: t.surface,
      tdColor: t.surface,
      tdColorHover: t.surfaceHover,
      borderColor: t.borderSoft,
      thTextColor: t.text3,
      thFontWeight: '600',
      tdTextColor: t.text,
      thPaddingMedium: '10px 12px',
      tdPaddingMedium: '11px 12px',
    },
    Menu: {
      itemTextColor: t.text2,
      itemTextColorHover: t.text,
      itemTextColorActive: t.accent,
      itemTextColorActiveHover: t.accent,
      itemColorHover: t.surfaceHover,
      itemColorActive: 'rgba(34, 197, 94, 0.12)',
      itemColorActiveHover: 'rgba(34, 197, 94, 0.16)',
      itemIconColor: t.text3,
      itemIconColorActive: t.accent,
      itemIconColorHover: t.text,
      itemIconColorActiveHover: t.accent,
      itemHeight: '36px',
      borderRadius: '7px',
      groupTextColor: t.text3,
    },
    Button: {
      textColorGhost: t.text2,
      textColorGhostHover: t.text,
      borderGhost: t.border,
      borderGhostHover: t.border,
    },
    Tag: {
      borderRadius: '999px',
      heightSmall: '20px',
      fontSizeSmall: '11.5px',
    },
    Input: {
      border: `1px solid ${t.border}`,
      borderHover: `1px solid ${t.accent}`,
      borderFocus: `1px solid ${t.accent}`,
      boxShadowFocus: `0 0 0 3px rgba(34, 197, 94, 0.16)`,
      color: t.inset,
    },
    Switch: {
      railColorActive: t.accent,
    },
    Statistic: {
      labelTextColor: t.text3,
      valueTextColor: t.text,
    },
    Drawer: {
      color: t.surface,
      titleFontSize: '15px',
      titleFontWeight: '600',
    },
    Modal: {
      color: t.surface,
      titleFontSize: '15px',
      titleFontWeight: '600',
    },
    Progress: {
      railColor: t.inset,
    },
    Tooltip: {
      color: t.surfaceHover,
      textColor: t.text,
      padding: '6px 10px',
    },
  };
}

export const darkOverrides = overrides(dark);
export const lightOverrides = overrides(light);
export { darkTheme };
