/**
 * 管理界面：鉴权 + 管理 API。
 *
 * 鉴权采用无状态会话：密码经常时比较校验后，签发 HMAC 签名的 httpOnly cookie，
 * 不占用 KV 存储。所有写接口额外校验 Origin 同站，防止 CSRF。
 */

import { generateApiKey, randomId, signSession, timingSafeEqual, verifySession } from './crypto';
import {
  CHANNEL_FAULT_STATUSES,
  forceRefreshCredential,
  getCredentialStatus,
  markCredentialFailure,
  markCredentialSuccess,
} from './credentials';
import { getTokenStore, hashApiKey } from './store';
import { resolveBrowserModelsList } from './models';
import { getKeyUsage, deleteKeyUsage, resetKeyUsage } from './key-usage';
import { renderLoginPage } from './admin-ui';
import { serveAppShell, serveStaticFile } from './static';
import { fetchCheckinStatus, fetchCredentialQuota, fetchDailyCheckin } from './upstream-billing';
import { CATCHUP_DELAYS_MIN, CHECKIN_UTC_HOUR, CHECKIN_UTC_MINUTE } from './scheduled';
import { createSseReader, parseSseJsonChunks } from './protocol/sse';
import { prepareChatPayload } from './payload';
import type { ClientKey, Credential, CredentialKind, KeyQuota } from './types';
import { Env, jsonResponse, fetchWithTimeout, resolveRateLimit } from './utils';
import { checkRateLimit } from './rate-limiter';
import { metricsSnapshot } from './metrics';
import { historySnapshot, initMetricsHistory } from './metrics-history';
import { logSnapshot, pushLog } from './logs';

const SESSION_COOKIE = 'cb_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_SESSION_SECRET = 'dev-insecure-session-secret';
/** 上游额度查询默认地址(与转发链路保持一致,仅用于「设置」页展示) */
const DEFAULT_UPSTREAM_QUOTA_URL = 'https://copilot.tencent.com/v2/billing/meter/get-user-resource';

// ── 会话 ──────────────────────────────────────────────────────────────────

function sessionSecret(env: Env): string {
  return env.ADMIN_SESSION_SECRET || DEFAULT_SESSION_SECRET;
}

/** 管理功能是否启用（需配置管理员密码） */
export function isAdminEnabled(env: Env): boolean {
  return Boolean(env.ADMIN_PASSWORD);
}

/**
 * 解析客户端来源 IP(用于管理限流分桶)。
 * 优先取 X-Forwarded-For 首个地址;缺失时退化为 UA 前缀 / unknown,
 * 避免多客户端共享单桶互相 429。
 */
function resolveClientIp(request: Request): string {
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }

  // 无来源 IP(本地/特殊回源):用 User-Agent 前缀做弱区分,避免全局共享桶
  const ua = request.headers.get('user-agent') ?? '';
  const uaKey = ua.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return uaKey || 'unknown';
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  return verifySession(match?.[1], sessionSecret(env));
}

/**
 * 校验写请求的 Origin 是否同站，防 CSRF。
 * 缺少 Origin（如 curl）时放行，便于脚本化管理。
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * 管理接口统一的鉴权守卫。返回 null 表示放行，否则返回错误响应。
 */
async function guard(request: Request, env: Env, ip: string): Promise<Response | null> {
  if (!isAdminEnabled(env)) {
    return jsonResponse(
      { error: 'Admin disabled', message: 'ADMIN_PASSWORD is not configured' },
      env,
      404,
    );
  }

  // 管理接口限流:已鉴权操作放宽额度(登录爆破由 handleLogin 独立防护)
  if (!checkRateLimit(`admin:${ip}`, 600, 60_000, 120)) {
    return jsonResponse({ error: 'Too Many Requests' }, env, 429);
  }

  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, env, 401);
  }

  if (request.method !== 'GET' && !isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden', message: 'Cross-origin write denied' }, env, 403);
  }

  return null;
}

// ── 路由入口 ──────────────────────────────────────────────────────────────

/**
 * 处理 /admin 与 /admin/* 请求。
 */
