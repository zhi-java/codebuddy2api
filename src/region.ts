/**
 * 上游区域档案（Region Profile）。
 *
 * ## 为什么需要这个模块
 *
 * 网关同时支持两个彼此独立的上游：国内版（copilot.tencent.com）与国际版
 * （codebuddy.ai）。二者在**域名、路径前缀、鉴权体系、渠道准入、功能开放**
 * 上全都不一样，此前这些常量散落在 index/models/credentials/upstream-billing
 * 四个模块里各自硬编码（同一套 CLI 指纹头甚至被重复写了两遍）。
 *
 * 直接在调用点加 `if (intl)` 分支会让这些差异继续扩散。这里把「一个区域
 * 的全部上游差异」收敛成不可变的档案对象，所有上游交互只从档案派生，
 * 新增区域 = 新增一个档案条目，而不是在业务代码里加条件。
 *
 * ## 区域归属是凭证级属性，不是全局配置
 *
 * 一个网关可同时持有国内版与国际版凭证（region 字段），两类凭证在同一进程
 * 内并行服务不同客户端。这带来一条硬性不变量：
 *
 *   **凭证只能被打到与自身 region 匹配的上游端点。**
 *
 * 国内 token 打到国际端点（或反之）必然 401，若不做约束，故障转移逻辑会在
 * 两个 region 的凭证间反复横跳，把本可通过的单 region 故障放大成全池不可用。
 * 该约束由 profileFor(credential) 统一保证，见 credentials.ts 的选凭证逻辑。
 *
 * ## 事实来源（实测，非推测）
 *
 * 国际版各项取值来自对公开可访问资源的探测、官方 CLI 分发包分析，以及
 * 真实令牌的端到端验证（2026-10-10）：
 *   - OIDC 元数据：https://www.codebuddy.ai/auth/realms/copilot/.well-known/openid-configuration
 *   - 网页版 bundle（download.codebuddy.ai/web/ide/.../main-*.js）
 *   - 官方 CLI：npm @tencent-ai/codebuddy-code
 *
 * 探测结论（仅用无效凭据，未动用任何真实令牌）：
 *   - POST /v2/chat/completions     → 401（路由存在，缺凭证）
 *   - POST /v3/config               → 404（该路径不属于国际版）
 *   - POST /billing/meter/*         → 401（同源，openresty）
 *
 * 由此确定：国际版聊天端点与国内版同为 /v2/chat/completions，差异在域名与
 * 身份头；而计费接口**没有 /v2 前缀**，且不存在每日签到（国内版专属活动）。
 *
 * 实测补充（真实令牌）：
 *   - 国际版**强制流式**，非流式请求返回 400 code=11101
 *     「Non-stream chat request is currently not supported」
 *   - 国际版**要求首条消息为 system prompt**，否则返回 400 code=11128
 *     「first message is not system prompt」
 *   - 刷新响应带 `code: 0`，与国内版一致
 *   - 额度接口沿用国内版的 ProductCode（p_tcaca）即可，数据形状相同
 *   → 前两条是网关转发链路必须适配的硬约束，见 payload.ts 的 prepareChatPayload。
 */

/** 上游区域 */
export type Region = 'cn' | 'intl';

/** 区域档案：某个上游的完整差异集合 */
export interface RegionProfile {
  /** 区域标识 */
  region: Region;
  /** 中文显示名 */
  label: string;
  /** API origin */
  apiBase: string;
  /** 区域特有路径（不带 /v2 前缀的走 base，其余为完整路径） */
  paths: {
    chatCompletions: string;
    config: string;
    refresh: string;
    quota: string;
  };
  /**
   * 渠道身份头。
   *
   * 上游按这些头做渠道准入：国内版实测「缺失 UA 直接 403」，多带无关头
   * （如 OpenAI SDK 的 x-stainless-*、浏览器 origin）同样会被判为非法调用。
   * 国际版走 openresty + Bearer，未观测到渠道指纹要求，置空即只发 Bearer。
   *
   * 分两类，对应两种凭证形态（见 upstream-billing.ts）：
   *  - sessionFingerprint：**仅** CLI OAuth 会话可带。ck_ 控制台 Key 带上
   *    x-ide-* 会被判定为冒充 CLI 会话并 403。
   *  - clientUserAgent：两类凭证都要带。国内版缺失 UA 直接 403，
   *    与是否冒充会话无关。
   */
  fingerprint: {
    /** 仅 cli_oauth 会话形态携带的渠道身份头 */
    sessionFingerprint: Record<string, string>;
    /** 所有凭证形态都要携带的 UA（ck_ 用轻量值，不冒充 CLI） */
    clientUserAgent: string;
  };
  /** 功能开放情况：按能力开关，而不是在调用点写区域分支 */
  features: {
    /** 每日签到（国内版「Buddy 加油站」专属，国际版无此活动） */
    dailyCheckin: boolean;
    /** 计费/额度查询 */
    billing: boolean;
    /** 自动化 token 刷新 */
    autoRefresh: boolean;
    /**
     * 首条消息必须是 system prompt。
     *
     * 国际版实测：不满足时返回 400 `first message is not system prompt`。
     * 国内版无此约束，因此这是必须按区域开关的行为，不能全局生效。
     */
    requireLeadingSystem: boolean;
  };
}

