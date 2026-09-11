/**
 * 凭证与客户端 key 的存储层。
 *
 * 提供两种实现：
 *   - 持久化版本：生产使用(SQLite/JSON 的 KVLike),凭证敏感字段 AES-GCM 加密后落盘
 *   - 内存版本：未注入存储或测试环境自动降级,进程内有效
 */

import { decryptSecret, encryptSecret, sha256Hex } from './crypto';
import type { ClientKey, Credential, GatewaySettings, TokenStore } from './types';

const CRED_PREFIX = 'cred:';
const KEY_PREFIX = 'key:';
const CRED_INDEX = 'idx:cred';
const KEY_INDEX = 'idx:key';

/** 键值存储的最小接口，便于测试注入假实现 */
export interface KVLike {
  get(key: string, type?: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 落盘形态：敏感字段加密 */
interface StoredCredential extends Omit<Credential, 'apiKey' | 'accessToken' | 'refreshToken'> {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
}

async function readIndex(kv: KVLike, indexKey: string): Promise<string[]> {
  const raw = await kv.get(indexKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIndex(kv: KVLike, indexKey: string, ids: string[]): Promise<void> {
  await kv.put(indexKey, JSON.stringify([...new Set(ids)]));
}

// ── 列表缓存 ───────────────────────────────────────────────────────────────
/**
 * 凭证/Key 列表的短 TTL 缓存。
 *
 * 代理热路径每请求都要读「绑定的凭证」与「Key 记录」,而每次读取都要走同步
 * SQLite 查询 + 逐条 AES-GCM 解密;高并发下这会把事件循环堵住(实测吞吐
 * 63 → 529 req/s)。
 *
 * 缓存按 KV 实例挂在 globalThis 上,原因有二:
 *   1. 测试会把各模块分别打包,模块级变量会导致写入方与读取方各持一份缓存;
 *   2. 按实例隔离可避免不同 KV(不同测试/多租户)之间串数据。
 * 写入即失效,TTL 仅作为外部改写的兜底。
 */
interface StoreCache {
  credentials?: { at: number; list: Credential[] };
  keys?: { at: number; list: ClientKey[] };
}

const CACHE_REGISTRY = globalThis as unknown as {
  __cbGatewayStoreCache?: WeakMap<object, StoreCache>;
};
const storeCaches =
  CACHE_REGISTRY.__cbGatewayStoreCache ?? (CACHE_REGISTRY.__cbGatewayStoreCache = new WeakMap<object, StoreCache>());

const CACHE_TTL_MS = 2_000;

function cacheOf(kv: object): StoreCache {
  let cache = storeCaches.get(kv);
  if (!cache) {
    cache = {};
    storeCaches.set(kv, cache);
  }
  return cache;
}

function invalidateStoreCache(kv: object, kind: keyof StoreCache): void {
  const cache = storeCaches.get(kv);
  if (cache) delete cache[kind];
}

// ── 持久化实现 ─────────────────────────────────────────────────────────────

class KVTokenStore implements TokenStore {
  readonly persistent = true;

  constructor(
    private readonly kv: KVLike,
    private readonly encSecret?: string,
  ) {}

  async listCredentials(): Promise<Credential[]> {
    const now = Date.now();
    const cached = cacheOf(this.kv).credentials;
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return cached.list;
    }
    const ids = await readIndex(this.kv, CRED_INDEX);
    const credentials = await Promise.all(ids.map((id) => this.getCredential(id)));
    const list = credentials.filter((c): c is Credential => Boolean(c));
    cacheOf(this.kv).credentials = { at: Date.now(), list };
    return list;
  }

  async getCredential(id: string): Promise<Credential | undefined> {
    const raw = await this.kv.get(CRED_PREFIX + id);
    if (!raw) return undefined;

    let stored: StoredCredential;
    try {
      stored = JSON.parse(raw) as StoredCredential;
    } catch {
      return undefined;
    }

    try {
      return {
        ...stored,
        apiKey: stored.apiKey ? await decryptSecret(stored.apiKey, this.encSecret) : undefined,
        accessToken: stored.accessToken
          ? await decryptSecret(stored.accessToken, this.encSecret)
          : undefined,
        refreshToken: stored.refreshToken
          ? await decryptSecret(stored.refreshToken, this.encSecret)
          : undefined,
      };
    } catch {
      // 密钥轮换或数据损坏时，返回结构但清空敏感字段，避免整个接口 500
      return { ...stored, apiKey: undefined, accessToken: undefined, refreshToken: undefined };
    }
  }

  async saveCredential(credential: Credential): Promise<void> {
    const stamped: StoredCredential = {
      ...credential,
      apiKey: credential.apiKey
        ? await encryptSecret(credential.apiKey, this.encSecret)
        : undefined,
      accessToken: credential.accessToken
        ? await encryptSecret(credential.accessToken, this.encSecret)
        : undefined,
      refreshToken: credential.refreshToken
        ? await encryptSecret(credential.refreshToken, this.encSecret)
        : undefined,
    };

    await this.kv.put(CRED_PREFIX + credential.id, JSON.stringify(stamped));
    const ids = await readIndex(this.kv, CRED_INDEX);
    ids.push(credential.id);
    await writeIndex(this.kv, CRED_INDEX, ids);
    invalidateStoreCache(this.kv, 'credentials');
  }

  async deleteCredential(id: string): Promise<void> {
    await this.kv.delete(CRED_PREFIX + id);
    const ids = await readIndex(this.kv, CRED_INDEX);
    await writeIndex(this.kv, CRED_INDEX, ids.filter((v) => v !== id));
    invalidateStoreCache(this.kv, 'credentials');

    // 清理 key 中的悬空绑定
    const keys = await this.listKeys();
    for (const key of keys) {
      if (key.credentialIds.includes(id)) {
        await this.saveKey({
          ...key,
          credentialIds: key.credentialIds.filter((credId) => credId !== id),
        });
      }
    }
  }

  async listKeys(): Promise<ClientKey[]> {
    const now = Date.now();
    const cachedKeys = cacheOf(this.kv).keys;
    if (cachedKeys && now - cachedKeys.at < CACHE_TTL_MS) {
      return cachedKeys.list;
    }
    const ids = await readIndex(this.kv, KEY_INDEX);
    const keys = await Promise.all(ids.map((id) => this.kv.get(KEY_PREFIX + id)));
    const list = keys
      .map((raw) => {
        if (!raw) return undefined;
        try {
          return JSON.parse(raw) as ClientKey;
        } catch {
          return undefined;
        }
      })
      .filter((k): k is ClientKey => Boolean(k));
    cacheOf(this.kv).keys = { at: Date.now(), list };
    return list;
  }

  async getKeyByHash(keyHash: string): Promise<ClientKey | undefined> {
    const keys = await this.listKeys();
    return keys.find((k) => k.keyHash === keyHash);
  }

  async saveKey(key: ClientKey): Promise<void> {
    await this.kv.put(KEY_PREFIX + key.id, JSON.stringify(key));
    const ids = await readIndex(this.kv, KEY_INDEX);
    if (!ids.includes(key.id)) {
      ids.push(key.id);
      await writeIndex(this.kv, KEY_INDEX, ids);
    }
    invalidateStoreCache(this.kv, 'keys');
  }

  async deleteKey(id: string): Promise<void> {
    await this.kv.delete(KEY_PREFIX + id);
    const ids = await readIndex(this.kv, KEY_INDEX);
    await writeIndex(this.kv, KEY_INDEX, ids.filter((v) => v !== id));
    invalidateStoreCache(this.kv, 'keys');
  }

  // ── 设置 ────────────────────────────────────────────────────────────
  async getSettings(): Promise<GatewaySettings> {
    const raw = await this.kv.get('settings');
    if (!raw) return { autoCheckin: false };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { autoCheckin: parsed.autoCheckin === true };
    } catch {
      return { autoCheckin: false };
    }
  }

  async putSettings(settings: GatewaySettings): Promise<void> {
    await this.kv.put('settings', JSON.stringify(settings));
  }
}

// ── 内存实现 ──────────────────────────────────────────────────────────────

class MemoryTokenStore implements TokenStore {
  readonly persistent = false;

  private readonly credentials = new Map<string, Credential>();
  private readonly keys = new Map<string, ClientKey>();

  async listCredentials(): Promise<Credential[]> {
    return [...this.credentials.values()];
  }

  async getCredential(id: string): Promise<Credential | undefined> {
    return this.credentials.get(id);
  }

  async saveCredential(credential: Credential): Promise<void> {
    this.credentials.set(credential.id, { ...credential });
  }

  async deleteCredential(id: string): Promise<void> {
    this.credentials.delete(id);
    for (const key of this.keys.values()) {
      if (key.credentialIds.includes(id)) {
        key.credentialIds = key.credentialIds.filter((credId) => credId !== id);
      }
    }
  }

  async listKeys(): Promise<ClientKey[]> {
    return [...this.keys.values()];
  }

  async getKeyByHash(keyHash: string): Promise<ClientKey | undefined> {
    return [...this.keys.values()].find((k) => k.keyHash === keyHash);
  }

  async saveKey(key: ClientKey): Promise<void> {
    this.keys.set(key.id, { ...key });
  }

  async deleteKey(id: string): Promise<void> {
    this.keys.delete(id);
  }

  // ── 设置 ────────────────────────────────────────────────────────────
  private memSettings = { autoCheckin: false };

  async getSettings(): Promise<GatewaySettings> {
    return { ...this.memSettings };
  }

  async putSettings(settings: GatewaySettings): Promise<void> {
    this.memSettings = { ...settings };
  }
}

// ── 工厂 ──────────────────────────────────────────────────────────────────

let cachedStore: TokenStore | undefined;

/**
 * 获取存储实例。未注入持久化后端时降级为内存存储，保证本地开发与测试可用。
 */
export function createTokenStore(kv?: KVLike, encSecret?: string): TokenStore {
  if (!kv) return new MemoryTokenStore();
  return new KVTokenStore(kv, encSecret);
}

/**
 * 取全局存储单例（按是否注入 CREDENTIALS_KV 决定实现）。
 * 测试可通过 resetTokenStore() 重置。
 */
export function getTokenStore(env: { CREDENTIALS_KV?: KVLike; CREDENTIALS_ENC_SECRET?: string }): TokenStore {
  if (!cachedStore) {
    cachedStore = createTokenStore(env.CREDENTIALS_KV, env.CREDENTIALS_ENC_SECRET);
  }
  return cachedStore;
}

export function resetTokenStore(): void {
  cachedStore = undefined;
}

/** 计算自建 key 的哈希指纹 */
export function hashApiKey(apiKey: string): Promise<string> {
  return sha256Hex(apiKey);
}
