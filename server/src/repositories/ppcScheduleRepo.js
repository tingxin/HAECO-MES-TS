/**
 * `ppc_schedule` 仓储（PPC 排产结果 mock，需求 26.4）。
 *
 * ⚠⚠⚠ read-only, no write methods, per design.md integration contract constraint ⚠⚠⚠
 * 本仓储代表外部系统（PPC 排产）数据，本模块只读。`GET /api/ppc/schedule?pid=&cardId=`
 * 的数据源；释放生成 JOB 时其 `job_target_date` 写入 `job.job_target_date`
 * （该写入落在 `jobRepo.js`，与本仓储无关）。取不到值时该列留空且**不阻断**释放
 * （需求 26.4），种子含故意缺 `pid_no` 的行以覆盖该分支。`pid_no`/`card_id` 为软引用
 * （不建外键）。本仓储不提供任何 create/update/remove/insert 导出。
 */

import { getDb } from '../db/connection.js';
import { rowToCamel, rowsToCamel } from './case-convert.js';

/**
 * 按主键取一条排产结果行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM ppc_schedule WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按 PID 取排产结果行（可能多行，按 `id` 升序）。
 * @param {string} pidNo
 * @returns {object[]}
 */
export function findByPidNo(pidNo) {
  const rows = getDb().prepare('SELECT * FROM ppc_schedule WHERE pid_no = ? ORDER BY id ASC').all(pidNo);
  return rowsToCamel(rows);
}

/**
 * 按工卡取排产结果行（可能多行，按 `id` 升序）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function findByCardId(cardId) {
  const rows = getDb().prepare('SELECT * FROM ppc_schedule WHERE card_id = ? ORDER BY id ASC').all(cardId);
  return rowsToCamel(rows);
}

/**
 * 取某 PID/工卡对应的 `job_target_date`（需求 26.1、26.4 释放生成 JOB 时的取数入口）：
 * 优先按 `(pid_no, card_id)` 精确匹配，其次退化为仅按 `pid_no` 或仅按 `card_id` 匹配
 * （两者均给出但只有一者命中时，仍应取到值而非直接判定取不到）。全部未命中返回 `null`
 * （不阻断释放，需求 26.4）。
 * @param {string | null} pidNo
 * @param {number | string | null} cardId
 * @returns {string | null}
 */
export function findJobTargetDate(pidNo, cardId) {
  const db = getDb();
  if (pidNo !== null && pidNo !== undefined && cardId !== null && cardId !== undefined) {
    const exact = db
      .prepare('SELECT job_target_date FROM ppc_schedule WHERE pid_no = ? AND card_id = ?')
      .get(pidNo, cardId);
    if (exact !== undefined) return exact.job_target_date ?? null;
  }
  if (pidNo !== null && pidNo !== undefined) {
    const byPid = db.prepare('SELECT job_target_date FROM ppc_schedule WHERE pid_no = ?').get(pidNo);
    if (byPid !== undefined) return byPid.job_target_date ?? null;
  }
  if (cardId !== null && cardId !== undefined) {
    const byCard = db.prepare('SELECT job_target_date FROM ppc_schedule WHERE card_id = ?').get(cardId);
    if (byCard !== undefined) return byCard.job_target_date ?? null;
  }
  return null;
}

/**
 * 取全部排产结果行，按 `id` 升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM ppc_schedule ORDER BY id ASC').all();
  return rowsToCamel(rows);
}

export default { findById, findByPidNo, findByCardId, findJobTargetDate, list };
