import {
  getModelsList,
  getModelById,
  findModelMetadata,
  fetchUpstreamModels,
  OpenAIModel,
} from './models';
import {
  resolveUpstreamCredential,
  markCredentialFailure,
  markCredentialSuccess,
  getCredentialStatus,
  CHANNEL_FAULT_STATUSES,
  UnauthorizedError,
  UpstreamCredentialError,
} from './credentials';
import { getTokenStore } from './store';
import type { UpstreamCredential } from './types';
import { Env, jsonResponse, fetchWithTimeout, normalizeModelId, resolveRateLimit } from './utils';
import { handleAdmin } from './admin';
import { renderLandingPage, renderPublicModelsPage, renderHealthPage, type LandingStatus } from './admin-ui';
import { checkRateLimit, getRateLimitKey, maybeCleanupBuckets } from './rate-limiter';
import {
  completionTap,
  createSseTransformer,
  keepAliveTransform,
  parseSseJsonChunks,
  SSE_DONE,
  usageTap,
  extractUsageFromSseText,
  type TokenUsage,
} from './protocol/sse';
import { prepareChatPayload, sanitizeChatPayload } from './payload';
import { recordRequest, attachTokenUsage, uptimeSnapshot, type RequestRecord } from './metrics';
import { pushLog } from './logs';
import { anthropicRequestToChat, AnthropicConverter } from './protocol/anthropic';
import { responsesRequestToChat, ResponsesConverter } from './protocol/responses';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const REQUEST_EXCLUDED = new Set([
  'host', 'content-length', ...HOP_BY_HOP,
  // 网关自身管理/身份相关头,不透传:
  'x-api-key', 'anthropic-version',
]);
const RESPONSE_EXCLUDED = new Set(['content-length', ...HOP_BY_HOP]);

/**
 * 允许转发到 CodeBuddy Chat 上游的客户端头白名单。
 *
 * 上游会校验渠道身份:任何未识别的客户端指纹头(DSH 的 deepseek-harness UA、
 * OpenAI SDK 的 x-stainless-*、浏览器的 origin/referer 等)都会导致
 * "Illegal API invocation from an unapproved channel"。
 * 因此这里只保留业务必需头,其余一律不透传。
 */
const FORWARDED_CLIENT_HEADERS = new Set(['accept', 'accept-language', 'content-type']);

const DEFAULT_UPSTREAM_QUOTA_URL = 'https://copilot.tencent.com/v2/billing/meter/get-user-resource';
const APPROVED_UPSTREAM_USER_AGENT = 'CLI/2.107.0 CodeBuddy/2.107.0';

/** 入口限流配置(默认值与管理端「设置」展示共用同一份解析逻辑) */
const rateLimit = resolveRateLimit(process.env);

/** CodeBuddy 上游认可的 CLI 渠道指纹(与模型目录/计费链路保持一致)。 */
const APPROVED_UPSTREAM_CHANNEL_HEADERS: Record<string, string> = {
  'user-agent': APPROVED_UPSTREAM_USER_AGENT,
  'x-ide-type': 'CLI',
  'x-ide-name': 'CLI',
  'x-ide-version': '2.107.0',
  'x-requested-with': 'XMLHttpRequest',
  'x-codebuddy-request': '1',
  'x-product': 'SaaS',
  'x-private-data': 'false',
};

// ── Entry point ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // 去尾斜杠,兼容部分 SDK 把 base_url 拼成 /v1/ 后再追加路径
    const path = url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;

    // ── Rate limiting ─────────────────────────────────────────────────
    // 管理面(含鉴权与独立限流)不占全局入口桶,避免管理台多视图请求触发 429
    if (!path.startsWith('/admin')) {
      const rateLimitKey = getRateLimitKey(request);
      if (!checkRateLimit(rateLimitKey, rateLimit.perMinute, 60_000, rateLimit.burst)) {
        // 明确告知客户端可重试时机,避免 SDK 立刻重放再次被拒
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '2', 'content-type': 'text/plain; charset=utf-8' },
        });
      }
    }
    maybeCleanupBuckets();

    // ── CORS preflight ────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight(request, env);
    }

    // ── Route: /admin — 管理界面与管理 API（未启用时 404） ────────────
    if (path === '/admin' || path.startsWith('/admin/')) {
      return handleAdmin(request, env, path);
    }

    // ── Body size check for POST endpoints ────────────────────────────
    if (request.method === 'POST') {
      const contentLength = parseInt(request.headers.get('content-length') || '0');
      if (contentLength > MAX_BODY_SIZE) {
        return new Response('Payload Too Large', { status: 413 });
      }
    }

    // ── Route: GET /v1/models | /models — list all models ────────────
    // DeepSeek Harness / 部分 OpenAI SDK 会打无 /v1 前缀的路径
    if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      // 浏览器页面使用网关已配置的健康凭证实时拉取;API 客户端使用自身凭证
      if (wantsHtml(request)) {
        return htmlResponse(renderPublicModelsPage(await resolveBrowserModelsList(env)));
      }
      return withCredential(request, env, async (credential) =>
        jsonResponse(await resolveModelsList(credential, env), env),
      );
    }

    // ── Route: GET /v1/models/:id | /models/:id — single model ───────
    const modelDetailMatch = path.match(/^\/(?:v1\/)?models\/(.+)$/);
    if (request.method === 'GET' && modelDetailMatch) {
      const requestedId = modelDetailMatch[1];
      return withCredential(request, env, async (credential) => {
        const upstreamModels = await fetchUpstreamModels(credential, env);
        const model = findModel(upstreamModels, requestedId)
          ?? getModelById(requestedId);

        if (!model) {
          return jsonResponse({ error: 'Model not found' }, env, 404);
        }
        return jsonResponse(model, env);
      });
    }

    // ── Route: POST /v1/chat/completions | /chat/completions ─────────
    if (request.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      return handleChatCompletions(request, env);
    }

    // ── Route: POST /v1/messages | /messages — Anthropic Messages API ──
    if (request.method === 'POST' && (path === '/v1/messages' || path === '/messages')) {
      return handleProtocolEndpoint(request, env, 'anthropic');
    }

    // ── Route: POST /v1/responses | /responses — OpenAI Responses API ──
    if (request.method === 'POST' && (path === '/v1/responses' || path === '/responses')) {
      return handleProtocolEndpoint(request, env, 'responses');
    }

    // ── Route: POST /quota — CodeBuddy credits quota proxy ───────────
    if (request.method === 'POST' && path === '/quota') {
      return handleQuota(request, env);
    }

    // ── GET / — 品牌落地页;GET /health — 纯 JSON 健康检查 ────────────
    if (request.method === 'GET') {
      if (path === '/') {
        return htmlResponse(renderLandingPage(await buildLandingStatus(env)));
      }
      if (path === '/health') {
        if (wantsHtml(request)) {
          return htmlResponse(renderHealthPage());
        }
        return jsonResponse({ status: 'ok' }, env);
      }
    }

    return jsonResponse({ error: 'Not Found' }, env, 404);
  },
};

