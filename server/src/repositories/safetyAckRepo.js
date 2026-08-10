/**
 * `safety_acknowledgement` 仓储（关键工序安全警示查看确认，需求 31.5–31.7）。
 * 纯 SQL 读写封装：不校验、不带业务逻辑——门禁判定在 `domain/safety.js` 的
 * `canEnterExecution`，本仓储只提供确认记录的落库与查询。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `safety_acknowledgement` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const SAFETY_ACK_COLUMNS = Object.freeze([
  'job_process_id', 'acknowledged_by', 'acknowledged_at',
]);

function toWriteRow(input) {
  const row = pickColumns(input, SAFETY_ACK_COLUMNS);
  if (row.job_process_id !== undefined) row.job_process_id = toIntOrNull(row.job_process_id);
  return row;
}

function toAck(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.jobProcessId !== undefined) camel.jobProcessId = toIntOrNull(camel.jobProcessId);
  return camel;
}

/**
 * 新增一条安全警示查看确认记录。
 * @param {object} ack camelCase：`{ jobProcessId, acknowledgedBy, acknowledgedAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(ack) {
  return insertRow(getDb(), 'safety_acknowledgement', toWriteRow(ack));
}

/**
 * 按主键取一条确认记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM safety_acknowledgement WHERE id = ?').get(id);
  return toAck(row);
}

/**
 * 取某 JOB 工序实例的全部确认记录，按 `id` 升序（供 `canEnterExecution` 逐条匹配用户与完整性）。
 * @param {number | string} jobProcessId
 * @returns {object[]}
 */
export function listByJobProcessId(jobProcessId) {
  const rows = getDb()
    .prepare('SELECT * FROM safety_acknowledgement WHERE job_process_id = ? ORDER BY id ASC')
    .all(jobProcessId);
  return rows.map(toAck);
}

/**
 * 存在性判定：某用户对某 JOB 工序实例是否已有**完整**（含确认人与确认时间）确认记录
 * ——安全警示门禁的直接依据（需求 31.6、31.7）。
 * @param {number | string} jobProcessId
 * @param {string} userId 操作人员标识（工号），须与 `acknowledged_by` 同一口径
 * @returns {boolean}
 */
export function hasAck(jobProcessId, userId) {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM safety_acknowledgement
        WHERE job_process_id = ? AND acknowledged_by = ?
          AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL
        LIMIT 1`,
    )
    .get(jobProcessId, userId);
  return row !== undefined;
}

export default { create, findById, listByJobProcessId, hasAck };
