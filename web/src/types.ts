/** 展示层通用类型:与网关管理 API 的响应结构保持一致。 */

export type CredentialKind = 'ck_apikey' | 'cli_oauth';
export type CredentialStatus = 'healthy' | 'expired' | 'cooling' | 'disabled' | 'error';

export interface CredentialSummary {
  id: string;
  name: string;
  kind: CredentialKind;
  status: CredentialStatus;
  enabled: boolean;
  userId?: string;
  domain?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  lastError?: string;
  updatedAt: number;
  hasApiKey: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

export interface KeySummary {
  id: string;
  name: string;
  enabled: boolean;
  credentialIds: string[];
  createdAt: number;
  lastUsedAt?: number;
  modelAliases?: Record<string, string>;
}

export interface GatewayState {
  storage: 'persistent' | 'memory';
  credentials: CredentialSummary[];
  keys: KeySummary[];
  counts: { credentials: number; healthy: number; keys: number; enabledKeys: number };
}

export interface GatewaySettings {
  autoCheckin: boolean;
}

/** 运行配置(只读,不含密钥) */
export interface GatewayConfig {
  storage: 'persistent' | 'memory';
  thinkingMode: string;
  rateLimit: { perMinute: number; burst: number };
  sessionTtlHours: number;
  checkinSchedule: string;
  /** 主时点后仍有未签到凭证时的补签间隔(分钟) */
  checkinCatchupMinutes: number[];
  upstream: { chat: string; quota: string; config: string; refresh: string };
  timeout: { totalSeconds: number; connectSeconds: number };
}

export interface RequestRecord {
  at: number;
  path: string;
  model: string;
  status: number;
  durationMs: number;
  credentialId?: string;
  /** 命中的上游凭证名(日志与列表直读,免去按 ID 反查) */
  credentialName?: string;
  retried?: boolean;
  error?: string;
  /** 上游上报的 token 用量(流式请求在流结束后回填) */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 上游实报的积分消耗;undefined 表示上游未上报 */
  credit?: number;
}

export interface MinuteBucket {
  minute: number;
  total: number;
  errors: number;
  durationSumMs: number;
  totalTokens: number;
}

export interface GroupStat {
  key: string;
  total: number;
  errors: number;
  avgDurationMs: number;
  totalTokens: number;
}

export interface MetricsSnapshot {
  totals: {
    total: number;
    success: number;
    error: number;
    successRate: number;
    avgDurationMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    lastMinute: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 已上报 usage 的请求数(与 total 的比值即覆盖率) */
    tokenReported: number;
    avgTokensPerMinute: number;
    /** 上游实报的积分消耗合计 */
    credit: number;
    /** 已上报 credit 的请求数 */
    creditReported: number;
  };
  uptime: { startedAt: number; uptimeMs: number };
  series: MinuteBucket[];
  byModel: GroupStat[];
  byPath: GroupStat[];
  statusBuckets: { class2xx: number; class4xx: number; class5xx: number };
  recent: RequestRecord[];
  recentErrors: RequestRecord[];
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface QuotaInfo {
  total?: number;
  used?: number;
  remaining?: number;
  cycleStart?: string;
  cycleEnd?: string;
  resourceId?: string;
  checkedAt?: number;
}

/**
 * 签到活动状态(Buddy 加油站)。
 * 上游按期开放(如第 8 期「开学季」2026-09-01~09-15),期号与档期均为下发的只读信息。
 */
export interface CheckinStatus {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  totalCredits: number;
  season: number;
  activityName?: string;
  themeName?: string;
  startTime?: string;
  endTime?: string;
  actionButton?: { show: boolean; text: string; action: string };
  /** 该凭证能否执行领取(控制台 API Key 仅可查询状态) */
  canClaim: boolean;
  claimBlockedReason?: string;
}

/** 试跑会话中的一条消息(前端本地维护) */
export interface PlaygroundMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  model?: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
}

/** 流式试跑的事件(与后端 handleChatTestStream 对齐) */
export type ChatStreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'done'; model: string; finishReason: string }
  | { type: 'error'; message: string };
