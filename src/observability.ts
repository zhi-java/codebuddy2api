/**
 * Observability 日志模块
 * 输出结构化的脱敏日志，仅包含：API 密钥（部分脱敏）、用户问题、模型输出。
 * 日志通过 console.log 以 JSON 格式输出，可在 wrangler tail 或 Cloudflare 控制台查看。
 */

// ── API 密钥脱敏 ────────────────────────────────────────────────────────────

/**
 * 对 Authorization header 进行部分脱敏。
 * 格式：Bearer Token → "Bearer a1b2***c3d4"
 * 长度 ≤ 8 的 token 显示为 "<too-short>"
 */
export function redactApiKey(authorization: string | null): string {
  if (!authorization) return '<none>';
  const match = authorization.match(/^(\S+)\s+(.+)$/);
  if (!match) return '<malformed>';
  const [, scheme, token] = match;
  if (token.length <= 8) return `${scheme} <too-short>`;
  const prefix = token.slice(0, 4);
  const suffix = token.slice(-4);
  return `${scheme} ${prefix}***${suffix}`;
}

// ── 用户输入提取 ────────────────────────────────────────────────────────────

/**
 * 从 chat completions 请求 payload 中提取所有 user 角色的消息文本。
 * 多个 user 消息用 " | " 分隔。
 */
export function extractUserInput(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '<no payload>';
  const messages = payload['messages'];
  if (!Array.isArray(messages)) return '<no messages>';

  const userMessages = messages
    .filter(
      (m): m is Record<string, unknown> =>
        m !== null && typeof m === 'object' && !Array.isArray(m) && String(m['role']) === 'user',
    )
    .map((m) => extractTextContent(m))
    .filter(Boolean);

  return userMessages.length > 0 ? userMessages.join(' | ') : '<no user messages>';
}

/**
 * 从消息对象中提取文本内容。
 * 支持 content 为 string 或 [{ type: "text", text: "..." }, ...] 数组格式。
 */
function extractTextContent(msg: Record<string, unknown>): string {
  const content = msg['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is Record<string, unknown> =>
          p !== null && typeof p === 'object' && !Array.isArray(p) && p['type'] === 'text',
      )
      .map((p) => String((p as Record<string, unknown>)['text'] ?? ''))
      .join('');
  }
  return '';
}

// ── 模型输出提取 ────────────────────────────────────────────────────────────

/**
 * 从聚合后的 chat completion 响应体中提取 assistant 输出文本。
 */
export function extractAssistantOutput(responseBody: Record<string, unknown>): string {
  const choices = responseBody['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '<no output>';

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object' || Array.isArray(firstChoice)) {
    return '<no output>';
  }

  const choice = firstChoice as Record<string, unknown>;
  const message = choice['message'];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return '<no output>';

  const msg = message as Record<string, unknown>;
  return typeof msg['content'] === 'string' ? msg['content'] : JSON.stringify(msg);
}

// ── 结构化日志输出 ──────────────────────────────────────────────────────────

export interface ObservabilityEntry {
  timestamp: string;
  api_key: string;
  model: string;
  user_input: string;
  assistant_output: string;
}

/**
 * 打印一条结构化的可观测性日志（JSON 格式）。
 * 在 wrangler tail 或 Cloudflare Workers Logs 中可直接搜索 "_observability" 关键词。
 */
export function logObservability(
  authorization: string | null,
  payload: Record<string, unknown> | undefined,
  responseBody: Record<string, unknown>,
): void {
  const model =
    (payload && typeof payload['model'] === 'string' ? payload['model'] : '') || 'unknown';

  const entry: ObservabilityEntry = {
    timestamp: new Date().toISOString(),
    api_key: redactApiKey(authorization),
    model,
    user_input: extractUserInput(payload),
    assistant_output: extractAssistantOutput(responseBody),
  };

  console.log(JSON.stringify({ _observability: entry }));
}
