/**
 * `print_template` 仓储（打印模板，需求 40.1–40.4）。纯 SQL 读写封装。
 *
 * 模板**选用**（回退链 L1–L4）的判定逻辑在 `domain/print-template.js` 的
 * `selectPrintTemplate`——该函数消费本仓储 `list()` 返回的行集，本仓储不做选用判定。
 * `findByCardType`/`findDefault` 是常用查询的便捷方法，行为需与
 * `selectPrintTemplate` 的对应级别一致（精确匹配 / 默认模板），但不替代该函数的
 * 完整回退链（跨类目兜底仍须调用 `selectPrintTemplate(card, list())`）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, toFlag, updateRow } from './case-convert.js';

/** `print_template` 除 `id` 外的全部列（snake_case）。 */
export const PRINT_TEMPLATE_COLUMNS = Object.freeze([
  'target_kind', 'target_code', 'template_body', 'is_default',
]);

function toWriteRow(input) {
  const row = pickColumns(input, PRINT_TEMPLATE_COLUMNS);
  if (row.is_default !== undefined) row.is_default = toFlag(row.is_default);
  return row;
}

/**
 * 按主键取一条打印模板行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM print_template WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 取某工卡类型的专属模板行（`target_kind = 'card_type'`，需求 40.1、40.3）。
 * 同类型多行时（理论上不应有多条非默认专属行）按 `is_default` 降序、`id` 升序返回。
 * @param {string} cardType
 * @returns {object[]}
 */
export function findByCardType(cardType) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM print_template WHERE target_kind = 'card_type' AND target_code = ? ORDER BY is_default DESC, id ASC",
    )
    .all(cardType);
  return rowsToCamel(rows);
}

/**
 * 取某执行过程单据类型的专属模板行（`target_kind = 'exec_doc_type'`，需求 40.2）。
 * @param {string} execDocType
 * @returns {object[]}
 */
export function findByExecDocType(execDocType) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM print_template WHERE target_kind = 'exec_doc_type' AND target_code = ? ORDER BY is_default DESC, id ASC",
    )
    .all(execDocType);
  return rowsToCamel(rows);
}

/**
 * 取某类目（`card_type` / `exec_doc_type`）下的默认模板行（`is_default = 1`，
 * 部分唯一索引 `ux_print_template_default` 保证至多一条；需求 40.4）。
 * @param {'card_type' | 'exec_doc_type'} targetKind
 * @returns {object | null}
 */
export function findDefault(targetKind) {
  const row = getDb()
    .prepare('SELECT * FROM print_template WHERE target_kind = ? AND is_default = 1 LIMIT 1')
    .get(targetKind);
  return rowToCamel(row);
}

/**
 * 取全部打印模板行（供 `selectPrintTemplate` 的完整回退链输入）。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM print_template ORDER BY target_kind ASC, target_code ASC, id ASC').all();
  return rowsToCamel(rows);
}

/**
 * 新增一条打印模板行（config_write 维护，需求 40.1、40.2）。
 * @param {object} entry camelCase：`{ targetKind, targetCode, templateBody, isDefault }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'print_template', toWriteRow(entry));
}

/**
 * 按主键更新一条打印模板行（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'print_template', id, toWriteRow(patch));
}

/**
 * 按主键删除一条打印模板行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM print_template WHERE id = ?').run(id).changes;
}

export default {
  findById,
  findByCardType,
  findByExecDocType,
  findDefault,
  list,
  create,
  update,
  remove,
};
