/**
 * `task_no_sequence` 仓储（批量复制的编号规则与流水，需求 38.8、38.9）。纯 SQL 读写封装。
 *
 * ⚠ 跳号策略在**领域层**，不在本仓储：`domain/task-no.js` 的 `generateTaskNoBatch` 依
 * `rule`（`{ prefix, suffix, next_seq, step }`）与调用方给定的 `existing`（现存全部
 * `task_card.task_no`）纯函数式算出一批不冲突的编号，并返回 `nextSeq`（下次起始序号）。
 * 本仓储只负责：
 * ① 取规则行（`peek`/`findByAffix`/`list`）供服务层拼出 `existing` 集合并调用
 *    `generateTaskNoBatch`；
 * ② 落库推进 `next_seq`（`allocate`）——服务层拿到 `generateTaskNoBatch` 的返回后，
 *    须调用 `allocate(id, result.nextSeq)` 才算完成一次批量取号的持久化，否则并发或
 *    重试会重复分配同一段序号。
 *
 * 「跳过已占用编号」不是本仓储的职责：本仓储不知道 `task_card` 表的存在，`existing`
 * 查重集合完全由服务层组装并传给 `domain/task-no.js`。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, toIntOrNull, updateRow } from './case-convert.js';

/** `task_no_sequence` 除 `id` 外的全部列（snake_case）。 */
export const TASK_NO_SEQUENCE_COLUMNS = Object.freeze(['prefix', 'suffix', 'next_seq', 'step']);

function toWriteRow(input) {
  const row = pickColumns(input, TASK_NO_SEQUENCE_COLUMNS);
  if (row.next_seq !== undefined) row.next_seq = toIntOrNull(row.next_seq);
  if (row.step !== undefined) row.step = toIntOrNull(row.step);
  return row;
}

function toRule(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.nextSeq !== undefined) camel.nextSeq = toIntOrNull(camel.nextSeq);
  if (camel.step !== undefined) camel.step = toIntOrNull(camel.step);
  return camel;
}

/**
 * 按主键取一条编号规则行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM task_no_sequence WHERE id = ?').get(id);
  return toRule(row);
}

/**
 * 按 `(prefix, suffix)` 取一条编号规则行（`UNIQUE` 对应的精确取数）。
 * @param {string} prefix
 * @param {string} suffix
 * @returns {object | null}
 */
export function findByAffix(prefix, suffix) {
  const row = getDb()
    .prepare('SELECT * FROM task_no_sequence WHERE prefix = ? AND suffix = ?')
    .get(prefix ?? '', suffix ?? '');
  return toRule(row);
}

/**
 * 查看（不推进）一条编号规则当前状态——`peek(id)` 语义等价 `findById(id)`，
 * 命名区别在于调用侧意图：仅查看当前 `next_seq` 而不打算落库推进。
 * @param {number | string} id
 * @returns {object | null}
 */
export function peek(id) {
  return findById(id);
}

/**
 * 取全部编号规则行，按 `id` 升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM task_no_sequence ORDER BY id ASC').all();
  return rows.map(toRule);
}

/**
 * 新增一条编号规则行（config_write 维护，需求 38.8）。
 * @param {object} entry camelCase：`{ prefix, suffix, nextSeq, step }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'task_no_sequence', toWriteRow(entry));
}

/**
 * 按主键更新一条编号规则行（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'task_no_sequence', id, toWriteRow(patch));
}

/**
 * 按主键删除一条编号规则行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM task_no_sequence WHERE id = ?').run(id).changes;
}

/**
 * 推进流水：将 `next_seq` 落库为给定值（`generateTaskNoBatch` 返回的 `nextSeq`，
 * 需求 38.8、38.9）——服务层完成一次批量取号后调用本方法持久化推进结果。
 * @param {number | string} id
 * @param {number} nextSeq
 * @returns {number} 受影响行数
 */
export function allocate(id, nextSeq) {
  return updateRow(getDb(), 'task_no_sequence', id, { next_seq: toIntOrNull(nextSeq) });
}

export default { findById, findByAffix, peek, list, create, update, remove, allocate };
