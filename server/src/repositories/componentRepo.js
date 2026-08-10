/**
 * `inserted_component` 仓储（需求 13.1–13.3、18.1、18.2）。
 *
 * `payload` 列的序列化/解析**复用** `domain/collections.js` 的
 * `serializeComponent` / `parseComponent`（往返等价 + `step_id` 绑定关系保持，
 * Property 12 的落位），本仓储不手写 JSON 序列化。
 */

import { getDb } from '../db/connection.js';
import { parseComponent, serializeComponent } from '../domain/collections.js';
import { insertRow, updateRow } from './case-convert.js';

/** `serializeComponent` 产出行的全部列名（除 `id`），供 `INSERT`/`UPDATE` 使用。 */
const WRITE_COLUMNS = Object.freeze(['step_id', 'type', 'payload', 'sort_order']);

function toWriteRow(input) {
  const serialized = serializeComponent(input);
  const row = {};
  for (const column of WRITE_COLUMNS) row[column] = serialized[column];
  return row;
}

/**
 * 新增一个插入组件。
 * @param {object} component camelCase：`{ stepId, type, payload, sortOrder }`
 * @returns {number | bigint} 新增行 id
 */
export function create(component) {
  return insertRow(getDb(), 'inserted_component', toWriteRow(component));
}

/**
 * 按主键更新插入组件（整行覆盖式写入，与 {@link create} 同序列化管道）。
 * @param {number | string} id
 * @param {object} component
 * @returns {number} 受影响行数
 */
export function update(id, component) {
  return updateRow(getDb(), 'inserted_component', id, toWriteRow(component));
}

/**
 * 按主键删除一个插入组件。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM inserted_component WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一个插入组件（`payload` 已解析回对象）。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM inserted_component WHERE id = ?').get(id);
  return row === undefined ? null : parseComponent(row);
}

/**
 * 取某工序的全部插入组件，按 `sort_order` 升序（`payload` 已解析回对象）。
 * @param {number | string} stepId
 * @returns {object[]}
 */
export function listByStepId(stepId) {
  const rows = getDb()
    .prepare('SELECT * FROM inserted_component WHERE step_id = ? ORDER BY sort_order ASC, id ASC')
    .all(stepId);
  return rows.map(parseComponent);
}

export default { create, update, remove, findById, listByStepId };
