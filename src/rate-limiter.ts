/**
 * 简易令牌桶速率限制器（内存实现）
 * 注意：Cloudflare Workers 是无状态的，此限制在同一 Worker 实例内生效。
 * 生产环境建议使用 Durable Objects 或 KV 实现全局限流。
 */

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const BUCKETS = new Map<string, TokenBucket>();

/** 默认配置：每分钟 60 次请求，最大突发 10 次 */
const DEFAULT_RATE = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BURST = 10;

/**
 * 检查是否允许请求。
 * @returns true 表示允许，false 表示被限流
 */
export function checkRateLimit(
  key: string,
  rate: number = DEFAULT_RATE,
  windowMs: number = DEFAULT_WINDOW_MS,
  burst: number = DEFAULT_BURST,
): boolean {
  const now = Date.now();
  let bucket = BUCKETS.get(key);

  if (!bucket) {
    bucket = { tokens: burst, lastRefill: now };
    BUCKETS.set(key, bucket);
  }

  // 令牌补充
  const elapsed = now - bucket.lastRefill;
  const refillTokens = (elapsed / windowMs) * rate;
  bucket.tokens = Math.min(burst, bucket.tokens + refillTokens);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

/**
 * 从 Request 中提取限流 key。
 * 优先级：X-Forwarded-For 首个 IP > CF-Connecting-IP > 匿名 key
 */
export function getRateLimitKey(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return `ip:${cfIp}`;

  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) {
    const firstIp = forwarded.split(',')[0].trim();
    if (firstIp) return `ip:${firstIp}`;
  }

  return 'anonymous';
}

/**
 * 定期清理过期桶（每 5 分钟清理一次，防止内存泄漏）
 */
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 300_000;

export function maybeCleanupBuckets(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  // 清理 10 分钟未使用的桶
  const staleThreshold = now - 600_000;
  for (const [key, bucket] of BUCKETS) {
    if (bucket.lastRefill < staleThreshold) {
      BUCKETS.delete(key);
    }
  }
}
