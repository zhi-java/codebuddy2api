/**
 * 请求量的日/月归档。
 *
 * metrics.ts 只在内存里保留 60 分钟滚动窗口,进程重启即清零,回答不了
 * 「昨天用了多少」「上个月消耗多少积分」。本模块订阅 metrics 的事件出口,
 * 把每条完成请求累加进所属自然日的日桶,节流写入持久化存储;
 * 月桶由日桶派生(不单独落盘),避免两份数据口径漂移。
 *
 * 口径:
 *   - 按**服务器本地时区**切分自然日/自然月(容器内建议设置 TZ=Asia/Shanghai)
 *   - 用量(tokens/credit)归到请求**发生**的那一天,而非流式回填的时刻
 *   - 只统计代理请求,管理台自身的调用不计入
 *
 * 写入策略:
 *   - 内存全量驻留(默认保留 400 天,约 60KB),读快照零 IO
 *   - 变更后节流 10 秒落盘:进程被强杀最多丢失最后 10 秒的归档增量,
 *     实时统计(内存窗口)不受影响
 *   - 索引先于数据落盘,保证崩溃后不会留下读不到的孤儿归档
 */

import { setMetricsSink, type MetricsEventSink, type RequestRecord } from './metrics';
import type { KVLike } from './store';

/** 日/月桶共用的可加指标集合 */
interface MetricTotals {
  total: number;
  success: number;
  error: number;
  /** 请求耗时总和,除以 total 即平均耗时 */
  durationSumMs: number;
  promptTokens: number;
  completionTokens: number;
  /** 上游实报的积分消耗合计 */
  credit: number;
}

/** 单日聚合(本地时区自然日) */
export interface DayBucket extends MetricTotals {
  /** 本地日期 YYYY-MM-DD */
  day: string;
}

/** 单月聚合(由日桶派生) */
export interface MonthBucket extends MetricTotals {
  /** 本地月份 YYYY-MM */
  month: string;
}

export interface HistorySnapshot {
  /** 是否已接入持久化存储(内存存储时归档不可用) */
  enabled: boolean;
  /** 日归档保留天数 */
  retentionDays: number;
  /** 按日序列,升序,缺失日补零 */
  days: DayBucket[];
  /** 按月序列,升序,缺失月补零 */
  months: MonthBucket[];
}

const DAY_PREFIX = 'metrics:day:';
const INDEX_KEY = 'metrics:index';

/** 日归档保留天数:覆盖 12 个自然月并留余量 */
export const RETENTION_DAYS = 400;

/** 落盘节流间隔。SQLite 单条写入很小,5 秒既能把强杀损失压在秒级,也不至于打满 IO。 */
const FLUSH_INTERVAL_MS = 5_000;

const MS_PER_DAY = 86_400_000;

interface HistoryState {
  kv?: KVLike;
  /** 全量日桶(已落盘值 + 未落盘增量) */
  days: Map<string, DayBucket>;
  /** 有未落盘增量的日期 */
  dirty: Set<string>;
  /** 已归档的日期列表(升序) */
  index: string[];
  loaded: boolean;
  loading?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  /** 进行中的落盘任务:并发调用合流到同一次,避免同一批日桶被重复写 */
  flushing?: Promise<void>;
  lastFlushAt: number;
}

/**
 * 状态挂在 globalThis 上,原因与 metrics.ts 相同:
 * 测试会把各模块分别打包成独立 bundle,模块级变量会导致写入方与读取方各持一份。
 */
const REGISTRY = globalThis as unknown as { __cbGatewayMetricsHistory?: HistoryState };

function state(): HistoryState {
  return (
    REGISTRY.__cbGatewayMetricsHistory ?? (REGISTRY.__cbGatewayMetricsHistory = createState())
  );
}

function createState(): HistoryState {
  return {
    days: new Map<string, DayBucket>(),
    dirty: new Set<string>(),
    index: [],
    loaded: false,
    lastFlushAt: 0,
  };
}

// ── 日期工具(全部按本地时区) ────────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日期键 `YYYY-MM-DD` */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地月份键 `YYYY-MM` */
function localMonthKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * 按自然日偏移。用 Date 构造器而非 `ts - n*86400000`:
 * 后者在夏令时切换日会偏移一小时,跨日边界时把请求算错天。
 */
function shiftDay(base: Date, offset: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
}

function shiftMonth(base: Date, offset: number): Date {
  return new Date(base.getFullYear(), base.getMonth() + offset, 1);
}

// ── 桶构造与合并 ──────────────────────────────────────────────────────────