/** 浏览器(可读 HTML)请求判定:Accept 含 text/html */
function wantsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('text/html') || accept.includes('application/xhtml+xml');
}

/**
 * 组装落地页的运行时状态。
 *
 * 该页面对外无鉴权,因此只回传**粗粒度**信息:
 *   - 模型数量取内置快照目录,不触发上游调用(落地页不该被上游抖动拖慢)
 *   - 凭证池在服务端就压成三档枚举,渲染层拿不到原始计数,结构上杜绝泄漏
 */
async function buildLandingStatus(env: Env): Promise<LandingStatus> {
  const uptime = uptimeSnapshot();
  let modelCount = 0;
  let sampleModel = 'default';
  let credentialPool: LandingStatus['credentialPool'] = 'unknown';

  try {
    const models = getModelsList().data;
    modelCount = models.length;
    sampleModel = pickSampleModel(models);
  } catch {
    modelCount = 0;
  }

  try {
    const credentials = await getTokenStore(env).listCredentials();
    if (credentials.length > 0) {
      const healthy = credentials.filter((c) => getCredentialStatus(c) === 'healthy').length;
      if (healthy === 0) credentialPool = 'none';
      else if (healthy < credentials.length) credentialPool = 'partial';
      else credentialPool = 'good';
    }
  } catch {
    // 存储不可用时不对外暴露细节
    credentialPool = 'unknown';
  }

  return { ...uptime, modelCount, sampleModel, credentialPool };
}

/**
 * 落地页 curl 示例引用哪个模型。
 *
 * 从目录里现取而非写死：示例写死会在模型下线后变成一条跑不通的命令，
 * 而这页的首要价值就是「照抄即可用」。
 */
const SAMPLE_MODEL_PREFERENCE = ['deepseek-v4-pro', 'glm-5.3', 'hy4-preview'];

function pickSampleModel(models: OpenAIModel[]): string {
  for (const id of SAMPLE_MODEL_PREFERENCE) {
    if (models.some((model) => model.id === id)) return id;
  }
  // 目录首个条目可能是 'default' 这类别名，仅作兜底
  return models[0]?.id ?? 'default';
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

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
  const startedAt = Date.now();
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
  const requestedModel = typeof payloadObject?.['model'] === 'string' ? payloadObject['model'] : '';

  const upstreamUrl = buildUpstreamUrl(env, request.url);
  const upstreamHeaders = buildUpstreamHeaders(request);
  const exposeReasoning = shouldExposeChatReasoning(payloadObject, env);
  let attempts = 0;
  let usedCredentialId: string | undefined;
  let usedCredentialName: string | undefined;

  // 记录对象先建好:流式请求的 usage 由上游在流末尾给出,需要等响应流结束后
  // 由 usageTap 回填,所以不能在 handler 返回时一次性构造。
  const record: RequestRecord = {
    at: startedAt,
    path: '/v1/chat/completions',
    model: requestedModel,
    status: 0,
    durationMs: 0,
  };
  // 供通用故障转移层写失败日志时读取(见 requestModels 说明)
  requestModels.set(request, requestedModel);
  const onUsage = (usage: TokenUsage): void => attachTokenUsage(record, usage);

  // 日志落笔时机:流式请求的 usage/credit 在流末尾才到,需由完成旁路触发;
  // 非流式与错误路径在响应返回时即已齐全。用 once 保证两种路径各只记一条。
  let finalized = false;
  // 流式响应的 usage/credit 在流末尾才到:一旦把 finalize 交给完成旁路,
  // 响应返回时就不能再落笔,否则日志会在 usage 到达前先写出空值。
  let streamPending = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    logRequestOutcome(record, 'chat');
  };

  const response = await withCredential(request, env, async (credential, clientKey) => {
    attempts += 1;
    usedCredentialId = credential.credentialId;
    usedCredentialName = credential.credentialName;
    // Rewrite body(按命中 Key 应用 model 别名,再统一改写/强制流式)
    const prepared = payloadObject
      ? applyModelAlias(payloadObject, clientKey)
      : undefined;
    const bodyStr = prepared
      ? JSON.stringify(await prepareChatPayload(prepared, env, credential))
      : JSON.stringify(payload);

    applyCredentialHeaders(upstreamHeaders, credential);

    try {
      const upstreamResponse = await fetchWithTimeout(env, upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: bodyStr,
      });

      // 上游错误(无论是否流式)→ 可诊断透传(空 body 自动回填 JSON,客户端可读)
      if (!upstreamResponse.ok) {
        logChatRequestShape(request, bodyStr, upstreamHeaders, upstreamResponse, credential);
        return buildErrorResponse(upstreamResponse, env, request);
      }
      // 流式请求 → 原样透传
      if (clientRequestedStream) {
        streamPending = true;
        return buildUpstreamResponse(upstreamResponse, env, request, {
          stripReasoning: !exposeReasoning,
          onUsage,
          onComplete: finalize,
        });
      }

      // Non-streaming: read body, aggregate SSE → JSON
      return buildNonStreamingChatResponse(upstreamResponse, env, request, exposeReasoning, onUsage);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 上游响应头已到达,失败发生在读取/聚合阶段 → 上游可能已生成并计费,
      // 标记为本地失败以阻止凭证故障转移重放。
      if (errMsg === 'Upstream timeout') {
        return localFailureResponse('Upstream timeout', 504);
      }
      return localFailureResponse(`Upstream error: ${errMsg}`, 502);
    }
  });

  record.status = response.status;
  record.durationMs = Date.now() - startedAt;
  record.credentialId = usedCredentialId;
  record.credentialName = usedCredentialName;
  record.retried = attempts > 1;
  if (response.status >= 400) record.error = requestErrorSummaries.get(request);
  recordRequest(record);
  // 流式请求的 usage/credit 在流末尾才到:交给完成旁路落笔,
  // 此处不能提前记(否则日志里 token/积分永远是空的)
  if (!streamPending) finalize();
  return response;
}

