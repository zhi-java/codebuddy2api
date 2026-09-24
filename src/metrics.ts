/**
 * 进程内请求监控统计。
 *
 * 只保留内存中的滚动窗口(默认最近 60 分钟,按分钟分桶)与最近若干条请求明细,
 * 不落盘、不记录请求正文或凭证明文;进程重启即清零。
 *
 * 供管理台「总览」渲染:流量时序、延迟分位、按模型/接口聚合、错误明细。
 */

import { recordKeyUsage } from './key-usage';

/** 单条请求明细(供管理台「最近请求」列表展示) */
export interface RequestRecord {
  at: number;
  path: string;
  model: string;
  status: number;
  durationMs: number;
  credentialId?: string;
  /** 命中的上游凭证名(便于日志直读,免去按 ID 反查) */
  credentialName?: string;
  /**
   * 命中的网关 Key ID（sk-cb-* 请求才有；透传模式无此字段）。
   *
   * 记录它是为了支撑「按 Key 统计」：请求链路早就拿到了 clientKey，
   * 只是此前没落到记录里，导致无法回答「这个 Key 用了多少」。
   */
  keyId?: string;
  /** 命中的网关 Key 名称（同上，便于列表直读免去反查） */
  keyName?: string;
  /** 该请求是否发生过凭证故障转移 */
  retried?: boolean;
  /** 失败请求的上游错误码/摘要(成功时缺失) */
  error?: string;
  /**
   * 上游返回的 token 用量。流式请求要等响应流结束才拿得到 usage,
   * 因此这三个字段在 recordRequest 之后由 attachTokenUsage 补齐;
   * totalTokens 同时充当「是否已上报」的哨兵,避免重复累加。
   */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * 上游实报的积分消耗(usage.credit)。
   * 流式请求同样由 attachTokenUsage 在流末尾补齐;缺省表示未上报。
   */
  credit?: number;
}

export interface MinuteBucket {
  /** 分钟起始时间戳 */
  minute: number;
  total: number;
  errors: number;
  /** 该分钟内的请求耗时总和,用于画平均延迟曲线 */
  durationSumMs: number;
  /** 该分钟内的 token 消耗合计 */
  totalTokens: number;
}

/** 按模型/接口聚合的统计行 */
export interface GroupStat {
  key: string;
  total: number;
  errors: number;
  avgDurationMs: number;
  /** 该分组已上报的 token 消耗合计 */
  totalTokens: number;
}

export interface MetricsSnapshot {
  totals: {
    total: number;
    success: number;
    error: number;
    successRate: number;
    avgDurationMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    lastMinute: number;
    /** token 消耗合计(仅统计上游上报了 usage 的请求) */
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 已上报 usage 的请求数:与 total 的比值即 token 统计覆盖率 */
    tokenReported: number;
    /** 窗口内每分钟的平均 token 消耗(用于展示速率) */
    avgTokensPerMinute: number;
    /** 上游实报的积分消耗合计(仅统计上报了 credit 的请求) */
    credit: number;
    /** 已上报 credit 的请求数,用于判断覆盖率 */
    creditReported: number;
  };
  /** 服务进程运行信息(供「健康」区展示) */
  uptime: {
    startedAt: number;
    uptimeMs: number;
  };
  /** 最近 60 分钟逐分钟序列(补零,便于直接画图) */
  series: MinuteBucket[];
  byModel: GroupStat[];
  byPath: GroupStat[];
  /** 状态码分布(2xx/4xx/5xx → 次数) */
  statusBuckets: { class2xx: number; class4xx: number; class5xx: number };
  recent: RequestRecord[];
  /** 最近失败请求(最多 10 条),供总览的「近期错误」面板 */
  recentErrors: RequestRecord[];
}

/**
 * 事件出口。
 *
 * 本模块只保留内存滚动窗口,历史归档(日/月)由 metrics-history.ts 负责。
 * 两者用回调解耦:metrics 不依赖存储,history 不侵入请求热路径的统计逻辑。
 * 回调必须同步且不抛错(热路径调用),异步落盘由订阅方自行节流。
 */