function emptyDay(day: string): DayBucket {
  return { day, total: 0, success: 0, error: 0, durationSumMs: 0, promptTokens: 0, completionTokens: 0, credit: 0 };
}

function emptyMonth(month: string): MonthBucket {
  return { month, total: 0, success: 0, error: 0, durationSumMs: 0, promptTokens: 0, completionTokens: 0, credit: 0 };
}

/** 把 source 累加进 target(日桶、月桶共用同一套指标) */
function addInto(target: MetricTotals, source: MetricTotals): void {
  target.total += source.total;
  target.success += source.success;
  target.error += source.error;
  target.durationSumMs += source.durationSumMs;
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.credit += source.credit;
}

function parseIndex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').sort();
  } catch {
    return [];
  }
}

/** 解析已落盘的日桶;结构不合法时返回 undefined(按零值处理,不中断服务) */
function parseDay(raw: string | null, fallbackDay: string): DayBucket | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DayBucket>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      day: typeof parsed.day === 'string' ? parsed.day : fallbackDay,
      total: num(parsed.total),
      success: num(parsed.success),
      error: num(parsed.error),
      durationSumMs: num(parsed.durationSumMs),
      promptTokens: num(parsed.promptTokens),
      completionTokens: num(parsed.completionTokens),
      credit: num(parsed.credit),
    };
  } catch {
    return undefined;
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/**
 * 接入持久化存储并开始归档。
 *
 * 幂等:同一存储重复接入不会重置内存镜像。需在进程启动时调用一次
 * (server.ts),管理端也会按 env 惰性兜底(见 admin.ts),两者互不干扰。
 * 未接入时本模块完全惰性,快照返回 `enabled: false`。
 */
export function initMetricsHistory(kv: KVLike): void {
  const st = state();
  if (st.kv === kv) return;
  st.kv = kv;
  // 切换存储时丢弃上一份内存镜像,避免两个数据源串味
  st.days = new Map<string, DayBucket>();
  st.dirty = new Set<string>();
  st.index = [];
  st.loaded = false;
  st.loading = undefined;
  setMetricsSink(sink);
  // 提前预热:首屏快照与首条请求都不必等磁盘
  void ensureLoaded();
}

/** 读取全部日归档(仅首次真正读盘)。读失败时降级为「仅有本次运行的增量」。 */
async function ensureLoaded(): Promise<void> {
  const st = state();
  if (!st.kv || st.loaded) return;
  if (!st.loading) {
    const kv = st.kv;
    st.loading = (async () => {
      const index = parseIndex(await kv.get(INDEX_KEY));
      const stored = await Promise.all(
        index.map(async (day) => parseDay(await kv.get(DAY_PREFIX + day), day)),
      );
      for (const bucket of stored) {
        if (!bucket) continue;
        const inMemory = st.days.get(bucket.day);
        // 进程启动到读盘完成之间可能已累加了增量,此时合并而非覆盖
        if (inMemory) addInto(inMemory, bucket);
        else st.days.set(bucket.day, bucket);
      }
      st.index = index;
      st.loaded = true;
    })()
      .catch(() => {
        // 读盘失败:保留内存增量继续服务,下次 flush 会把它们写回去
        st.loaded = true;
      })
      .finally(() => {
        st.loading = undefined;
      });
  }
  await st.loading;
}

function scheduleFlush(): void {
  const st = state();
  if (st.timer) return;
  const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - st.lastFlushAt));
  st.timer = setTimeout(() => {
    st.timer = undefined;
    void flushMetricsHistory();
  }, wait);
  // Node 下不因此定时器阻止进程退出
  (st.timer as unknown as { unref?: () => void }).unref?.();
}

/** 把未落盘的日桶写入存储(幂等,可重复调用；并发调用合流)。 */
export function flushMetricsHistory(): Promise<void> {
  const st = state();
  if (!st.kv) return Promise.resolve();
  if (st.flushing) return st.flushing;
  st.flushing = writeDirtyDays().finally(() => {
    st.flushing = undefined;
  });
  return st.flushing;
}

async function writeDirtyDays(): Promise<void> {
  const st = state();
  const kv = st.kv;
  if (!kv) return;

  await ensureLoaded();
  if (st.dirty.size === 0) return;

  const pending = [...st.dirty];
  st.dirty.clear();
  st.lastFlushAt = Date.now();

  let indexChanged = false;
  for (const day of pending) {
    const bucket = st.days.get(day);
    if (!bucket) continue;
    try {
      // 索引先行:先让日期可被发现,再写数据。反序若在两次写之间崩溃,
      // 会留下一份永远读不到的归档;索引里多一个空日期则无害(读时补零)。
      if (!st.index.includes(day)) {
        st.index = [...st.index, day].sort();
        indexChanged = true;
        await kv.put(INDEX_KEY, JSON.stringify(st.index));
      }
      await kv.put(DAY_PREFIX + day, JSON.stringify(bucket));
    } catch {
      // 写失败:退回脏集合,下轮重试
      st.dirty.add(day);
    }
  }

  if (indexChanged) await pruneExpired(kv);
}

