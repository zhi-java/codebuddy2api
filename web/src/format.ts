/** 时间、数值与状态格式化辅助。 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD HH:mm`（空值显示 —） */
export function fmtTime(ms?: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `HH:mm:ss`（日志与实时明细用） */
export function fmtClock(ms?: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `HH:mm`（图表时间轴用） */
export function fmtHm(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：`约 3 小时` / `已过 2 天` */
export function relTime(ms?: number): string {
  if (!ms) return '—';
  const seconds = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const unit = abs < 60 ? '秒' : abs < 3600 ? '分钟' : abs < 86400 ? '小时' : '天';
  const value =
    abs < 60 ? abs : abs < 3600 ? Math.round(abs / 60) : abs < 86400 ? Math.round(abs / 3600) : Math.round(abs / 86400);
  return (seconds >= 0 ? '约 ' : '已过 ') + value + ' ' + unit;
}

/** 运行时长：`3 天 4 小时` / `12 分钟` */
export function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '不到 1 分钟';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

/** 毫秒耗时：`820 ms` / `1.24 s` */
export function fmtMs(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function num(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

/** token 数量：`1,234` / `12.3K` / `1.24M`（KPI 与列表共用，保持同一种读法） */
export function fmtTokens(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value < 10_000) return value.toLocaleString('en-US');
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 格式化积分消耗。上游按小数上报(如 0.01、2.5),整数位不显示多余小数,
 * 极小值保留 4 位以免显示成 0。undefined 表示上游未上报。
 */
export function fmtCredit(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (value < 0.01) return value.toFixed(4);
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toFixed(2);
}

/** 从 token 用量对象里取一个数字字段 */
export function usageNum(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === 'number' ? value : undefined;
}

// ── 日/月归档格式化 ───────────────────────────────────────────────────────

/** `YYYY-MM-DD` → `09-21`（图表轴用，短） */
export function fmtDayShort(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

/** `YYYY-MM-DD` → `9月21日`（表格与提示用） */
export function fmtDayLabel(day: string): string {
  if (day.length < 10) return day;
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
}

/** `YYYY-MM` → `26年9月`（图表轴用，短） */
export function fmtMonthShort(month: string): string {
  if (month.length < 7) return month;
  return `${month.slice(2, 4)}年${Number(month.slice(5, 7))}月`;
}

/** `YYYY-MM` → `2026年9月`（表格用） */
export function fmtMonthLabel(month: string): string {
  if (month.length < 7) return month;
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
}

/** 占比：0 分母返回 0，避免出现 NaN% */
export function rate(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** 成功率文案；无请求时显示 — 而不是 0% */
export function fmtRate(part: number, whole: number): string {
  if (!whole) return '—';
  return `${rate(part, whole)}%`;
}

export interface Delta {
  /** 相对上一周期的变化率（%），上一周期为 0 时无意义 → null */
  percent: number | null;
  /** 绝对差值 */
  diff: number;
  direction: 'up' | 'down' | 'flat';
}

/**
 * 环比上一个周期。
 *
 * 上一周期为 0 时不给百分比（除以 0 会得到 Infinity，展示成「+∞%」毫无意义），
 * 只保留绝对差值，由调用方决定文案。
 */
export function delta(current: number, previous: number): Delta {
  const diff = current - previous;
  const direction: Delta['direction'] = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  if (previous <= 0) return { percent: null, diff, direction };
  return { percent: Math.round((diff / previous) * 1000) / 10, diff, direction };
}

export const KIND_NAME: Record<string, string> = {
  ck_apikey: '控制台 Key',
  cli_oauth: 'CLI OAuth',
};

export const STATUS_META: Record<
  string,
  { label: string; type: 'success' | 'warning' | 'error' | 'default' | 'info' }
> = {
  healthy: { label: '健康', type: 'success' },
  cooling: { label: '冷却中', type: 'warning' },
  expired: { label: '已过期', type: 'error' },
  disabled: { label: '已停用', type: 'default' },
  error: { label: '异常', type: 'error' },
  refreshing: { label: '刷新中', type: 'info' },
};

export const LEVEL_META: Record<string, { label: string; type: 'default' | 'warning' | 'error' }> = {
  info: { label: 'INFO', type: 'default' },
  warn: { label: 'WARN', type: 'warning' },
  error: { label: 'ERROR', type: 'error' },
};
