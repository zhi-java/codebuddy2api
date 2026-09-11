/**
 * 管理 API 客户端。
 *
 * 统一处理三类横切关注点：
 *   - 会话失效(401) → 回登录页
 *   - 限流抖动(429) → 退避重试一次
 *   - 错误归一化 → 抛出可读 message,由调用方 toast
 */

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 查询参数(自动跳过 undefined) */
  query?: Record<string, string | number | undefined>;
  /** 是否允许 429 自动重试(默认允许) */
  retryOn429?: boolean;
  /** 外部取消信号(与 429 重试共存) */
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const res = await fetch(buildUrl(path, options.query), {
    method,
    credentials: 'same-origin',
    headers: options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (res.status === 401) {
    // 会话过期:交给服务端重新渲染登录页
    window.location.href = '/admin';
    throw new Error('会话已过期');
  }
  if (res.status === 429 && options.retryOn429 !== false) {
    await sleep(600);
    return api<T>(path, { ...options, retryOn429: false });
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 无 body(204 等)按空处理
  }

  if (!res.ok) {
    const record = (data ?? {}) as Record<string, unknown>;
    const message = String(record.message ?? record.error ?? `HTTP ${res.status}`);
    throw new Error(message);
  }
  return data as T;
}

/** 管理端 JSON 响应统一包一层 data 字段 */
export interface DataResponse<T> {
  data: T;
}

/**
 * 流式试跑:读取 SSE 并逐事件回调。
 *
 * 用 fetch + ReadableStream 而非 EventSource —— 需要 POST 请求体与中途取消。
 */
export async function streamChatTest(
  body: Record<string, unknown>,
  onEvent: (event: import('./types').ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/admin/api/chat-test/stream', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (res.status === 401) {
    window.location.href = '/admin';
    throw new Error('会话已过期');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as Record<string, unknown>;
      detail = String(payload.message ?? payload.error ?? payload.detail ?? detail);
    } catch {
      // 保留状态码描述
    }
    throw new Error(detail);
  }
  if (!res.body) throw new Error('响应不支持流式读取');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = raw.split('\n').find((item) => item.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as import('./types').ChatStreamEvent);
      } catch {
        // 忽略无法解析的事件
      }
    }
  }
}
