/**
 * 迁移仓储（`migration_batch` + `migration_record`，需求 41.4、41.5、17.1、17.2）。
 * 纯 SQL 读写封装：不校验、不带默认值、不调用领域函数。
 *
 * 两表职责分离：`migration_batch` 记批次头（来源通道/文件名与汇总计数），
 * `migration_record` 记逐条结果（成功/失败及失败原因分类）。逐条校验与报告汇总的唯一
 * 权威来源是 `domain/migrate-card.js` 的 `migrateRecords`（Property 32）：其产出的
 * `successCount`/`failureCount`/`records`/`byCategory` 由服务层落库为本仓储的批次头与
 * 逐条记录，本仓储不重新计算、不重新分类，只管落库与查询。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `migration_batch` 除 `id` 外的全部列（snake_case）。 */
export const MIGRATION_BATCH_COLUMNS = Object.freeze([
  'source_channel', 'source_name', 'total_count', 'success_count', 'failure_count',
  'executed_by', 'executed_at',
]);

/** `migration_record` 除 `id` 外的全部列（snake_case）。 */
export const MIGRATION_RECORD_COLUMNS = Object.freeze([
  'batch_id', 'row_no', 'source_task_no', 'card_id', 'status', 'failure_category', 'failure_reason',
]);

const BATCH_INT_COLUMNS = Object.freeze(['total_count', 'success_count', 'failure_count']);

function toBatchWriteRow(input) {
  const row = pickColumns(input, MIGRATION_BATCH_COLUMNS);
  for (const column of BATCH_INT_COLUMNS) {
    if (row[column] !== undefined) row[column] = toIntOrNull(row[column]);
  }
  return row;
}

function toBatch(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.totalCount !== undefined) camel.totalCount = toIntOrNull(camel.totalCount);
  if (camel.successCount !== undefined) camel.successCount = toIntOrNull(camel.successCount);
  if (camel.failureCount !== undefined) camel.failureCount = toIntOrNull(camel.failureCount);
  return camel;
}

function toRecordWriteRow(input) {
  const row = pickColumns(input, MIGRATION_RECORD_COLUMNS);
  if (row.batch_id !== undefined) row.batch_id = toIntOrNull(row.batch_id);
  if (row.row_no !== undefined) row.row_no = toIntOrNull(row.row_no);
  if (row.card_id !== undefined) row.card_id = toIntOrNull(row.card_id);
  return row;
}

function toRecord(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.batchId !== undefined) camel.batchId = toIntOrNull(camel.batchId);
  if (camel.rowNo !== undefined) camel.rowNo = toIntOrNull(camel.rowNo);
  if (camel.cardId !== undefined) camel.cardId = toIntOrNull(camel.cardId);
  return camel;
}

/**
 * 新增一条迁移批次头。
 * @param {object} batch camelCase：`{ sourceChannel, sourceName, totalCount, successCount,
 *   failureCount, executedBy, executedAt }`
 * @returns {number | bigint} 新增批次 id
 */
export function createBatch(batch) {
  return insertRow(getDb(), 'migration_batch', toBatchWriteRow(batch));
}

/**
 * 按主键取一条批次头。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findBatchById(id) {
  const row = getDb().prepare('SELECT * FROM migration_batch WHERE id = ?').get(id);
  return toBatch(row);
}

/**
 * 分页列出批次头，按 `id` 降序（最近批次在前）。
 * @param {{ page?: number, pageSize?: number }} [options]
 * @returns {{ list: object[], total: number, page: number, pageSize: number }}
 */
export function listBatches(options = {}) {
  const { page = 1, pageSize = 20 } = options;
  const safePage = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.trunc(Number(page)) : 1;
  const safePageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.trunc(Number(pageSize))
    : 20;
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS count FROM migration_batch').get().count;
  const rows = db
    .prepare('SELECT * FROM migration_batch ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(safePageSize, (safePage - 1) * safePageSize);
  return { list: rows.map(toBatch), total, page: safePage, pageSize: safePageSize };
}

/**
 * 新增一条迁移逐条结果。
 * @param {object} record camelCase：`{ batchId, rowNo, sourceTaskNo, cardId, status,
 *   failureCategory, failureReason }`
 * @returns {number | bigint} 新增行 id
 */
export function createRecord(record) {
  return insertRow(getDb(), 'migration_record', toRecordWriteRow(record));
}

/**
 * 批量新增迁移逐条结果（一个批次通常产出多条逐条记录；在**同一事务**内逐条插入，
 * 事务边界由调用方——服务层——负责）。
 * @param {ReadonlyArray<object>} records camelCase 记录数据集合
 * @returns {(number | bigint)[]} 新增行 id 集合，与入参顺序一致
 */
export function createRecords(records) {
  const list = Array.isArray(records) ? records : [];
  return list.map((record) => createRecord(record));
}

/**
 * 按主键取一条逐条结果。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findRecordById(id) {
  const row = getDb().prepare('SELECT * FROM migration_record WHERE id = ?').get(id);
  return toRecord(row);
}

/**
 * 取某批次的全部逐条结果，按 `row_no` 升序（源文件行号顺序）。
 * @param {number | string} batchId
 * @returns {object[]}
 */
export function listRecordsByBatchId(batchId) {
  const rows = getDb()
    .prepare('SELECT * FROM migration_record WHERE batch_id = ? ORDER BY row_no ASC, id ASC')
    .all(batchId);
  return rows.map(toRecord);
}

export default {
  createBatch,
  findBatchById,
  listBatches,
  createRecord,
  createRecords,
  findRecordById,
  listRecordsByBatchId,
};
