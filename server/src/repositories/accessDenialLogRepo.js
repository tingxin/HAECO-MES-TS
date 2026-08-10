/**
 * `access_denial_log` 仓储（越权尝试审计，需求 47.10）。纯 SQL 读写封装。
 *
 * ⚠ 与 `change_record` 职责分离：本表记录**被拒绝的访问尝试**（无业务变更发生），
 * `change_record` 记录**已发生的业务变更**，两者不混用（见 schema.sql 表头注）。
 * 由权限中间件或 `config_write`/`capability_write` 等写端点在拒绝请求（403）时写入，
 * 本仓储不做权限判断，只负责落库与查询。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel } from './case-convert.js';

/** `access_denial_log` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const ACCESS_DENIAL_LOG_COLUMNS = Object.freeze([
  'staff_no', 'role', 'permission_point', 'method', 'path', 'denied_at',
]);

function toWriteRow(input) {
  return pickColumns(input, ACCESS_DENIAL_LOG_COLUMNS);
}

function toLog(row) {
  return rowToCamel(row);
}

/**
 * 新增一条越权尝试记录（权限中间件/写端点拒绝请求时写入）。
 * @param {object} log camelCase：`{ staffNo, role, permissionPoint, method, path, deniedAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(log) {
  return insertRow(getDb(), 'access_denial_log', toWriteRow(log));
}

/**
 * 按主键取一条越权尝试记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM access_denial_log WHERE id = ?').get(id);
  return toLog(row);
}

/**
 * 取某工号（尝试者）的全部越权尝试记录，按 `denied_at` 升序、同时间戳按 `id` 升序。
 * @param {string} staffNo
 * @returns {object[]}
 */
export function listByUserId(staffNo) {
  const rows = getDb()
    .prepare('SELECT * FROM access_denial_log WHERE staff_no = ? ORDER BY denied_at ASC, id ASC')
    .all(staffNo);
  return rows.map(toLog);
}

/**
 * 分页列出全部越权尝试记录，按 `id` 降序（最近尝试在前）。
 * @param {{ page?: number, pageSize?: number }} [options]
 * @returns {{ list: object[], total: number, page: number, pageSize: number }}
 */
export function listAll(options = {}) {
  const { page = 1, pageSize = 20 } = options;
  const safePage = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.trunc(Number(page)) : 1;
  const safePageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.trunc(Number(pageSize))
    : 20;
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS count FROM access_denial_log').get().count;
  const rows = db
    .prepare('SELECT * FROM access_denial_log ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(safePageSize, (safePage - 1) * safePageSize);
  return { list: rows.map(toLog), total, page: safePage, pageSize: safePageSize };
}

export default { create, findById, listByUserId, listAll };
