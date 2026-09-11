/**
 * 进程内请求监控统计。
 *
 * 只保留内存中的滚动窗口(默认最近 60 分钟,按分钟分桶)与最近若干条请求明细,
 * 不落盘、不记录请求正文或凭证明文;进程重启即清零。
 *
 * 供管理台「总览」渲染:流量时序、延迟分位、按模型/接口聚合、错误明细。
 */

/** 单条请求明细(供管理台「最近请求」列表展示) */
export interface RequestRecord {
  at: number;
  path: string;
  model: string;
  status: number;
  durationMs: number;
  credentialId?: string;
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
}

/**
 * 补齐一条请求的 token 用量。
 *
 * 流式请求在 recordRequest 时还不知道 token 数(usage 由上游在流末尾给出),
 * 由响应流结束时的回调补齐。以 totalTokens 作幂等哨兵:重复调用(例如流被
 * 取消后又触发 flush)不会重复累加,缺失 usage 的请求则永远保持 undefined。
 */
export function attachTokenUsage(
  record: RequestRecord,
  usage: { promptTokens: number; completionTokens: number },
): void {
  if (record.totalTokens !== undefined) return;

  const toCount = (value: number): number => {
    const n = Math.round(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const prompt = toCount(usage.promptTokens);
  const completion = toCount(usage.completionTokens);
  const total = prompt + completion;

  record.promptTokens = prompt;
  record.completionTokens = completion;
  record.totalTokens = total;

  state.totals.promptTokens += prompt;
  state.totals.completionTokens += completion;
  state.totals.tokenReported += 1;

  // 桶可能尚未建立(流先于 recordRequest 结束)或已被 prune(超长流跨出窗口),
  // 两种情况都交给 addTokensToBucket 处理,不会重复累加。
  addTokensToBucket(record, total);
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

/** 清空统计(仅供测试)。 */
export function resetMetrics(): void {
  state.buckets.clear();
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
