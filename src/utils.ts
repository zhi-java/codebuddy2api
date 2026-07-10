/**
 * Environment variables declared in wrangler.jsonc / Cloudflare dashboard
 */
export interface Env {
  UPSTREAM_CHAT_COMPLETIONS_URL: string;
  UPSTREAM_QUOTA_URL?: string;
  UPSTREAM_TIMEOUT_SECONDS: string;
  UPSTREAM_CONNECT_TIMEOUT_SECONDS: string;
  CORS_ALLOW_ORIGINS: string;
  CORS_ALLOW_CREDENTIALS: string;
  DEBUG: string;
}

// ── System text replacements ──────────────────────────────────────────────

const PROMPT_ROLES = new Set(['system', 'developer']);

const SYSTEM_TEXT_REPLACEMENTS: [RegExp, string][] = [
  [
    /You\s+are\s+Claude\s+Code,\s*Anthropic['’]s\s+official\s+CLI\s+for\s+Claude\.?/gi,
    'You are CodeBuddy, Tencent\'s official CLI.',
  ],
  [
    /main\s+branch\s+\(you\s+will\s+usually\s+use\s+this\s+for\s+prs\)/gi,
    'main branch (you will usually use this for pr)',
  ],
];

const MODEL_SUFFIX_PATTERN = /^(.+)\[[^\]]+\]$/;

/**
 * Replace known system-prompt fragments within text.
 */
function replaceSystemText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SYSTEM_TEXT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const match = trimmed.match(MODEL_SUFFIX_PATTERN);
  return match ? match[1].trim() : trimmed;
}

// ── Payload rewrites ──────────────────────────────────────────────────────

/**
 * Rewrite the chat-completions payload's system/developer-message content
 * by replacing known text fragments.
 *
 * Handles both:
 *   content: "string"
 *   content: [{ type: "text", text: "..." }, ...]
 */
export function rewritePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload['model'] === 'string') {
    payload['model'] = normalizeModelId(payload['model']);
  }

  const messages = payload['messages'];
  if (!Array.isArray(messages)) return payload;

  for (const message of messages) {
    if (!message || typeof message !== 'object' || !PROMPT_ROLES.has(String(message['role']))) continue;

    const content = message['content'];

    // Case 1: content is a plain string
    if (typeof content === 'string') {
      message['content'] = replaceSystemText(content);
      continue;
    }

    // Case 2: content is an array of content parts
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && part['type'] === 'text' && typeof part['text'] === 'string') {
          part['text'] = replaceSystemText(part['text']);
        }
      }
    }
  }

  return payload;
}

// ── Shared timeout / fetch helpers ────────────────────────────────────────

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** 最大重试次数 */
const MAX_RETRIES = 2;

/**
 * 判断错误是否可以重试。
 * 可重试的条件：网络错误（非 AbortError）、上游 502/503/504
 */
function isRetryable(err: unknown, status?: number): boolean {
  if (status !== undefined && RETRYABLE_STATUSES.has(status)) return true;
  if (err instanceof TypeError) return true; // 网络错误
  if (err instanceof DOMException) return false; // AbortError 等不可重试
  return false;
}

/**
 * 执行一次带有超时控制的 fetch，在超时时抛出 AbortError。
 * 返回原始 Response（不自动读取 body），调用方自行处理响应。
 */
export async function fetchWithTimeout(
  env: Env,
  requestInfo: RequestInfo,
  requestInit: RequestInit = {},
  debug = false,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = parseFloat(env.UPSTREAM_TIMEOUT_SECONDS || '600') * 1000;
  const connectTimeoutMs = parseFloat(env.UPSTREAM_CONNECT_TIMEOUT_SECONDS || '30') * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + connectTimeoutMs);

  try {
    const response = await fetch(requestInfo, { ...requestInit, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    if (debug) console.error(`[DEBUG] Upstream error: ${errMsg}`);

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Upstream timeout');
    }
    throw err;
  }
}

/**
 * 带重试的超时 fetch。
 * 对可重试错误（502/503/504、网络错误）最多重试 MAX_RETRIES 次。
 * 请求体不是 ReadableStream 才能安全重试（JSON 字符串 / 空 body 等）。
 */
export async function fetchWithRetry(
  env: Env,
  requestInfo: RequestInfo,
  requestInit: RequestInit = {},
  debug = false,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && debug) {
      console.log(`[DEBUG] Retry attempt ${attempt}/${MAX_RETRIES}`);
    }

    try {
      const response = await fetchWithTimeout(env, requestInfo, requestInit, debug);

      // 成功或非可重试状态码直接返回
      if (response.ok || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }

      // 可重试状态码，记录并进入下一轮
      if (attempt < MAX_RETRIES) {
        if (debug) console.log(`[DEBUG] Retryable status ${response.status}, will retry...`);
        // 消耗 body 避免内存泄漏
        await response.body?.cancel();
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(attempt * 500); // 递增退避：0ms, 500ms, 1000ms
        continue;
      }

      // 重试耗尽，返回最后一个响应
      return response;
    } catch (err: unknown) {
      lastError = err;

      if (attempt < MAX_RETRIES && isRetryable(err)) {
        if (debug) console.log(`[DEBUG] Retryable error, will retry...`);
        await sleep(attempt * 500);
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Debug / logging helpers ───────────────────────────────────────────────

const DEBUG_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function parseDebugValue(val: string | undefined): boolean {
  if (!val) return false;
  return DEBUG_TRUE_VALUES.has(val.toLowerCase());
}

export function isDebugEnabled(env: Env): boolean {
  return parseDebugValue(env.DEBUG);
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie']);

/**
 * Return a JSON response with standard headers (content-type + CORS).
 */
export function jsonResponse(data: unknown, env: Env, status = 200): Response {
  const body = JSON.stringify(data);
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': env.CORS_ALLOW_ORIGINS?.trim() || '*',
  });
  return new Response(body, { status, headers });
}

/**
 * Return a copy of the headers with sensitive values redacted (for logging).
 */
export function redactHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    result[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? '<redacted>' : value;
  }
  return result;
}
