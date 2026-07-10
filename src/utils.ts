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

/**
 * 执行一次带有超时控制的 fetch，在超时时抛出 AbortError。
 * 返回原始 Response（不自动读取 body），调用方自行处理响应。
 */
export async function fetchWithTimeout(
  env: Env,
  requestInfo: RequestInfo,
  requestInit: RequestInit = {},
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

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Upstream timeout');
    }
    throw err;
  }
}

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
