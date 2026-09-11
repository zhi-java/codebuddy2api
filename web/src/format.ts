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

/** 从 token 用量对象里取一个数字字段 */
export function usageNum(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === 'number' ? value : undefined;
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
