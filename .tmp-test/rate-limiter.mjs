// src/rate-limiter.ts
var BUCKETS = /* @__PURE__ */ new Map();
var DEFAULT_RATE = 60;
var DEFAULT_WINDOW_MS = 6e4;
var DEFAULT_BURST = 10;
function checkRateLimit(key, rate = DEFAULT_RATE, windowMs = DEFAULT_WINDOW_MS, burst = DEFAULT_BURST) {
  const now = Date.now();
  let bucket = BUCKETS.get(key);
  if (!bucket) {
    bucket = { tokens: burst, lastRefill: now };
    BUCKETS.set(key, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  const refillTokens = elapsed / windowMs * rate;
  bucket.tokens = Math.min(burst, bucket.tokens + refillTokens);
  bucket.lastRefill = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}
function getRateLimitKey(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return `ip:${cfIp}`;
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp) return `ip:${firstIp}`;
  }
  return "anonymous";
}
var lastCleanup = Date.now();
var CLEANUP_INTERVAL_MS = 3e5;
function maybeCleanupBuckets() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  const staleThreshold = now - 6e5;
  for (const [key, bucket] of BUCKETS) {
    if (bucket.lastRefill < staleThreshold) {
      BUCKETS.delete(key);
    }
  }
}
export {
  checkRateLimit,
  getRateLimitKey,
  maybeCleanupBuckets
};
