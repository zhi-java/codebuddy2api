/**
 * 客户端凭证解析与上游凭证生命周期管理。
 *
 * 解析优先级：
 *   1. `sk-cb-*`  —— 网关自建 key：查库 → 取绑定凭证 → 必要时自动刷新 → 故障转移
 *   2. `ck_*`     —— 控制台 API key：原样透传（历史行为，零改动）
 *   3. 其他 JWT    —— CLI accessToken 等：原样透传（历史行为，零改动）
 *
 * 刷新采用惰性策略：仅当 accessToken 距过期不足 REFRESH_MARGIN_MS 时触发，
 * 并用 in-flight Promise 做并发去重，避免同一凭证被并发刷新多次。
 */

import { extractUserIdFromJwt } from './crypto';
import { detectRegionFromToken, endpointUrl, profileFor } from './region';
import { getTokenStore, hashApiKey } from './store';
import type { KVLike } from './store';
import type { Credential, CredentialStatus, UpstreamCredential } from './types';

/** 本模块只依赖环境字段的子集，便于测试注入 */
interface CredentialEnv {
  UPSTREAM_REFRESH_URL?: string;
  GATEWAY_KEY_PREFIX?: string;
  CREDENTIALS_KV?: KVLike;
  CREDENTIALS_ENC_SECRET?: string;
}

/**
 * 判定为「渠道故障」的上游状态码 —— 即换一个凭证重试有意义的失败。
 *
 * 与「请求本身有问题」相对:400(带错误体的参数错误)、404 这类换个账号也一样失败,
 * 不应记为凭证故障,否则会误伤健康凭证。代理链路与连通测试/对话共用此口径。
 */
export const CHANNEL_FAULT_STATUSES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

/** 距过期不足该阈值时触发刷新 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** 刷新失败后的冷却时长，期间不再选中该凭证 */
const COOLDOWN_MS = 60 * 1000;
/** 刷新请求超时 */
const REFRESH_TIMEOUT_MS = 20_000;

/** 同一 isolate 内的刷新去重表 */
const inFlightRefreshes = new Map<string, Promise<Credential>>();

/** 运行期冷却表（不落盘，isolate 重启即失效） */
const cooldowns = new Map<string, number>();

/**
 * lastUsedAt 落盘节流。
 *
 * 代理热路径原本每请求都要同步写一次 SQLite;高并发下这是把事件循环堵住的
 * 主因。这里改成同一 Key 最多每 60 秒落盘一次,「最近使用」精度仍是分钟级。
 */
const lastUsedFlushedAt = new Map<string, number>();
const LAST_USED_FLUSH_MS = 60_000;

async function touchKeyLastUsed(
  store: ReturnType<typeof getTokenStore>,
  clientKey: import('./types').ClientKey,
): Promise<void> {
  const now = Date.now();
  if (now - (lastUsedFlushedAt.get(clientKey.id) ?? 0) < LAST_USED_FLUSH_MS) return;
  lastUsedFlushedAt.set(clientKey.id, now);
  await store.saveKey({ ...clientKey, lastUsedAt: now }).catch(() => undefined);
}

// ── 凭证状态判定 ──────────────────────────────────────────────────────────

/**
 * 计算凭证运行状态。冷却为运行期状态，优先于持久化状态判定。
 */
export function getCredentialStatus(credential: Credential): CredentialStatus {
  if (!credential.enabled) return 'disabled';

  if (credential.kind === 'cli_oauth') {
    const now = Date.now();
    if (credential.refreshExpiresAt && credential.refreshExpiresAt <= now) return 'expired';
    if (credential.expiresAt && credential.expiresAt <= now && !credential.refreshToken) {
      return 'expired';
    }
    // 两种 token 都没有 → 永远换不出可用凭证，不能报 healthy：
    // 否则控制台显示健康、实际任何请求都失败，故障转移还会选中它
    if (!credential.accessToken && !credential.refreshToken) return 'expired';
  }

  // 控制台 Key 为空同理：不可能通过上游鉴权
  if (credential.kind === 'ck_apikey' && !credential.apiKey) return 'expired';

  if ((cooldowns.get(credential.id) ?? 0) > Date.now()) return 'cooling';
  if (credential.lastError) return 'error';
  return 'healthy';
}

