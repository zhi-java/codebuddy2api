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
