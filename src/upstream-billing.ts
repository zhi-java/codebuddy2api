/**
 * 上游计费能力封装:额度查询 + 每日签到。
 *
 * 对应上游接口(实测个人账号可用):
 *   POST {endpoint}/v2/billing/meter/get-user-resource
 *   POST {endpoint}/billing/meter/daily-checkin
 *
 * 头要求与模型目录一致:CLI/CodeBuddy UA + X-IDE 类型 + X-User-Id。
 * 调用前若 accessToken 临近过期会先执行一次刷新。
 */

import { getTokenStore } from './store';
import type { KVLike } from './store';
import { refreshCredential } from './credentials';
import type { Credential } from './types';

/** 距过期不足该阈值先刷新(与 credentials.ts 保持一致) */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 20_000;

interface BillingEnv {
  UPSTREAM_BILLING_BASE?: string;
  CREDENTIALS_KV?: KVLike;
  CREDENTIALS_ENC_SECRET?: string;
}

function baseUrl(env: BillingEnv): string {
  return (env.UPSTREAM_BILLING_BASE || 'https://copilot.tencent.com').replace(/\/+$/, '');
}

/** 取可用的上游 token;OAuth 过期时自动刷新 */
async function resolveToken(credential: Credential, env: BillingEnv): Promise<string> {
  let effective = credential;

  if (
    credential.kind === 'cli_oauth' &&
    credential.refreshToken &&
    credential.expiresAt &&
    credential.expiresAt - Date.now() < REFRESH_MARGIN_MS
  ) {
    effective = await refreshCredential(credential, env);
  }

  const token = effective.kind === 'ck_apikey' ? effective.apiKey : effective.accessToken;
  if (!token) throw new Error('credential has no usable token');
  return token;
}

interface BillingResponse {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

/**
 * 按凭证类型构造上游请求头:
 *  - cli_oauth:CLI 会话形态(CLI 头 + X-User-Id),实测签到/额度可用
 *  - ck_apikey:轻量 API-key 形态(不冒充 CLI 会话,否则上游 403)
 */
function buildBillingHeaders(credential: Credential, token: string): Record<string, string> {
  const isCli = credential.kind === 'cli_oauth';

  const common: Record<string, string> = {
    'host': 'copilot.tencent.com',
    'x-domain': 'copilot.tencent.com',
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'authorization': `Bearer ${token}`,
    // 实测:缺失 User-Agent 会被上游 403,必须显式设置
    'user-agent': isCli ? 'CLI/2.107.0 CodeBuddy/2.107.0' : 'curl/8.6.0',
  };

  if (!isCli) {
    // API-key 通道:通用客户端形态(不加 CLI 会话身份头)
    return common;
  }

  return {
    ...common,
    'x-ide-type': 'CLI',
    'x-ide-name': 'CLI',
    'x-ide-version': '2.107.0',
    'x-user-id': credential.userId ?? '',
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
    'x-product': 'SaaS',
    'x-private-data': 'false',
  };
}

interface PostResult {
  httpStatus: number;
  body: BillingResponse;
}

async function postBilling(
  path: string,
  credential: Credential,
  env: BillingEnv,
  payload: Record<string, unknown>,
): Promise<PostResult> {
  const token = await resolveToken(credential, env);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl(env)}${path}`, {
      method: 'POST',
      headers: buildBillingHeaders(credential, token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    let body: BillingResponse = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      body = parsed && typeof parsed === 'object' ? (parsed as BillingResponse) : {};
    } catch {
      body = { code: response.status, msg: raw.slice(0, 200) };
    }
    return { httpStatus: response.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── 额度查询 ───────────────────────────────────────────────────────────────

export interface QuotaSummary {
  available: boolean;
  total: number;
  remaining: number;
  used: number;
  percent: number;
  packageName?: string;
  cycleStart?: string;
  cycleEnd?: string;
  resourceId?: string;
  /** 查询时间 */
  checkedAt: number;
}

function toNum(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

function parseQuota(body: BillingResponse): QuotaSummary {
  const data = body.data as { Response?: { Data?: { Accounts?: unknown[] } } } | undefined;
  const accounts = Array.isArray(data?.Response?.Data?.Accounts)
    ? (data?.Response?.Data?.Accounts as Record<string, unknown>[])
    : [];

  // 账户可能同时持有多个资源包(订阅+奖励等):额度应为全包汇总
  const active = accounts.filter((a) => a && typeof a === 'object');
  if (active.length === 0) {
    return {
      available: false,
      total: 0,
      remaining: 0,
      used: 0,
      percent: 0,
      checkedAt: Date.now(),
    };
  }

  const total = active.reduce((sum, a) => sum + toNum(a.CapacitySize), 0);
  const remaining = active.reduce((sum, a) => sum + toNum(a.CapacityRemain), 0);
  const used = active.reduce((sum, a) => sum + toNum(a.CapacityUsed), 0);

  const first = active[0];
  const packageCounts = new Map<string, number>();
  for (const a of active) {
    const name = typeof a.PackageName === 'string' ? a.PackageName : '';
    if (name) packageCounts.set(name, (packageCounts.get(name) ?? 0) + 1);
  }
  const packageSummary = [...packageCounts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(' + ');

  return {
    available: true,
    total,
    remaining,
    used,
    percent: total > 0 ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 0,
    packageName: packageSummary || undefined,
    cycleStart: typeof first.CycleStartTime === 'string' ? first.CycleStartTime : undefined,
    cycleEnd: typeof first.CycleEndTime === 'string' ? first.CycleEndTime : undefined,
    resourceId: typeof first.ResourceId === 'string' ? first.ResourceId : undefined,
    checkedAt: Date.now(),
  };
}

/**
 * 查询凭证对应上游账号的额度摘要。
 */
export async function fetchCredentialQuota(
  credential: Credential,
  env: BillingEnv,
): Promise<QuotaSummary> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const begin = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 00:00:00`;

