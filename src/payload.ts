/**
 * 上游 Chat Completions 载荷处理（代理链路与管理台「试跑」共用）。
 *
 * 集中两件事，避免两条链路的参数语义漂移：
 *   1. 白名单清洗 + max_tokens 钳制：过滤上游不认识的字段，并按模型输出上限收敛；
 *   2. 思考档位映射：把客户端的思考意图翻译成上游要求的 reasoning_effort
 *      (hy4-preview 默认输出思考，deepseek-v4-* 必须显式传档位)。
 */

import { findModelMetadata, fetchUpstreamModels, OpenAIModel } from './models';
import { profileFor } from './region';
import type { UpstreamCredential } from './types';
import { CODEBUDDY_CHANNEL_LINE, Env, rewritePayload, normalizeModelId } from './utils';

/**
 * DeepSeek Harness / 新版 OpenAI SDK 会带上游不认识的字段,且常把
 * 输入窗口(context_window,最高 1M)误填进 max_tokens(上游按输出上限校验,
 * 常见上限约 32k–50k)。白名单清洗 + 钳制,避免上游 400 空 body。
 */
export const CHAT_PAYLOAD_ALLOW = new Set([
  'model', 'messages', 'stream', 'temperature', 'top_p',
  'max_tokens', 'stop', 'tools', 'tool_choice', 'reasoning_effort',
]);

export const MAX_OUTPUT_TOKENS_HARD_CAP = 32_768;

/**
 * 解析发往上游的思考档位。
 *
 * 上游各模型开启思考的参数不一致:hy4-preview 默认就吐 reasoning_content,
 * 而 deepseek-v4-flash / deepseek-v4.1-flash 必须显式传 reasoning_effort 才会输出
 * (传 thinking.enabled 无效)。因此这里统一把客户端的思考意图
 * (thinking / enable_thinking / reasoning_effort)映射成上游需要的
 * reasoning_effort,客户端未指定时用模型默认档位补足。
 * EMIT_THINKING=off 或客户端显式关闭时不传,上游就不会产生思考内容。
 *
 * 模型元数据优先取内置快照,其次取上游实时目录(如 deepseek-v4.1-flash)。
 */
export async function resolveUpstreamReasoningEffort(
  payload: Record<string, unknown>,
  env: Env,
  credential: UpstreamCredential,
): Promise<string | undefined> {
  const mode = (env.EMIT_THINKING || 'auto').toLowerCase();
  if (mode === 'off') return undefined;

  const thinking = payload['thinking'];
  const thinkingObject = thinking && typeof thinking === 'object' && !Array.isArray(thinking)
    ? thinking as Record<string, unknown>
    : undefined;
  const clientEffort = typeof payload['reasoning_effort'] === 'string' ? payload['reasoning_effort'] : undefined;
  const disabled =
    thinkingObject?.['type'] === 'disabled' ||
    payload['enable_thinking'] === false ||
    (typeof clientEffort === 'string' && ['none', 'off', 'disabled'].includes(clientEffort.toLowerCase()));
  if (disabled) return undefined;

  const modelId = typeof payload['model'] === 'string' ? normalizeModelId(payload['model']) : '';
  if (!modelId) return undefined;

  let model = findModelMetadata(modelId);
  if (!model) {
    // 内置快照没有该模型:拉一次上游实时目录(带 10 分钟缓存)补齐元数据
    const live = await fetchUpstreamModels(credential, env).catch(() => undefined);
    model = live?.find((entry) => entry.id === modelId);
  }
  // 上游也不认识该模型:不猜参数,交给上游按自身默认行为处理
  if (!model) return undefined;

  const isReasoningModel = Boolean(model._supportsReasoning || model._defaultEffort);
  if (!isReasoningModel) return undefined;

  const requested = typeof clientEffort === 'string' && !['none', 'off', 'disabled'].includes(clientEffort.toLowerCase())
    ? clientEffort
    : undefined;
  const effort = requested ?? model._defaultEffort ?? 'high';

  const supported = model._supportedEfforts;
  if (Array.isArray(supported) && supported.length > 0 && !supported.includes(effort)) {
    return supported.includes(model._defaultEffort ?? '') ? model._defaultEffort : supported[0];
  }
  return effort;
}

