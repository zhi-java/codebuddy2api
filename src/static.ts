/**
 * 静态资源托管（管理控制台前端产物）。
 *
 * 由网关进程直接服务 web/dist：
 *   - 带 hash 的 assets/* 长缓存（内容不可变）
 *   - index.html 与其它未匹配路径 no-store，且回退到 SPA 入口
 *   - 目录穿越防护：解析后的真实路径必须仍在 publicDir 内
 *   - 预压缩协商：构建期产出的 .br / .gz 旁路文件按 Accept-Encoding 直接返回
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

/**
 * 可压缩类型白名单。
 *
 * 只对文本类产物启用压缩：字体（woff2）、图片本身已是压缩格式，
 * 再套一层 Content-Encoding 既省不下字节，还平白增加解压开销。
 * 构建期已按同样口径排除，这里是运行时的第二道闸。
 */
const COMPRESSIBLE_EXT = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.txt',
  '.map',
]);

function contentTypeOf(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** 按 q 值降序排列的编码候选（仅保留我们真正有旁路文件的两种） */
interface EncodingCandidate {
  encoding: 'br' | 'gzip';
  ext: string;
}

/**
 * 解析 Accept-Encoding，返回按客户端偏好排序的候选编码。
 *
 * 处理 q 值（`gzip;q=0` 表示显式拒绝）与 `*` 通配；
 * 缺失或 q=0 的编码不进入候选，由调用方回退到未压缩原文。
 */
function negotiateEncoding(header: string | null): EncodingCandidate[] {
  if (!header) return [];

  const accepted = new Map<string, number>();
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;

    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) {
        const parsed = Number.parseFloat(match[1]);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    accepted.set(name, q);
  }

  const wildcard = accepted.get('*');
  const scoreOf = (name: string): number => {
    const explicit = accepted.get(name);
    if (explicit !== undefined) return explicit;
    return wildcard ?? 0;
  };

  // br 优先于 gzip：同等 q 值下压缩率明显更高（实测 vendor 块 149KB vs 185KB）
  return (
    [
      { encoding: 'br' as const, ext: '.br' },
      { encoding: 'gzip' as const, ext: '.gz' },
    ] satisfies EncodingCandidate[]
  )
    .map((candidate) => ({ candidate, q: scoreOf(candidate.encoding) }))
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.candidate);
}

/** 旁路压缩文件是否存在且非空 */
async function compressedVariant(filePath: string, ext: string): Promise<string | null> {
  const candidate = `${filePath}${ext}`;
  try {
    const info = await stat(candidate);
    return info.isFile() && info.size > 0 ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * 读取 publicDir 下的文件并构造 Response。
 *
 * @param publicDir 前端产物根目录（绝对路径）
 * @param pathname  请求路径（如 /admin/assets/index-xxx.js）
 * @param basePath  需要剥离的路径前缀（如 /admin）
 * @param acceptEncoding 请求的 Accept-Encoding 头，用于选择预压缩变体
 * @returns 命中返回 Response，未命中或越界返回 null
 */
export async function serveStaticFile(
  publicDir: string,
  pathname: string,
  basePath: string,
  acceptEncoding: string | null = null,
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

    // 选择预压缩变体。旁路文件路径由已通过越界校验的 target 派生，天然在同一目录内。
    let filePath = target;
    let contentEncoding: string | null = null;
    const compressible = COMPRESSIBLE_EXT.has(path.extname(target).toLowerCase());
    if (compressible) {
      for (const candidate of negotiateEncoding(acceptEncoding)) {
        const variant = await compressedVariant(target, candidate.ext);
        if (variant) {
          filePath = variant;
          contentEncoding = candidate.encoding;
          break;
        }
      }
    }

    const body = await readFile(filePath);
    const isHashedAsset = /[.-][A-Za-z0-9_-]{8,}\./.test(path.basename(target));

    const headers: Record<string, string> = {
      // 内容类型取自原始文件：.br/.gz 只是传输编码，不改变载荷类型
      'content-type': contentTypeOf(target),
      'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (contentEncoding) headers['content-encoding'] = contentEncoding;
    // 同一 URL 存在多种编码变体，必须声明 Vary，否则中间层缓存
    // （前置 nginx / CDN）会把 br 变体错发给不支持 br 的客户端。
    if (compressible) headers.vary = 'Accept-Encoding';

    return new Response(body as unknown as BodyInit, { status: 200, headers });
  } catch {
    return null;
  }
}

/** 读取 SPA 入口 index.html。 */
export async function serveAppShell(
  publicDir: string,
  acceptEncoding: string | null = null,
): Promise<Response | null> {
  return serveStaticFile(publicDir, '/index.html', '/admin', acceptEncoding);
}
