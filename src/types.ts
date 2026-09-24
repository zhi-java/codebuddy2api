/**
 * 网关凭证体系的核心类型定义。
 *
 * 网关同时支持三类客户端凭证：
 *   1. `sk-cb-*` —— 网关自建 API key，网关托管上游凭证并自动刷新
 *   2. `ck_*`    —— 控制台 API key，原样透传上游
 *   3. 其他 JWT   —— CLI accessToken 等，原样透传上游
 */

/** 上游凭证类型 */
export type CredentialKind = 'ck_apikey' | 'cli_oauth';

/** 凭证运行状态（派生字段，不持久化） */
export type CredentialStatus = 'healthy' | 'expired' | 'cooling' | 'disabled' | 'error';

/**
 * 上游凭证记录（持久化，敏感字段加密存储）。
 */
export interface Credential {
  id: string;
  name: string;
  kind: CredentialKind;

  /** kind=ck_apikey 时使用 */
  apiKey?: string;

  /** kind=cli_oauth 时使用 */
  accessToken?: string;
  refreshToken?: string;
  /** accessToken 过期时间（ms） */
  expiresAt?: number;
  /** refreshToken 过期时间（ms） */
  refreshExpiresAt?: number;
  /** JWT sub，用于上游 X-User-Id */
  userId?: string;
  domain?: string;

  enabled: boolean;
  createdAt: number;
  updatedAt: number;

  /** 最近一次刷新/调用错误（不持久化到 KV 的运行时字段除外） */
  lastError?: string;
  /** 冷却截止时间戳（ms），运行期计算 */
  coolingUntil?: number;
}

/**
 * Key 级配额策略。
 *
 * 三类**总量**配额（非速率）：请求数、Token 消耗、积分消耗。
 * 每类各有日/月两个窗口，未设置表示该窗口不限制。
 *
 * 为什么是总量而非速率：管理台的诉求是「这个 Key 一天/一月最多用多少」，
 * 属于预算控制；速率限制（每秒/每分多少）已由入口限流按 IP 承担，
 * 两者是不同的防护目的，不混在同一处。
 *
 * 累计值不落在这里（见 KeyUsage）——策略是配置，用量是运行时状态，
 * 分开存避免每次请求都重写策略记录。
 */
export interface KeyQuota {
  /** 每日请求数上限 */
  dailyRequests?: number;
  /** 每月请求数上限 */
  monthlyRequests?: number;
  /** 每日 Token 上限（prompt+completion） */
  dailyTokens?: number;
  /** 每月 Token 上限 */
  monthlyTokens?: number;
  /** 每日积分上限（上游实报 credit） */
  dailyCredit?: number;
  /** 每月积分上限 */
  monthlyCredit?: number;
}

/**
 * Key 的用量累计（运行时状态，按窗口滚动）。
 *
 * 日窗口在本地日切时归零，月窗口在自然月切换时归零——
 * 与 metrics-history 的 localDayKey 口径一致，避免出现两套「一天」的定义。
 */
export interface KeyUsageCounters {
  requests: number;
  tokens: number;
  credit: number;
}

/** 单个 Key 在某个时刻的用量快照（日 + 月两个窗口） */
export interface KeyUsage {
  /** 当前本地日，形如 2026-09-24；与记录不符时视为跨天需归零 */
  day: string;
  /** 当前自然月，形如 2026-09；与记录不符时视为跨月需归零 */
  month: string;
  daily: KeyUsageCounters;
  monthly: KeyUsageCounters;
  /** 最近一次用量更新时间 */
  updatedAt: number;
}

/**
 * 网关自建 API key 记录。
 * 明文只在创建时返回一次，库中仅保留 SHA-256 哈希。
 */
export interface ClientKey {
  id: string;
  name: string;
  keyHash: string;
  /** 绑定的上游凭证 ID（多对多） */
  credentialIds: string[];
  enabled: boolean;
  createdAt: number;
  lastUsedAt?: number;
  /** 客户端模型名 → 实际上游模型名(客户端无感知的重写,key 级生效) */
  modelAliases?: Record<string, string>;
  /**
   * 允许使用的模型 ID 白名单。
   *
   * **空数组或未设置 = 不限制（全部模型可用）** —— 这是默认值，
   * 因为新增 Key 时不应该要求用户先把所有模型勾一遍；否则上游新增模型后
   * 老 Key 会被静默拦住。
   */
  modelIds?: string[];
  /** 配额策略；未设置表示不限量 */
  quota?: KeyQuota;
}

/**
 * 解析后的上游凭证，供转发链路直接使用。
 */
export interface UpstreamCredential {
  /** 用于 Authorization 头的上游 token */
  token: string;
  /** 上游 X-User-Id（可为空） */
  userId?: string;
  /** 来源类型，便于日志与排障 */
  kind: CredentialKind | 'passthrough';
  /** 命中的凭证 ID（透传模式为空） */
  credentialId?: string;
  /** 命中的凭证名，供日志直读（避免按 ID 反查；透传模式为空） */
  credentialName?: string;
}

/**
 * 存储抽象。实现需同时提供持久化版本与内存版本（后者用于测试与无绑定降级）。
 */
/** 网关全局设置(持久化) */
export interface GatewaySettings {
  /** 每日自动签到(领 credits),由进程内定时器触发 */
  autoCheckin: boolean;
}

export interface TokenStore {
  readonly persistent: boolean;

  // ── 设置 ───────────────────────────────────────────────────────────
  getSettings(): Promise<GatewaySettings>;
  putSettings(settings: GatewaySettings): Promise<void>;

  // ── 凭证 ────────────────────────────────────────────────────────────
  listCredentials(): Promise<Credential[]>;
  getCredential(id: string): Promise<Credential | undefined>;
  saveCredential(credential: Credential): Promise<void>;
  deleteCredential(id: string): Promise<void>;

  // ── 自建 key ────────────────────────────────────────────────────────
  listKeys(): Promise<ClientKey[]>;
  getKeyByHash(keyHash: string): Promise<ClientKey | undefined>;
  saveKey(key: ClientKey): Promise<void>;
  deleteKey(id: string): Promise<void>;
}
