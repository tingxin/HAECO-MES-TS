/**
 * `card_type_commercial_map` 仓储（工卡类型 → 商务分类映射，需求 43.1–43.5）。
 * 纯 SQL 读写封装——仅作派生优先级链的 **P6 兜底层**取数来源，本仓储不做裁决，
 * 多命中的裁决职责在 `domain/classification.js` 的 `deriveCommercialClassification`。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, updateRow } from './case-convert.js';

/** `card_type_commercial_map` 除 `id` 外的全部列（snake_case）。 */
export const COMMERCIAL_MAP_COLUMNS = Object.freeze(['card_type', 'commercial_classification']);

function toWriteRow(input) {
  return pickColumns(input, COMMERCIAL_MAP_COLUMNS);
}

/**
 * 按主键取一条映射行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM card_type_commercial_map WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 取某工卡类型的商务分类映射行（需求 43.1，类型 01/11 等多值场景返回多行）。
 * @param {string} cardType
 * @returns {object[]}
 */
export function listByCardType(cardType) {
  const rows = getDb()
    .prepare('SELECT * FROM card_type_commercial_map WHERE card_type = ? ORDER BY id ASC')
    .all(cardType);
  return rowsToCamel(rows);
}

/**
 * 取全部映射行（运行时权威表全量，供 `normalizeCardTypeMap` 归一化）。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM card_type_commercial_map ORDER BY card_type ASC, id ASC').all();
  return rowsToCamel(rows);
}

/**
 * 新增一条映射行（config_write 维护，需求 43.5）。
 * @param {object} entry camelCase：`{ cardType, commercialClassification }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'card_type_commercial_map', toWriteRow(entry));
}

/**
 * 按主键更新一条映射行（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'card_type_commercial_map', id, toWriteRow(patch));
}

/**
 * 按主键删除一条映射行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM card_type_commercial_map WHERE id = ?').run(id).changes;
}

export default { findById, listByCardType, list, create, update, remove };