export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  if (!isAdminEnabled(env)) {
    return new Response('Admin disabled', { status: 404 });
  }

  const ip = resolveClientIp(request);

  // ── 登录 / 登出 ────────────────────────────────────────────────
  if (path === '/admin/login' && request.method === 'POST') {
    return handleLogin(request, env, ip);
  }
  if (path === '/admin/logout' && request.method === 'POST') {
    return withClearedCookie(jsonResponse({ ok: true }, env), env, request);
  }

  // ── 管理 API ──────────────────────────────────────────────────
  if (path.startsWith('/admin/api/')) {
    const denied = await guard(request, env, ip);
    if (denied) return denied;
    return handleAdminApi(request, env, path);
  }

  // ── 控制台静态资源(带 hash 的 JS/CSS,不含数据,无需鉴权) ───────
  // Accept-Encoding 透传给 static.ts：命中构建期预压缩的 .br/.gz 时直接返回，
  // 免去运行时压缩的 CPU 开销（厂商块 676KB → br 149KB）。
  const acceptEncoding = request.headers.get('accept-encoding');
  if (path !== '/admin' && path !== '/admin/') {
    const asset = await serveStaticFile(publicDir(env), path, '/admin', acceptEncoding);
    if (asset) return asset;
  }

  // ── 控制台页面:未登录先登录,已登录返回 SPA 入口 ────────────────
  if (!(await isAuthenticated(request, env))) {
    return htmlResponse(renderLoginPage());
  }
  const shell = await serveAppShell(publicDir(env), acceptEncoding);
  if (shell) return shell;
  return htmlResponse(renderConsoleNotBuilt());
}

/**
 * 控制台前端产物目录。
 * Docker 镜像固定为 /app/public;源码运行默认取仓库内 web/dist。
 */
function publicDir(env: Env): string {
  if (env.PUBLIC_DIR) return env.PUBLIC_DIR;
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '.';
  return `${cwd}/web/dist`;
}

