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
  /** 网关层(APISIX)鉴权/策略拒绝时的字段名与业务体不同 */
  message?: unknown;
}

/** 取上游错误文案:业务体用 msg,网关策略拒绝用 message */
function errorText(body: BillingResponse): string | undefined {
  if (typeof body.msg === 'string' && body.msg) return body.msg;
  if (typeof body.message === 'string' && body.message) return body.message;
  return undefined;
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

// ── 每日签到(Buddy 加油站,按期活动) ───────────────────────────────────────
//
// 实测要点(2026-09-11,三凭据交叉验证):
//   - 状态查询:`POST /v2/billing/meter/checkin-activity-status` —— 只读,含活动期次/连续天数/已得积分
//   - 领取签到:`POST /v2/billing/meter/daily-checkin`
//   - 旧路径 `/billing/meter/checkin-status`(无 /v2) 是遗留端点,恒返回 active=false,
//     不可用于判断活动是否进行;旧 `/billing/meter/daily-checkin` 虽可调用但不产出积分。
//   - `ck_` 前缀的两段式 API Key 可**读**状态,但**领取**会被网关策略拒绝:
//     HTTP 403 {"message":"API key not allowed for this path or method"}
//   - 活动按期滚动(如第 8 期「开学季」2026-09-01~09-15),期号由 status 下发,无需硬编码。

/** 签到活动状态(只读) */
export interface CheckinStatus {
  /** 活动是否进行中 */
  active: boolean;
  /** 今日是否已领取 */
  todayCheckedIn: boolean;
  /** 连续签到天数 */
  streakDays: number;
  /** 每日可得 credits */
  dailyCredit: number;
  /** 今日已得 credits */
  todayCredit: number;
  /** 本期累计 credited */
  totalCredits: number;
  /** 活动期次(如 8) */
  season: number;
  /** 活动名(如「开学季」) */
  activityName?: string;
  /** 品牌位名称(如「Buddy加油站」) */
  themeName?: string;
  /** 本期开始时间 */
  startTime?: string;
  /** 本期结束时间(期次滚动依据) */
  endTime?: string;
  /** 上游下发的引导按钮(如「认证领积分」) */
  actionButton?: { show: boolean; text: string; action: string };
}

/** 状态查询结果 + 该凭据是否具备领取权限 */
export interface CheckinStatusResult extends CheckinStatus {
  /** 该凭据能否执行领取(ck_ 两段式 API Key 为 false) */
  canClaim: boolean;
  /** canClaim=false 时的原因 */
  claimBlockedReason?: string;
}

/** 签到领取结果 */
export interface CheckinResult {
  /** 本次获得 credits(0 表示无奖励/已签到) */
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
  /** 上游提示语 */
  message?: string;
  /** 领取后重新查询的状态(若可得) */
  status?: CheckinStatus;
}

function parseCheckinStatus(data: Record<string, unknown>): CheckinStatus {
  const ab = data.action_button as Record<string, unknown> | undefined;
  return {
    active: Boolean(data.active),
    todayCheckedIn: Boolean(data.today_checked_in),
    streakDays: toNum(data.streak_days),
    dailyCredit: toNum(data.daily_credit),
    todayCredit: toNum(data.today_credit),
    totalCredits: toNum(data.total_credits),
    season: toNum(data.season),
    activityName: typeof data.activity_name === 'string' && data.activity_name ? data.activity_name : undefined,
    themeName: typeof data.theme_name === 'string' && data.theme_name ? data.theme_name : undefined,
    startTime: typeof data.start_time === 'string' && data.start_time ? data.start_time : undefined,
    endTime: typeof data.end_time === 'string' && data.end_time ? data.end_time : undefined,
    ...(ab && typeof ab === 'object'
      ? {
          actionButton: {
            show: Boolean(ab.show),
            text: typeof ab.text === 'string' ? ab.text : '',
            action: typeof ab.action === 'string' ? ab.action : '',
          },
        }
      : {}),
  };
}

/**
 * 判断 token 是否为 JWT(三段式,首段可解析出 JSON 头)。
 * 注意:不能用 kind 判断——`ck_apikey` 类型下既有 JWT 形态的 token(可领取),
 * 也有 `ck_xxx.yyy` 形态的控制台 API Key(不可领取);也不能只看是否含 `.`
 * (该 Key 本身形如 `ck_<id>.<secret>`,含点但只有两段)。
 */
function isJwt(token: string | undefined): boolean {
  if (!token || !token.startsWith('eyJ')) return false;
  return token.split('.').length === 3;
}

/**
 * 领取权限预判:控制台 API Key 形态的凭证可读状态,但领取类接口会被上游
 * 以 HTTP 403 `API key not allowed for this path or method` 拒绝。
 *
 * 这是**预判**(用于控制台提前置灰),并非最终裁决——真实结果仍以领取接口的
 * 403 为准(fetchDailyCheckin 会如实抛出)。
 */
function claimBlockedReasonFor(credential: Credential): string | undefined {
  const token = credential.kind === 'ck_apikey' ? credential.apiKey : credential.accessToken;
  if (token && !isJwt(token)) {
    return '该凭证为控制台 API Key，上游策略不允许其执行领取（仅可查询状态）';
  }
  return undefined;
}

/**
 * 查询签到活动状态(只读,无副作用)。
 * 不会改变上游账号状态,可在控制台安全轮询。
 */
export async function fetchCheckinStatus(
  credential: Credential,
  env: BillingEnv,
): Promise<CheckinStatusResult> {
  const { httpStatus, body } = await postBilling(
    '/v2/billing/meter/checkin-activity-status',
    credential,
    env,
    {},
  );

  if (httpStatus === 401 || httpStatus === 403) {
    throw new Error(`上游鉴权失败(HTTP ${httpStatus})`);
  }
  if (body.code !== 0 || httpStatus >= 400) {
    throw new Error(`签到状态查询被拒绝:${errorText(body) || `HTTP ${httpStatus}`}`);
  }

  const blocked = claimBlockedReasonFor(credential);
  return {
    ...parseCheckinStatus((body.data ?? {}) as Record<string, unknown>),
    canClaim: !blocked,
    ...(blocked ? { claimBlockedReason: blocked } : {}),
  };
}

/**
 * 对上游账号执行每日签到(Buddy 加油站)。
 * 注意:该操作会改变上游账号资源状态,调用方应经管理员显式操作触发。
 */
export async function fetchDailyCheckin(
  credential: Credential,
  env: BillingEnv,
): Promise<CheckinResult> {
  const { httpStatus, body } = await postBilling('/v2/billing/meter/daily-checkin', credential, env, {});

  const msg = errorText(body);

  // 无领取权限:明确报错,避免被误判为"已签到"而静默吞掉
  if (httpStatus === 403) {
    throw new Error(`签到被拒绝:${msg || '该凭证无权执行领取'}`);
  }
  if (httpStatus === 401) {
    throw new Error(`上游鉴权失败(HTTP 401)`);
  }

  const data = (body.data ?? {}) as Record<string, unknown>;

  // 上游对"今日已签到"返回 HTTP 400 + code 10001:属正常业务状态,不视为失败。
  // 此时补一次状态查询,保证 streakDays/totalCredits 仍可展示。
  if (body.code === 10001 || (httpStatus >= 400 && msg && msg.includes('已签到'))) {
    let status: CheckinStatus | undefined;
    try {
      status = await fetchCheckinStatus(credential, env);
    } catch {
      // 状态查询失败不影响"已签到"这一结论
    }
    return {
      credit: 0,
      streakDays: status?.streakDays ?? 0,
      isStreakDay: false,
      message: msg || '今天已签到,请明天再来',
      ...(status ? { status } : {}),
    };
  }

  if (body.code !== 0 || httpStatus >= 400) {
    throw new Error(`签到失败:${msg || `HTTP ${httpStatus}`}`);
  }

  // 领取成功:回查状态以获得准确的本期累计与连续天数
  let status: CheckinStatus | undefined;
  try {
    status = await fetchCheckinStatus(credential, env);
  } catch {
    // 忽略:回查仅用于补全展示字段
  }

  return {
    credit: toNum(data.credit) || status?.todayCredit || 0,
    streakDays: toNum(data.streak_days) || status?.streakDays || 0,
    isStreakDay: Boolean(data.is_streak_day),
    message: msg,
    ...(status ? { status } : {}),
  };
}

// ── 便捷:按凭证 id 查询(供 admin 路由) ─────────────────────────────────────

export async function getCredentialById(
  id: string,
  env: BillingEnv,
): Promise<Credential | undefined> {
  return getTokenStore(env).getCredential(id);
}
