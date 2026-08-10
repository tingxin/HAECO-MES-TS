/**
 * `commercial_classification_result` 仓储（商务分类派生审计轨迹，需求 29.5、29.6）。
 * 纯 SQL 读写封装：不校验、不带默认值、不调用领域函数。
 *
 * ⚠⚠⚠ 本仓储**只写不改，无更新/删除方法（无 `update`/`remove` 导出）** ⚠⚠⚠
 *
 * 这不是遗漏，而是「追加式（append-only）审计轨迹」这一表定位的仓储层落实（对应
 * `jobStepSnapshotRepo.js` 的同类约定）：每次派生或人工确认都**追加**一行，不更新既有行，
 * 同一工卡因此可有多行历史。`task_card.commercial_classification` 是**另行同步**的当前
 * 权威值，其值恒等于本表最新一行（按追加顺序，即「最后一行」）的 `classification`——
 * 该同步是服务层职责（写工卡表 + 写本表须在同一事务内完成），本仓储只管追加与只读查询，
 * 不做同步、不做业务裁决。
 *
 * `classification` 允许为 `null`：类型 11 或同层多命中时不自动裁决，此行仅登记候选与
 * 待确认状态，由人工确认后再追加一行（`isManualConfirmed`/`confirmedBy`/`confirmedAt`）。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toFlag, toIntOrNull } from './case-convert.js';

/** `commercial_classification_result` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const CLASSIFICATION_RESULT_COLUMNS = Object.freeze([
  'card_id', 'classification', 'hit_tier', 'source_ref',
  'is_manual_confirmed', 'confirmed_by', 'confirmed_at', 'created_at',
]);

function toWriteRow(input) {
  const row = pickColumns(input, CLASSIFICATION_RESULT_COLUMNS);
  if (row.card_id !== undefined) row.card_id = toIntOrNull(row.card_id);
  if (row.is_manual_confirmed !== undefined) row.is_manual_confirmed = toFlag(row.is_manual_confirmed);
  return row;
}

function toResult(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.cardId !== undefined) camel.cardId = toIntOrNull(camel.cardId);
  if (camel.isManualConfirmed !== undefined) camel.isManualConfirmed = toIntOrNull(camel.isManualConfirmed);
  return camel;
}

/**
 * 追加一条商务分类派生（或人工确认）结果行。**无对应 `update`/`remove`**——
 * 修正既有结果的唯一合法路径是追加一条新行，而非就地改写旧行（见模块头注）。
 * @param {object} result camelCase：`{ cardId, classification, hitTier, sourceRef,
 *   isManualConfirmed, confirmedBy, confirmedAt, createdAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(result) {
  return insertRow(getDb(), 'commercial_classification_result', toWriteRow(result));
}

/**
 * 按主键取一条分类结果。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM commercial_classification_result WHERE id = ?').get(id);
  return toResult(row);
}

/**
 * 取某工卡的全部分类结果历史，按追加顺序（`id` 升序）——「最新」即数组最后一项。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM commercial_classification_result WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(toResult);
}

/**
 * 取某工卡**最新**一条分类结果（按追加顺序取最后一行，`task_card.commercial_classification`
 * 理应与其 `classification` 列同步）。
 * @param {number | string} cardId
 * @returns {object | null}
 */
export function findLatestByCardId(cardId) {
  const row = getDb()
    .prepare('SELECT * FROM commercial_classification_result WHERE card_id = ? ORDER BY id DESC LIMIT 1')
    .get(cardId);
  return toResult(row);
}

export default { create, findById, listByCardId, findLatestByCardId };
