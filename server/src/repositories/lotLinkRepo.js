/**
 * `lot_list_link` 仓储（需求 48.1、48.2）。纯 SQL 读写封装。
 * IR Lot 卡（`card_type='05'`）与 Lot List 的关联，供 `domain/bom.js` 的
 * `aggregateBomBase` 汇总 BOM Base 输出时读取。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, updateRow } from './case-convert.js';

export const LOT_LIST_LINK_COLUMNS = Object.freeze(['card_id', 'lot_number', 'lot_list_ref']);

function toWriteRow(input) {
  return pickColumns(input, LOT_LIST_LINK_COLUMNS);
}

/**
 * 新增一条 Lot List 关联。
 * @param {object} link camelCase：`{ cardId, lotNumber, lotListRef }`
 * @returns {number | bigint} 新增行 id
 */
export function create(link) {
  return insertRow(getDb(), 'lot_list_link', toWriteRow(link));
}

/**
 * 按主键更新一条 Lot List 关联（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'lot_list_link', id, toWriteRow(patch));
}

/**
 * 按主键删除一条 Lot List 关联。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM lot_list_link WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一条 Lot List 关联。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM lot_list_link WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 取某工卡（类型 05）的全部 Lot List 关联，按 `id` 升序。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM lot_list_link WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(rowToCamel);
}

export default { create, update, remove, findById, listByCardId };
