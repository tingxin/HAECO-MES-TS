/**
 * `job` 仓储（执行域主表，工程释放生成）。纯 SQL 读写封装：不校验、不带默认值、
 * 不调用领域函数——闸门与业务规则属服务层（`jobService.js` 等）职责。
 *
 * ⚠ 两域分离（Property 31）：OWNER / JOB TARGET DATE / Check / 进厂·出厂 P/N·S/N /
 *   CSNo. / WORK ORDER 与 Process Card 四字段（PART No/S/N/DES./Operation Type）、
 *   `start_time` / `finish_time`（工卡级起止时间的唯一落位）**只落本表**，`task_card`
 *   一律不含；任何执行期写入都不得修改 `task_card` 行的任何字段（服务层职责，本仓储
 *   物理上不接触 `task_card` 表）。
 * ⚠ `owner` / `job_target_date` / `check_type` / 进出厂件号 / Process Card 四字段与工时聚合
 *   均为只读带出列（PPC 排产、Process Data 写入），编制界面不接受人工写入——闸门在服务层，
 *   本仓储只做落库。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 *
 * 需求：15.1, 15.2, 26.1–26.5, 27.1–27.5, 31.5–31.7, 32.2, 32.3, 33.1–33.6, 37.1–37.4, 49.5–49.7
 */

import { getDb } from '../db/connection.js';
import {
  insertRow,
  pickColumns,
  rowToCamel,
  toIntOrNull,
  updateRow,
} from './case-convert.js';

/** `job` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const JOB_COLUMNS = Object.freeze([
  'job_no', 'card_id', 'card_revision', 'pid_no', 'released_at', 'released_by',
  'owner', 'job_target_date', 'check_type', 'inbound_gear_pn', 'inbound_sn',
  'cs_no', 'work_order', 'outbound_gear_pn', 'part_no', 'part_sn', 'part_desc',
  'operation_type', 'start_time', 'finish_time', 'exec_status',
]);

/** INTEGER 外键/版本列，出入参保持原生数字语义。 */
const INT_COLUMNS = Object.freeze(['card_id', 'card_revision']);

function toWriteRow(input) {
  const row = pickColumns(input, JOB_COLUMNS);
  for (const column of INT_COLUMNS) {
    if (row[column] !== undefined) row[column] = toIntOrNull(row[column]);
  }
  return row;
}

function toJob(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.cardId !== undefined) camel.cardId = toIntOrNull(camel.cardId);
  if (camel.cardRevision !== undefined) camel.cardRevision = toIntOrNull(camel.cardRevision);
  return camel;
}

/**
 * 新增一条 JOB（释放服务在同一事务内创建 `job` / `job_process` / `job_step_snapshot` /
 * 条码，本函数只做落库）。
 * @param {object} job camelCase JOB 数据
 * @returns {number | bigint} 新增行 id
 */
export function create(job) {
  return insertRow(getDb(), 'job', toWriteRow(job));
}

/**
 * 按主键更新 JOB（服务层负责聚合工卡级 `start_time`/`finish_time`——由 `domain/times.js`
 * 的 `computeCardTimes` 算出后回写，本函数只做落库）。
 * @param {number | string} id
 * @param {object} patch camelCase 待更新字段（未提供的字段不写入，即部分更新）
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'job', id, toWriteRow(patch));
}

/**
 * 按主键取一条 JOB。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM job WHERE id = ?').get(id);
  return toJob(row);
}

/**
 * 按 `job_no` 取一条 JOB（`UNIQUE(job_no)` 对应的精确取数）。
 * @param {string} jobNo
 * @returns {object | null}
 */
export function findByJobNo(jobNo) {
  const row = getDb().prepare('SELECT * FROM job WHERE job_no = ?').get(jobNo);
  return toJob(row);
}

/**
 * 取某工卡（跨全部释放次数）的全部 JOB，按 `id` 升序。同一 Task Card 可多次释放，
 * 各自独立 `job_no`（需求 37.3）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM job WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(toJob);
}

export default { create, update, findById, findByJobNo, listByCardId };
