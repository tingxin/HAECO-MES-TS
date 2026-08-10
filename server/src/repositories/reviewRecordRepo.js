/**
 * `review_record` 仓储（按版本留存的审核记录，需求 34.6–34.9、34.11）。
 * 纯 SQL 读写封装：不校验、不带默认值、不调用领域函数。
 *
 * 记录挂在 `(card_id, card_revision)` 上而非仅 `card_id`：升版后新版本审核记录数从 0 起算
 * （需求 34.9、Property 19）。`comment` 由 schema `NOT NULL` 兜底必填（需求 34.11），本仓储
 * 不重复校验。既承接「提交审核」结果，也承接批准/驳回的审核动作（`action ∈ {approve, reject}`）。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `review_record` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const REVIEW_RECORD_COLUMNS = Object.freeze([
  'card_id', 'card_revision', 'action', 'reviewer', 'comment', 'reviewed_at',
]);

function toWriteRow(input) {
  const row = pickColumns(input, REVIEW_RECORD_COLUMNS);
  if (row.card_id !== undefined) row.card_id = toIntOrNull(row.card_id);
  if (row.card_revision !== undefined) row.card_revision = toIntOrNull(row.card_revision);
  return row;
}

function toRecord(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.cardId !== undefined) camel.cardId = toIntOrNull(camel.cardId);
  if (camel.cardRevision !== undefined) camel.cardRevision = toIntOrNull(camel.cardRevision);
  return camel;
}

/**
 * 新增一条审核记录（提交审核结果或批准/驳回动作均经此落库；不校验，`NOT NULL` 由 DB 层兜底）。
 * @param {object} record camelCase：`{ cardId, cardRevision, action, reviewer, comment, reviewedAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(record) {
  return insertRow(getDb(), 'review_record', toWriteRow(record));
}

/**
 * 按主键取一条审核记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM review_record WHERE id = ?').get(id);
  return toRecord(row);
}

/**
 * 取某工卡（跨全部版本）的审核记录，按 `card_revision` 升序、同版本内按 `id` 升序
 * （即时间顺序，供需求 34.9「新版本审核记录数从 0 起算」的按版本切片消费）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM review_record WHERE card_id = ? ORDER BY card_revision ASC, id ASC')
    .all(cardId);
  return rows.map(toRecord);
}

/**
 * 取某工卡某一版本的审核记录，按时间顺序（`id` 升序）。
 * @param {number | string} cardId
 * @param {number} cardRevision
 * @returns {object[]}
 */
export function listByCardRevision(cardId, cardRevision) {
  const rows = getDb()
    .prepare('SELECT * FROM review_record WHERE card_id = ? AND card_revision = ? ORDER BY id ASC')
    .all(cardId, toIntOrNull(cardRevision));
  return rows.map(toRecord);
}

export default { create, findById, listByCardId, listByCardRevision };
