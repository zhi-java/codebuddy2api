/**
 * Node.js 服务入口(Node 部署版)。
 *
 * 复用 index.ts 的 default export 作为请求处理器:
 *   http(s) 请求 → 构造标准 Request → worker.fetch(request, env) → 回写 Response
 * 存储:createNodeKv(SQLite/JSON 文件)注入 env.CREDENTIALS_KV;crypto.subtle /
 * Web Streams 均为 Node ≥18 原生能力,协议转换/管理台/凭证链路零改动。
 *
 * 运行:
 *   npx esbuild src/server.ts --bundle --platform=node --format=cjs --outfile=dist/server.cjs
 *   node dist/server.cjs
 * 环境变量:PORT / HOST / DATA_FILE 及 ADMIN_PASSWORD / ADMIN_SESSION_SECRET /
 * CREDENTIALS_ENC_SECRET 等网关配置。
 */

import { createNodeKv } from './node-kv';
import { performAutoCheckins, planNextCheckinRun } from './scheduled';
import { installProcessGuards } from './process-guards';
import worker from './index';
import type { Env } from './utils';

// ── 环境组装 ───────────────────────────────────────────────────────────────

function nodePath(): { resolve(...p: string[]): string } {
  return require('node:path') as { resolve(...p: string[]): string };
}

function buildNodeEnv(): Env {
  const env = process.env;
  const defaultData = nodePath().resolve(process.cwd(), 'data', 'codebuddy.db');

  const nodeEnv: Env = {
    UPSTREAM_CHAT_COMPLETIONS_URL:
      env.UPSTREAM_CHAT_COMPLETIONS_URL || 'https://copilot.tencent.com/v2/chat/completions',
    UPSTREAM_QUOTA_URL:
      env.UPSTREAM_QUOTA_URL || 'https://copilot.tencent.com/v2/billing/meter/get-user-resource',
    UPSTREAM_CONFIG_URL: env.UPSTREAM_CONFIG_URL || 'https://copilot.tencent.com/v3/config',
    UPSTREAM_REFRESH_URL:
      env.UPSTREAM_REFRESH_URL || 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
    UPSTREAM_TIMEOUT_SECONDS: env.UPSTREAM_TIMEOUT_SECONDS || '600',
    UPSTREAM_CONNECT_TIMEOUT_SECONDS: env.UPSTREAM_CONNECT_TIMEOUT_SECONDS || '30',
    CORS_ALLOW_ORIGINS: env.CORS_ALLOW_ORIGINS || '*',
    CORS_ALLOW_CREDENTIALS: env.CORS_ALLOW_CREDENTIALS || 'false',
    CREDENTIALS_KV: createNodeKv({ file: env.DATA_FILE || defaultData }),
    ...(env.ADMIN_PASSWORD ? { ADMIN_PASSWORD: env.ADMIN_PASSWORD } : {}),
    ...(env.ADMIN_SESSION_SECRET ? { ADMIN_SESSION_SECRET: env.ADMIN_SESSION_SECRET } : {}),
    ...(env.CREDENTIALS_ENC_SECRET ? { CREDENTIALS_ENC_SECRET: env.CREDENTIALS_ENC_SECRET } : {}),
    ...(env.GATEWAY_KEY_PREFIX ? { GATEWAY_KEY_PREFIX: env.GATEWAY_KEY_PREFIX } : {}),
    ...(env.EMIT_THINKING ? { EMIT_THINKING: env.EMIT_THINKING } : {}),
    ...(env.PUBLIC_DIR ? { PUBLIC_DIR: env.PUBLIC_DIR } : {}),
    ...(env.DEBUG ? { DEBUG: env.DEBUG } : {}),
  };
  return nodeEnv;
}

// ── 每日自动签到定时器(UTC 03:17,失败自动补签) ────────────────────────────
//
// 主时点执行一轮;若仍有凭证未签到(网络抖动/上游 5xx/容器恰在时点重启),
// 按递增间隔补签若干次,用尽后等次日主时点。调度决策见 scheduled.ts
// 的 planNextCheckinRun(纯函数,可单测)。

function scheduleDailyCheckin(env: Env): void {
  let catchupIndex = 0;

  const run = (delayMs: number): void => {
    setTimeout(() => {
      performAutoCheckins(env)
        .then((report) => {
          const plan = planNextCheckinRun(report.pending, catchupIndex);
          catchupIndex = plan.catchupIndex;
          if (report.pending > 0 && plan.catchupIndex > 0) {
            console.log(
              `[codebuddy-gateway] 签到补签：仍有 ${report.pending} 个凭证未签到，` +
                `${Math.round(plan.delayMs / 60_000)} 分钟后重试`,
            );
          }
          run(plan.delayMs);
        })
        .catch(() => {
          // 整轮异常(如存储不可用):退回次日主时点,避免死循环
          catchupIndex = 0;
          run(planNextCheckinRun(0, 0).delayMs);
        });
    }, delayMs);
  };

  run(planNextCheckinRun(0, 0).delayMs);
}

