/**
 * 进程内日志缓冲。
 *
 * 网关运行期的结构化事件(上游失败、凭证切换、定时签到等)既输出到 stdout
 * (docker logs 可见),也写入内存环形缓冲,供管理台「日志」页面查看。
 * 只记录事件元数据,不记录请求正文、系统提示词或凭证明文。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 300;

/**
 * 缓冲区挂在 globalThis 上:测试会把各模块分别打包成独立 bundle,
 * 若用模块级变量会各自持有一份空缓冲,导致管理端读不到请求侧写入的日志。
 */
const REGISTRY = globalThis as unknown as { __cbGatewayLogs?: LogEntry[] };
const entries: LogEntry[] = REGISTRY.__cbGatewayLogs ?? (REGISTRY.__cbGatewayLogs = []);

/** 写入一条日志:同时进 stdout 与内存缓冲。 */
export function pushLog(
  level: LogLevel,
  event: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry: LogEntry = { at: Date.now(), level, event, message, ...(data ? { data } : {}) };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

  const line = JSON.stringify({ event, level, message, ...(data ?? {}) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** 读取最近日志(新的在前)。 */
export function logSnapshot(limit = 200): LogEntry[] {
  return entries.slice(0, Math.max(0, Math.min(limit, MAX_ENTRIES)));
}

/** 清空日志缓冲(仅供测试)。 */
export function resetLogs(): void {
  entries.length = 0;
}
