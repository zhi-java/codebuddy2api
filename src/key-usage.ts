/**
 * Key 级用量累计与配额判定。
 *
 * ## 职责
 *
 * 1. 累计每个 Key 在**日/月**两个窗口的请求数、Token、积分；
 * 2. 在请求进入上游前判定是否超配额（超了直接拒，不浪费上游调用与费用）。
 *
 * ## 为什么独立于 store.ts 的 ClientKey
 *
 * ClientKey 是**配置**（用户改一次，长期不变），用量是**运行时状态**（每请求都变）。
 * 混在一起会导致每次请求都重写整条 Key 记录（含 keyHash），既放大写入量，
 * 也让并发写同一 key 时互相覆盖配置。因此用量单独按 key 落一条记录。
 *
 * ## 持久化模式
 *
 * 沿用 metrics-history 的做法：内存累计 + 定期 flush + KV 落盘。
 * 进程内读写在内存完成（配额判定在请求热路径上，不能每次读盘），
 * 落盘异步进行；进程重启最多丢失一个 flush 周期的增量，对配额控制可接受。
 */

import type { KeyQuota, KeyUsage, KeyUsageCounters } from './types';
import type { KVLike } from './store';

const USAGE_PREFIX = 'keyusage:';
const USAGE_INDEX = 'idx:keyusage';
const FLUSH_INTERVAL_MS = 5_000;

/** 单条用量记录在内存中的形态（含脏标记） */
interface UsageEntry {
  usage: KeyUsage;
  dirty: boolean;
}

interface UsageState {
  kv?: KVLike;
  entries: Map<string, UsageEntry>;
  indexLoaded: boolean;
  lastFlushAt: number;
  flushing?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}

const state: UsageState = {
  entries: new Map(),
  indexLoaded: false,
  lastFlushAt: 0,
};