/**
 * 记录一次请求的最终去向:命中的上游凭证、状态、耗时、token 与积分消耗。
 *
 * 此前只有失败请求会写日志(`upstream_failure` / `credential_failover`),
 * 成功请求在管理台日志页完全看不到 —— 用户无从确认「这次调用用了哪个凭证、
 * 花了多少积分」。
 *
 * 流式请求的 usage/credit 由上游在流末尾给出,故此日志在流结束后才落笔;
 * 未上报的字段留空("未上报"),不猜测、不估算。
 */
function logRequestOutcome(record: RequestRecord, channel: string): void {
  const parts = [
    `${record.model || '-'}`,
    `凭证=${record.credentialName ?? record.credentialId ?? '透传'}`,
    `状态=${record.status}`,
    `${record.durationMs}ms`,
  ];
  if (record.retried) parts.push('已故障转移');
  if (record.totalTokens !== undefined) {
    parts.push(`token=${record.promptTokens}+${record.completionTokens}`);
  }
  // credit 为 0 是有效值(免费模型),用 !== undefined 区分「0 积分」与「未上报」
  parts.push(record.credit !== undefined ? `积分≈${record.credit}` : '积分=未上报');

  pushLog(record.status >= 400 ? 'warn' : 'info', 'request_completed',
    `[${channel}] ${parts.join(' ')}`, {
      channel,
      path: record.path,
      model: record.model,
      credentialId: record.credentialId,
      credentialName: record.credentialName,
      status: record.status,
      durationMs: record.durationMs,
      retried: record.retried || undefined,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      credit: record.credit,
      ...(record.error ? { error: record.error } : {}),
    });
}

/**
 * 将解析后的上游凭证写入转发头。
 * chat 通道实测只需 Authorization；X-User-Id 仅在有值时补充（模型目录接口必需）。
 */
function applyCredentialHeaders(headers: Headers, credential: UpstreamCredential): void {
  headers.set('authorization', `Bearer ${credential.token}`);
  if (credential.userId) {
    headers.set('x-user-id', credential.userId);
  }
}

// ── Quota handler ────────────────────────────────────────────────────────

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  const upstreamUrl = env.UPSTREAM_QUOTA_URL || DEFAULT_UPSTREAM_QUOTA_URL;
  const upstreamHeaders = new Headers({
    'content-type': 'application/json',
  });

  const requestBody = await request.text();
  const body = requestBody.trim() ? requestBody : '{}';
  let usedCredentialId: string | undefined;
  let usedCredentialName: string | undefined;

  const response = await withCredential(request, env, async (credential) => {
    usedCredentialId = credential.credentialId;
    usedCredentialName = credential.credentialName;
    applyCredentialHeaders(upstreamHeaders, credential);

    try {
      const upstreamResponse = await fetchWithTimeout(env, upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body,
      });

      if (!upstreamResponse.ok) {
        return buildErrorResponse(upstreamResponse, env, request);
      }
      return buildUpstreamResponse(upstreamResponse, env, request);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (errMsg === 'Upstream timeout') {
        return jsonResponse({ error: 'Upstream timeout' }, env, 504);
      }
      return jsonResponse({ error: 'Upstream error', message: errMsg }, env, 502);
    }
  });

  recordRequest({
    at: Date.now(),
    path: '/quota',
    model: '',
    status: response.status,
    durationMs: Date.now() - startedAt,
    credentialId: usedCredentialId,
  });
  return response;
}

// ── Protocol endpoint (Anthropic Messages / OpenAI Responses) ─────────────

type ProtocolKind = 'anthropic' | 'responses';

/**
 * 通用协议端点:把 Anthropic/Responses 请求转成上游 chat.completions,
 * 再把上游 SSE 转换回目标协议事件流。
 *
 * 客户端 stream=true → 流式转换管道;stream=false → 聚合为对象响应。
 */