// ── HTTP 适配 ──────────────────────────────────────────────────────────────

const MAX_BODY = 10 * 1024 * 1024; // 10MB,与 index.ts 一致

interface NodeHttp {
  createServer(cb: (req: HttpIncoming, res: HttpServerResponse) => void): HttpServer;
  ServerResponse: unknown;
}
// 最小形状(运行时对象,不引 @types/node)
type HttpIncoming = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, cb: () => void): unknown;
  destroy(): void;
};
type HttpServerResponse = {
  writeHead(status: number, headers?: Record<string, string | string[] | undefined>): void;
  setHeader(name: string, value: string | string[]): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: Uint8Array | string): void;
  destroy(): void;
  on(event: string, cb: () => void): unknown;
  once(event: string, cb: () => void): unknown;
};
type HttpServer = {
  listen(port: number, host: string, cb?: () => void): void;
  close(cb?: () => void): void;
  closeIdleConnections?(): void;
};

async function readBody(req: HttpIncoming): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BODY) return null; // 413
    chunks.push(chunk);
  }
  if (chunks.length === 0) return new Uint8Array(0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function handleNodeRequest(req: HttpIncoming, res: HttpServerResponse, env: Env): Promise<void> {
  try {
    const rawUrl = req.url || '/';
    const url = new URL(rawUrl, `http://${(req.headers.host as string) || 'localhost'}`);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value) continue;
      if (name === 'connection' || name === 'keep-alive' || name === 'transfer-encoding' || name === 'content-length') {
        continue;
      }
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v);
      } else {
        headers.append(name, value);
      }
    }

    const method = (req.method || 'GET').toUpperCase();
    let body: Uint8Array | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = await readBody(req);
      if (raw === null) {
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('Payload Too Large');
        return;
      }
      if (raw.byteLength > 0) body = raw;
    }

    const request = new Request(url, {
      method,
      headers,
      body: body as BodyInit | undefined,
    });

    const response = await worker.fetch(request, env);

    const responseHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === 'set-cookie') {
        const cookies = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
        responseHeaders[name] = cookies && cookies.length ? cookies : [value];
        return;
      }
      responseHeaders[name] = value;
    });

    res.writeHead(response.status, responseHeaders);

    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 尊重 TCP 背压:客户端读得慢时等 drain,避免在内存里无限堆积
      if (value && value.byteLength && !res.write(value)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err: unknown) {
    try {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      res.destroy();
    }
  }
}

// ── 启动 ───────────────────────────────────────────────────────────────────

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServerOptions = {}): { server: HttpServer; env: Env } {
  const env = buildNodeEnv();
  const http = require('node:http') as NodeHttp;

  const server = http.createServer((req, res) => {
    void handleNodeRequest(req, res, env);
  });

  const envPort = process.env.PORT ? Number(process.env.PORT) : 8787;
  const port = opts.port !== undefined ? opts.port : envPort;
  const envHost = process.env.HOST || '0.0.0.0';
  const host = opts.host !== undefined ? opts.host : envHost;

  scheduleDailyCheckin(env);
  server.listen(port, host);
  console.log(`[codebuddy-gateway] listening on http://${host}:${port}`);

  /**
   * 进程兜底:上游断流时 undici 可能把 socket 错误抛到事件循环顶层,
   * 默认语义下会直接杀掉进程(所有客户端同时断服)。详见 process-guards.ts。
   */
  installProcessGuards();

  /**
   * 优雅停机:停止接受新连接,等在途请求(含 SSE 流)自然结束。
   * 超过宽限期仍未结束则强制退出,避免容器在 docker stop 的 kill 时限内
   * 被硬杀导致流式响应截断。宽限期需小于 compose 的 stop_grace_period。
   */
  const SHUTDOWN_GRACE_MS = 25_000;
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[codebuddy-gateway] ${signal} received, draining in-flight requests…`);
    server.close(() => process.exit(0));
    // 空闲的 keep-alive 连接会阻止 close 回调,主动断开
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, env };
}

// 直接运行(node dist/server.cjs)时启动;被测试 import 时需显式调用 startServer
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('server.cjs')) {
  startServer();
}
