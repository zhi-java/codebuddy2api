/**
 * 加密与签名工具。
 *
 * 全部基于 Web Crypto（Node ≥18 原生），无第三方依赖：
 *   - SHA-256：自建 key 哈希（只存哈希，不存明文）
 *   - AES-GCM：上游凭证落盘加密
 *   - HMAC-SHA256：管理会话 cookie 签名（无状态会话）
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── 编码辅助 ──────────────────────────────────────────────────────────────

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * 将 Uint8Array 规整为独立 ArrayBuffer。
 * slice() 得到的视图底层可能带偏移量，Web Crypto 的类型签名要求纯 ArrayBuffer。
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

// ── 哈希 ──────────────────────────────────────────────────────────────────

/** 计算 SHA-256 十六进制摘要，用于自建 key 的指纹存储。 */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

// ── 常时比较 ──────────────────────────────────────────────────────────────

/**
 * 常时比较（恒定耗时），避免时序侧信道。
 * 注意：仅比较长度一致后的内容，长度差异本身不视为机密。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = enc;
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);

  let diff = bytesA.length ^ bytesB.length;
  const length = Math.max(bytesA.length, bytesB.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
}

// ── AES-GCM 加解密 ────────────────────────────────────────────────────────

/**
 * 由明文口令派生 AES-GCM 密钥。
 * 使用 SHA-256 派生固定长度密钥，兼容 KV 中存储的场景。
 */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM 加密，输出 base64url(iv + 密文)。密钥缺失时原样返回明文（本地开发降级）。 */
export async function encryptSecret(plaintext: string, secret?: string): Promise<string> {
  if (!secret) return plaintext;

  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));

  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return toBase64Url(packed.buffer);
}

/** AES-GCM 解密。密钥缺失时视为明文；解密失败抛出错误由调用方处理。 */
export async function decryptSecret(payload: string, secret?: string): Promise<string> {
  if (!secret) return payload;

  const key = await deriveAesKey(secret);
  const packed = fromBase64Url(payload);
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(cipher),
  );
  return dec.decode(plain);
}

// ── HMAC 会话签名 ─────────────────────────────────────────────────────────

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * 签发无状态会话票据：`base64url(payload).base64url(signature)`。
 * payload 为 `{exp}`，签名防止篡改。
 */
export async function signSession(
  expiresAt: number,
  secret: string,
): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify({ exp: expiresAt })));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}

/**
 * 校验会话票据：签名有效且未过期返回 true。
 */
export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!token) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  try {
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      toArrayBuffer(fromBase64Url(signature)),
      enc.encode(payload),
    );
    if (!valid) return false;

    const claims = JSON.parse(dec.decode(fromBase64Url(payload))) as { exp?: unknown };
    return typeof claims.exp === 'number' && claims.exp > Date.now();
  } catch {
    return false;
  }
}

// ── 随机 ID ───────────────────────────────────────────────────────────────

/** 生成带前缀的随机标识符，如 `cred_a1b2c3d4e5f6`。 */
export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${toHex(bytes.buffer)}`;
}

/**
 * 生成网关自建 API key 明文，形如 `sk-cb-<32字节随机>`。
 * 明文仅在创建响应中返回一次。
 */
export function generateApiKey(prefix = 'sk-cb'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}-${toBase64Url(bytes.buffer)}`;
}

/**
 * 从 JWT 载荷中解析 sub,作为上游需要的 X-User-Id。
 * 解析失败时返回 undefined,由调用方回退到随机值或省略该头。
 */
export function extractUserIdFromJwt(token: string): string | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;

  try {
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(dec.decode(fromBase64Url(padded))) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}
