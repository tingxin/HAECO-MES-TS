/**
 * `app_user` 仓储（最小用户主数据，需求 47.1、22.3、7.4）。纯 SQL 读写封装。
 *
 * ⚠ 不含口令列，本仓储亦不涉及任何认证逻辑（design.md §1.10）；`staff_no` UNIQUE 是
 * 全系统操作人标识的比较基准。当前仅需读取（会话选定、角色查询、一编一审比较），
 * 用户主数据的新增/停用维护未纳入本任务范围，故本仓储只提供查询方法。
 */

import { getDb } from '../db/connection.js';
import { rowToCamel, rowsToCamel } from './case-convert.js';

/**
 * 按主键取一个用户。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM app_user WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按工号取一个用户（`staff_no` UNIQUE，全系统操作人标识，需求 22.3、7.4）。
 * @param {string} staffNo
 * @returns {object | null}
 */
export function findByStaffNo(staffNo) {
  const row = getDb().prepare('SELECT * FROM app_user WHERE staff_no = ?').get(staffNo);
  return rowToCamel(row);
}

/**
 * 取全部启用（`is_active = 1`）用户，按 `staff_no` 升序。
 * @returns {object[]}
 */
export function listActive() {
  const rows = getDb()
    .prepare('SELECT * FROM app_user WHERE is_active = 1 ORDER BY staff_no ASC')
    .all();
  return rowsToCamel(rows);
}

/**
 * 取全部用户（含停用），按 `staff_no` 升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM app_user ORDER BY staff_no ASC').all();
  return rowsToCamel(rows);
}

export default { findById, findByStaffNo, listActive, list };