async function handleProtocolEndpoint(
  request: Request,
  env: Env,
  kind: ProtocolKind,
): Promise<Response> {
  const startedAt = Date.now();
  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const body = (typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
    ? rawPayload
    : {}) as Record<string, unknown>;

  // 1. 客户端是否要流式(两协议均显式声明;默认非流式)
  const clientWantsStream = body['stream'] === true;

  const upstreamUrl = buildUpstreamUrl(env, request.url);
  const upstreamHeaders = buildUpstreamHeaders(request);
  const path = kind === 'anthropic' ? '/v1/messages' : '/v1/responses';
  const requestedModel = typeof body['model'] === 'string' ? body['model'] : '';
  let attempts = 0;
  let usedCredentialId: string | undefined;
  let usedCredentialName: string | undefined;

  // 同 chat 链路:usage 在流末尾才到,先建记录对象由旁路回填
  const record: RequestRecord = {
    at: startedAt,
    path,
    model: requestedModel,
    status: 0,
    durationMs: 0,
  };
  requestModels.set(request, requestedModel);
  const onUsage = (usage: TokenUsage): void => attachTokenUsage(record, usage);

  // 日志落笔时机:流式请求的 usage/credit 在流末尾才到,需由完成旁路触发;
  // 非流式与错误路径在响应返回时即已齐全。用 once 保证两种路径各只记一条。
  let finalized = false;
  // 同 chat 链路:流式时把落笔交给完成旁路
  let streamPending = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    logRequestOutcome(record, kind);
  };

  const response = await withCredential(request, env, async (credential, clientKey) => {
    attempts += 1;
    usedCredentialId = credential.credentialId;
    usedCredentialName = credential.credentialName;
    // 2. 目标协议请求 → 上游 chat payload(应用 Key 级模型别名)
    const chatPayload =
      kind === 'anthropic'
        ? anthropicRequestToChat(body)
        : responsesRequestToChat(body);
    applyModelAlias(chatPayload, clientKey);

    // 3. 统一改写:模型名规范化 + 系统提示品牌文本替换 + 思考档位映射 + 字段清洗
    await prepareChatPayload(chatPayload, env, credential);
    const requestModel = typeof chatPayload['model'] === 'string' ? chatPayload['model'] : '';

    applyCredentialHeaders(upstreamHeaders, credential);

    try {
      const upstreamResponse = await fetchWithTimeout(env, upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(chatPayload),
      });

      // 上游错误 → 可诊断透传(空 body 自动回填)
      if (!upstreamResponse.ok) {
        return buildErrorResponse(upstreamResponse, env, request);
      }

      if (clientWantsStream) {
        const thinkingOptions = resolveThinking(body, env);
        const converter: AnthropicConverter | ResponsesConverter =
          kind === 'anthropic'
            ? new AnthropicConverter({ model: requestModel, ...thinkingOptions })
            : new ResponsesConverter({
                model: requestModel,
                // Responses 协议用 reasoning item 承载思考,选项名为 emitReasoning
                emitReasoning: thinkingOptions.emitThinking,
                carryReasoning: thinkingOptions.carryReasoning,
              });

        const transform = createSseTransformer(
          (chunk) =>
            kind === 'anthropic'
              ? (converter as AnthropicConverter).feed(chunk)
              : (converter as ResponsesConverter).feed(chunk),
          () =>
            kind === 'anthropic'
              ? (converter as AnthropicConverter).finish()
              : (converter as ResponsesConverter).finish(),
        );

        const headers = new Headers({
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        const cors = buildCorsHeaders(env, request);
        cors.forEach((value, name) => headers.set(name, value));

        const upstreamBody = upstreamResponse.body
          ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });

        streamPending = true;
        // 用量旁路必须挂在协议转换之前:转换后的目标协议事件不再保留上游 usage。
        // 顺序:观察上游原始 SSE → 协议转换 → 完成旁路 → 心跳保活
        const stream = upstreamBody
          .pipeThrough(usageTap(onUsage))
          .pipeThrough(transform)
          .pipeThrough(completionTap(finalize))
          .pipeThrough(keepAliveTransform());

        return new Response(stream, {
          status: 200,
          headers,
        });
      }

      // 非流式:聚合上游 SSE → 目标协议对象
      const upstreamText = await upstreamResponse.text();
      const usage = extractUsageFromSseText(upstreamText);
      if (usage) onUsage(usage);
      const thinkingOptions = resolveThinking(body, env);
      const responseBody =
        kind === 'anthropic'
          ? AnthropicConverter.fromUpstreamText(upstreamText, {
              model: requestModel,
              ...thinkingOptions,
            }).buildMessage()
          : ResponsesConverter.fromUpstreamText(upstreamText, {
              model: requestModel,
              emitReasoning: thinkingOptions.emitThinking,
              carryReasoning: thinkingOptions.carryReasoning,
            }).buildResponse();

      const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
      const cors = buildCorsHeaders(env, request);
      cors.forEach((value, name) => headers.set(name, value));

      return new Response(JSON.stringify(responseBody), {
        status: upstreamResponse.status,
        headers,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // 同 chat 链路:读取/转换阶段的失败不得触发凭证重放,否则重复扣费。
      if (errMsg === 'Upstream timeout') {
        return localFailureResponse('Upstream timeout', 504);
      }
      return localFailureResponse(`Upstream error: ${errMsg}`, 502);
    }
  });

  record.status = response.status;
  record.durationMs = Date.now() - startedAt;
  record.credentialId = usedCredentialId;
  record.credentialName = usedCredentialName;
  record.retried = attempts > 1;
  if (response.status >= 400) record.error = requestErrorSummaries.get(request);
  recordRequest(record);
  // 流式请求的 usage/credit 在流末尾才到:交给完成旁路落笔,
  // 此处不能提前记(否则日志里 token/积分永远是空的)
  if (!streamPending) finalize();
  return response;
}

/**
 * Anthropic Messages / OpenAI Responses 的思考输出策略(EMIT_THINKING):
 *   auto/缺省— 思考走独立 thinking/reasoning 块下发(不并入正文)
 *   thinking — 同上(显式声明)
 *   text     — 并入正文(仅用于客户端不认思考块的场景)
 *   off      — 丢弃 reasoning
 * 注:绝不能在 auto 下把思考并入正文,否则 Anthropic 客户端会把内部推理当成最终答案。
 */
