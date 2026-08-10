/**
 * `role_permission` 仓储（角色 × 权限点矩阵，需求 47.1–47.10、20.9）。纯 SQL 读写封装。
 *
 * 运行时权威：`domain/permission.js` 的 `checkPermission`/`explainPermission` 消费本仓储
 * `list()`/`listByRole()` 返回的行集，直接判定 `allowed`——本仓储不做授权判定，只做取数。
 * 种子写入的矩阵恒为 8 角色 × 13 权限点 = 104 行完整矩阵（`buildRolePermissionRows`，
 * `seed.js`），`UNIQUE (role, permission_point)` 保证同组合不重复登记。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, toFlag, updateRow } from './case-convert.js';

/** `role_permission` 除 `id` 外的全部列（snake_case）。 */
export const ROLE_PERMISSION_COLUMNS = Object.freeze(['role', 'permission_point', 'allowed']);

function toWriteRow(input) {
  const row = pickColumns(input, ROLE_PERMISSION_COLUMNS);
  if (row.allowed !== undefined) row.allowed = toFlag(row.allowed);
  return row;
}

/**
 * 按主键取一条权限矩阵行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM role_permission WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按 `(role, permission_point)` 取一条判定行（`UNIQUE` 对应的精确取数）。
 * @param {string} role
 * @param {string} permissionPoint
 * @returns {object | null}
 */
export function findByRoleAndPoint(role, permissionPoint) {
  const row = getDb()
    .prepare('SELECT * FROM role_permission WHERE role = ? AND permission_point = ?')
    .get(role, permissionPoint);
  return rowToCamel(row);
}

/**
 * 取某角色的全部权限点判定行（需求 `GET /api/me/permissions` 的数据源）。
 * @param {string} role
 * @returns {object[]}
 */
export function listByRole(role) {
  const rows = getDb()
    .prepare('SELECT * FROM role_permission WHERE role = ? ORDER BY permission_point ASC')
    .all(role);
  return rowsToCamel(rows);
}

/**
 * 取完整矩阵（默认 8×13=104 行），按角色、权限点升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb()
    .prepare('SELECT * FROM role_permission ORDER BY role ASC, permission_point ASC')
    .all();
  return rowsToCamel(rows);
}

/**
 * 新增一条权限矩阵行（config_write 维护，需求 47.1）。
 * @param {object} entry camelCase：`{ role, permissionPoint, allowed }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'role_permission', toWriteRow(entry));
}

/**
 * 按主键更新一条权限矩阵行（部分更新，通常用于切换 `allowed`）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'role_permission', id, toWriteRow(patch));
}

/**
 * 按主键删除一条权限矩阵行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM role_permission WHERE id = ?').run(id).changes;
}

export default { findById, findByRoleAndPoint, listByRole, list, create, update, remove };
