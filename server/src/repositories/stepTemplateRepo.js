/**
 * `step_template` 仓储（工序模板，需求 14.1、14.2）。纯 SQL 读写封装。
 *
 * `payload` 为工序内容全量 JSON（工序字段 + 采集项 + 插入组件），结构与
 * `job_step_snapshot.content` 同构（schema.sql 头注）。同 `execDocumentRepo.js` 对
 * `content` 的约定：`payload` **不解析、不重新序列化**——写入时若传入已解析对象才
 * 序列化，传入字符串则直接落列；读取时原样返回列取值（字符串），套用工序内容展开的
 * 反序列化由调用方（服务层）负责，本仓储不介入该形态转换。
 *
 * 需求 14.2「按工卡类型」检索：`step_template` 表本身**不含** `card_type` 列
 * （schema.sql 未定义），`listByCardType` 目前退化为 `list()` 的别名——工序模板当前
 * 不区分工卡类型，供批量套用（任务 18.3）按名称选择。若后续需要按类型筛选，需先在
 * schema.sql 补列，本仓储不臆造不存在的列。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, updateRow } from './case-convert.js';

/** `step_template` 除 `id` 外的全部列（snake_case）。 */
export const STEP_TEMPLATE_COLUMNS = Object.freeze(['name', 'payload']);

/** `payload` 传入已解析对象（非字符串）时序列化为 JSON 文本；字符串原样保留（见模块头注）。 */
function normalizePayload(value) {
  if (value === null || value === undefined || typeof value === 'string') return value;
  return JSON.stringify(value);
}

function toWriteRow(input) {
  const row = pickColumns(input, STEP_TEMPLATE_COLUMNS);
  if (row.payload !== undefined) row.payload = normalizePayload(row.payload);
  return row;
}

/**
 * 按主键取一条工序模板。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM step_template WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按模板名称取一条工序模板（`name` UNIQUE）。
 * @param {string} name
 * @returns {object | null}
 */
export function findByName(name) {
  const row = getDb().prepare('SELECT * FROM step_template WHERE name = ?').get(name);
  return rowToCamel(row);
}

/**
 * 取全部工序模板，按 `name` 升序（需求 14.2 选择套用列表）。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM step_template ORDER BY name ASC').all();
  return rowsToCamel(rows);
}

/**
 * 按工卡类型取可套用的工序模板列表（见模块头注：`step_template` 当前不区分工卡类型，
 * 本方法退化为 {@link list} 的别名，供任务 18.3 批量套用路由统一调用签名）。
 * @param {string} _cardType 当前未参与过滤（占位参数，保留调用签名以便后续扩展）
 * @returns {object[]}
 */
export function listByCardType(_cardType) {
  return list();
}

/**
 * 新增一条工序模板（需求 14.2「保存为可复用模板」）。
 * @param {object} entry camelCase：`{ name, payload }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'step_template', toWriteRow(entry));
}

/**
 * 按主键更新一条工序模板（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'step_template', id, toWriteRow(patch));
}

/**
 * 按主键删除一条工序模板。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM step_template WHERE id = ?').run(id).changes;
}

export default { findById, findByName, list, listByCardType, create, update, remove };