function resolveThinking(
  body: Record<string, unknown>,
  env: Env,
): { emitThinking: boolean; carryReasoning: boolean } {
  void body;
  const mode = (env.EMIT_THINKING || 'auto').toLowerCase();
  if (mode === 'off') return { emitThinking: false, carryReasoning: false };
  if (mode === 'text') return { emitThinking: false, carryReasoning: true };
  // thinking / auto:思考走独立的 thinking，reasoning 块下发(不并入正文),
  // 由客户端自行决定是否渲染;支持思考的客户端因此不会拿不到内容。
  return { emitThinking: true, carryReasoning: false };
}

// ── Shared upstream request headers ─────────────────────────────────────────

/**
 * 构造转发给上游的请求头。
 *
 * 采用白名单而不是黑名单:客户端身份指纹一旦泄漏到 CodeBuddy 上游,
 * 整条请求会被判定为未授权渠道(HTTP 400)。这里只保留业务必需头,
 * 再叠加网关认可的 CLI 渠道指纹。
 */
function buildUpstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (REQUEST_EXCLUDED.has(lower)) return;
    if (!FORWARDED_CLIENT_HEADERS.has(lower)) return;
    headers.set(name, value);
  });

  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  for (const [name, value] of Object.entries(APPROVED_UPSTREAM_CHANNEL_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

// ── Model alias ─────────────────────────────────────────────────────────────

/**
 * 按命中的网关 Key 应用模型别名重写(客户端无感知)。
 * 匹配基于规范化后的模型名(自动剥 [1m] 等后缀),保证 'glm-5.2[1m]' 命中别名 'glm-5.2'。
 * 直接修改传入对象;无别名配置时不产生任何变化。
 */
function applyModelAlias(
  payload: Record<string, unknown>,
  clientKey: import('./types').ClientKey | undefined,
): Record<string, unknown> {
  const aliases = clientKey?.modelAliases;
  const rawModel = payload['model'];
  if (!aliases || typeof rawModel !== 'string') return payload;

  const mapped = aliases[normalizeModelId(rawModel)] ?? aliases[rawModel];
  if (typeof mapped === 'string' && mapped) {
    payload['model'] = mapped;
  }
  return payload;
}

/**
 * Chat Completions 的思考输出策略。
 *
 * 思考内容走独立的 `reasoning_content` 字段,不会混入 `content`,
 * 因此默认(含 auto)直接下发,让 Cherry / DSH / DeepSeek SDK 等
 * 支持该字段的客户端能拿到思考过程;仅 EMIT_THINKING=off 时剥离。
 */
function shouldExposeChatReasoning(
  payload: Record<string, unknown> | undefined,
  env: Env,
): boolean {
  void payload;
  const mode = (env.EMIT_THINKING || 'auto').toLowerCase();
  return mode !== 'off';
}

function stripChatReasoningChunk(chunk: Record<string, unknown>): string {
  const choices = chunk['choices'];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
      const delta = (choice as Record<string, unknown>)['delta'];
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
      delete (delta as Record<string, unknown>)['reasoning_content'];
      delete (delta as Record<string, unknown>)['reasoning'];
    }
  }
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** 400 渠道错误时记录脱敏请求形状,用于定位真实客户端与重放请求的差异。 */
function logChatRequestShape(
  request: Request,
  bodyStr: string,
  upstreamHeaders: Headers,
  upstreamResponse: Response,
  credential?: UpstreamCredential,
): void {
  try {
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const serialized = bodyStr.toLowerCase();
    const inboundHeaderNames: string[] = [];
    request.headers.forEach((_value, name) => {
      if (name.startsWith('x-') || name === 'user-agent' || name.startsWith('openai-')) {
        inboundHeaderNames.push(name);
      }
    });
    pushLog('warn', 'chat_request_shape', `上游 ${upstreamResponse.status}: ${body.model ?? ''}`, {
      requestId: request.headers.get('x-request-id') || crypto.randomUUID(),
      upstreamRequestId: upstreamResponse.headers.get('x-request-id') || upstreamResponse.headers.get('traceid') || upstreamResponse.headers.get('eo-log-uuid'),
      model: body.model,
      stream: body.stream,
      topLevelKeys: Object.keys(body).sort(),
      messageCount: messages.length,
      messageRoles: messages.map((message) =>
        message && typeof message === 'object' ? (message as Record<string, unknown>).role : undefined,
      ),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      bodyBytes: new TextEncoder().encode(bodyStr).byteLength,
      markers: {
        deepseekHarness: serialized.includes('deepseek harness'),
        deepseekHyphen: serialized.includes('deepseek-harness'),
        anthropic: serialized.includes('anthropic'),
        codeBuddy: serialized.includes('codebuddy'),
      },
      inboundHeaderNames: inboundHeaderNames.sort(),
      forwardedUserAgent: upstreamHeaders.get('user-agent'),
      forwardedIdeType: upstreamHeaders.get('x-ide-type'),
      credentialId: credential?.credentialId,
      credentialName: credential?.credentialName,
      upstreamStatus: upstreamResponse.status,
    });
  } catch {
    // 诊断日志失败不影响原始上游错误响应。
  }
}

// ── Response builders ────────────────────────────────────────────────────

/** 可读化的上游错误文案 */
function describeUpstreamError(status: number): string {
  if (status === 400) {
    return '上游拒绝了请求(HTTP 400)。常见原因:max_tokens 超过模型输出上限、请求含上游不接受的字段、上下文超出窗口、或模型不可用。可尝试:换用更大窗口模型、减小 max_tokens、或在管理台「试跑」用同模型复现。';
  }
  if (status === 401 || status === 403) {
    return `上游鉴权失败(HTTP ${status}),请检查该凭证是否仍然有效(管理台可「测试/刷新」)。`;
  }
  if (status === 429) {
    return '上游限流(HTTP 429),请稍后重试。';
  }
  if (status === 500 || status === 502 || status === 503) {
    return `上游服务异常(HTTP ${status}),请稍后重试。`;
  }
  return `上游返回 HTTP ${status}。`;
}

/**
 * 构造上游错误透传:上游非 2xx 时原样返回其 body;
 * 若 body 为空(客户端常见 "400 no body" 困惑),则回填可诊断的 JSON 错误体。
 */
async function buildErrorResponse(
  upstreamResponse: Response,
  env: Env,
  request: Request,
): Promise<Response> {
  const status = upstreamResponse.status;

  // 有明确长度或流不可用时按原样透传
  const lengthHeader = upstreamResponse.headers.get('content-length');
  if (upstreamResponse.body && lengthHeader && Number(lengthHeader) > 0) {
    return buildUpstreamResponse(upstreamResponse, env, request);
  }

  // 读取小体积错误体(限制 8KB,避免大流被读空)
  let raw = '';
  try {
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        if (raw.length > 8192) { reader.cancel(); break; }
      }
    }
  } catch { /* 读取出错则按空处理 */ }

  if (raw.trim().length > 0) {
    // 上游确有 body:原样回传(尽力保持 content-type)
    return buildUpstreamResponse(
      new Response(raw, {
        status,
        headers: {
          'content-type': upstreamResponse.headers.get('content-type') ?? 'text/plain; charset=utf-8',
        },
      }),
      env,
      request,
    );
  }

  // 空 body → 生成可诊断 JSON。内部标记只供凭证故障转移使用,
  // 最终响应返回客户端前会移除,避免暴露网关实现细节。
  const body = {
    error: {
      message: describeUpstreamError(status),
      type: 'upstream_error',
      code: `upstream_http_${status}`,
      status,
    },
  };
  const response = jsonResponse(body, env, status);
  response.headers.set(EMPTY_UPSTREAM_RESPONSE_HEADER, '1');
  return response;
}

