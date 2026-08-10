/**
 * `exec_doc_type` 仓储（执行单据类型与签署要求属性，需求 16.2、16.4、16.5）。
 * 纯 SQL 读写封装。`code` 为主键（`code TEXT PRIMARY KEY`），无自增 `id`。
 *
 * ⚠ `sign_rule` 是需求 45.8「该单据至少配置一个签署项」判定的依据来源
 * （`SC` = '单据不签署，所发工卡步骤需签署'，其余为 '签署'）；本仓储只做取数，
 * 该判定逻辑归属服务层/领域层。
 */

import { getDb } from '../db/connection.js';
import { pickColumns } from './case-convert.js';

/** `exec_doc_type` 除 `code`（主键）外的全部列（snake_case）。 */
export const EXEC_DOC_TYPE_COLUMNS = Object.freeze(['name', 'sign_rule']);

function toWriteRow(input) {
  return pickColumns(input, EXEC_DOC_TYPE_COLUMNS);
}

/**
 * 按代码取一条单据类型行。
 * @param {string} code
 * @returns {{ code: string, name: string | null, signRule: string } | null}
 */
export function findByCode(code) {
  const row = getDb().prepare('SELECT * FROM exec_doc_type WHERE code = ?').get(code);
  if (row === undefined) return null;
  return { code: row.code, name: row.name, signRule: row.sign_rule };
}

/**
 * 取全部单据类型行，按 `code` 升序。
 * @returns {{ code: string, name: string | null, signRule: string }[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM exec_doc_type ORDER BY code ASC').all();
  return rows.map((row) => ({ code: row.code, name: row.name, signRule: row.sign_rule }));
}

/**
 * 新增一条单据类型行（config_write 维护）。
 * @param {{ code: string, name?: string | null, signRule: string }} entry
 * @returns {void}
 */
export function create(entry) {
  const row = toWriteRow(entry);
  const columns = ['code', ...Object.keys(row)];
  const placeholders = columns.map(() => '?').join(', ');
  getDb()
    .prepare(`INSERT INTO exec_doc_type (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(entry.code, ...Object.keys(row).map((column) => row[column]));
}

/**
 * 按代码更新一条单据类型行（部分更新）——主键列非 `id`，不复用 `case-convert.js`
 * 的 `updateRow`（该助手假定主键列为 `id`），此处直译等价 `UPDATE ... WHERE code = ?`。
 * @param {string} code
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(code, patch) {
  const row = toWriteRow(patch);
  const columns = Object.keys(row);
  if (columns.length === 0) return 0;
  const setClause = columns.map((column) => `${column} = ?`).join(', ');
  const info = getDb()
    .prepare(`UPDATE exec_doc_type SET ${setClause} WHERE code = ?`)
    .run(...columns.map((column) => row[column]), code);
  return info.changes;
}

export default { findByCode, list, create, update };