function isSelectable(credential: Credential): boolean {
  const status = getCredentialStatus(credential);
  return status === 'healthy' || status === 'error';
}

/** 选中优先级：健康 > 有错误历史但可用；同级取过期时间最晚的 */
function pickCredential(credentials: Credential[]): Credential | undefined {
  const candidates = credentials.filter(isSelectable);
  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) => {
    const scoreA = getCredentialStatus(a) === 'healthy' ? 0 : 1;
    const scoreB = getCredentialStatus(b) === 'healthy' ? 0 : 1;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return (b.expiresAt ?? 0) - (a.expiresAt ?? 0);
  })[0];
}

function markCooldown(id: string, error: string): void {
  cooldowns.set(id, Date.now() + COOLDOWN_MS);
  void error; // 错误信息写入持久化记录由调用方处理
}

/**
 * 记录一次请求级上游失败，供后续请求跳过该凭证并自动切换。
 * 冷却只作用于当前进程，错误摘要持久化到管理台可见的凭证状态。
 */
export async function markCredentialFailure(
  credentialId: string | undefined,
  error: string,
  env: CredentialEnv,
): Promise<void> {
  if (!credentialId) return;
  markCooldown(credentialId, error);
  const store = getTokenStore(env);
  const credential = await store.getCredential(credentialId);
  if (!credential) return;
  await store.saveCredential({ ...credential, lastError: error, updatedAt: Date.now() });
}

/** 请求成功后清除此前的运行期冷却和错误标记。 */
export async function markCredentialSuccess(
  credentialId: string | undefined,
  env: CredentialEnv,
): Promise<void> {
  if (!credentialId) return;
  cooldowns.delete(credentialId);
  const store = getTokenStore(env);
  const credential = await store.getCredential(credentialId);
  if (!credential || !credential.lastError) return;
  await store.saveCredential({ ...credential, lastError: undefined, updatedAt: Date.now() });
}

// ── 上游刷新 ──────────────────────────────────────────────────────────────

interface RefreshResponse {
  code?: number;
  data?: {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    refreshExpiresIn?: number;
    tokenType?: string;
    domain?: string;
  };
}

/**
 * 调用上游刷新接口换取新的 accessToken / refreshToken。
 *
 * 端点按凭证区域路由：国内版 /v2/plugin/auth/token/refresh，国际版
 * /v2/auth/token/refresh（国际版是自有端点而非 Keycloak 标准 OAuth，
 * 取自官方 CLI 分发包，取证见 region.ts）。两者请求形态一致——
 * 均为 `X-Refresh-Token` 头 + 空 JSON 体，因此只有 URL 随区域变化。
 *
 * 环境变量 UPSTREAM_REFRESH_URL 仅覆盖**国内版**端点（存量用法保持不变）；
 * 国际版端点恒取自档案。
 *
 * 实测响应结构为顶层 data：{ code, data: { accessToken, refreshToken, expiresIn, ... } }
 */
