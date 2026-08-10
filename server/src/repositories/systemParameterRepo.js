/**
 * `system_parameter` 仓储（系统参数，需求 35.1、35.2）。纯 SQL 读写封装。
 *
 * 键即主键（`key TEXT PRIMARY KEY`），无自增 `id`；`get`/`set` 直接以 `key` 定位，
 * 不复用 `case-convert.js` 的 `insertRow`/`updateRow`（两者假定主键列为 `id`）。
 */

import { getDb } from '../db/connection.js';

/**
 * 按键取参数值。
 * @param {string} key
 * @returns {string | null} 键不存在时返回 `null`
 */
export function get(key) {
  const row = getDb().prepare('SELECT value FROM system_parameter WHERE key = ?').get(key);
  return row === undefined ? null : row.value;
}

/**
 * 写入（新增或覆盖）一个参数键值（需求 35.1）。
 * @param {string} key
 * @param {string | null} value
 * @returns {void}
 */
export function set(key, value) {
  getDb()
    .prepare('INSERT INTO system_parameter (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value ?? null);
}

/**
 * 删除一个参数键。
 * @param {string} key
 * @returns {number} 受影响行数
 */
export function remove(key) {
  return getDb().prepare('DELETE FROM system_parameter WHERE key = ?').run(key).changes;
}

/**
 * 取全部系统参数，按 `key` 升序。
 * @returns {{ key: string, value: string | null }[]}
 */
export function list() {
  return getDb().prepare('SELECT * FROM system_parameter ORDER BY key ASC').all();
}

export default { get, set, remove, list };
