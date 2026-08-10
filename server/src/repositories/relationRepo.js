/**
 * `card_relation` 仓储（需求 21.1–21.5、45.8、45.9、16.4、16.5）。纯 SQL 读写封装。
 *
 * 行构造（`origin` 推断、`key_info_snapshot` 序列化）属 `domain/relation.js` 的
 * `buildRelation`/`syncRelationKeyInfo` 职责；本仓储只接受已构造好的 camelCase 行落库，
 * 不重复推断。`key_info_snapshot` 出参解析为对象（复用领域层的 `readKeyInfoSnapshot`
 * 语义等价的解析结果），便于服务层直接消费。
 */

import { getDb } from '../db/connection.js';
import { parsePayload, serializePayload } from '../domain/collections.js';
import { insertRow, pickColumns, rowToCamel } from './case-convert.js';

export const CARD_RELATION_COLUMNS = Object.freeze([
  'card_id', 'exec_doc_type', 'related_doc_no', 'job_id', 'origin', 'key_info_snapshot',
  'created_by', 'created_at',
]);

function toWriteRow(input) {
  const row = pickColumns(input, CARD_RELATION_COLUMNS);
  if (row.key_info_snapshot !== undefined && typeof row.key_info_snapshot !== 'string') {
    row.key_info_snapshot = serializePayload(row.key_info_snapshot);
  }
  return row;
}

function toRelation(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  camel.keyInfoSnapshot = parsePayload(camel.keyInfoSnapshot);
  return camel;
}

/**
 * 新增一条工卡关联（通常传入 `domain/relation.js` 的 `buildRelation` 产出）。
 * @param {object} relation camelCase 关联行
 * @returns {number | bigint} 新增行 id
 */
export function create(relation) {
  return insertRow(getDb(), 'card_relation', toWriteRow(relation));
}

/**
 * 按主键删除一条关联。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM card_relation WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一条关联（`key_info_snapshot` 已解析回对象）。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM card_relation WHERE id = ?').get(id);
  return toRelation(row);
}

/**
 * 按三元组 `(card_id, exec_doc_type, related_doc_no)` 取一条关联（`UNIQUE` 对应的精确取数）。
 * @param {number | string} cardId
 * @param {string} execDocType
 * @param {string} relatedDocNo
 * @returns {object | null}
 */
export function findByTriple(cardId, execDocType, relatedDocNo) {
  const row = getDb()
    .prepare(
      'SELECT * FROM card_relation WHERE card_id = ? AND exec_doc_type = ? AND related_doc_no = ?',
    )
    .get(cardId, execDocType, relatedDocNo);
  return toRelation(row);
}

/**
 * 取某工卡的全部关联（需求 21.2），按 `id` 升序。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM card_relation WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(toRelation);
}

/**
 * 更新一条关联的关键信息快照（需求 21.5），传入已序列化或未序列化的对象皆可。
 * @param {number | string} id
 * @param {unknown} keyInfoSnapshot
 * @returns {number} 受影响行数
 */
export function updateKeyInfoSnapshot(id, keyInfoSnapshot) {
  const text = typeof keyInfoSnapshot === 'string' ? keyInfoSnapshot : serializePayload(keyInfoSnapshot);
  return getDb()
    .prepare('UPDATE card_relation SET key_info_snapshot = ? WHERE id = ?')
    .run(text, id).changes;
}

export default { create, remove, findById, findByTriple, listByCardId, updateKeyInfoSnapshot };
