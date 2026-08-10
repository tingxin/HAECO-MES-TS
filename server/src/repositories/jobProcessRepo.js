/**
 * `job_process` 仓储（JOB 工序实例，需求 11.4、15.1–15.4、33.2–33.4、47.7）。
 * 纯 SQL 读写封装：不校验、不带默认值、不调用领域函数。
 *
 * ⚠ 条码只在执行域生成：`barcode_value` = `{JOB No}-{Process ID}`（`domain/barcode.js` 的
 *   `generateBarcode`），本仓储只做落库，不生成条码值。
 * ⚠ `step_id` 仅作**溯源引用**：JOB 的执行与呈现一律读 `job_step_snapshot.content`，
 *   本仓储不因 `step_id` 反查 `process_step` 当前内容（Property 34）。
 * ⚠ `effective_man_hours` / `actual_man_hours` 由 Production 报工写入，TS 编制界面不可写
 *   （需求 47.7）——闸门在服务层，本仓储只做落库。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import {
  insertRow,
  pickColumns,
  rowToCamel,
  toIntOrNull,
  updateRow,
} from './case-convert.js';

/** `job_process` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const JOB_PROCESS_COLUMNS = Object.freeze([
  'job_id', 'step_id', 'process_id', 'barcode_value', 'barcode_type',
  'start_time', 'finish_time', 'effective_man_hours', 'actual_man_hours',
]);

/** INTEGER 外键列，出入参保持原生数字语义。 */
const INT_COLUMNS = Object.freeze(['job_id', 'step_id']);

function toWriteRow(input) {
  const row = pickColumns(input, JOB_PROCESS_COLUMNS);
  for (const column of INT_COLUMNS) {
    if (row[column] !== undefined) row[column] = toIntOrNull(row[column]);
  }
  return row;
}

function toJobProcess(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.jobId !== undefined) camel.jobId = toIntOrNull(camel.jobId);
  if (camel.stepId !== undefined) camel.stepId = toIntOrNull(camel.stepId);
  return camel;
}

/**
 * 新增一条 JOB 工序实例（释放服务在同一事务内创建，本函数只做落库）。
 * @param {object} jobProcess camelCase 数据
 * @returns {number | bigint} 新增行 id
 */
export function create(jobProcess) {
  return insertRow(getDb(), 'job_process', toWriteRow(jobProcess));
}

/**
 * 按主键更新 JOB 工序实例（服务层负责报工写入的字段级校验，本函数只做落库）。
 * @param {number | string} id
 * @param {object} patch camelCase 待更新字段（未提供的字段不写入，即部分更新）
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'job_process', id, toWriteRow(patch));
}

/**
 * 按主键取一条 JOB 工序实例。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM job_process WHERE id = ?').get(id);
  return toJobProcess(row);
}

/**
 * 按 `(job_id, process_id)` 取一条 JOB 工序实例（`UNIQUE(job_id, process_id)` 对应的精确取数）。
 * @param {number | string} jobId
 * @param {string} processId
 * @returns {object | null}
 */
export function findByJobIdAndProcessId(jobId, processId) {
  const row = getDb()
    .prepare('SELECT * FROM job_process WHERE job_id = ? AND process_id = ?')
    .get(jobId, processId);
  return toJobProcess(row);
}

/**
 * 取某 JOB 的全部工序实例，按 `process_id` 升序。
 * @param {number | string} jobId
 * @returns {object[]}
 */
export function listByJobId(jobId) {
  const rows = getDb()
    .prepare('SELECT * FROM job_process WHERE job_id = ? ORDER BY process_id ASC, id ASC')
    .all(jobId);
  return rows.map(toJobProcess);
}

export default { create, update, findById, findByJobIdAndProcessId, listByJobId };