/** 产物缺失(未执行前端构建)时的可操作提示 */
function renderConsoleNotBuilt(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>控制台未构建</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b14;color:#f1f5f9;
font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.box{max-width:520px;padding:28px 30px;border:1px solid #1e293b;border-radius:14px;background:#0d1320}
h1{margin:0 0 10px;font-size:18px}code{background:#101624;padding:2px 6px;border-radius:6px;font-size:13px}
p{color:#94a3b8;margin:8px 0}</style></head>
<body><div class="box">
<h1>控制台前端尚未构建</h1>
<p>管理 API 已就绪，但缺少前端产物。请在仓库中执行：</p>
<p><code>cd web &amp;&amp; npm install &amp;&amp; npm run build</code></p>
<p>或使用 Docker 镜像（镜像内已包含构建产物）。</p>
</div></body></html>`;
}

/**
 * 会话 cookie 是否带 Secure 属性。
 *
 * 浏览器只在 HTTPS(或被视为可信源的 localhost)下保存 Secure cookie。通过明文
 * HTTP 访问内网地址时若仍带 Secure,cookie 会被静默丢弃 —— 表现为「密码正确
 * 但登录后立刻退回未登录态」,极难排查。
 *
 * 判断顺序:
 *   1. ADMIN_COOKIE_SECURE 显式设置(1/true/yes)时以其为准,便于反代终结 TLS
 *   2. X-Forwarded-Proto 为 https(反代已终结 TLS)
 *   3. request.url 协议为 https(Workers 等原生 HTTPS 运行时)
 */
function useSecureCookie(request: Request, env: Env): boolean {
  const flag = env.ADMIN_COOKIE_SECURE?.trim().toLowerCase();
  if (flag) return flag === '1' || flag === 'true' || flag === 'yes';

  const proto = request.headers.get('X-Forwarded-Proto');
  if (proto) return proto.split(',')[0].trim().toLowerCase() === 'https';

  return new URL(request.url).protocol === 'https:';
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
  );
}

async function handleLogin(request: Request, env: Env, ip: string): Promise<Response> {
  if (!checkRateLimit(`admin-login:${ip}`, 10, 60_000, 5)) {
    return jsonResponse({ error: 'Too Many Requests' }, env, 429);
  }

  let body: { password?: unknown } = {};
  try {
    body = (await request.json()) as { password?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, env, 400);
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!env.ADMIN_PASSWORD || !timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return jsonResponse({ error: 'Unauthorized', message: 'Invalid password' }, env, 401);
  }

  const token = await signSession(Date.now() + SESSION_TTL_MS, sessionSecret(env));
  const response = jsonResponse({ ok: true }, env);
  response.headers.append(
    'set-cookie',
    sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), useSecureCookie(request, env)),
  );
  return response;
}

function withClearedCookie(response: Response, env: Env, request: Request): Response {
  response.headers.append('set-cookie', sessionCookie('', 0, useSecureCookie(request, env)));
  return response;
}

// ── 管理 API 分发 ─────────────────────────────────────────────────────────

async function handleAdminApi(request: Request, env: Env, path: string): Promise<Response> {
  const store = getTokenStore(env);

  // ── 运行配置(只读,供「设置」页展示;不含任何密钥) ────────────
  /**
   * 管理台的可用模型清单（供 Key 的模型绑定多选）。
   *
   * 为什么不复用 GET /v1/models：那个端点面向 **API 客户端**，要求网关 Key 鉴权。
   * 管理台用的是 cookie 会话，直接请求它会拿到 401，而前端 api.ts 对 401 的
   * 处理是整页跳转 /admin —— 表现为「打开 Key 页面就被弹回总览」。
   * 因此提供这个走 cookie 鉴权的独立端点。
   *
   * 用健康凭证实时拉取（与公开模型页同一策略），失败时回退内置快照，
   * 保证管理台在凭证不可用时仍能拿到一份模型清单。
   */
  /**
   * 管理台的可用模型清单（供 Key 的模型绑定多选）。
   *
   * 为什么不复用 GET /v1/models：那个端点面向 **API 客户端**，要求网关 Key 鉴权。
   * 管理台用的是 cookie 会话，直接请求它会拿到 401，而前端 api.ts 对 401 的处理
   * 是整页跳转 /admin —— 表现为「打开 Key 页面就被弹回总览」。
   * 本端点走 cookie 鉴权，内部用健康凭证代拉（不暴露凭证）。
   */
  if (path === '/admin/api/models' && request.method === 'GET') {
    const models = await resolveBrowserModelsList(env);
    return jsonResponse({ data: models.map((m) => ({ id: m.id, name: m._name ?? m.id })) }, env);
  }

  if (path === '/admin/api/config' && request.method === 'GET') {
    const limit = resolveRateLimit(env);
    return jsonResponse(
      {
        data: {
          storage: store.persistent ? 'persistent' : 'memory',
          thinkingMode: (env.EMIT_THINKING || 'auto').toLowerCase(),
          rateLimit: { perMinute: limit.perMinute, burst: limit.burst },
          sessionTtlHours: Math.round(SESSION_TTL_MS / 3600_000),
          checkinSchedule: `UTC ${String(CHECKIN_UTC_HOUR).padStart(2, '0')}:${String(CHECKIN_UTC_MINUTE).padStart(2, '0')}`,
          checkinCatchupMinutes: CATCHUP_DELAYS_MIN,
          upstream: {
            chat: env.UPSTREAM_CHAT_COMPLETIONS_URL,
            quota: env.UPSTREAM_QUOTA_URL || DEFAULT_UPSTREAM_QUOTA_URL,
            config: env.UPSTREAM_CONFIG_URL || 'https://copilot.tencent.com/v3/config',
            refresh: env.UPSTREAM_REFRESH_URL || 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
          },
          timeout: {
            totalSeconds: Number(env.UPSTREAM_TIMEOUT_SECONDS) || 600,
            connectSeconds: Number(env.UPSTREAM_CONNECT_TIMEOUT_SECONDS) || 30,
          },
        },
      },
      env,
    );
  }

  // ── 实时请求监控统计 ──────────────────────────────────────
  if (path === '/admin/api/metrics' && request.method === 'GET') {
    return jsonResponse({ data: metricsSnapshot() }, env);
  }

  // ── 请求量的日/月归档(持久化,跨重启保留)─────────────────
  if (path === '/admin/api/metrics/history' && request.method === 'GET') {
    // 兜底接入:Node 入口已在启动时接好,其它运行时(或直接复用本模块的
    // 测试)在这里按 env 惰性接入。同一存储重复调用是幂等的。
    if (env.CREDENTIALS_KV) initMetricsHistory(env.CREDENTIALS_KV);

    const url = new URL(request.url);
    const snapshot = await historySnapshot({
      days: Number(url.searchParams.get('days') ?? '30'),
      months: Number(url.searchParams.get('months') ?? '12'),
    });
    return jsonResponse({ data: snapshot }, env);
  }

  // ── 运行日志(内存缓冲,新的在前;支持级别与关键词过滤) ──────
  if (path === '/admin/api/logs' && request.method === 'GET') {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '200');
    const level = url.searchParams.get('level') ?? '';
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();

    let entries = logSnapshot(Number.isFinite(limit) ? limit : 200);
    if (level === 'info' || level === 'warn' || level === 'error') {
      entries = entries.filter((entry) => entry.level === level);
    }
    if (query) {
      entries = entries.filter((entry) =>
        `${entry.event} ${entry.message} ${JSON.stringify(entry.data ?? {})}`.toLowerCase().includes(query),
      );
    }
    return jsonResponse({ data: entries }, env);
  }

  // ── 网关设置(签到策略)─────────────────────────────────────
  if (path === '/admin/api/settings' && request.method === 'GET') {
    return jsonResponse({ data: await store.getSettings() }, env);
  }

  if (path === '/admin/api/settings' && request.method === 'PUT') {
    const body = await readJson(request);
    const next: import('./types').GatewaySettings = {
      autoCheckin: body.autoCheckin === true,
    };
    await store.putSettings(next);
    return jsonResponse({ data: next }, env);
  }

  // ── 仪表盘聚合数据 ──────────────────────────────────────────
  if (path === '/admin/api/state' && request.method === 'GET') {
    const credentials = await store.listCredentials();
    const keys = await store.listKeys();

    return jsonResponse(
      {
        storage: store.persistent ? 'persistent' : 'memory',
        credentials: credentials.map(summarizeCredential),
        keys: keys.map(summarizeKey),
        counts: {
          credentials: credentials.length,
          healthy: credentials.filter((c) => getCredentialStatus(c) === 'healthy').length,
          keys: keys.length,
          enabledKeys: keys.filter((k) => k.enabled).length,
        },
      },
      env,
    );
  }

  // ── 凭证 ────────────────────────────────────────────────────
  if (path === '/admin/api/credentials' && request.method === 'GET') {
    const credentials = await store.listCredentials();
    return jsonResponse({ data: credentials.map(summarizeCredential) }, env);
  }

  if (path === '/admin/api/credentials' && request.method === 'POST') {
    const body = await readJson(request);
    const kind = body.kind === 'ck_apikey' ? 'ck_apikey' : 'cli_oauth';
    const now = Date.now();

    const credential: Credential = {
      id: randomId('cred'),
      name: String(body.name ?? '未命名凭证'),
      kind: kind as CredentialKind,
      enabled: body.enabled !== false,
      createdAt: now,
      updatedAt: now,
      ...(kind === 'ck_apikey'
        ? { apiKey: String(body.apiKey ?? '') }
        : {
            accessToken: body.accessToken ? String(body.accessToken) : undefined,
            refreshToken: body.refreshToken ? String(body.refreshToken) : undefined,
            expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : undefined,
            refreshExpiresAt:
              typeof body.refreshExpiresAt === 'number' ? body.refreshExpiresAt : undefined,
            userId: body.userId ? String(body.userId) : undefined,
            domain: body.domain ? String(body.domain) : undefined,
          }),
    };

    credential.userId ??= deriveUserId(credential);
    await store.saveCredential(credential);
    return jsonResponse({ data: summarizeCredential(credential) }, env, 201);
  }

  const credMatch = /^\/admin\/api\/credentials\/([^/]+)(\/refresh|\/quota|\/checkin|\/checkin-status)?$/.exec(path);
  if (credMatch) {
    const id = decodeURIComponent(credMatch[1]);
    const action = credMatch[2] ?? '';
    const isRefresh = action === '/refresh';

    if (isRefresh && request.method === 'POST') {
      try {
        const refreshed = await forceRefreshCredential(id, env);
        return jsonResponse({ data: summarizeCredential(refreshed) }, env);
      } catch (err: unknown) {
        return jsonResponse(
          { error: 'Refresh failed', message: err instanceof Error ? err.message : String(err) },
          env,
          502,
        );
      }
    }

    // ── 额度查询(只读)──────────────────────────────────────
    if (action === '/quota' && request.method === 'GET') {
      const credential = await store.getCredential(id);
      if (!credential) return jsonResponse({ error: 'Not Found' }, env, 404);

      try {
        const quota = await fetchCredentialQuota(credential, env);
        return jsonResponse({ data: quota }, env);
      } catch (err: unknown) {
        return jsonResponse(
          { error: 'Quota query failed', message: err instanceof Error ? err.message : String(err) },
          env,
          502,
        );
      }
    }

    // ── 签到活动状态(只读,无副作用;供控制台轮询)──────────
    if (action === '/checkin-status' && request.method === 'GET') {
      const credential = await store.getCredential(id);
      if (!credential) return jsonResponse({ error: 'Not Found' }, env, 404);

      try {
        const status = await fetchCheckinStatus(credential, env);
        // 状态查询是一次真实的上游鉴权调用,成功即证明凭证可用 → 清除历史错误标记。
        // 注意:失败时**不**标记错误 —— 计费接口不通不等于模型链路不通
        // (例如控制台 API Key 形态的凭证可查状态但无领取权限),贸然标记会误伤。
        await markCredentialSuccess(credential.id, env).catch(() => undefined);
        return jsonResponse({ data: status }, env);
      } catch (err: unknown) {
        return jsonResponse(
          { error: 'Check-in status failed', message: err instanceof Error ? err.message : String(err) },
          env,
          502,
        );
      }
    }

    // ── 每日签到(改变上游账号资源状态,需显式触发)──────────
    if (action === '/checkin' && request.method === 'POST') {
      const credential = await store.getCredential(id);
      if (!credential) return jsonResponse({ error: 'Not Found' }, env, 404);

      try {
        const result = await fetchDailyCheckin(credential, env);
        return jsonResponse({ data: result }, env);
      } catch (err: unknown) {
        return jsonResponse(
          { error: 'Check-in failed', message: err instanceof Error ? err.message : String(err) },
          env,
          502,
        );
      }
    }

    if (request.method === 'PUT') {
      const existing = await store.getCredential(id);
      if (!existing) return jsonResponse({ error: 'Not Found' }, env, 404);

      const body = await readJson(request);
      const updated: Credential = {
        ...existing,
        name: typeof body.name === 'string' ? body.name : existing.name,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
        updatedAt: Date.now(),
      };
      await store.saveCredential(updated);
      return jsonResponse({ data: summarizeCredential(updated) }, env);
    }

    if (request.method === 'DELETE') {
      await store.deleteCredential(id);
      return jsonResponse({ ok: true }, env);
    }
  }

  // ── 客户端 key ──────────────────────────────────────────────
  if (path === '/admin/api/keys' && request.method === 'GET') {
    const keys = await store.listKeys();
    return jsonResponse({ data: keys.map(summarizeKey) }, env);
  }

  if (path === '/admin/api/keys' && request.method === 'POST') {
    const body = await readJson(request);
    const plaintext = generateApiKey(env.GATEWAY_KEY_PREFIX || 'sk-cb');

    const key: ClientKey = {
      id: randomId('key'),
      name: String(body.name ?? '未命名 Key'),
      keyHash: await hashApiKey(plaintext),
      credentialIds: Array.isArray(body.credentialIds)
        ? body.credentialIds.filter((v): v is string => typeof v === 'string')
        : [],
      enabled: true,
      createdAt: Date.now(),
      // 创建时不传即「不限模型 / 不限量」——不给新 Key 预设限制，
      // 避免用户配完发现模型是被默认挡住的
      ...(parseModelIds(body.modelIds) ? { modelIds: parseModelIds(body.modelIds) } : {}),
      ...(parseQuota(body.quota) ? { quota: parseQuota(body.quota) } : {}),
    };

    await store.saveKey(key);
    // 明文仅在此处返回一次，库中只存哈希
    return jsonResponse({ data: { ...summarizeKey(key), plaintext } }, env, 201);
  }

  // 用量重置单独匹配：路径后缀是 /reset-usage，与上面的 /bind 后缀不共用正则
  const resetMatch = /^\/admin\/api\/keys\/([^/]+)\/reset-usage$/.exec(path);
  if (resetMatch && request.method === 'POST') {
    await resetKeyUsage(decodeURIComponent(resetMatch[1]));
    return jsonResponse({ ok: true }, env);
  }

  const keyMatch = /^\/admin\/api\/keys\/([^/]+)(\/bind)?$/.exec(path);
  if (keyMatch) {
    const id = decodeURIComponent(keyMatch[1]);
    const isBind = keyMatch[2] === '/bind';

    if (isBind && request.method === 'POST') {
      const keys = await store.listKeys();
      const existing = keys.find((k) => k.id === id);
      if (!existing) return jsonResponse({ error: 'Not Found' }, env, 404);

      const body = await readJson(request);
      const credentialIds = Array.isArray(body.credentialIds)
        ? body.credentialIds.filter((v): v is string => typeof v === 'string')
        : [];

      await store.saveKey({ ...existing, credentialIds });
      return jsonResponse({ data: summarizeKey({ ...existing, credentialIds }) }, env);
    }

    if (request.method === 'PUT') {
      const keys = await store.listKeys();
      const existing = keys.find((k) => k.id === id);
      if (!existing) return jsonResponse({ error: 'Not Found' }, env, 404);

      const body = await readJson(request);
      const updated: ClientKey = {
        ...existing,
        name: typeof body.name === 'string' ? body.name : existing.name,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
        modelAliases: isAliasMap(body.modelAliases)
          ? (body.modelAliases as Record<string, string>)
          : existing.modelAliases,
      };

      // 模型绑定：传了该字段就覆盖（空数组=取消限制），没传则保持原值
      const modelIds = parseModelIds(body.modelIds);
      if (modelIds !== undefined) updated.modelIds = modelIds;

      // 配额：同上语义
      const quota = parseQuota(body.quota);
      if (quota !== undefined) {
        // 全空表示取消所有配额限制，直接删字段而不是留空对象
        if (Object.keys(quota).length === 0) delete updated.quota;
        else updated.quota = quota;
      }

      await store.saveKey(updated);
      return jsonResponse({ data: summarizeKey(updated) }, env);
    }

    if (request.method === 'DELETE') {
      await store.deleteKey(id);
      // 一并清掉用量记录，否则重建同名 Key 会继承旧计数
      await deleteKeyUsage(id);
      return jsonResponse({ ok: true }, env);
    }

    // 重置用量（保留配额策略，只把累计值清零）
    if (request.method === 'POST' && resetMatch) {
      await resetKeyUsage(id);
      return jsonResponse({ ok: true }, env);
    }
  }

  // ── 连通性自测 ──────────────────────────────────────────────
  if (path === '/admin/api/test' && request.method === 'POST') {
    return handleTest(request, env);
  }

  // ── Chat 试跑:真实对话验证(聚合返回文本) ─────────────────────────
  if (path === '/admin/api/chat-test' && request.method === 'POST') {
    return handleChatTest(request, env);
  }

  // 管理台「试跑」的流式版本:逐字下发思考与正文,支持中途取消
  if (path === '/admin/api/chat-test/stream' && request.method === 'POST') {
    return handleChatTestStream(request, env);
  }

  return jsonResponse({ error: 'Not Found' }, env, 404);
}

/**
 * 用指定凭证向上游发一次最小 chat 请求，验证可用性。
 */
async function handleTest(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const credentialId = typeof body.credentialId === 'string' ? body.credentialId : '';
  const credential = credentialId ? await getTokenStore(env).getCredential(credentialId) : undefined;

  if (!credential) {
    return jsonResponse({ error: 'Credential not found' }, env, 404);
  }

  const token = credential.kind === 'ck_apikey' ? credential.apiKey : credential.accessToken;
  if (!token) {
    return jsonResponse({ error: 'Credential has no usable token' }, env, 400);
  }

  const url = env.UPSTREAM_CHAT_COMPLETIONS_URL;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(credential.userId ? { 'x-user-id': credential.userId } : {}),
      },
      body: JSON.stringify({
        model: typeof body.model === 'string' ? body.model : 'hy3',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });

    // 测试是显式的可用性验证,结果回写凭证状态:
    // 通过 → 清除历史错误标记(否则失败过的凭证会一直显示 error);
    // 渠道故障(429/5xx 等)→ 记录失败,与转发链路同一口径;
    // 其余(如带错误体的 400)→ 请求本身的问题,不归咎于凭证。
    if (response.ok) {
      await markCredentialSuccess(credentialId, env).catch(() => undefined);
    } else if (CHANNEL_FAULT_STATUSES.has(response.status)) {
      await markCredentialFailure(
        credentialId,
        `连通测试失败:上游 HTTP ${response.status}`,
        env,
      ).catch(() => undefined);
    }

    return jsonResponse(
      { ok: response.ok, status: response.status, credential: credential.name },
      env,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // 网络层异常(超时/连接失败)属渠道故障
    await markCredentialFailure(credentialId, `连通测试失败:${message}`, env).catch(
      () => undefined,
    );
    return jsonResponse({ ok: false, message, credential: credential.name }, env, 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Chat 试跑:用所选凭证真实对话一次(上游仅支持流式,内部聚合),
 * 返回完整文本/推理/用量,供管理台「试跑」视图展示。
 */
/**
 * 管理台「试跑」的流式版本。
 *
 * 与聚合版共用参数,但把上游 SSE 逐事件转成管理台易消费的简化事件:
 *   {"type":"reasoning","delta":"…"}  思考增量
 *   {"type":"content","delta":"…"}    正文增量
 *   {"type":"usage","usage":{…}}      token 用量
 *   {"type":"done","model":"…","finishReason":"…"}
 *   {"type":"error","message":"…"}
 * 客户端断开(取消)时同步中断上游请求,避免上游继续计费。
 */
async function handleChatTestStream(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const credentialId = typeof body.credentialId === 'string' ? body.credentialId : '';
  const credential = credentialId ? await getTokenStore(env).getCredential(credentialId) : undefined;
  if (!credential) return jsonResponse({ error: 'Credential not found' }, env, 404);

  const token = credential.kind === 'ck_apikey' ? credential.apiKey : credential.accessToken;
  if (!token) return jsonResponse({ error: 'Credential has no usable token' }, env, 400);

  const model = typeof body.model === 'string' && body.model ? body.model : 'hy4-preview';
  const userMessage = typeof body.message === 'string' ? body.message : '';
  if (!userMessage) return jsonResponse({ error: 'message is required' }, env, 400);

  const messages: Record<string, unknown>[] = [];
  const system = typeof body.system === 'string' ? body.system.trim() : '';
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userMessage });

  const temperature = typeof body.temperature === 'number' ? body.temperature : 1;
  const maxTokens = typeof body.maxTokens === 'number' && body.maxTokens > 0
    ? Math.min(Math.floor(body.maxTokens), 32_768)
    : 4000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  // 与代理链路共用载荷处理:字段白名单 + max_tokens 钳制 + 思考档位映射。
  // 否则「试跑」会绕过 thinking 映射,导致 deepseek-v4-* 看不到思考输出。
  const payload = await prepareChatPayload(
    { model, stream: true, max_tokens: maxTokens, temperature, messages },
    env,
    { token, userId: credential.userId, kind: credential.kind, credentialId: credential.id },
  );

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(env, env.UPSTREAM_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
        ...(credential.userId ? { 'x-user-id': credential.userId } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    await markCredentialFailure(credentialId, `试跑失败:${message}`, env).catch(() => undefined);
    return jsonResponse({ error: 'Chat test failed', message }, env, 502);
  }

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 500);
    clearTimeout(timeoutId);
    // 仅渠道故障归咎于凭证;带错误体的 400 属请求问题,不应误伤
    if (CHANNEL_FAULT_STATUSES.has(upstream.status)) {
      await markCredentialFailure(
        credentialId,
        `试跑失败:上游 HTTP ${upstream.status}`,
        env,
      ).catch(() => undefined);
    }
    return jsonResponse({ error: 'Upstream error', status: upstream.status, detail }, env, 502);
  }

  // 上游已接受并开始产出:视为该凭证可用,清除历史错误标记
  await markCredentialSuccess(credentialId, env).catch(() => undefined);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (payload: Record<string, unknown>) => {
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        const reader = createSseReader();
        const decoder = new TextDecoder();
        let responseModel = model;
        let finishReason: string | undefined;
        let usage: Record<string, unknown> | undefined;

        const upstreamReader = upstream.body?.getReader();
        if (upstreamReader) {
          for (;;) {
            const { done, value } = await upstreamReader.read();
            if (done) break;
            for (const chunk of reader.feed(decoder.decode(value, { stream: true }))) {
              if (typeof chunk.model === 'string') responseModel = chunk.model;
              if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage as Record<string, unknown>;
              const choices = chunk.choices;
              if (!Array.isArray(choices)) continue;
              for (const choice of choices) {
                if (!choice || typeof choice !== 'object') continue;
                const record = choice as Record<string, unknown>;
                if (typeof record.finish_reason === 'string') finishReason = record.finish_reason;
                const delta = record.delta as Record<string, unknown> | undefined;
                if (!delta) continue;
                if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                  send({ type: 'reasoning', delta: delta.reasoning_content });
                }
                if (typeof delta.content === 'string' && delta.content) {
                  send({ type: 'content', delta: delta.content });
                }
              }
            }
          }
          for (const chunk of reader.eof()) {
            if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage as Record<string, unknown>;
          }
        }
        if (usage) send({ type: 'usage', usage });
        send({ type: 'done', model: responseModel, finishReason: finishReason ?? 'stop' });
      } catch (err: unknown) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearTimeout(timeoutId);
        streamController.close();
      }
    },
    cancel() {
      // 客户端取消:中断上游请求,避免上游继续消耗额度
      controller.abort();
      clearTimeout(timeoutId);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

async function handleChatTest(request: Request, env: Env): Promise<Response> {  const body = await readJson(request);
  const credentialId = typeof body.credentialId === 'string' ? body.credentialId : '';
  const credential = credentialId
    ? await getTokenStore(env).getCredential(credentialId)
    : undefined;

  if (!credential) {
    return jsonResponse({ error: 'Credential not found' }, env, 404);
  }

  const token = credential.kind === 'ck_apikey' ? credential.apiKey : credential.accessToken;
  if (!token) {
    return jsonResponse({ error: 'Credential has no usable token' }, env, 400);
  }

  const model = typeof body.model === 'string' && body.model ? body.model : 'hy3';
  const messages: Record<string, unknown>[] = [];
  const system = typeof body.system === 'string' && body.system.trim()
    ? body.system.trim()
    : '';
  const userMessage = typeof body.message === 'string' ? body.message : '';

  if (!userMessage) {
    return jsonResponse({ error: 'message is required' }, env, 400);
  }
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userMessage });

  const url = env.UPSTREAM_CHAT_COMPLETIONS_URL;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetchWithTimeout(env, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(credential.userId ? { 'x-user-id': credential.userId } : {}),
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 4000,
        temperature: 1,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text();
      // 试跑是真实调用,渠道故障同样回写凭证状态(与转发链路、连通测试同一口径)
      if (CHANNEL_FAULT_STATUSES.has(response.status)) {
        await markCredentialFailure(
          credentialId,
          `试跑失败:上游 HTTP ${response.status}`,
          env,
        ).catch(() => undefined);
      }
      return jsonResponse(
        { error: 'Upstream error', status: response.status, detail: raw.slice(0, 500) },
        env,
        502,
      );
    }

    // 上游已接受并开始产出:视为该凭证可用,清除历史错误标记
    await markCredentialSuccess(credentialId, env).catch(() => undefined);

    const chunks = parseSseJsonChunks(await response.text());
    let content = '';
    let reasoning = '';
    let usage: Record<string, unknown> | undefined;
    let responseModel: string | undefined;
    let finishReason: string | undefined;

    for (const chunk of chunks) {
      if (typeof chunk.model === 'string') responseModel = chunk.model;
      if (chunk.usage && typeof chunk.usage === 'object') {
        usage = chunk.usage as Record<string, unknown>;
      }
      const choices = chunk.choices;
      if (!Array.isArray(choices)) continue;
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object') continue;
        const c = choice as Record<string, unknown>;
        const delta = c.delta as Record<string, unknown> | undefined;
        if (!delta) continue;
        if (typeof delta.content === 'string') content += delta.content;
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (typeof c.finish_reason === 'string') finishReason = c.finish_reason;
      }
    }

    return jsonResponse(
      {
        credential: credential.name,
        model: responseModel ?? model,
        content,
        reasoning,
        finishReason,
        usage,
      },
      env,
    );
  } catch (err: unknown) {
    return jsonResponse(
      { error: 'Chat test failed', message: err instanceof Error ? err.message : String(err) },
      env,
      502,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function deriveUserId(credential: Credential): string | undefined {
  const token = credential.kind === 'ck_apikey' ? credential.apiKey : credential.accessToken;
  if (!token || token.split('.').length !== 3) return undefined;
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4))) as {
      sub?: unknown;
    };
    return typeof claims.sub === 'string' ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 凭证摘要：剔除敏感字段，避免管理接口回显 token。
 */
function summarizeCredential(credential: Credential) {
  return {
    id: credential.id,
    name: credential.name,
    kind: credential.kind,
    status: getCredentialStatus(credential),
    enabled: credential.enabled,
    userId: credential.userId,
    domain: credential.domain,
    expiresAt: credential.expiresAt,
    refreshExpiresAt: credential.refreshExpiresAt,
    lastError: credential.lastError,
    updatedAt: credential.updatedAt,
    hasApiKey: Boolean(credential.apiKey),
    hasAccessToken: Boolean(credential.accessToken),
    hasRefreshToken: Boolean(credential.refreshToken),
  };
}

function summarizeKey(key: ClientKey) {
  return {
    id: key.id,
    name: key.name,
    enabled: key.enabled,
    credentialIds: key.credentialIds,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    modelAliases: key.modelAliases,
    // 空数组表示不限模型；前端据此显示「全部模型」
    modelIds: key.modelIds ?? [],
    quota: key.quota ?? {},
    // 当前用量快照：列表页卡片直接展示，免去前端逐 Key 再请求
    usage: getKeyUsage(key.id),
  };
}

/**
 * 解析并校验模型 ID 白名单。
 *
 * 返回 `string[]` 或 `undefined`（表示「未提供该字段，保持原值」）。
 * 空数组是**有效值**，语义为「不限制」——因此不能与 undefined 混为一谈：
 * 前者是用户主动清空限制，后者是本次请求没带这个字段。
 */
function parseModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

const QUOTA_FIELDS = [
  'dailyRequests', 'monthlyRequests',
  'dailyTokens', 'monthlyTokens',
  'dailyCredit', 'monthlyCredit',
] as const;

/**
 * 解析配额策略。
 *
 * 只接受非负有限数；其余（含 null / 空字符串）视为**清除该项限制**。
 * 负数与 NaN 会让「已用 >= 上限」的比较失去意义，直接丢弃而不是钳到 0——
 * 钳到 0 会让 Key 立刻被自己的配置锁死，那不是用户的意图。
 */
function parseQuota(value: unknown): KeyQuota | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const quota: KeyQuota = {};
  let hasAny = false;

  for (const field of QUOTA_FIELDS) {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      quota[field] = Math.floor(n);
      hasAny = true;
    }
  }

  // 全部字段被清空时返回空对象（表示不限量），而不是 undefined——
  // 这样调用方能把「用户主动取消所有配额」与「本次没提交配额字段」区分开。
  return hasAny ? quota : {};
}

/** 校验 modelAliases 结构(字符串→字符串映射) */
function isAliasMap(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string'),
  );
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
