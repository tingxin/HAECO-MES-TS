/**
 * `supersede_record` 仓储（版本取代关系，需求 44.1、44.2、44.8）。
 * 纯 SQL 读写封装：不校验、不带默认值、不调用领域函数。
 *
 * ⚠ 键为 `task_no` 而非 `card_id`：取代关系描述的是**同一编号下两个版本**的关系，不填作废
 * 原因、不走作废流程（需求 44.3）。批准服务须在**同一事务**内、按「①原生效版本降级为
 * Superseded 并写本表 → ②本版本置 Effective 并写 `review_record`」的固定顺序执行
 * （Property 25），本仓储只负责落库，不实现该顺序约束（服务层职责）。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `supersede_record` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const SUPERSEDE_RECORD_COLUMNS = Object.freeze([
  'task_no', 'superseded_revision', 'superseding_revision', 'superseded_at',
]);

function toWriteRow(input) {
  const row = pickColumns(input, SUPERSEDE_RECORD_COLUMNS);
  if (row.superseded_revision !== undefined) row.superseded_revision = toIntOrNull(row.superseded_revision);
  if (row.superseding_revision !== undefined) row.superseding_revision = toIntOrNull(row.superseding_revision);
  return row;
}

function toRecord(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.supersededRevision !== undefined) camel.supersededRevision = toIntOrNull(camel.supersededRevision);
  if (camel.supersedingRevision !== undefined) camel.supersedingRevision = toIntOrNull(camel.supersedingRevision);
  return camel;
}

/**
 * 新增一条版本取代记录（批准事务内、原生效版本降级为 Superseded 时写入）。
 * @param {object} record camelCase：`{ taskNo, supersededRevision, supersedingRevision, supersededAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(record) {
  return insertRow(getDb(), 'supersede_record', toWriteRow(record));
}

/**
 * 按主键取一条取代记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM supersede_record WHERE id = ?').get(id);
  return toRecord(row);
}

/**
 * 取某工卡编号（跨全部版本）的取代记录，按 `id` 升序（即取代发生的时间顺序）。
 * @param {string} taskNo
 * @returns {object[]}
 */
export function listByTaskNo(taskNo) {
  const rows = getDb()
    .prepare('SELECT * FROM supersede_record WHERE task_no = ? ORDER BY id ASC')
    .all(taskNo);
  return rows.map(toRecord);
}

/**
 * 取某工卡编号（跨全部版本）的取代记录。别名沿用任务说明的 `listByCardId` 命名，
 * 实参与 {@link listByTaskNo} 相同（`supersede_record` 无 `card_id` 列，键为 `task_no`）。
 * @param {string} taskNo
 * @returns {object[]}
 */
export function listByCardId(taskNo) {
  return listByTaskNo(taskNo);
}

export default { create, findById, listByTaskNo, listByCardId };
