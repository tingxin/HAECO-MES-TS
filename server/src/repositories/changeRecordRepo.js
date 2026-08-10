/**
 * `change_record` 仓储（变更记录，需求 19.1–19.3、20.8、42.5）。纯 SQL 读写封装。
 *
 * ⚠⚠⚠ 本仓储**只写不改，无更新/删除方法（无 `update`/`remove` 导出）** ⚠⚠⚠
 *
 * 这不是遗漏，而是变更留痕作为适航可追溯性核心证据这一定位的仓储层落实（对应
 * `jobStepSnapshotRepo.js` 的同类约定）：`change_record` 是全部编辑入口（保存、工序/参考
 * 文件删除、升版、批量替换、作废）共用的**唯一**审计轨迹，一旦写入即不可再改动或抹除，
 * 否则「变更历史可追溯」这一不变式（Property 35）就形同虚设。行内容的唯一合法构造点是
 * `domain/change-record.js` 的 `buildChangeRecords`——本仓储只负责将其产出的行原样落库，
 * 不做二次拼装、不做业务校验（`reason NOT NULL` 由 DB 层兜底）。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `change_record` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const CHANGE_RECORD_COLUMNS = Object.freeze([
  'card_id', 'card_revision', 'change_type', 'field', 'old_value', 'new_value',
  'reason', 'operator_id', 'timestamp',
]);

function toWriteRow(input) {
  const row = pickColumns(input, CHANGE_RECORD_COLUMNS);
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
 * 新增一条变更记录（`buildChangeRecords` 产出的单条记录行落库）。
 * @param {object} record camelCase：`{ cardId, cardRevision, changeType, field, oldValue,
 *   newValue, reason, operatorId, timestamp }`
 * @returns {number | bigint} 新增行 id
 */
export function create(record) {
  return insertRow(getDb(), 'change_record', toWriteRow(record));
}

/**
 * 批量新增变更记录（`buildChangeRecords` 一次通常产出多条记录，或批量替换逐卡各一条；
 * 在**同一事务**内逐条插入，事务边界由调用方——服务层——负责）。
 * @param {ReadonlyArray<object>} records camelCase 记录数据集合
 * @returns {(number | bigint)[]} 新增行 id 集合，与入参顺序一致
 */
export function createMany(records) {
  const list = Array.isArray(records) ? records : [];
  return list.map((record) => create(record));
}

/**
 * 按主键取一条变更记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM change_record WHERE id = ?').get(id);
  return toRecord(row);
}

/**
 * 取某工卡（跨全部版本）的变更记录，按 `id` 升序（即变更发生的时间顺序）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM change_record WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(toRecord);
}

/**
 * 取某工卡某一版本的变更记录，按 `id` 升序。
 * @param {number | string} cardId
 * @param {number} cardRevision
 * @returns {object[]}
 */
export function listByCardRevision(cardId, cardRevision) {
  const rows = getDb()
    .prepare('SELECT * FROM change_record WHERE card_id = ? AND card_revision = ? ORDER BY id ASC')
    .all(cardId, toIntOrNull(cardRevision));
  return rows.map(toRecord);
}

export default { create, createMany, findById, listByCardId, listByCardRevision };