/** 清理超出保留期的日归档。 */
async function pruneExpired(kv: KVLike): Promise<void> {
  const st = state();
  const cutoff = localDayKey(Date.now() - RETENTION_DAYS * MS_PER_DAY);
  // 键为 `YYYY-MM-DD`,字典序即时间序
  const expired = st.index.filter((day) => day < cutoff);
  if (expired.length === 0) return;

  st.index = st.index.filter((day) => day >= cutoff);
  for (const day of expired) {
    st.days.delete(day);
    st.dirty.delete(day);
    try {
      await kv.delete(DAY_PREFIX + day);
    } catch {
      // 删除失败仅占用一点空间,不阻塞归档
    }
  }
  try {
    await kv.put(INDEX_KEY, JSON.stringify(st.index));
  } catch {
    // 索引回写失败:下次 flush 会带上正确的索引
  }
}

// ── 事件订阅 ──────────────────────────────────────────────────────────────

/** 就地累加指定请求所属日期的日桶。 */
function accumulate(at: number, apply: (bucket: DayBucket) => void): void {
  const st = state();
  if (!st.kv) return;

  const day = localDayKey(at);
  const bucket = st.days.get(day) ?? emptyDay(day);
  apply(bucket);
  st.days.set(day, bucket);
  st.dirty.add(day);
  scheduleFlush();
}

const sink: MetricsEventSink = {
  onRequest(record: RequestRecord): void {
    accumulate(record.at, (bucket) => {
      bucket.total += 1;
      if (record.status >= 400) bucket.error += 1;
      else bucket.success += 1;
      bucket.durationSumMs += record.durationMs;
    });
  },

  onUsage(record: RequestRecord, delta): void {
    // 归到请求发生的日期:长流可能跨日结束,按回填时刻会算错天
    accumulate(record.at, (bucket) => {
      bucket.promptTokens += delta.promptTokens ?? 0;
      bucket.completionTokens += delta.completionTokens ?? 0;
      bucket.credit += delta.credit ?? 0;
    });
  },
};

// ── 快照 ──────────────────────────────────────────────────────────────────

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 读取日/月归档。缺失的日期与月份补零,调用方可直接画图。
 *
 * @param options.days   返回的日序列长度(默认 30,上限为保留天数)
 * @param options.months 返回的月序列长度(默认 12,上限 24)
 */
export async function historySnapshot(
  options: { days?: number; months?: number } = {},
): Promise<HistorySnapshot> {
  const st = state();
  const dayCount = clampInt(options.days ?? 30, 1, RETENTION_DAYS);
  const monthCount = clampInt(options.months ?? 12, 1, 24);

  if (!st.kv) {
    return { enabled: false, retentionDays: RETENTION_DAYS, days: [], months: [] };
  }

  await ensureLoaded();

  // 读时顺手落盘:仪表盘轮询是天然的检查点,把「硬杀丢失窗口」从固定的节流间隔
  // 收窄到「最近一次查看之后」。不 await —— 读取本身是内存快照,不该被写入拖慢。
  if (st.dirty.size > 0) void flushMetricsHistory();

  const today = new Date();
  const days: DayBucket[] = [];
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const key = localDayKey(shiftDay(today, -offset).getTime());
    days.push(st.days.get(key) ?? emptyDay(key));
  }

  const byMonth = new Map<string, MonthBucket>();
  for (const bucket of st.days.values()) {
    const key = bucket.day.slice(0, 7);
    const target = byMonth.get(key) ?? emptyMonth(key);
    addInto(target, bucket);
    byMonth.set(key, target);
  }

  const months: MonthBucket[] = [];
  for (let offset = monthCount - 1; offset >= 0; offset -= 1) {
    const key = localMonthKey(shiftMonth(today, -offset));
    months.push(byMonth.get(key) ?? emptyMonth(key));
  }

  return { enabled: true, retentionDays: RETENTION_DAYS, days, months };
}

/** 清空归档状态(仅供测试)。不删除已落盘数据。 */
export function resetMetricsHistory(): void {
  const st = state();
  if (st.timer) clearTimeout(st.timer);
  REGISTRY.__cbGatewayMetricsHistory = createState();
  setMetricsSink(undefined);
}
