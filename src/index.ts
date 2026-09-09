import { getModelsList, getModelById } from './models';
import { Env, rewritePayload, jsonResponse, fetchWithTimeout } from './utils';
import { checkRateLimit, getRateLimitKey, maybeCleanupBuckets } from './rate-limiter';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const REQUEST_EXCLUDED = new Set(['host', 'content-length', ...HOP_BY_HOP]);
const RESPONSE_EXCLUDED = new Set(['content-length', ...HOP_BY_HOP]);

const DEFAULT_UPSTREAM_QUOTA_URL = 'https://copilot.tencent.com/v2/billing/meter/get-user-resource';

// ── Entry point ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Rate limiting ─────────────────────────────────────────────────
    const rateLimitKey = getRateLimitKey(request);
    if (!checkRateLimit(rateLimitKey)) {
      return new Response('Too Many Requests', { status: 429 });
    }
    maybeCleanupBuckets();

    // ── CORS preflight ────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight(request, env);
    }

    // ── Body size check for POST endpoints ────────────────────────────
    if (request.method === 'POST') {
      const contentLength = parseInt(request.headers.get('content-length') || '0');
      if (contentLength > MAX_BODY_SIZE) {
        return new Response('Payload Too Large', { status: 413 });
      }
    }

    // ── Route: GET /v1/models — list all models ──────────────────────
    if (request.method === 'GET' && path === '/v1/models') {
      return jsonResponse(getModelsList(), env);
    }

    // ── Route: GET /v1/models/:id — single model detail ──────────────
    const modelDetailMatch = path.match(/^\/v1\/models\/(.+)$/);
    if (request.method === 'GET' && modelDetailMatch) {
      const model = getModelById(modelDetailMatch[1]);
      if (!model) {
        return jsonResponse({ error: 'Model not found' }, env, 404);
      }
      return jsonResponse(model, env);
    }

    // ── Route: POST /v1/chat/completions ─────────────────────────────
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      return handleChatCompletions(request, env);
    }

    // ── Route: POST /quota — CodeBuddy credits quota proxy ───────────
    if (request.method === 'POST' && path === '/quota') {
      return handleQuota(request, env);
    }

    // ── Health check ──────────────────────────────────────────────────
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return jsonResponse({ status: 'ok' }, env);
    }

    return jsonResponse({ error: 'Not Found' }, env, 404);
  },
};

// ── CORS preflight ───────────────────────────────────────────────────────

function handleCorsPreflight(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(env, request),
  });
}

function parseCorsOrigins(env: Env): string[] {
  return (env.CORS_ALLOW_ORIGINS || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function resolveCorsAllowOrigin(env: Env, requestOrigin: string | null): string {
  const allowOrigins = parseCorsOrigins(env);
  const allowsAnyOrigin = allowOrigins.length === 0 || allowOrigins.includes('*');
  const allowsCredentials = env.CORS_ALLOW_CREDENTIALS === 'true';

  if (allowsAnyOrigin) {
    return allowsCredentials && requestOrigin ? requestOrigin : '*';
  }

  if (requestOrigin && allowOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return allowOrigins[0];
}

export function buildCorsHeaders(env: Env, request?: Request): Headers {
  const headers = new Headers();
  const requestOrigin = request?.headers.get('origin') ?? null;
  const allowOrigin = resolveCorsAllowOrigin(env, requestOrigin);
  headers.set('access-control-allow-origin', allowOrigin);
  headers.set('access-control-allow-methods', 'POST, GET, OPTIONS');
  headers.set('access-control-allow-headers', '*');
  if (env.CORS_ALLOW_CREDENTIALS === 'true') {
    headers.set('access-control-allow-credentials', 'true');
  }
  if (allowOrigin !== '*') {
    headers.set('vary', 'Origin');
  }
  headers.set('access-control-max-age', '86400');
  return headers;
}

// ── Chat completions handler ─────────────────────────────────────────────

async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const payloadObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const clientRequestedStream = payloadObject?.['stream'] === true;

  const upstreamUrl = buildUpstreamUrl(env, request.url);

  // Build upstream request headers
  const upstreamHeaders = new Headers();
  for (const [name, value] of request.headers) {
    if (!REQUEST_EXCLUDED.has(name.toLowerCase())) {
      upstreamHeaders.set(name, value);
    }
  }

  // Rewrite body (only for small payloads to save CPU)
  const bodyStr = payloadObject
    ? JSON.stringify(prepareChatPayload(payloadObject))
    : JSON.stringify(payload);

  try {
    const upstreamResponse = await fetchWithTimeout(env, upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: bodyStr,
    });

    // Stream request or upstream error → pure pass-through
    if (clientRequestedStream || !upstreamResponse.ok) {
      return buildUpstreamResponse(upstreamResponse, env, request);
    }

    // Non-streaming: read body, aggregate SSE → JSON
    return buildNonStreamingChatResponse(upstreamResponse, env, request);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg === 'Upstream timeout') {
      return new Response('Upstream timeout', { status: 504 });
    }
    return new Response(`Upstream error: ${errMsg}`, { status: 502 });
  }
}