  const { httpStatus, body } = await postBilling('/v2/billing/meter/get-user-resource', credential, env, {
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: begin,
    PackageEndTimeRangeEnd: '2127-01-01 00:00:00',
  });

  if (httpStatus === 401 || httpStatus === 403) {
    throw new Error(`上游鉴权失败(HTTP ${httpStatus})`);
  }
  if (body.code !== 0 || httpStatus >= 400) {
    const why = typeof body.msg === 'string' ? body.msg : `HTTP ${httpStatus}`;
    throw new Error(`额度查询被拒绝:${why}`);
  }
  return parseQuota(body);
}

// ── 每日签到 ───────────────────────────────────────────────────────────────

export interface CheckinResult {
  /** 本次获得 credits(0 表示无奖励/已签到) */
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
  /** 上游提示语 */
  message?: string;
}

/**
 * 对上游账号执行每日签到。
 * 注意:该操作会改变上游账号资源状态,调用方应经管理员显式操作触发。
 */
export async function fetchDailyCheckin(
  credential: Credential,
  env: BillingEnv,
): Promise<CheckinResult> {
  const { httpStatus, body } = await postBilling('/billing/meter/daily-checkin', credential, env, {});

  if (httpStatus === 401 || httpStatus === 403) {
    throw new Error(`上游鉴权失败(HTTP ${httpStatus})`);
  }

  const data = (body.data ?? {}) as Record<string, unknown>;
  const msg = typeof body.msg === 'string' ? body.msg : undefined;

  // 上游对"今日已签到"返回 HTTP 400 + code 10001:属正常业务状态,不视为失败
  if (body.code === 10001 || (httpStatus >= 400 && msg && msg.includes('已签到'))) {
    return {
      credit: 0,
      streakDays: 0,
      isStreakDay: false,
      message: msg || '今天已签到,请明天再来',
    };
  }

  if (body.code !== 0 || httpStatus >= 400) {
    throw new Error(`签到失败:${msg || `HTTP ${httpStatus}`}`);
  }

  return {
    credit: toNum(data.credit),
    streakDays: toNum(data.streak_days),
    isStreakDay: Boolean(data.is_streak_day),
    message: msg,
  };
}

// ── 便捷:按凭证 id 查询(供 admin 路由) ─────────────────────────────────────

export async function getCredentialById(
  id: string,
  env: BillingEnv,
): Promise<Credential | undefined> {
  return getTokenStore(env).getCredential(id);
}
