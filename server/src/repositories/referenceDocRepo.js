/**
 * `reference_document` 仓储（需求 9.1–9.3）。纯 SQL 读写封装，无校验、无业务规则。
 *
 * 逻辑字段名沿用 `domain/collections.js` 的 `REFERENCE_DOC_FIELDS`（docType/refNo/
 * docRevision/ataChapter），此处只做行级 CRUD，集合增删的「不影响其它条目」语义已由
 * 该领域模块保证，服务层负责组合两者。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, updateRow } from './case-convert.js';

export const REFERENCE_DOC_COLUMNS = Object.freeze(['card_id', 'doc_type', 'ref_no', 'doc_revision', 'ata_chapter']);

function toWriteRow(input) {
  return pickColumns(input, REFERENCE_DOC_COLUMNS);
}

/**
 * 新增一条参考文件。
 * @param {object} doc camelCase：`{ cardId, docType, refNo, docRevision, ataChapter }`
 * @returns {number | bigint} 新增行 id
 */
export function create(doc) {
  return insertRow(getDb(), 'reference_document', toWriteRow(doc));
}

/**
 * 按主键更新参考文件（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'reference_document', id, toWriteRow(patch));
}

/**
 * 按主键删除一条参考文件。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM reference_document WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一条参考文件。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM reference_document WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 取某工卡的全部参考文件（需求 9.1–9.3），按 `id` 升序（插入顺序）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM reference_document WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(rowToCamel);
}

export default { create, update, remove, findById, listByCardId };