/**
 * 国内版 CLI 会话指纹。
 *
 * 改造前这段头在 index.ts / models.ts / upstream-billing.ts 各写了一遍,
 * 升级 CLI 版本号时极易漏改一处 —— 现统一在此定义。
 */
const CN_SESSION_FINGERPRINT: Record<string, string> = {
  'x-ide-type': 'CLI',
  'x-ide-name': 'CLI',
  'x-ide-version': '2.107.0',
  'x-requested-with': 'XMLHttpRequest',
  'x-codebuddy-request': '1',
  'x-product': 'SaaS',
  'x-private-data': 'false',
};

/** 国内版档案：保持改造前的全部既有行为 */
export const CN_PROFILE: RegionProfile = {
  region: 'cn',
  label: '国内版',
  apiBase: 'https://copilot.tencent.com',
  paths: {
    chatCompletions: '/v2/chat/completions',
    config: '/v3/config',
    refresh: '/v2/plugin/auth/token/refresh',
    quota: '/v2/billing/meter/get-user-resource',
  },
  fingerprint: {
    sessionFingerprint: CN_SESSION_FINGERPRINT,
    clientUserAgent: 'CLI/2.107.0 CodeBuddy/2.107.0',
  },
  features: { dailyCheckin: true, billing: true, autoRefresh: true, requireLeadingSystem: false },
};

/**
 * 国际版档案。
 *
 * apiBase 用门户 origin 本身：网页版 bundle 里所有业务接口都是同源相对路径
 * （无独立 api 域），且 /billing/* 直接挂在 www.codebuddy.ai 下。
 */
export const INTL_PROFILE: RegionProfile = {
  region: 'intl',
  label: '国际版',
  apiBase: 'https://www.codebuddy.ai',
  paths: {
    // 与国内版同为 /v2/chat/completions（实测 401 而非 404，路由存在）
    chatCompletions: '/v2/chat/completions',
    // 国际版 CLI 用 /v3/config 拉模型目录；国内版同路径返回 404，反之亦然
    config: '/v3/config',
    // 国际版刷新是**同名同形状**的自有端点：/v2/plugin/auth/token/refresh，
    // 与国内版仅域名不同（实测 2026-10-10 确认为 200）。
    //
    // 注意：官方 CLI 分发包里出现的 /v2/auth/token/refresh 属于**企业微信
    // 插件**链路（WxAuthenticationProvider），宿主不同，在网页版域名下恒 404。
    // 最初的档案误采了该路径，是真实链路测试发现的。
    refresh: '/v2/plugin/auth/token/refresh',
    // 计费接口无 /v2 前缀 —— 与国内版的 /v2/billing/* 形状不同
    quota: '/billing/meter/get-user-resource',
  },
  // 国际版未观测到渠道指纹准入要求；refresh 端点需要专属头，由 refreshCredential 附加
  fingerprint: {
    sessionFingerprint: {},
    clientUserAgent: 'CLI/2.107.0 CodeBuddy/2.107.0',
  },
  features: {
    dailyCheckin: false, // 「Buddy 加油站」是国内版专属活动，国际版无对应接口
    billing: true,
    autoRefresh: true,
    // 实测：首条非 system 时返回 400「first message is not system prompt」
    requireLeadingSystem: true,
  },
};

const PROFILES: Record<Region, RegionProfile> = {
  cn: CN_PROFILE,
  intl: INTL_PROFILE,
};

/** 取指定区域档案 */
export function profileFor(region: Region | undefined): RegionProfile {
  return PROFILES[region ?? 'cn'] ?? CN_PROFILE;
}

/** 区域是否合法（用于管理台入参白名单，避免任意字符串落库） */
export function isRegion(value: unknown): value is Region {
  return value === 'cn' || value === 'intl';
}

/**
 * 从 JWT 的 `iss` 推断区域。
 *
 * 国际版令牌由 Keycloak 签发（iss 含 codebuddy.ai），国内版令牌无 iss 字段。
 * 这样新增凭证时用户不必手选区域——粘贴国际版 token 即可自动归类，
 * 手选仅作为兜底与纠错手段。
 */
export function detectRegionFromToken(token: string | undefined): Region | undefined {
  if (!token || !token.startsWith('eyJ')) return undefined;
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  try {
    const payload = JSON.parse(decodeBase64Url(segments[1])) as { iss?: unknown };
    if (typeof payload.iss !== 'string') return undefined;
    return payload.iss.includes('codebuddy.ai') ? 'intl' : 'cn';
  } catch {
    return undefined;
  }
}

/** base64url 解码（JWT 载荷可能含中文/需容忍 padding 缺失） */
function decodeBase64Url(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  // 转成 UTF-8 字节序列，避免非 ASCII 载荷产生乱码
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 取档案的完整端点 URL */
export function endpointUrl(profile: RegionProfile, pathKey: keyof RegionProfile['paths']): string {
  return `${profile.apiBase}${profile.paths[pathKey]}`;
}