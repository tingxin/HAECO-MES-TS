/**
 * `capability_list` 仓储（能力清单，需求 39.1–39.4，QA_Engineer 维护）。纯 SQL 读写封装。
 *
 * 「当前生效版本」判定（需求 39.4）：`effective_from <= 校验日 AND (effective_to IS NULL
 * OR effective_to >= 校验日)`，同期多条取 `revision` 最大者——`effective_from`/`effective_to`
 * 为 `'YYYY-MM-DD'` 定宽 TEXT，字典序比较与时间序等价（同 `domain/capability.js` 模块头注）。
 *
 * ⚠ 该判定的**权威实现**在 `domain/capability.js` 的 `checkCapability`/`currentCapabilityRevision`
 * （纯函数，作用域无关，供服务层对任意子集复用）；本仓储的 `currentByScope` 只是同一判定的
 * SQL 直译版本，作为**只读查询便捷方法**存在（避免服务层每次都要先 `list()` 全表再在 JS
 * 端过滤），两者对同一输入必须给出一致结果——不得在本仓储引入与 `domain/capability.js`
 * 不同的第二套判定口径。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, toIntOrNull, updateRow } from './case-convert.js';

/** `capability_list` 除 `id` 外的全部列（snake_case）。 */
export const CAPABILITY_LIST_COLUMNS = Object.freeze([
  'ac_type', 'gear_type', 'skill', 'revision', 'effective_from', 'effective_to',
]);

function toWriteRow(input) {
  const row = pickColumns(input, CAPABILITY_LIST_COLUMNS);
  if (row.revision !== undefined) row.revision = toIntOrNull(row.revision);
  return row;
}

function toEntry(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.revision !== undefined) camel.revision = toIntOrNull(camel.revision);
  return camel;
}

/**
 * 按主键取一条能力清单行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM capability_list WHERE id = ?').get(id);
  return toEntry(row);
}

/**
 * 取全部能力清单行（供 `domain/capability.js` 的 `checkCapability` 全表输入）。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb()
    .prepare('SELECT * FROM capability_list ORDER BY ac_type ASC, gear_type ASC, skill ASC, revision ASC')
    .all();
  return rows.map(toEntry);
}

/**
 * 取某 (机型, 起落架类型, 专业) 三元组的全部版本行（含已过期/尚未生效），按 `revision` 升序。
 * @param {string} acType
 * @param {string} gearType
 * @param {string} skill
 * @returns {object[]}
 */
export function listByScope(acType, gearType, skill) {
  const rows = getDb()
    .prepare('SELECT * FROM capability_list WHERE ac_type = ? AND gear_type = ? AND skill = ? ORDER BY revision ASC')
    .all(acType, gearType, skill);
  return rows.map(toEntry);
}

/**
 * 取某三元组在给定日期的**当前有效版本**行（需求 39.4 的「选择当前生效版本」查询便捷方法）：
 * 生效期覆盖 `onDate` 且 `revision` 最大者；同一 SQL 语句内完成过滤与取最大值，
 * 无覆盖记录时返回 `null`。判定口径须与 `domain/capability.js` 的 `checkCapability` 一致
 * （字典序日期比较，`effective_to IS NULL` 视为长期有效）。
 * @param {string} acType
 * @param {string} gearType
 * @param {string} skill
 * @param {string} [onDate] `'YYYY-MM-DD'`；缺省取当日（SQLite `date('now')`）
 * @returns {object | null}
 */
export function currentByScope(acType, gearType, skill, onDate) {
  const date = typeof onDate === 'string' && onDate.trim() !== '' ? onDate : null;
  const row = getDb()
    .prepare(
      `SELECT * FROM capability_list
       WHERE ac_type = ? AND gear_type = ? AND skill = ?
         AND effective_from <= COALESCE(?, date('now'))
         AND (effective_to IS NULL OR effective_to >= COALESCE(?, date('now')))
       ORDER BY revision DESC
       LIMIT 1`,
    )
    .get(acType, gearType, skill, date, date);
  return toEntry(row);
}

/**
 * 新增一条能力清单行（QA_Engineer 维护，需求 39.1）。
 * @param {object} entry camelCase：`{ acType, gearType, skill, revision, effectiveFrom, effectiveTo }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'capability_list', toWriteRow(entry));
}

/**
 * 按主键更新一条能力清单行（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'capability_list', id, toWriteRow(patch));
}

/**
 * 按主键删除一条能力清单行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM capability_list WHERE id = ?').run(id).changes;
}

export default { findById, list, listByScope, currentByScope, create, update, remove };