/** `YYYY-MM-DD`（本地时区），与 metrics-history 的 localDayKey 口径一致 */
export function localDayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM`（本地时区） */
export function localMonthKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function emptyCounters(): KeyUsageCounters {
  return { requests: 0, tokens: 0, credit: 0 };
}

function newUsage(now: number): KeyUsage {
  return {
    day: localDayKey(now),
    month: localMonthKey(now),
    daily: emptyCounters(),
    monthly: emptyCounters(),
    updatedAt: now,
  };
}

/**
 * 按当前时间滚动窗口。
 *
 * 跨天只归零 daily、跨月只归零 monthly —— 分别判断，因为月末最后一天
 * 既跨天又跨月时，两个窗口都要归零，不能用一个条件覆盖两种情况。
 */
function rollWindows(usage: KeyUsage, now: number): void {
  const day = localDayKey(now);
  const month = localMonthKey(now);

  if (usage.day !== day) {
    usage.day = day;
    usage.daily = emptyCounters();
  }
  if (usage.month !== month) {
    usage.month = month;
    usage.monthly = emptyCounters();
  }
}

function entryFor(keyId: string, now: number): UsageEntry {
  let entry = state.entries.get(keyId);
  if (!entry) {
    entry = { usage: newUsage(now), dirty: false };
    state.entries.set(keyId, entry);
  }
  rollWindows(entry.usage, now);
  return entry;
}

/** 初始化：注入 KV 并加载索引、启动定期 flush */
export function initKeyUsage(kv: KVLike): void {
  state.kv = kv;
  state.indexLoaded = false;
  state.entries.clear();

  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    void flushKeyUsage();
  }, FLUSH_INTERVAL_MS);
  // 定时器不应阻止进程退出(与 server.ts 的优雅停机配合)
  if (typeof state.timer === 'object' && state.timer && 'unref' in state.timer) {
    (state.timer as unknown as { unref(): void }).unref();
  }
}

/** 清空全部内存态（测试用）—— 与 resetKeyUsage(keyId) 不同，后者重置单个 Key 的用量 */
export function resetAllKeyUsage(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.entries.clear();
  state.kv = undefined;
  state.indexLoaded = false;
  state.lastFlushAt = 0;
  state.flushing = undefined;
}

async function loadIndex(): Promise<void> {
  if (state.indexLoaded || !state.kv) return;
  state.indexLoaded = true;
  try {
    const raw = await state.kv.get(USAGE_INDEX);
    if (!raw) return;
    const ids = JSON.parse(raw) as unknown;
    if (!Array.isArray(ids)) return;
    await Promise.all(
      ids
        .filter((v): v is string => typeof v === 'string')
        .map(async (id) => {
          try {
            const text = await state.kv!.get(USAGE_PREFIX + id);
            if (!text) return;
            const usage = JSON.parse(text) as KeyUsage;
            if (usage && typeof usage === 'object') {
              state.entries.set(id, { usage, dirty: false });
            }
          } catch {
            // 单条读盘失败不影响其余记录
          }
        }),
    );
    // 加载完成后立即按当前时间滚动窗口（进程可能跨天重启）
    const now = Date.now();
    for (const entry of state.entries.values()) rollWindows(entry.usage, now);
  } catch {
    // 索引读盘失败：从空开始，后续 flush 会重建
  }
}

/** 记录一次请求的用量增量 */
export function recordKeyUsage(
  keyId: string,
  delta: { tokens?: number; credit?: number; countRequest?: boolean },
): void {
  if (!keyId) return;
  const now = Date.now();
  const entry = entryFor(keyId, now);

  // 请求数默认不计：由 recordRequest 统一累加（含失败请求），
  // 避免同一次请求在两处各加一次。只有显式要求时才在此累加。
  if (delta.countRequest) {
    entry.usage.daily.requests += 1;
    entry.usage.monthly.requests += 1;
  }
  if (delta.tokens && delta.tokens > 0) {
    entry.usage.daily.tokens += delta.tokens;
    entry.usage.monthly.tokens += delta.tokens;
  }
  if (delta.credit && delta.credit > 0) {
    entry.usage.daily.credit += delta.credit;
    entry.usage.monthly.credit += delta.credit;
  }
  entry.usage.updatedAt = now;
  entry.dirty = true;

  // 首次记录时确保索引已加载，避免重启后覆盖已有记录
  if (!state.indexLoaded) void loadIndex();
}

/** 读取某 Key 的当前用量（不存在时返回零值快照） */
export function getKeyUsage(keyId: string): KeyUsage {
  const now = Date.now();
  const entry = state.entries.get(keyId);
  if (!entry) return newUsage(now);
  rollWindows(entry.usage, now);
  return entry.usage;
}

/** 一次配额判定的结果 */
export interface QuotaVerdict {
  allowed: boolean;
  /** 超限时说明触发了哪一项，供响应体与日志使用 */
  exceeded?: 'dailyRequests' | 'monthlyRequests' | 'dailyTokens' | 'monthlyTokens' | 'dailyCredit' | 'monthlyCredit';
  /** 超限时的可读说明 */
  message?: string;
}

const QUOTA_LABELS: Record<NonNullable<QuotaVerdict['exceeded']>, string> = {
  dailyRequests: '今日请求数',
  monthlyRequests: '本月请求数',
  dailyTokens: '今日 Token 用量',
  monthlyTokens: '本月 Token 用量',
  dailyCredit: '今日积分消耗',
  monthlyCredit: '本月积分消耗',
};

/**
 * 判定是否超配额。
 *
 * 只检查**已设置**的配额项：未设置（undefined）表示该项不限。
 * 判定基于已累计的用量，因此在「刚好用完最后一个额度」时仍放行这一次，
 * 超额体现在下一次请求——这是预算型配额的常规语义（不是硬性速率闸门）。
 */
export function checkKeyQuota(keyId: string, quota: KeyQuota | undefined): QuotaVerdict {
  if (!quota) return { allowed: true };

  const usage = getKeyUsage(keyId);
  const checks: Array<[NonNullable<QuotaVerdict['exceeded']>, number | undefined, number]> = [
    ['dailyRequests', quota.dailyRequests, usage.daily.requests],
    ['monthlyRequests', quota.monthlyRequests, usage.monthly.requests],
    ['dailyTokens', quota.dailyTokens, usage.daily.tokens],
    ['monthlyTokens', quota.monthlyTokens, usage.monthly.tokens],
    ['dailyCredit', quota.dailyCredit, usage.daily.credit],
    ['monthlyCredit', quota.monthlyCredit, usage.monthly.credit],
  ];

  for (const [field, limit, used] of checks) {
    if (typeof limit === 'number' && limit >= 0 && used >= limit) {
      return {
        allowed: false,
        exceeded: field,
        message: `${QUOTA_LABELS[field]}已达上限（${used}/${limit}）`,
      };
    }
  }

  return { allowed: true };
}

async function writeDirty(): Promise<void> {
  if (!state.kv) return;
  const dirtyIds: string[] = [];
  for (const [id, entry] of state.entries) {
    if (entry.dirty) dirtyIds.push(id);
  }
  if (dirtyIds.length === 0) return;

  // 先写数据再写索引：索引里出现但数据缺失的条目在加载时会被跳过，
  // 反过来（数据在、索引缺）会导致重启后记录读不回来。
  await Promise.all(
    dirtyIds.map(async (id) => {
      const entry = state.entries.get(id);
      if (!entry) return;
      await state.kv!.put(USAGE_PREFIX + id, JSON.stringify(entry.usage));
      entry.dirty = false;
    }),
  );

  const index = Array.from(state.entries.keys());
  await state.kv.put(USAGE_INDEX, JSON.stringify(index));
}

/** 把内存中的脏记录刷到磁盘（幂等，可并发调用） */
export function flushKeyUsage(): Promise<void> {
  if (!state.kv) return Promise.resolve();
  if (state.flushing) return state.flushing;

  state.flushing = (async () => {
    await loadIndex();
    await writeDirty();
  })()
    .catch(() => undefined) // 落盘失败不阻塞请求链路，下次 flush 重试
    .finally(() => {
      state.flushing = undefined;
      state.lastFlushAt = Date.now();
    });

  return state.flushing;
}

/** 删除某 Key 的用量记录（删除 Key 时调用，避免残留数据） */
export async function deleteKeyUsage(keyId: string): Promise<void> {
  state.entries.delete(keyId);
  if (!state.kv) return;
  try {
    await state.kv.delete(USAGE_PREFIX + keyId);
    const index = Array.from(state.entries.keys());
    await state.kv.put(USAGE_INDEX, JSON.stringify(index));
  } catch {
    // 删除失败只影响残留数据，不影响功能
  }
}

/**
 * 重置某 Key 的用量累计（保留配额策略）。
 *
 * 语义是「从此刻重新开始计量」，因此归零两个窗口的计数并把窗口对齐到当前
 * 日/月——否则若旧记录的 day 是昨天，下次 rollWindows 会把刚重置的值再清一次，
 * 看起来像「重置没生效」。
 */
export async function resetKeyUsage(keyId: string): Promise<void> {
  const now = Date.now();
  const fresh = newUsage(now);
  const existing = state.entries.get(keyId);
  if (existing) {
    existing.usage = fresh;
    existing.dirty = true;
  } else {
    state.entries.set(keyId, { usage: fresh, dirty: true });
  }
  await flushKeyUsage();
}

/** 全部 Key 的用量快照（供管理台列表一次性读取，避免 N+1 次读） */
export function allKeyUsage(): Record<string, KeyUsage> {
  const now = Date.now();
  const out: Record<string, KeyUsage> = {};
  for (const [id, entry] of state.entries) {
    rollWindows(entry.usage, now);
    out[id] = entry.usage;
  }
  return out;
}
