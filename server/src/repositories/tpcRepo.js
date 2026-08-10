/**
 * `tpc_document` 仓储（TPC 文档 mock，需求 7.3、25.1）。
 *
 * ⚠⚠⚠ read-only, no write methods, per design.md integration contract constraint ⚠⚠⚠
 * 本仓储代表外部系统（技术出版物中心）数据，本模块只读、无写端点（需求 7.3 归属独立流程
 * LGS-TS-07-01，见 requirements.md 模块边界声明）。`GET /api/tpc/documents` 的数据源；
 * 检索命中后回填 `task_card` 的四个只读列（`document_type`/`ref_no`/`document_revision`/
 * `document_desc`）——那四列的写入走 `taskCardRepo.js`，本仓储不提供任何
 * create/update/remove/insert 导出。
 */

import { getDb } from '../db/connection.js';
import { rowToCamel, rowsToCamel } from './case-convert.js';

/**
 * 按主键取一条 TPC 文档。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM tpc_document WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按参考号取 TPC 文档（可能多版本，按 `id` 升序）。
 * @param {string} refNo
 * @returns {object[]}
 */
export function findByRefNo(refNo) {
  const rows = getDb().prepare('SELECT * FROM tpc_document WHERE ref_no = ? ORDER BY id ASC').all(refNo);
  return rowsToCamel(rows);
}

/**
 * 按关键字检索（需求 25.1），`keyword` 列子串匹配（大小写不敏感）。
 * @param {string} keyword
 * @returns {object[]}
 */
export function searchByKeyword(keyword) {
  const rows = getDb()
    .prepare('SELECT * FROM tpc_document WHERE keyword LIKE ? COLLATE NOCASE ORDER BY id ASC')
    .all(`%${keyword}%`);
  return rowsToCamel(rows);
}

/**
 * 取全部 TPC 文档，按 `id` 升序。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM tpc_document ORDER BY id ASC').all();
  return rowsToCamel(rows);
}

export default { findById, findByRefNo, searchByKeyword, list };
