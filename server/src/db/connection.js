/**
 * SQLite 连接管理（better-sqlite3，同步驱动）。
 *
 * - 默认库文件：`<repo>/HAECO-MES-TS/data/haeco-mes-ts.db`（相对本模块解析，不依赖 process.cwd()）
 * - 环境变量 `HAECO_MES_DB_PATH` 可指向临时库文件或 `:memory:`，供属性测试与接口测试逐次重建
 * - 所有连接统一开启 `PRAGMA foreign_keys = ON`
 *
 * 导出：
 * - `getDb()` / `db`：进程级同步连接单例
 * - `openDatabase(path)`：新建独立连接（测试逐次重建用）
 * - `closeDb()` / `resetDb()`：关闭或重置单例
 * - `DEFAULT_DB_PATH` / `resolveDbPath()`：路径解析
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** server/ 目录（src/db → src → server） */
export const SERVER_ROOT = path.resolve(MODULE_DIR, '..', '..');

/** 项目根目录（server 的上一级），data/ 位于此处而非 server/ 下 */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

/** 默认数据目录与库文件 */
export const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'haeco-mes-ts.db');

/** 指定库路径的环境变量名 */
export const DB_PATH_ENV = 'HAECO_MES_DB_PATH';

/** 内存库标识 */
export const MEMORY_DB_PATH = ':memory:';

/** 是否为内存库（`:memory:` 或空串——better-sqlite3 视空串为匿名临时库） */
export function isMemoryPath(dbPath) {
  return dbPath === MEMORY_DB_PATH || dbPath === '';
}

/**
 * 解析实际使用的库路径。
 * 优先级：显式入参 > 环境变量 `HAECO_MES_DB_PATH` > 默认库文件。
 * 相对路径以项目根目录为基准解析，保证脚本在任意目录被调用时行为一致。
 */
export function resolveDbPath(explicitPath) {
  const raw =
    explicitPath !== undefined && explicitPath !== null
      ? explicitPath
      : process.env[DB_PATH_ENV];

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_DB_PATH;
  }

  const value = String(raw).trim();
  if (isMemoryPath(value)) return MEMORY_DB_PATH;

  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);
}

/** 按需创建库文件所在目录（内存库跳过） */
function ensureParentDir(dbPath) {
  if (isMemoryPath(dbPath)) return;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

/**
 * 新建一个独立的同步连接（不进入单例缓存）。
 * 测试可用 `openDatabase(':memory:')` 或临时文件路径逐次重建。
 */
export function openDatabase(dbPath, options = {}) {
  const target = resolveDbPath(dbPath);
  ensureParentDir(target);

  const connection = new Database(target, options);
  connection.pragma('foreign_keys = ON');
  return connection;
}

let singleton = null;
let singletonPath = null;

/** 获取进程级连接单例（首次调用时按当前解析路径建立） */
export function getDb() {
  if (singleton !== null && singleton.open) return singleton;

  const target = resolveDbPath();
  singleton = openDatabase(target);
  singletonPath = target;
  return singleton;
}

/** 当前单例所用库路径；尚未建立连接时返回 null */
export function getDbPath() {
  return singletonPath;
}

/** 关闭并清空单例（幂等） */
export function closeDb() {
  if (singleton !== null) {
    if (singleton.open) singleton.close();
    singleton = null;
    singletonPath = null;
  }
}

/**
 * 重置单例：关闭旧连接后按给定/当前解析路径重新建立。
 * 供属性测试与接口测试在每次迭代前重建数据库。
 */
export function resetDb(dbPath) {
  closeDb();
  const target = resolveDbPath(dbPath);
  singleton = openDatabase(target);
  singletonPath = target;
  return singleton;
}

/**
 * 默认导出的连接单例代理：`db.prepare(...)` 等调用会在首次访问时建立连接，
 * 且在 `resetDb()` 之后自动指向新连接，避免调用方持有失效引用。
 */
export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const instance = getDb();
      const value = instance[prop];
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    set(_target, prop, value) {
      getDb()[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in getDb();
    },
  },
);

export default db;
