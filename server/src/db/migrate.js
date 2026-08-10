/**
 * 建表 / 迁移脚本（任务 3.6）。
 *
 * ## 两种用法
 *
 * 1. **CLI**：`npm run migrate`（等价 `node src/db/migrate.js`）——在 `HAECO_MES_DB_PATH`
 *    或默认库文件 `<repo>/HAECO-MES-TS/data/haeco-mes-ts.db` 上建表并输出摘要。
 * 2. **可导入函数**：`migrate(connection)`——在**调用方给定的连接**上建表。属性测试与接口测试
 *    每次迭代用 `openDatabase(':memory:')` 重建库，随后 `migrate(conn)` + `seed(conn)`
 *    （design.md「测试策略」：事务/持久化属性在内存 SQLite 上逐次重建 schema 与 seed）。
 *
 * ## 为什么不直接读 schema.sql
 *
 * `schema.sql` 是**模板**，枚举 CHECK 写作 `{{CHECK:...}}` 占位符（design.md「枚举的单一
 * 事实来源」）。执行前必须经 `db/schema.js` 从 `domain/enums.js` 渲染，故本模块一律经
 * `applySchema()` / `buildSchemaSql()`，**不读取 schema.sql 原文**——直接执行模板会因
 * 占位符语法错误而失败，或（若被误改为可执行 SQL）造成枚举在 DDL 中二次手写。
 *
 * DDL 全部对象为 `IF NOT EXISTS`，故本脚本可重复执行（幂等）。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeDb, getDb, openDatabase, resolveDbPath } from './connection.js';
import { applySchema } from './schema.js';

/**
 * 在给定连接上执行完整 DDL。
 * @param {import('better-sqlite3').Database} [connection] 目标连接；缺省用进程级单例
 * @returns {import('better-sqlite3').Database} 同一连接，便于链式调用
 */
export function migrate(connection) {
  const conn = connection ?? getDb();
  applySchema(conn);
  return conn;
}

/** 列出库中已建立的表名（升序，排除 sqlite_ 内部表） */
export function listTables(connection) {
  return connection
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

/**
 * 独立执行一次迁移：按路径新开连接、建表、返回摘要后关闭连接。
 * 供 CLI 与「只想建库、不想持有连接」的调用方使用。
 * @param {{ dbPath?: string }} [options]
 * @returns {{ dbPath: string, tables: string[] }}
 */
export function runMigration(options = {}) {
  const dbPath = resolveDbPath(options.dbPath);
  const connection = openDatabase(dbPath);
  try {
    migrate(connection);
    return { dbPath, tables: listTables(connection) };
  } finally {
    connection.close();
  }
}

/** 本模块是否作为 CLI 入口被直接执行 */
function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isCliEntry()) {
  try {
    const { dbPath, tables } = runMigration();
    console.log(`[migrate] 数据库：${dbPath}`);
    console.log(`[migrate] 表数量：${tables.length}`);
    console.log('[migrate] 完成（DDL 幂等，可重复执行）');
  } catch (error) {
    console.error(`[migrate] 失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

export default migrate;