export interface MetricsEventSink {
  /** 一次代理请求完成(此时 token/credit 可能尚未回填) */
  onRequest(record: RequestRecord): void;
  /**
   * 该请求的上游用量被补齐。token 与 credit 各自独立幂等:
   * 同一次调用可能只带其中一个字段,重复调用不会重复上报。
   */
  onUsage(record: RequestRecord, delta: { promptTokens?: number; completionTokens?: number; credit?: number }): void;
}

let sink: MetricsEventSink | undefined;

/** 安装/卸载事件出口(未安装时本模块退化为纯内存统计)。 */
export function setMetricsSink(next?: MetricsEventSink): void {
  sink = next;
}

/** 安全投递:订阅方的异常不能影响请求统计本身。 */
function emit(fn: (target: MetricsEventSink) => void): void {
  if (!sink) return;
  try {
    fn(sink);
  } catch {
    // 归档失败只影响历史视图,不影响实时统计
  }
}

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;
const RECENT_MAX = 200;
const RECENT_ERRORS_MAX = 10;
/** 延迟分位采样上限:避免长跑后排序开销无界 */
const LATENCY_SAMPLE_MAX = 2_000;

interface Bucket {
  total: number;
  errors: number;
  durationSumMs: number;
  totalTokens: number;
}

interface MetricsState {
  buckets: Map<number, Bucket>;
  recent: RequestRecord[];
  totals: {
    total: number;
    success: number;
    error: number;
    durationSumMs: number;
    promptTokens: number;
    completionTokens: number;
    tokenReported: number;
    credit: number;
    creditReported: number;
  };
  /** 最近若干次耗时样本(环形上限),用于分位数 */
  latencies: number[];
  startedAt: number;
}

/**
 * 统计状态挂在 globalThis 上:测试会把各模块分别打包成独立 bundle,
 * 若用模块级变量会各自持有一份空统计,导致管理端读不到请求侧数据。
 */
const REGISTRY = globalThis as unknown as { __cbGatewayMetrics?: MetricsState };

function createState(): MetricsState {
  return {
    buckets: new Map<number, Bucket>(),
    recent: [],
    totals: {
      total: 0,
      success: 0,
      error: 0,
      durationSumMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokenReported: 0,
      credit: 0,
      creditReported: 0,
    },
    latencies: [],
    startedAt: Date.now(),
  };
}

const state: MetricsState = REGISTRY.__cbGatewayMetrics ?? (REGISTRY.__cbGatewayMetrics = createState());