// ── Quota handler ────────────────────────────────────────────────────────

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const upstreamUrl = env.UPSTREAM_QUOTA_URL || DEFAULT_UPSTREAM_QUOTA_URL;
  const authorization = request.headers.get('authorization');
  const upstreamHeaders = new Headers({
    'content-type': 'application/json',
  });

  if (authorization) {
    upstreamHeaders.set('authorization', authorization);
  }

  const requestBody = await request.text();
  const body = requestBody.trim() ? requestBody : '{}';

  try {
    const upstreamResponse = await fetchWithTimeout(env, upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body,
    });

    return buildUpstreamResponse(upstreamResponse, env, request);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg === 'Upstream timeout') {
      return jsonResponse({ error: 'Upstream timeout' }, env, 504);
    }
    return jsonResponse({ error: 'Upstream error', message: errMsg }, env, 502);
  }
}

// ── Payload preparation ──────────────────────────────────────────────────

function prepareChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const rewrittenPayload = rewritePayload(payload);
  rewrittenPayload['stream'] = true;
  return rewrittenPayload;
}

// ── Response builders ────────────────────────────────────────────────────

function buildUpstreamResponse(upstreamResponse: Response, env: Env, request: Request): Response {
  const responseHeaders = new Headers();
  for (const [name, value] of upstreamResponse.headers) {
    if (!RESPONSE_EXCLUDED.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  }

  const corsHeaders = buildCorsHeaders(env, request);
  for (const [name, value] of corsHeaders) {
    responseHeaders.set(name, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

async function buildNonStreamingChatResponse(
  upstreamResponse: Response,
  env: Env,
  request: Request,
): Promise<Response> {
  const chunks = parseSseJsonChunks(await upstreamResponse.text());
  const responseBody = buildChatCompletionResponse(chunks);
  const responseHeaders = new Headers({
    'content-type': 'application/json; charset=utf-8',
  });

  const corsHeaders = buildCorsHeaders(env, request);
  for (const [name, value] of corsHeaders) {
    responseHeaders.set(name, value);
  }

  return new Response(JSON.stringify(responseBody), {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

// ── SSE parsing ──────────────────────────────────────────────────────────

function parseSseJsonChunks(body: string): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [];
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];

    if (!data || data === '[DONE]') return;

    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        chunks.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed SSE events
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      flushEvent();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  flushEvent();
  return chunks;
}

function buildChatCompletionResponse(chunks: Record<string, unknown>[]): Record<string, unknown> {
  const firstChunk = chunks[0] ?? {};
  const choices = new Map<number, Record<string, unknown>>();
  let usage: unknown;

  for (const chunk of chunks) {
    if (chunk['usage']) {
      usage = chunk['usage'];
    }

    const chunkChoices = chunk['choices'];
    if (!Array.isArray(chunkChoices)) continue;

    for (let fallbackIndex = 0; fallbackIndex < chunkChoices.length; fallbackIndex++) {
      const chunkChoice = chunkChoices[fallbackIndex];
      if (!chunkChoice || typeof chunkChoice !== 'object' || Array.isArray(chunkChoice)) continue;

      const choice = chunkChoice as Record<string, unknown>;
      const index = typeof choice['index'] === 'number' ? choice['index'] : fallbackIndex;
      const aggregate = getAggregateChoice(choices, index);
      const delta = choice['delta'];

      if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
        mergeDelta(aggregate, delta as Record<string, unknown>);
      }

      if ('finish_reason' in choice) {
        aggregate['finish_reason'] = choice['finish_reason'];
      }
      if ('logprobs' in choice) {
        aggregate['logprobs'] = choice['logprobs'];
      }
    }
  }

  return {
    id: firstChunk['id'] ?? `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: typeof firstChunk['created'] === 'number' ? firstChunk['created'] : Math.floor(Date.now() / 1000),
    model: firstChunk['model'] ?? '',
    choices: Array.from(choices.values())
      .sort((a, b) => Number(a['index']) - Number(b['index']))
      .map((choice) => ({
        index: choice['index'],
        message: choice['message'],
        logprobs: choice['logprobs'] ?? null,
        finish_reason: choice['finish_reason'] ?? 'stop',
      })),
    ...(usage ? { usage } : {}),
  };
}

function getAggregateChoice(
  choices: Map<number, Record<string, unknown>>,
  index: number,
): Record<string, unknown> {
  const existingChoice = choices.get(index);
  if (existingChoice) return existingChoice;

  const choice = {
    index,
    message: {
      role: 'assistant',
      content: '',
    },
    finish_reason: null,
  };

  choices.set(index, choice);
  return choice;
}

function mergeDelta(choice: Record<string, unknown>, delta: Record<string, unknown>): void {
  const message = choice['message'];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  const target = message as Record<string, unknown>;
  if (typeof delta['role'] === 'string') {
    target['role'] = delta['role'];
  }
  if (typeof delta['content'] === 'string') {
    target['content'] = `${target['content'] ?? ''}${delta['content']}`;
  }
  if (typeof delta['reasoning_content'] === 'string') {
    target['reasoning_content'] = `${target['reasoning_content'] ?? ''}${delta['reasoning_content']}`;
  }
  if ('tool_calls' in delta) {
    target['tool_calls'] = delta['tool_calls'];
  }
}

export function buildUpstreamUrl(env: Env, requestUrl: string): string {
  const base = env.UPSTREAM_CHAT_COMPLETIONS_URL || 'https://copilot.tencent.com/v2/chat/completions';
  const reqUrl = new URL(requestUrl);
  if (reqUrl.search) {
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}${reqUrl.searchParams.toString()}`;
  }
  return base;
}
