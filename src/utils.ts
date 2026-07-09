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
  const body = JSON.stringify(data, null, 2);
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
