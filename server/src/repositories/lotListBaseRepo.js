/**
 * `lot_list_base` 仓储（Lot List 所含 Base Number 集合 mock，需求 48.3、48.8）。
 *
 * ⚠⚠⚠ read-only, no write methods, per design.md integration contract constraint ⚠⚠⚠
 * 本仓储代表外部系统（Lot List / LT 单据主数据，归属独立模块，《临时设计说明》A6
 * 待澄清项 1）数据，本模块只读。`GET /api/lot-lists/:lotListRef/bases` 的数据源，为
 * `domain/bom.js` 的 `aggregateBomBase` 的 `lotLinks` 入参补齐 Base 值。不去重：
 * 同一 `lot_list_ref` 下多条 Base 并存，来源标识由 `bom_base_output.source` 承担
 * （写入在 `bomBaseRepo.js`，与本仓储无关）。本仓储不提供任何
 * create/update/remove/insert 导出。
 */

import { getDb } from '../db/connection.js';
import { rowToCamel, rowsToCamel } from './case-convert.js';

/**
 * 按主键取一条 Lot List Base 行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM lot_list_base WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 取某 Lot List 引用下的全部 Base 行（原始行形态，含 `lot_number`），按 `id` 升序。
 * @param {string} lotListRef
 * @returns {object[]}
 */
export function listByLotListRef(lotListRef) {
  const rows = getDb()
    .prepare('SELECT * FROM lot_list_base WHERE lot_list_ref = ? ORDER BY id ASC')
    .all(lotListRef);
  return rowsToCamel(rows);
}

/**
 * 取某 Lot List 引用下的 `[{ baseNumber, lotNumber }]` 精简形态（需求 48.3、48.8，
 * `aggregateBomBase` 的 `lotLinks` 入参补齐来源），按 `id` 升序，不去重。
 * @param {string} lotListRef
 * @returns {{ baseNumber: string, lotNumber: string | null }[]}
 */
export function listBasesByLotListRef(lotListRef) {
  const rows = getDb()
    .prepare('SELECT base_number, lot_number FROM lot_list_base WHERE lot_list_ref = ? ORDER BY id ASC')
    .all(lotListRef);
  return rows.map((row) => ({ baseNumber: row.base_number, lotNumber: row.lot_number }));
}

/**
 * 取全部 Lot List Base 行，按 `id` 升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM lot_list_base ORDER BY id ASC').all();
  return rowsToCamel(rows);
}

export default { findById, listByLotListRef, listBasesByLotListRef, list };
