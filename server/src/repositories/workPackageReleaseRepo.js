/**
 * `work_package_release` 仓储（发布至工包的结果记录，需求 24.1–24.3）。
 * 纯 SQL 读写封装：不校验、不带默认值、不调用领域函数。
 *
 * ⚠ `result NOT NULL`（DB 层兜底）落实需求 24.3、Property 15「无论成功与否均记录一次
 * 发布结果」——本仓储不判断发布是否应当成功，只负责将服务层给定的结果原样落库。
 * 本表同时是「作废前置校验」中「在编工包已选入」一类引用检查的数据来源之一（见
 * `domain/void-rules.js` 的 `checkVoidPrecondition`），但该业务判断在服务层完成，
 * 本仓储只提供 CRUD/读取。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `work_package_release` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const WORK_PACKAGE_RELEASE_COLUMNS = Object.freeze([
  'card_id', 'job_no', 'package_ref', 'released_at', 'result',
]);

function toWriteRow(input) {
  const row = pickColumns(input, WORK_PACKAGE_RELEASE_COLUMNS);
  if (row.card_id !== undefined) row.card_id = toIntOrNull(row.card_id);
  return row;
}

function toRelease(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.cardId !== undefined) camel.cardId = toIntOrNull(camel.cardId);
  return camel;
}

/**
 * 新增一条发布结果记录（无论成功或失败均落一行，需求 24.3）。
 * @param {object} release camelCase：`{ cardId, jobNo, packageRef, releasedAt, result }`
 * @returns {number | bigint} 新增行 id
 */
export function create(release) {
  return insertRow(getDb(), 'work_package_release', toWriteRow(release));
}

/**
 * 按主键取一条发布结果记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM work_package_release WHERE id = ?').get(id);
  return toRelease(row);
}

/**
 * 取某工卡的全部发布结果记录，按 `id` 升序（即发布尝试的时间顺序）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM work_package_release WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(toRelease);
}

/**
 * 按关联 JOB 编号取发布结果记录（成功发布后回填 `job_no`；失败记录该列可为 `NULL`，
 * 不会被本查询命中）。
 * @param {string} jobNo
 * @returns {object[]}
 */
export function findByJobId(jobNo) {
  const rows = getDb()
    .prepare('SELECT * FROM work_package_release WHERE job_no = ? ORDER BY id ASC')
    .all(jobNo);
  return rows.map(toRelease);
}

export default { create, findById, listByCardId, findByJobId };