function minuteOf(at: number): number {
  return Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

function prune(now: number): void {
  const oldest = minuteOf(now) - WINDOW_MINUTES * MINUTE_MS;
  for (const key of state.buckets.keys()) {
    if (key < oldest) state.buckets.delete(key);
  }
}

/**
 * 已把 token 计入分钟桶的记录。
 *
 * recordRequest 与 attachTokenUsage 都可能承担「把 token 记进分钟桶」这件事,
 * 取决于哪一步先拿到 usage:非流式在 recordRequest 之前就已解析出 usage,而
 * 流式通常更晚——但 pipeThrough 会立即抽取上游,极短的流可能在 recordRequest
 * 之前就结束并触发 attachTokenUsage。用 WeakSet 显式标记,保证同一记录只入桶一次。
 */
const bucketedRecords = new WeakSet<RequestRecord>();

/** 把 token 计入所属分钟桶(幂等)。桶尚未建立时不标记,留给 recordRequest 补记。 */
function addTokensToBucket(record: RequestRecord, total: number): void {
  if (bucketedRecords.has(record)) return;
  const bucket = state.buckets.get(minuteOf(record.at));
  if (!bucket) return;
  bucketedRecords.add(record);
  bucket.totalTokens += total;
}

/** 记录一次已完成的代理请求。 */
export function recordRequest(record: RequestRecord): void {
  const minute = minuteOf(record.at);
  const bucket = state.buckets.get(minute) ?? { total: 0, errors: 0, durationSumMs: 0, totalTokens: 0 };
  bucket.total += 1;
  bucket.durationSumMs += record.durationMs;
  if (record.status >= 400) bucket.errors += 1;
  state.buckets.set(minute, bucket);

  // 注意：请求数**不在此累加**。它由请求链路的准入闸门统一计（见 index.ts 的
  // enforceKeyPolicy 调用点）——因为本函数可能被故障转移等分支绕过，
  // 在此计数会漏计失败请求，使配额形同虚设。
  // 这里只负责 token / 积分，它们要等上游 usage 才拿得到（见 attachTokenUsage）。

  // 非流式请求在进到这里之前就已拿到 usage,补记进桶;
  // 流式请求此刻 token 仍缺失,稍后由 attachTokenUsage 补。
  if (record.totalTokens !== undefined) {
    addTokensToBucket(record, record.totalTokens);
  }

  state.totals.total += 1;
  state.totals.durationSumMs += record.durationMs;
  if (record.status >= 400) state.totals.error += 1;
  else state.totals.success += 1;

  state.latencies.push(record.durationMs);
  if (state.latencies.length > LATENCY_SAMPLE_MAX) state.latencies.shift();

  state.recent.unshift(record);
  if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;

  prune(record.at);

  emit((target) => target.onRequest(record));
}

/**
 * 补齐一条请求的 token 用量与积分消耗。
 *
 * 流式请求在 recordRequest 时还拿不到 usage(由上游在流末尾给出),
 * 由响应流结束时的回调补齐。以 totalTokens 作幂等哨兵:重复调用(例如流被
 * 取消后又触发 flush)不会重复累加,缺失 usage 的请求则永远保持 undefined。
 *
 * credit 单独判重(不挂在 token 哨兵上):部分请求只有 credit 或只有 token,
 * 且 credit 为 0 是有效值(免费模型),不能用真值判断。
 */
export function attachTokenUsage(
  record: RequestRecord,
  usage: { promptTokens: number; completionTokens: number; credit?: number },
): void {
  const delta: { promptTokens?: number; completionTokens?: number; credit?: number } = {};

  const toCount = (value: number): number => {
    const n = Math.round(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  // 积分:独立回填。上游未上报时保持 undefined,便于界面区分「0 积分」与「未上报」。
  if (record.credit === undefined && typeof usage.credit === 'number') {
    record.credit = usage.credit;
    state.totals.credit += usage.credit;
    state.totals.creditReported += 1;
    delta.credit = usage.credit;
  }

  // token 已计过的请求（非流式路径下 recordRequest 先跑，聚合结果的 totalTokens
  // 在进入本函数前就已设置）在此只需补记 credit。
  //
  // 注意：Key 用量的累加**不能**放在这个提前 return 之后——曾因此漏计：
  // 非流式请求的 token 走不到累加点，Key 统计里 tokens 恒为 0。
  // 两个窗口的写入统一收敛到末尾的 recordKeyUsage。
  if (record.totalTokens !== undefined) {
    if (record.keyId && delta.credit !== undefined) {
      recordKeyUsage(record.keyId, { credit: delta.credit });
    }
    if (delta.credit !== undefined) emit((target) => target.onUsage(record, delta));
    return;
  }

  const prompt = toCount(usage.promptTokens);
  const completion = toCount(usage.completionTokens);
  const total = prompt + completion;

  record.promptTokens = prompt;
  record.completionTokens = completion;
  record.totalTokens = total;

  state.totals.promptTokens += prompt;
  state.totals.completionTokens += completion;
  state.totals.tokenReported += 1;

  delta.promptTokens = prompt;
  delta.completionTokens = completion;

  // 桶可能尚未建立(流先于 recordRequest 结束)或已被 prune(超长流跨出窗口),
  // 两种情况都交给 addTokensToBucket 处理,不会重复累加。
  addTokensToBucket(record, total);

  // Key 用量：token 与 credit 一次写入（两者都到齐时才可能走到这里）
  if (record.keyId) {
    recordKeyUsage(record.keyId, { tokens: total, credit: record.credit });
  }

  emit((target) => target.onUsage(record, delta));
}

/** 线性插值分位数(样本已排序) */
function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

/** 按 key 聚合统计(默认取最近 200 条明细,足够反映当前热度) */
function groupBy(field: 'model' | 'path'): GroupStat[] {
  const map = new Map<string, { total: number; errors: number; durationSumMs: number; totalTokens: number }>();
  for (const record of state.recent) {
    const key = (field === 'model' ? record.model : record.path) || '(未知)';
    const entry = map.get(key) ?? { total: 0, errors: 0, durationSumMs: 0, totalTokens: 0 };
    entry.total += 1;
    entry.durationSumMs += record.durationMs;
    entry.totalTokens += record.totalTokens ?? 0;
    if (record.status >= 400) entry.errors += 1;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      total: value.total,
      errors: value.errors,
      avgDurationMs: Math.round(value.durationSumMs / value.total),
      totalTokens: value.totalTokens,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
}

/** 读取当前统计快照(自动补零成连续分钟序列)。 */
export function metricsSnapshot(now = Date.now()): MetricsSnapshot {
  prune(now);
  const currentMinute = minuteOf(now);
  const series: MinuteBucket[] = [];
  for (let i = WINDOW_MINUTES - 1; i >= 0; i -= 1) {
    const minute = currentMinute - i * MINUTE_MS;
    const bucket = state.buckets.get(minute);
    series.push({
      minute,
      total: bucket?.total ?? 0,
      errors: bucket?.errors ?? 0,
      durationSumMs: bucket?.durationSumMs ?? 0,
      totalTokens: bucket?.totalTokens ?? 0,
    });
  }

  const sorted = [...state.latencies].sort((a, b) => a - b);
  let class2xx = 0;
  let class4xx = 0;
  let class5xx = 0;
  for (const record of state.recent) {
    if (record.status >= 500) class5xx += 1;
    else if (record.status >= 400) class4xx += 1;
    else class2xx += 1;
  }

  const uptimeMs = Math.max(0, now - state.startedAt);
  // 平均速率按「进程实际运行过的分钟数」算,避免刚启动时被 60 分钟窗口稀释
  const activeMinutes = Math.min(WINDOW_MINUTES, Math.max(1, Math.ceil(uptimeMs / MINUTE_MS)));

  return {
    totals: {
      total: state.totals.total,
      success: state.totals.success,
      error: state.totals.error,
      successRate: state.totals.total > 0 ? Math.round((state.totals.success / state.totals.total) * 1000) / 10 : 0,
      avgDurationMs: state.totals.total > 0 ? Math.round(state.totals.durationSumMs / state.totals.total) : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      lastMinute: state.buckets.get(currentMinute)?.total ?? 0,
      promptTokens: state.totals.promptTokens,
      completionTokens: state.totals.completionTokens,
      totalTokens: state.totals.promptTokens + state.totals.completionTokens,
      tokenReported: state.totals.tokenReported,
      avgTokensPerMinute: Math.round((state.totals.promptTokens + state.totals.completionTokens) / activeMinutes),
      credit: Math.round(state.totals.credit * 10000) / 10000,
      creditReported: state.totals.creditReported,
    },
    uptime: { startedAt: state.startedAt, uptimeMs },
    series,
    byModel: groupBy('model'),
    byPath: groupBy('path'),
    statusBuckets: { class2xx, class4xx, class5xx },
    recent: [...state.recent].slice(0, 50),
    recentErrors: state.recent.filter((record) => record.status >= 400).slice(0, RECENT_ERRORS_MAX),
  };
}

/**
 * 进程启动信息。
 *
 * 公开落地页只需要运行时长,不值得为它做一次完整的 metricsSnapshot
 * (那会排序最多 2000 个延迟样本)。
 */
export function uptimeSnapshot(now = Date.now()): { startedAt: number; uptimeMs: number } {
  return { startedAt: state.startedAt, uptimeMs: Math.max(0, now - state.startedAt) };
}

/** 清空统计(仅供测试)。 */
export function resetMetrics(): void {  state.buckets.clear();
  state.recent.length = 0;
  state.latencies.length = 0;
  state.totals.total = 0;
  state.totals.success = 0;
  state.totals.error = 0;
  state.totals.durationSumMs = 0;
  state.totals.promptTokens = 0;
  state.totals.completionTokens = 0;
  state.totals.tokenReported = 0;
  state.startedAt = Date.now();
}
