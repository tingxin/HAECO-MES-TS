/**
 * `process_step` 仓储（需求 10.1, 11.1–11.3, 12.1, 30.1, 30.2, 31.1–31.4）。
 * 纯 SQL 读写封装：不含条码列（属执行域 `job_process`），不做只读带出列
 * （`operation`/`work_category`/`estimated_man_hours`）的写入闸门——闸门在服务层。
 */

import { getDb } from '../db/connection.js';
import {
  applyFlags,
  insertRow,
  pickColumns,
  rowToCamel,
  toIntOrNull,
  updateRow,
} from './case-convert.js';

export const PROCESS_STEP_COLUMNS = Object.freeze([
  'card_id', 'process_id', 'seq', 'skill', 'ref_doc_id', 'operation', 'work_category',
  'estimated_man_hours', 'description_zh', 'description_en', 'safety_warning',
  'visual_cue', 'repair_tips', 'is_critical',
]);

const FLAG_COLUMNS = Object.freeze(['is_critical']);
const INT_COLUMNS = Object.freeze(['seq', 'ref_doc_id']);

function toWriteRow(input) {
  const row = pickColumns(input, PROCESS_STEP_COLUMNS);
  applyFlags(row, FLAG_COLUMNS);
  for (const column of INT_COLUMNS) {
    if (row[column] !== undefined) row[column] = toIntOrNull(row[column]);
  }
  if (row.visual_cue !== undefined && row.visual_cue !== null && typeof row.visual_cue !== 'string') {
    row.visual_cue = JSON.stringify(row.visual_cue);
  }
  return row;
}

function toStep(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.isCritical !== undefined) camel.isCritical = toIntOrNull(camel.isCritical);
  if (typeof camel.visualCue === 'string') {
    try {
      camel.visualCue = JSON.parse(camel.visualCue);
    } catch {
      // Preserve legacy plain-text values rather than failing reads.
    }
  }
  return camel;
}

/**
 * 新增一道工序。
 * @param {object} step camelCase 工序数据
 * @returns {number | bigint} 新增行 id
 */
export function create(step) {
  return insertRow(getDb(), 'process_step', toWriteRow(step));
}

/**
 * 按主键更新工序（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'process_step', id, toWriteRow(patch));
}

/**
 * 按主键删除一道工序（`ON DELETE CASCADE` 联动清除其下采集项/组件/签署项）。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM process_step WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一道工序。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM process_step WHERE id = ?').get(id);
  return toStep(row);
}

/**
 * 按 `(card_id, process_id)` 取一道工序（`UNIQUE(card_id, process_id)` 对应的精确取数）。
 * @param {number | string} cardId
 * @param {string} processId
 * @returns {object | null}
 */
export function findByCardAndProcessId(cardId, processId) {
  const row = getDb()
    .prepare('SELECT * FROM process_step WHERE card_id = ? AND process_id = ?')
    .get(cardId, processId);
  return toStep(row);
}

/**
 * 取某工卡的全部工序，按 `seq` 升序（需求 10.1）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM process_step WHERE card_id = ? ORDER BY seq ASC, id ASC')
    .all(cardId);
  return rows.map(toStep);
}

export default { create, update, remove, findById, findByCardAndProcessId, listByCardId };
