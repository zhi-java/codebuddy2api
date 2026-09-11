/**
 * 网关运行时环境变量(由进程环境 / Docker Compose 注入)。
 */
export interface Env {
  UPSTREAM_CHAT_COMPLETIONS_URL: string;
  UPSTREAM_QUOTA_URL?: string;
  /** 上游模型配置接口,默认 https://copilot.tencent.com/v3/config */
  UPSTREAM_CONFIG_URL?: string;
  /** 上游 token 刷新接口,默认 https://copilot.tencent.com/v2/plugin/auth/token/refresh */
  UPSTREAM_REFRESH_URL?: string;
  UPSTREAM_TIMEOUT_SECONDS: string;
  UPSTREAM_CONNECT_TIMEOUT_SECONDS: string;
  CORS_ALLOW_ORIGINS: string;
  CORS_ALLOW_CREDENTIALS: string;

  /** 凭证存储(SQLite/JSON 的 KVLike;未注入时自动降级内存存储) */
  CREDENTIALS_KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** 凭证落盘加密密钥 */
  CREDENTIALS_ENC_SECRET?: string;
  /** 管理界面密码 */
  ADMIN_PASSWORD?: string;
  /** 思考输出策略:auto / thinking / text / off */
  EMIT_THINKING?: string;
  /** 管理会话签名密钥 */
  ADMIN_SESSION_SECRET?: string;
  /** 网关自建 key 前缀，默认 sk-cb */
  GATEWAY_KEY_PREFIX?: string;
  /** 入口限流:每分钟速率(按来源 IP) */
  RATE_LIMIT_PER_MINUTE?: string;
  /** 入口限流:令牌桶容量(突发额度) */
  RATE_LIMIT_BURST?: string;
  /** 管理台前端产物目录(默认 <cwd>/web/dist,Docker 内为 /app/public) */
  PUBLIC_DIR?: string;
  DEBUG?: string;
}

// ── System text replacements ──────────────────────────────────────────────

const PROMPT_ROLES = new Set(['system', 'developer']);

/** 替换后的渠道身份句(CodeBuddy 官方身份) */
const CODEBUDDY_CHANNEL_LINE = "You are CodeBuddy, Tencent's official AI coding assistant.";

/** 已知细节替换(Anthropic 渠道句由 replaceSystemText 行级规则统一处理) */
const SYSTEM_TEXT_REPLACEMENTS: [RegExp, string][] = [
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
  // 行级渠道特征处理(真实 Claude Code system 首行为 billing 标记、次行为
  // "You are a Claude agent, built on Anthropic's Claude Agent SDK." 等 SDK 措辞)
  const lines = text.split('\n');
  const rewritten: string[] = [];

  for (const rawLine of lines) {
    // 1) Anthropic 官方计费/渠道标记行:整体剔除(上游据此判定未授权渠道)
    if (/^\s*x-anthropic-billing-header\s*:/i.test(rawLine)) {
      continue;
    }

    let line = rawLine;
    // 2) Anthropic 渠道身份句(官方 SDK/官方 CLI/Anthropic 出品等自述,含措辞变体):
    //    整句(首个句号边界)替换为 CodeBuddy,句后内容保留
    if (
      !/CodeBuddy/i.test(line) &&
      /Anthropic['’]s\s+official|built\s+(?:on|by)\s+Anthropic|Agent\s+SDK|powered\s+by\s+Anthropic|an\s+Anthropic-powered|Anthropic['’]s\s+Claude/i.test(line)
    ) {
      const end = line.search(/\.(?=\s|$)/);
      const cut = end >= 0 ? end + 1 : line.length;
      line = CODEBUDDY_CHANNEL_LINE + line.slice(cut);
    }

    rewritten.push(line);
  }

  let result = rewritten.join('\n');
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

// ── 入口限流配置 ─────────────────────────────────────────────────────────

/** 单个来源 IP 的默认限流速率与突发额度 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;
export const DEFAULT_RATE_LIMIT_BURST = 60;

/**
 * 解析入口限流配置。
 * 默认按「单个来源 IP」计:编码智能体的工具调用循环很容易超过低频阈值,
 * 且多个客户端常共用出口 IP,因此默认值取得较宽,可用环境变量收紧或放宽。
 */
export function resolveRateLimit(env: { RATE_LIMIT_PER_MINUTE?: string; RATE_LIMIT_BURST?: string }): {
  perMinute: number;
  burst: number;
} {
  const perMinute = Number(env.RATE_LIMIT_PER_MINUTE);
  const burst = Number(env.RATE_LIMIT_BURST);
  return {
    perMinute: Number.isFinite(perMinute) && perMinute > 0 ? perMinute : DEFAULT_RATE_LIMIT_PER_MINUTE,
    burst: Number.isFinite(burst) && burst > 0 ? burst : DEFAULT_RATE_LIMIT_BURST,
  };
}

// ── Shared timeout / fetch helpers ────────────────────────────────────────
/**
 * 执行一次带有超时控制的 fetch，在超时时抛出 AbortError。
 * 返回原始 Response（不自动读取 body），调用方自行处理响应。
 */
export async function fetchWithTimeout(
  env: Env,
  requestInfo: string | URL | Request,
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
