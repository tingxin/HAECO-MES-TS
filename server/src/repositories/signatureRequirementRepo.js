/**
 * `signature_requirement` 仓储（需求 45.1–45.6）。纯 SQL 读写封装。
 *
 * 工卡下全部工序本表记录的并集即需求 32.4「必需签署项」的唯一来源
 * （由 `domain/signature.js` 的 `aggregateSignatureRequirements` 在服务层聚合，
 * 本仓储只提供按工序取数与增删改）。
 */

import { getDb } from '../db/connection.js';
import { applyFlags, insertRow, pickColumns, rowToCamel, toIntOrNull, updateRow } from './case-convert.js';

export const SIGNATURE_REQUIREMENT_COLUMNS = Object.freeze([
  'step_id', 'signature_role', 'stamp_required', 'date_required', 'sort_order',
]);

const FLAG_COLUMNS = Object.freeze(['stamp_required', 'date_required']);

function toWriteRow(input) {
  const row = pickColumns(input, SIGNATURE_REQUIREMENT_COLUMNS);
  applyFlags(row, FLAG_COLUMNS);
  return row;
}

function toRequirement(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.stampRequired !== undefined) camel.stampRequired = toIntOrNull(camel.stampRequired);
  if (camel.dateRequired !== undefined) camel.dateRequired = toIntOrNull(camel.dateRequired);
  return camel;
}

/**
 * 新增一条工序级签署项。
 * @param {object} requirement camelCase：`{ stepId, signatureRole, stampRequired, dateRequired, sortOrder }`
 * @returns {number | bigint} 新增行 id
 */
export function create(requirement) {
  return insertRow(getDb(), 'signature_requirement', toWriteRow(requirement));
}

/**
 * 按主键更新签署项（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'signature_requirement', id, toWriteRow(patch));
}

/**
 * 按主键删除一条签署项。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM signature_requirement WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一条签署项。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM signature_requirement WHERE id = ?').get(id);
  return toRequirement(row);
}

/**
 * 取某工序的全部签署项，按 `sort_order` 升序。
 * @param {number | string} stepId
 * @returns {object[]}
 */
export function listByStepId(stepId) {
  const rows = getDb()
    .prepare('SELECT * FROM signature_requirement WHERE step_id = ? ORDER BY sort_order ASC, id ASC')
    .all(stepId);
  return rows.map(toRequirement);
}

/**
 * 取某工卡（跨全部工序）的签署项并集（需求 32.4「必需签署项」来源），按 `step_id` 关联。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare(
      `SELECT sr.* FROM signature_requirement sr
         JOIN process_step ps ON ps.id = sr.step_id
        WHERE ps.card_id = ?
        ORDER BY ps.seq ASC, sr.sort_order ASC, sr.id ASC`,
    )
    .all(cardId);
  return rows.map(toRequirement);
}

export default { create, update, remove, findById, listByStepId, listByCardId };