export async function refreshCredential(
  credential: Credential,
  env: CredentialEnv,
): Promise<Credential> {
  if (!credential.refreshToken) {
    throw new Error('credential has no refreshToken');
  }

  const profile = profileFor(credential.region);
  const url =
    credential.region === 'intl'
      ? endpointUrl(profile, 'refresh')
      : env.UPSTREAM_REFRESH_URL || endpointUrl(profile, 'refresh');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-refresh-token': credential.refreshToken,
        'x-auth-refresh-source': 'plugin',
      },
      body: '{}',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`refresh failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as RefreshResponse;
    const data = body.data;

    // code 仅在上游确实下发时才作校验：国内版恒为 0，国际版未观测到该字段。
    // 若无条件要求 code===0，会把国际版的正常成功响应误判为失败。
    const codeRejected = body.code !== undefined && body.code !== 0;
    if (codeRejected || !data?.accessToken) {
      throw new Error(`refresh rejected: ${JSON.stringify(body).slice(0, 200)}`);
    }

    const now = Date.now();
    const updated: Credential = {
      ...credential,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? credential.refreshToken,
      expiresAt: data.expiresIn ? now + data.expiresIn * 1000 : credential.expiresAt,
      refreshExpiresAt: data.refreshExpiresIn
        ? now + data.refreshExpiresIn * 1000
        : credential.refreshExpiresAt,
      userId: extractUserIdFromJwt(data.accessToken) ?? credential.userId,
      domain: data.domain ?? credential.domain,
      lastError: undefined,
      updatedAt: now,
    };

    cooldowns.delete(credential.id);
    await getTokenStore(env).saveCredential(updated);
    return updated;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 确保凭证持有有效 token，必要时刷新（带并发去重）。
 *
 * 导出供管理端（连通测试 / 试跑）复用：这些入口不走转发链路，
 * 必须显式经过本函数才能与真实请求的行为保持一致。
 */
export async function ensureValidToken(credential: Credential, env: CredentialEnv): Promise<Credential> {
  const needsRefresh =
    credential.kind === 'cli_oauth' &&
    credential.refreshToken &&
    (!credential.expiresAt || credential.expiresAt - Date.now() < REFRESH_MARGIN_MS);

  if (!needsRefresh) return credential;

  const existing = inFlightRefreshes.get(credential.id);
  if (existing) return existing;

  const task = refreshCredential(credential, env)
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      markCooldown(credential.id, message);
      await getTokenStore(env)
        .saveCredential({ ...credential, lastError: message, updatedAt: Date.now() })
        .catch(() => undefined);
      throw err;
    })
    .finally(() => inFlightRefreshes.delete(credential.id));

  inFlightRefreshes.set(credential.id, task);
  return task;
}

// ── 客户端凭证解析 ────────────────────────────────────────────────────────

export interface ResolveResult {
  credential: UpstreamCredential;
  /** 命中的网关 key（透传模式为空） */
  clientKeyId?: string;
  /** 命中的网关 key 完整对象（含 modelAliases 等配置,透传模式为空） */
  clientKey?: import('./types').ClientKey;
}

export class UnauthorizedError extends Error {
  constructor(message = 'Invalid gateway API key') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class UpstreamCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamCredentialError';
  }
}

function passthrough(token: string): UpstreamCredential {
  return {
    token,
    userId: extractUserIdFromJwt(token),
    kind: 'passthrough',
    // 透传凭证没有记录可依凭,只能从令牌自身推断区域:
    // 国际版令牌由 Keycloak 签发(iss 含 codebuddy.ai),国内版无此特征。
    // 推断不出时按国内版处理,与存量行为一致。
    region: detectRegionFromToken(token) ?? 'cn',
  };
}

/**
 * 解析客户端 Authorization 头，产出可用的上游凭证。
 *
 * - 网关 key 未登记 / 已禁用 → UnauthorizedError（调用方返回 401）
 * - 网关 key 登记但所有绑定凭证不可用 → UpstreamCredentialError（调用方返回 502）
 * - 其余情况透传，保持与历史行为一致
 */
/**
 * 仅校验网关 Key 是否有效，不解析上游凭证。
 *
 * 用途：`/v1/messages/count_tokens` 这类**纯本地计算**的端点。
 * 它们不需要访问上游，因此不该因为凭证池暂时无可用凭证（全部冷却/过期）
 * 而失败——那会让客户端在凭证故障时连 token 计数都做不了。
 * 但仍需校验 Key，避免把算力入口开放给未认证请求。
 *
 * @returns 命中的 ClientKey
 * @throws UnauthorizedError Key 缺失/无效/禁用
 */
export async function resolveClientKey(
  authorization: string | null,
  env: CredentialEnv,
): Promise<import('./types').ClientKey> {
  const raw = authorization?.trim() ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(raw)?.[1] ?? (raw || undefined);

  if (!token) {
    throw new UnauthorizedError('Missing Authorization header');
  }

  const keyPrefix = env.GATEWAY_KEY_PREFIX || 'sk-cb';
  if (!token.startsWith(`${keyPrefix}-`)) {
    // 透传模式（ck_ 控制台 key / CLI accessToken）没有对应的 ClientKey 记录，
    // 调用方按「已认证但无 Key 元数据」处理。
    throw new UnauthorizedError('count_tokens requires a gateway key');
  }

  const store = getTokenStore(env);
  const clientKey = await store.getKeyByHash(await hashApiKey(token));
  if (!clientKey || !clientKey.enabled) {
    throw new UnauthorizedError();
  }
  return clientKey;
}

export async function resolveUpstreamCredential(
  authorization: string | null,
  env: CredentialEnv,
  excludedCredentialIds: ReadonlySet<string> = new Set(),
): Promise<ResolveResult> {
  const raw = authorization?.trim() ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(raw)?.[1] ?? (raw || undefined);

  if (!token) {
    throw new UnauthorizedError('Missing Authorization header');
  }

  const keyPrefix = env.GATEWAY_KEY_PREFIX || 'sk-cb';
  if (!token.startsWith(`${keyPrefix}-`)) {
    // 透传模式：ck_ 控制台 key 与 CLI accessToken
    return { credential: passthrough(token) };
  }

  const clientKey = await resolveClientKey(token, env);

  const store = getTokenStore(env);
  const boundCredentials = (await store.listCredentials()).filter((c) =>
    clientKey.credentialIds.includes(c.id),
  );

  if (boundCredentials.length === 0) {
    throw new UpstreamCredentialError('No upstream credential bound to this key');
  }

  const credentials = boundCredentials.filter((c) => !excludedCredentialIds.has(c.id));
  if (credentials.length === 0) {
    throw new UpstreamCredentialError('No untried upstream credential remains');
  }

  // 逐个尝试：刷新失败或冷却中的凭证自动跳过，实现故障转移
  const failures: string[] = [];
  const candidates = [...credentials].sort((a, b) => {
    const scoreA = getCredentialStatus(a) === 'healthy' ? 0 : 1;
    const scoreB = getCredentialStatus(b) === 'healthy' ? 0 : 1;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return (b.expiresAt ?? 0) - (a.expiresAt ?? 0);
  });

  // 故障转移只在**同一区域**内进行。
  //
  // 跨区必然失败：国内令牌打到国际端点（反之亦然）一律 401。若不收敛，
  // 一个 Key 同时绑定两区凭证时，每次 401 都会把故障转移到另一区的凭证上，
  // 把本可通过的单区故障放大成全池不可用；反之若某个 Key 只绑了一区凭证，
  // 反而不会被这个约束误伤。
  //
  // 锚点必须取自**排序后**的首选：排序结果才是真正会被使用的凭证，
  // 若从未排序的原始数组里取锚点，两者可能不是同一个，锚定区域就会与
  // 实际使用区域不一致。
  const anchor = candidates.find((c) => isSelectable(c));
  const sameRegion = anchor
    ? candidates.filter((c) => (c.region ?? 'cn') === (anchor.region ?? 'cn'))
    : candidates;

  for (const candidate of sameRegion) {
    if (!isSelectable(candidate)) {
      failures.push(`${candidate.name}: ${getCredentialStatus(candidate)}`);
      continue;
    }

    try {
      const effective = await ensureValidToken(candidate, env);
      const credentialToken = effective.kind === 'ck_apikey'
        ? effective.apiKey
        : effective.accessToken;

      if (!credentialToken) {
        failures.push(`${candidate.name}: empty token`);
        continue;
      }

      await touchKeyLastUsed(store, clientKey);

      return {
        credential: {
          token: credentialToken,
          userId: effective.userId ?? extractUserIdFromJwt(credentialToken),
          kind: effective.kind,
          region: effective.region ?? 'cn',
          credentialId: effective.id,
          credentialName: effective.name,
        },
        clientKeyId: clientKey.id,
        clientKey,
      };
    } catch (err: unknown) {
      failures.push(`${candidate.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new UpstreamCredentialError(
    `All bound credentials unavailable — ${failures.join('; ')}`,
  );
}

/**
 * 强制刷新指定凭证（管理界面用）。绕过冷却与过期判定。
 */
export async function forceRefreshCredential(
  id: string,
  env: CredentialEnv,
): Promise<Credential> {
  const store = getTokenStore(env);
  const credential = await store.getCredential(id);
  if (!credential) throw new UpstreamCredentialError(`Credential ${id} not found`);

  cooldowns.delete(id);
  return refreshCredential(credential, env);
}