function buildUpstreamResponse(
  upstreamResponse: Response,
  env: Env,
  request: Request,
  options: {
    stripReasoning?: boolean;
    onUsage?: (usage: TokenUsage) => void;
    onComplete?: () => void;
  } = {},
): Response {
  const responseHeaders = new Headers();
  upstreamResponse.headers.forEach((value, name) => {
    if (!RESPONSE_EXCLUDED.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  });

  const corsHeaders = buildCorsHeaders(env, request);
  corsHeaders.forEach((value, name) => responseHeaders.set(name, value));

  // SSE 透传流加心跳保活,避免上游长时间静默被中间层掐断
  let body: ReadableStream<Uint8Array> | null = upstreamResponse.body;
  const contentType = responseHeaders.get('content-type') ?? '';
  if (body && contentType.includes('text/event-stream')) {
    if (options.stripReasoning) {
      body = body
        .pipeThrough(createSseTransformer(
          (chunk) => stripChatReasoningChunk(chunk),
          () => SSE_DONE,
        ));
    }
    // 用量旁路:纯观察,不改动字节流
    if (options.onUsage) {
      body = body.pipeThrough(usageTap(options.onUsage));
    }
    // 完成旁路:流结束时才拿得到 usage,日志需在此时落笔(置于 keepAlive 之前,
    // 否则心跳会让流迟迟不结束,日志被推迟)
    if (options.onComplete) {
      body = body.pipeThrough(completionTap(options.onComplete));
    }
    body = body.pipeThrough(keepAliveTransform());
  } else if (options.onComplete) {
    // 非流式 body:读完即算完成
    options.onComplete();
  }

  return new Response(body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

async function buildNonStreamingChatResponse(
  upstreamResponse: Response,
  env: Env,
  request: Request,
  includeReasoning: boolean,
  onUsage?: (usage: TokenUsage) => void,
): Promise<Response> {
  const upstreamText = await upstreamResponse.text();
  const chunks = parseSseJsonChunks(upstreamText);

  // 用量旁路:非流式路径已把整条 SSE 读进内存,顺带解析不增加成本
  if (onUsage) {
    const usage = extractUsageFromSseText(upstreamText);
    if (usage) onUsage(usage);
  }

  // 空流兜底:上游 200 但没有任何事件(罕见的静默断流),避免客户端收到
  // 空 choices 的 200 而永久等待。
  // 注意:上游已完整响应(200 + body 读完)才走到这里,换凭证重放既救不回来
  // (同一 prompt 大概率同样结果),又可能让已完成计费的调用再扣一次,故标记本地失败。
  if (chunks.length === 0) {
    const emptyStream = jsonResponse(
      { error: 'Upstream returned empty stream', message: 'No SSE events received from upstream' },
      env,
      502,
    );
    emptyStream.headers.set(LOCAL_FAILURE_HEADER, '1');
    return emptyStream;
  }

  const responseBody = buildChatCompletionResponse(chunks, includeReasoning);
  const responseHeaders = new Headers({
    'content-type': 'application/json; charset=utf-8',
  });

  const corsHeaders = buildCorsHeaders(env, request);
  corsHeaders.forEach((value, name) => responseHeaders.set(name, value));

  return new Response(JSON.stringify(responseBody), {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

// ── SSE parsing ──────────────────────────────────────────────────────────

function buildChatCompletionResponse(
  chunks: Record<string, unknown>[],
  includeReasoning = true,
): Record<string, unknown> {
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
        mergeDelta(aggregate, delta as Record<string, unknown>, includeReasoning);
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

function mergeDelta(
  choice: Record<string, unknown>,
  delta: Record<string, unknown>,
  includeReasoning = true,
): void {
  const message = choice['message'];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  const target = message as Record<string, unknown>;
  if (typeof delta['role'] === 'string') {
    target['role'] = delta['role'];
  }
  if (typeof delta['content'] === 'string') {
    target['content'] = `${target['content'] ?? ''}${delta['content']}`;
  }
  if (includeReasoning && typeof delta['reasoning_content'] === 'string') {
    target['reasoning_content'] = `${target['reasoning_content'] ?? ''}${delta['reasoning_content']}`;
  }
  if (includeReasoning && typeof delta['reasoning'] === 'string') {
    target['reasoning'] = `${target['reasoning'] ?? ''}${delta['reasoning']}`;
  }
  if ('tool_calls' in delta) {
    target['tool_calls'] = delta['tool_calls'];
  }
}

// ── Credential resolution ─────────────────────────────────────────────────

/**
 * 单次请求的上游失败摘要。
 *
 * 失败原因在凭证故障转移层被解析出来,而指标在 handler 层记录,
 * 用 WeakMap 以 Request 为键传递,请求结束即随对象回收。
 */
const requestErrorSummaries = new WeakMap<Request, string>();

/**
 * 本次请求使用的模型名。
 *
 * 失败日志(upstream_failure / credential_failover / handler_threw)位于
 * withCredential 的通用故障转移层,拿不到 handler 内解析出的模型名;
 * 用 WeakMap 以 Request 为键传递,避免为每个调用点增加参数。
 * 记录失败日志时能看出「是哪个模型失败了」。
 */
const requestModels = new WeakMap<Request, string>();

/**
 * 统一解析客户端凭证并执行业务处理。
 *
 * 将凭证层的错误映射为 HTTP 语义：
 *   - UnauthorizedError        → 401（网关 key 无效/未登记）
 *   - UpstreamCredentialError  → 502（网关 key 有效，但上游凭证不可用）
 */
// 渠道故障状态码统一由凭证层定义,与连通测试/试跑共用同一口径
// 渠道故障状态码统一由凭证层定义,与连通测试/试跑共用同一口径
const RETRYABLE_UPSTREAM_STATUSES = CHANNEL_FAULT_STATUSES;
const EMPTY_UPSTREAM_RESPONSE_HEADER = 'x-gateway-empty-upstream';
const LOCAL_FAILURE_HEADER = 'x-gateway-local-failure';

function shouldRetryWithNextCredential(response: Response, credential: UpstreamCredential): boolean {
  // 透传 ck_/JWT 没有网关托管的候选集,不能盲目重放请求。
  if (!credential.credentialId) return false;
  // 网关自身产生的失败(读取中断/超时/空流兜底)不是上游拒绝:上游此时
  // 多半已经生成内容并按量计费,换凭证重发等于让同一条 prompt 扣两次积分。
  // 这类响应由网关打标记,一律不参与故障转移。上游真实返回的同名状态码
  // (502/503/504 等)不带标记,仍按渠道故障正常重试。
  if (response.headers.get(LOCAL_FAILURE_HEADER) === '1') return false;
  // 400 只有在上游完全没有 body 时才按渠道故障处理;有明确错误内容的
  // 400 通常是请求本身有问题,重试其它账号没有意义。
  return RETRYABLE_UPSTREAM_STATUSES.has(response.status) ||
    (response.status === 400 && response.headers.get(EMPTY_UPSTREAM_RESPONSE_HEADER) === '1');
}

/**
 * 构造网关自身产生的失败响应(非上游返回)。标记为本地失败后,凭证故障转移
 * 会跳过它 —— 重放一个可能已完成生成的上游请求会造成重复扣费。
 */
function localFailureResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { [LOCAL_FAILURE_HEADER]: '1' },
  });
}

function clearRetryMetadata(response: Response): Response {
  response.headers.delete(EMPTY_UPSTREAM_RESPONSE_HEADER);
  response.headers.delete(LOCAL_FAILURE_HEADER);
  return response;
}

async function logUpstreamFailure(
  request: Request,
  response: Response,
  credential: UpstreamCredential,
  retrying: boolean,
): Promise<void> {
  let responseBodyLength: number | undefined;
  let upstreamErrorCode: string | undefined;
  let upstreamErrorType: string | undefined;
  let upstreamErrorMessage: string | undefined;

  // 只读取错误响应副本,不消费交给客户端的 body;限制文本长度并脱敏。
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status === 400 || contentType.includes('json')) {
      const raw = (await response.clone().text()).slice(0, 8192);
      responseBodyLength = raw.length;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const error = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
          ? parsed.error as Record<string, unknown>
          : parsed;
        const clean = (value: unknown): string | undefined => {
          if (typeof value !== 'string') return undefined;
          return value.replace(/[\x00-\x1f]/g, ' ').replace(/(?:Bearer|sk-cb-|ck_)[^\s,;]+/gi, '[redacted]').slice(0, 300);
        };
        upstreamErrorCode = clean(error.code ?? parsed.code);
        upstreamErrorType = clean(error.type ?? parsed.type);
        upstreamErrorMessage = clean(error.message ?? parsed.message ?? parsed.msg);
      } catch {
        // 非 JSON 错误体只记录长度,不把原文写入日志。
      }
    }
  } catch {
    // 日志读取失败不影响请求响应。
  }

  requestErrorSummaries.set(
    request,
    `HTTP ${response.status}${upstreamErrorCode ? ` (${upstreamErrorCode})` : ''}${upstreamErrorMessage ? `: ${upstreamErrorMessage}` : ''}`.slice(0, 200),
  );

  pushLog(
    response.status >= 500 ? 'error' : 'warn',
    'upstream_failure',
    `上游 ${response.status}${upstreamErrorCode ? ` (${upstreamErrorCode})` : ''}` +
      `${requestModels.get(request) ? ` 模型=${requestModels.get(request)}` : ''}` +
      `${credential.credentialName ? ` 凭证=${credential.credentialName}` : ''}`,
    {
      requestId: request.headers.get('x-request-id') || crypto.randomUUID(),
      upstreamRequestId: response.headers.get('x-request-id') || response.headers.get('traceid') || response.headers.get('eo-log-uuid'),
      path: new URL(request.url).pathname,
      model: requestModels.get(request),
      status: response.status,
      credentialId: credential.credentialId,
      credentialName: credential.credentialName,
      retrying,
      emptyBody: response.headers.get(EMPTY_UPSTREAM_RESPONSE_HEADER) === '1',
      responseBodyLength,
      upstreamErrorCode,
      upstreamErrorType,
      upstreamErrorMessage,
    },
  );
}

/**
 * 为一次请求提供凭证级故障转移。
 * 只有在响应尚未交给客户端前,才会尝试下一个凭证；流已经开始后不做重放，避免重复写入。
 */
async function withCredential(
  request: Request,
  env: Env,
  handler: (credential: UpstreamCredential, clientKey?: import('./types').ClientKey) => Promise<Response> | Response,
): Promise<Response> {
  const authorization = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');
  const authHeader = authorization ?? (apiKey ? `Bearer ${apiKey}` : null);
  const excludedCredentialIds = new Set<string>();
  let lastRetryableResponse: Response | undefined;

  for (;;) {
    let resolved: Awaited<ReturnType<typeof resolveUpstreamCredential>>;
    try {
      resolved = await resolveUpstreamCredential(authHeader, env, excludedCredentialIds);
    } catch (err: unknown) {
      // 已经拿到过上游错误时，候选耗尽后保留最后一次真实响应；否则按鉴权/凭证错误处理。
      if (lastRetryableResponse) return clearRetryMetadata(lastRetryableResponse);
      if (err instanceof UnauthorizedError) {
        return jsonResponse({ error: 'Unauthorized', message: err.message }, env, 401);
      }
      if (err instanceof UpstreamCredentialError) {
        return jsonResponse({ error: 'Upstream credential unavailable', message: err.message }, env, 502);
      }
      throw err;
    }

    // handler 内部的 try 只覆盖上游交互,prepareChatPayload 等前置步骤在它之外;
    // 极端网络故障(上游断流触发 undici body controller 竞态)也可能把非业务异常
    // 抛出到这里。此时上游请求已经发出、可能已经计费,绝不能重放,直接按本地失败
    // 返回 —— 让客户端拿到可读的 502,而不是连接被重置。
    let response: Response;
    try {
      response = await handler(resolved.credential, resolved.clientKey);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushLog('error', 'handler_threw', `请求处理抛出异常: ${message}`, {
        path: new URL(request.url).pathname,
        model: requestModels.get(request),
        credentialId: resolved.credential.credentialId,
        credentialName: resolved.credential.credentialName,
      });
      // 这是最终响应,返回前清掉内部标记,避免暴露网关实现细节
      return clearRetryMetadata(localFailureResponse(`Upstream error: ${message}`, 502));
    }
    const shouldRetry = shouldRetryWithNextCredential(response, resolved.credential);
    if (response.status >= 400) {
      await logUpstreamFailure(request, response, resolved.credential, shouldRetry);
    }
    if (!shouldRetry) {
      await markCredentialSuccess(resolved.credential.credentialId, env).catch(() => undefined);
      return clearRetryMetadata(response);
    }

    const credentialId = resolved.credential.credentialId;
    if (!credentialId) return clearRetryMetadata(response);
    excludedCredentialIds.add(credentialId);
    lastRetryableResponse = response;
    pushLog(
      'warn',
      'credential_failover',
      `凭证 ${resolved.credential.credentialName ?? credentialId} 返回 ${response.status}` +
        `${requestModels.get(request) ? `（模型=${requestModels.get(request)}）` : ''}，切换到下一个`,
      {
        path: new URL(request.url).pathname,
        model: requestModels.get(request),
        status: response.status,
        credentialId,
        credentialName: resolved.credential.credentialName,
      },
    );
    await markCredentialFailure(
      credentialId,
      `upstream HTTP ${response.status}${response.headers.get(EMPTY_UPSTREAM_RESPONSE_HEADER) === '1' ? ' (empty body)' : ''}`,
      env,
    ).catch(() => undefined);
  }
}

// ── Model discovery helpers ───────────────────────────────────────────────

/**
 * 在动态模型列表中按 ID 查找（已处理后缀剥离）。
 */
function findModel(models: OpenAIModel[] | undefined, id: string): OpenAIModel | undefined {
  if (!models) return undefined;
  const normalizedId = normalizeModelId(decodeURIComponent(id));
  return models.find((m) => m.id === normalizedId);
}

/**
 * 浏览器模型目录：从网关托管凭证中选择一个健康凭证实时拉取。
 * 页面不要求用户在地址栏额外携带 Authorization，也不会向页面暴露凭证。
 */
async function resolveBrowserModelsList(env: Env): Promise<OpenAIModel[]> {
  try {
    const credentials = await getTokenStore(env).listCredentials();
    for (const credential of credentials) {
      const status = getCredentialStatus(credential);
      if (status !== 'healthy' && status !== 'error') continue;

      const token = credential.kind === 'ck_apikey'
        ? credential.apiKey
        : credential.accessToken;
      if (!token) continue;

      const models = await fetchUpstreamModels(
        {
          token,
          userId: credential.userId,
          kind: credential.kind,
          credentialId: credential.id,
        },
        env,
        { forceRefresh: true },
      );
      if (models?.length) return models;
    }
  } catch {
    // 凭证存储或上游异常时回退静态目录,页面仍可用。
  }
  return getModelsList().data;
}

/**
 * 解析模型列表：优先使用上游目录,失败回退静态快照。
 */
async function resolveModelsList(credential: UpstreamCredential, env: Env) {
  const upstreamModels = await fetchUpstreamModels(credential, env);

  if (!upstreamModels) {
    return getModelsList();
  }

  return { object: 'list' as const, data: upstreamModels };
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
