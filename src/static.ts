/**
 * 静态资源托管（管理控制台前端产物）。
 *
 * 由网关进程直接服务 web/dist：
 *   - 带 hash 的 assets/* 长缓存（内容不可变）
 *   - index.html 与其它未匹配路径 no-store，且回退到 SPA 入口
 *   - 目录穿越防护：解析后的真实路径必须仍在 publicDir 内
 *
 * 产物缺失时返回 null，由调用方决定降级文案（例如未构建的源码环境）。
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeOf(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 读取 publicDir 下的文件并构造 Response。
 *
 * @param publicDir 前端产物根目录（绝对路径）
 * @param pathname  请求路径（如 /admin/assets/index-xxx.js）
 * @param basePath  需要剥离的路径前缀（如 /admin）
 * @returns 命中返回 Response，未命中或越界返回 null
 */
export async function serveStaticFile(
  publicDir: string,
  pathname: string,
  basePath: string,
): Promise<Response | null> {
  const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
  const decoded = (() => {
    try {
      return decodeURIComponent(relative);
    } catch {
      return relative;
    }
  })();

  const target = path.resolve(publicDir, '.' + (decoded.startsWith('/') ? decoded : `/${decoded}`));
  const root = path.resolve(publicDir);
  // 目录穿越防护：真实路径必须位于产物目录内
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    const body = await readFile(target);
    const isHashedAsset = /[.-][A-Za-z0-9_-]{8,}\./.test(path.basename(target));
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': contentTypeOf(target),
        'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return null;
  }
}

/** 读取 SPA 入口 index.html。 */
export async function serveAppShell(publicDir: string): Promise<Response | null> {
  return serveStaticFile(publicDir, '/index.html', '/admin');
}
