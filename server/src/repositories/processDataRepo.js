/**
 * `process_data` 仓储（Process Data mock，需求 27.1、27.2、30.1）。
 *
 * ⚠⚠⚠ read-only, no write methods, per design.md integration contract constraint ⚠⚠⚠
 * 本仓储代表外部系统（Process Data）数据，本模块只读，无写端点：`part_no`/`part_sn`/
 * `part_desc`/`operation_type`/`operation` 任何角色皆不可经编制界面人工写入
 * （需求 27.3、30.2）。`GET /api/process-data?pid=&cardId=&stepId=` 的数据源，一次返回
 * 五项：前四项落 `job` 表（两域分离，需求 27.5，写入在 `jobRepo.js`），`operation`
 * 供工序只读展示（需求 30.1，写入在 `processStepRepo.js`）——本仓储只做取数，两处写入
 * 均与本仓储无关。`pid_no`/`card_id` 为软引用（不建外键）。本仓储不提供任何
 * create/update/remove/insert 导出。
 */

import { getDb } from '../db/connection.js';
import { rowToCamel, rowsToCamel } from './case-convert.js';

/**
 * 按主键取一条 Process Data 行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM process_data WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按 PID 取 Process Data 行（可能多行：卡级 `step_ref IS NULL` 一行 + 各工序行）。
 * @param {string} pidNo
 * @returns {object[]}
 */
export function findByPidNo(pidNo) {
  const rows = getDb().prepare('SELECT * FROM process_data WHERE pid_no = ? ORDER BY id ASC').all(pidNo);
  return rowsToCamel(rows);
}

/**
 * 按工卡取 Process Data 行（可能多行）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function findByCardId(cardId) {
  const rows = getDb().prepare('SELECT * FROM process_data WHERE card_id = ? ORDER BY id ASC').all(cardId);
  return rowsToCamel(rows);
}

/**
 * 取某 PID/工卡/工序组合的 Process Data 行（需求 27.1、27.2、30.1 一次返回五项的取数入口）：
 * `stepRef` 为 `null` 或未提供时取卡级行（`step_ref IS NULL`），否则精确匹配该工序。
 * @param {string | null} pidNo
 * @param {number | string | null} cardId
 * @param {string | null} [stepRef] `process_step.process_id`；缺省取卡级行
 * @returns {object | null}
 */
export function findOne(pidNo, cardId, stepRef) {
  const db = getDb();
  const hasStepRef = stepRef !== null && stepRef !== undefined;

  if (pidNo !== null && pidNo !== undefined && cardId !== null && cardId !== undefined) {
    const row = hasStepRef
      ? db.prepare('SELECT * FROM process_data WHERE pid_no = ? AND card_id = ? AND step_ref = ?').get(pidNo, cardId, stepRef)
      : db.prepare('SELECT * FROM process_data WHERE pid_no = ? AND card_id = ? AND step_ref IS NULL').get(pidNo, cardId);
    if (row !== undefined) return rowToCamel(row);
  }
  if (cardId !== null && cardId !== undefined) {
    const row = hasStepRef
      ? db.prepare('SELECT * FROM process_data WHERE card_id = ? AND step_ref = ?').get(cardId, stepRef)
      : db.prepare('SELECT * FROM process_data WHERE card_id = ? AND step_ref IS NULL').get(cardId);
    if (row !== undefined) return rowToCamel(row);
  }
  if (pidNo !== null && pidNo !== undefined) {
    const row = hasStepRef
      ? db.prepare('SELECT * FROM process_data WHERE pid_no = ? AND step_ref = ?').get(pidNo, stepRef)
      : db.prepare('SELECT * FROM process_data WHERE pid_no = ? AND step_ref IS NULL').get(pidNo);
    if (row !== undefined) return rowToCamel(row);
  }
  return null;
}

/**
 * 取全部 Process Data 行，按 `id` 升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM process_data ORDER BY id ASC').all();
  return rowsToCamel(rows);
}

export default { findById, findByPidNo, findByCardId, findOne, list };
