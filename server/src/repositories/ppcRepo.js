/**
 * `ppc_process_data` 仓储（PPC 工作分类与预计工时 mock，需求 11.3、25.2）。
 *
 * ⚠⚠⚠ read-only, no write methods, per design.md integration contract constraint ⚠⚠⚠
 * 本仓储代表外部系统（PPC，生产计划控制部门）数据，本模块只读：写入归 PPC 专属界面，
 * TS 编制界面不得人工写入 `work_category`/`estimated_man_hours`（需求 47.4、47.5）。
 * `GET /api/ppc/process-data` 的数据源。`card_id`/`step_ref` 为软引用（不建外键，
 * schema.sql 分节 4 头注）。本仓储不提供任何 create/update/remove/insert 导出。
 */

import { getDb } from '../db/connection.js';
import { rowToCamel, rowsToCamel } from './case-convert.js';

/**
 * 按主键取一条 PPC 工序数据行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM ppc_process_data WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 取某工卡的全部 PPC 工序数据行（需求 11.3），按 `step_ref` 升序。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM ppc_process_data WHERE card_id = ? ORDER BY step_ref ASC')
    .all(cardId);
  return rowsToCamel(rows);
}

/**
 * 取某工卡某工序的 PPC 工作分类与预计工时（`(card_id, step_ref)` 精确取数）。
 * @param {number | string} cardId
 * @param {string} stepRef `process_step.process_id`
 * @returns {object | null}
 */
export function findByCardAndStep(cardId, stepRef) {
  const row = getDb()
    .prepare('SELECT * FROM ppc_process_data WHERE card_id = ? AND step_ref = ?')
    .get(cardId, stepRef);
  return rowToCamel(row);
}

/**
 * 取全部 PPC 工序数据行，按 `id` 升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM ppc_process_data ORDER BY id ASC').all();
  return rowsToCamel(rows);
}

export default { findById, listByCardId, findByCardAndStep, list };