export function clampMaxTokens(value: unknown, modelId?: string): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const model = modelId ? findModelMetadata(modelId) : undefined;
  const cap = Math.min(
    typeof model?._maxOutputTokens === 'number' && model._maxOutputTokens > 0
      ? model._maxOutputTokens
      : MAX_OUTPUT_TOKENS_HARD_CAP,
    MAX_OUTPUT_TOKENS_HARD_CAP,
  );
  return Math.min(Math.floor(n), cap);
}

export async function sanitizeChatPayload(
  payload: Record<string, unknown>,
  env: Env,
  credential: UpstreamCredential,
): Promise<Record<string, unknown>> {
  if (payload['max_tokens'] == null && typeof payload['max_completion_tokens'] === 'number') {
    payload['max_tokens'] = payload['max_completion_tokens'];
  }

  // CodeBuddy 上游不接受 developer 角色(实测返回
  // "Illegal API invocation from an unapproved channel"),统一归一化为 system。
  // DSH / 新 SDK 会把 system prompt 以 developer 角色发送。
  const messages = payload['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      const record = message as Record<string, unknown>;
      if (record['role'] === 'developer') record['role'] = 'system';
    }
  }

  const modelId = typeof payload['model'] === 'string' ? payload['model'] : undefined;
  const clamped = clampMaxTokens(payload['max_tokens'], modelId);
  if (clamped !== undefined) payload['max_tokens'] = clamped;
  else delete payload['max_tokens'];

  // 思考档位映射(必须在白名单清洗前读取客户端的 thinking / reasoning_effort)
  const effort = await resolveUpstreamReasoningEffort(payload, env, credential);
  if (effort) payload['reasoning_effort'] = effort;
  else delete payload['reasoning_effort'];

  for (const key of Object.keys(payload)) {
    if (!CHAT_PAYLOAD_ALLOW.has(key)) delete payload[key];
  }
  return payload;
}

/**
 * 区域差异适配（在清洗与改写之后执行）。
 *
 * 国际版有两条国内版没有的硬约束，均由真实链路实测确认：
 *
 *  1. **强制流式** —— 非流式请求返回 400 `Non-stream chat request is
 *     currently not supported`。对国际版一律置 stream=true；客户端请求非流式
 *     时由上层协议层负责聚合成非流式响应（网关本身即如此设计）。
 *  2. **首条消息必须是 system prompt** —— 否则返回 400 `first message is
 *     not system prompt`。客户端（尤其 Anthropic 协议转换后的链路）可能
 *     发出「首条即 user」的形态，这里补一条 system 占位。
 *
 * 只对国际版生效：国内版不需要 system 前置，贸然插入会改变既有行为。
 */
function applyRegionRequirements(
  payload: Record<string, unknown>,
  credential: UpstreamCredential,
): void {
  const profile = profileFor(credential.region);
  if (!profile.features.requireLeadingSystem) return;

  payload['stream'] = true;

  const messages = payload['messages'];
  if (!Array.isArray(messages) || messages.length === 0) return;

  const hasLeadingSystem = (() => {
    const first = messages[0];
    return Boolean(first) && typeof first === 'object' && !Array.isArray(first)
      && (first as Record<string, unknown>)['role'] === 'system';
  })();
  if (hasLeadingSystem) return;

  // 只放行最小占位：真正的系统指令已由 rewritePayload 注入到任何存在的
  // system 消息里，这里仅在完全没有 system 时补一条身份声明。
  messages.unshift({
    role: 'system',
    content: CODEBUDDY_CHANNEL_LINE,
  });
}

export async function prepareChatPayload(
  payload: Record<string, unknown>,
  env: Env,
  credential: UpstreamCredential,
): Promise<Record<string, unknown>> {
  const rewrittenPayload = rewritePayload(await sanitizeChatPayload(payload, env, credential));
  rewrittenPayload['stream'] = true;
  applyRegionRequirements(rewrittenPayload, credential);
  return rewrittenPayload;
}
