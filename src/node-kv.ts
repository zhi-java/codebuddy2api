/**
 * Node.js 持久化存储(NodeKV)。
 *
 * 实现 store.ts 的 KVLike 接口,使现有 KVTokenStore
 * (前缀键、索引、AES-GCM 加密)可零改动直接复用。
 *
 * 后端策略:
 *   1. node:sqlite(Node ≥22.13 内置)→ 单表 key/value,最稳(推荐,Docker 内亦免编译)
 *   2. JSON 文件(无 SQLite 可用时降级,低频写入场景足够)
 *
 * 使用:
 *   const kv = createNodeKv({ file: process.env.DATA_FILE || './data/codebuddy.db' });
 *   const env = { CREDENTIALS_KV: kv, CREDENTIALS_ENC_SECRET: '...' };
 */

// ── Node 内置能力按需运行时加载 ──

interface FsLike {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string, enc: 'utf8'): void;
  renameSync(a: string, b: string): void;
}
interface PathLike {
  dirname(p: string): string;
}

function nodeFs(): FsLike {
  return require('node:fs') as FsLike;
}
function nodePath(): PathLike {
  return require('node:path') as PathLike;
}

import type { KVLike } from './store';

interface KvRow {
  k: string;
  v: string;
}

// ── SQLite 后端(node:sqlite 内置) ─────────────────────────────────────────

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** 尽力加载 node:sqlite(不同 Node 版本可能提示实验特性,仍可用) */
function loadSqlite(): { DatabaseSync: new (path: string) => unknown } | null {
  try {
    const mod = require('node:sqlite') as { DatabaseSync?: new (path: string) => unknown };
    if (typeof mod.DatabaseSync === 'function') return mod as { DatabaseSync: new (path: string) => unknown };
    return null;
  } catch {
    return null;
  }
}

function createSqliteKv(dbPath: string): KVLike {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('node:sqlite unavailable');

  if (dbPath !== ':memory:') {
    const fs = nodeFs();
    fs.mkdirSync(nodePath().dirname(dbPath), { recursive: true });
  }

  const db = new sqlite.DatabaseSync(dbPath) as unknown as SqliteDb;
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);

  const getStmt = db.prepare('SELECT v FROM kv WHERE k = ?');
  const putStmt = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  const delStmt = db.prepare('DELETE FROM kv WHERE k = ?');

  return {
    async get(key: string): Promise<string | null> {
      const row = getStmt.get(key) as { v?: unknown } | undefined;
      return row && typeof row.v === 'string' ? row.v : null;
    },
    async put(key: string, value: string): Promise<void> {
      putStmt.run(key, value);
    },
    async delete(key: string): Promise<void> {
      delStmt.run(key);
    },
  };
}

// ── JSON 文件后端(降级) ───────────────────────────────────────────────────

function createFileKv(filePath: string): KVLike {
  const loaded: Record<string, string> = {};
  let dirty = false;
  const fs = nodeFs();

  if (filePath !== ':memory:' && fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        Object.assign(loaded, parsed as Record<string, string>);
      }
    } catch {
      // 损坏文件忽略,从空开始
    }
  }

  const persist = (): void => {
    if (filePath === ':memory:' || !dirty) return;
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(nodePath().dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(loaded), 'utf8');
    fs.renameSync(tmp, filePath);
    dirty = false;
  };

  return {
    async get(key: string): Promise<string | null> {
      return Object.prototype.hasOwnProperty.call(loaded, key) ? loaded[key] : null;
    },
    async put(key: string, value: string): Promise<void> {
      loaded[key] = value;
      dirty = true;
      persist();
    },
    async delete(key: string): Promise<void> {
      delete loaded[key];
      dirty = true;
      persist();
    },
  };
}

// ── 工厂 ───────────────────────────────────────────────────────────────────

export interface NodeKvOptions {
  /** 存储路径:db 文件或 JSON 文件路径;':memory:' 内存 */
  file: string;
  /** 强制 JSON 文件后端(默认:SQLite 优先,失败降级) */
  preferFile?: boolean;
}

/**
 * 创建 Node KV 实例。
 * - .db 后缀 → SQLite;不可用时自动回退 JSON 文件(同路径 .json)
 * - 其它 → JSON 文件
 */
export function createNodeKv({ file, preferFile }: NodeKvOptions): KVLike {
  const isDb = file.endsWith('.db') || file.endsWith('.sqlite');
  if (isDb && !preferFile) {
    try {
      return createSqliteKv(file);
    } catch {
      // 降级 JSON
    }
  }
  return createFileKv(file);
}

/** 供类型检查/测试用 */
export type { KVLike };
export type { SqliteDb, KvRow };
