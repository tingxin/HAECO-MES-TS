/**
 * `capture_item` 仓储（需求 12.2、12.3）。
 *
 * `config` 列的序列化/解析**复用** `domain/collections.js` 的
 * `serializeCaptureItem` / `parseCaptureItem`（往返等价，Property 12 的落位），
 * 本仓储不手写 JSON 序列化。
 */

import { getDb } from '../db/connection.js';
import { parseCaptureItem, serializeCaptureItem } from '../domain/collections.js';
import { insertRow, updateRow } from './case-convert.js';

/** `serializeCaptureItem` 产出行的全部列名（除 `id`），供 `INSERT`/`UPDATE` 使用。 */
const WRITE_COLUMNS = Object.freeze(['step_id', 'type', 'item_key', 'label', 'config', 'required', 'sort_order']);

/** 从 `serializeCaptureItem` 产出中剔除 `id`（未提供的字段仍保留在写入行中，因为该函数总是补全全部字段）。 */
function toWriteRow(input) {
  const serialized = serializeCaptureItem(input);
  const row = {};
  for (const column of WRITE_COLUMNS) row[column] = serialized[column];
  return row;
}

/**
 * 新增一条数据采集项。
 * @param {object} item camelCase：`{ stepId, type, itemKey, label, config, required, sortOrder }`
 * @returns {number | bigint} 新增行 id
 */
export function create(item) {
  return insertRow(getDb(), 'capture_item', toWriteRow(item));
}

/**
 * 按主键更新数据采集项（整行覆盖式写入——`config` 等字段以 {@link serializeCaptureItem}
 * 的补全结果为准，与 `parseCaptureItem` 的往返约定一致）。
 * @param {number | string} id
 * @param {object} item
 * @returns {number} 受影响行数
 */
export function update(id, item) {
  return updateRow(getDb(), 'capture_item', id, toWriteRow(item));
}

/**
 * 按主键删除一条数据采集项。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM capture_item WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一条数据采集项（`config` 已解析回对象）。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM capture_item WHERE id = ?').get(id);
  return row === undefined ? null : parseCaptureItem(row);
}

/**
 * 取某工序的全部采集项，按 `sort_order` 升序（`config` 已解析回对象）。
 * @param {number | string} stepId
 * @returns {object[]}
 */
export function listByStepId(stepId) {
  const rows = getDb()
    .prepare('SELECT * FROM capture_item WHERE step_id = ? ORDER BY sort_order ASC, id ASC')
    .all(stepId);
  return rows.map(parseCaptureItem);
}

export default { create, update, remove, findById, listByStepId };
