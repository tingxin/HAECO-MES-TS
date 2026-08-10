/**
 * `bom_base_output` 仓储（需求 48.3–48.8）。纯 SQL 读写封装。
 * `source`（`ir_card` / `lot_list`）区分来源，当前不去重（见《临时设计说明》A6），
 * 汇总逻辑属 `domain/bom.js` 的 `aggregateBomBase`。
 */

import { getDb } from '../db/connection.js';
import { applyFlags, insertRow, pickColumns, rowToCamel, toIntOrNull, updateRow } from './case-convert.js';

export const BOM_BASE_OUTPUT_COLUMNS = Object.freeze([
  'card_id', 'base_number', 'source', 'lot_number', 'upper_part_name', 'is_lru',
]);

const FLAG_COLUMNS = Object.freeze(['is_lru']);

function toWriteRow(input) {
  const row = pickColumns(input, BOM_BASE_OUTPUT_COLUMNS);
  applyFlags(row, FLAG_COLUMNS);
  return row;
}

function toOutput(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.isLru !== undefined) camel.isLru = toIntOrNull(camel.isLru);
  return camel;
}

/**
 * 新增一条 BOM Base 输出行。
 * @param {object} output camelCase：`{ cardId, baseNumber, source, lotNumber, upperPartName, isLru }`
 * @returns {number | bigint} 新增行 id
 */
export function create(output) {
  return insertRow(getDb(), 'bom_base_output', toWriteRow(output));
}

/**
 * 按主键更新一条 BOM Base 输出行（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'bom_base_output', id, toWriteRow(patch));
}

/**
 * 按主键删除一条 BOM Base 输出行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM bom_base_output WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一条 BOM Base 输出行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM bom_base_output WHERE id = ?').get(id);
  return toOutput(row);
}

/**
 * 取某工卡的全部 BOM Base 输出行，按 `id` 升序。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM bom_base_output WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(toOutput);
}

export default { create, update, remove, findById, listByCardId };
