/**
 * `stage_card_type_constraint` + `stage_crosscut` 仓储（需求 46.9–46.14）。纯 SQL 读写封装。
 *
 * ⚠ 运行时权威：`domain/stage-constraint.js` 的 `validateStageCardType` / `defaultStageFor` /
 * `selectableStages` 一律消费本仓储 `list()` + `listCrosscut()` 归一化后的 `cfg`
 * （`normalizeStageConstraintConfig` 接受 `{ constraints, crosscut }` 形态），本仓储不做
 * 校验、不做默认值判定，只做取数与落库。
 *
 * `stage_crosscut` 为单列主键表（`stage TEXT PRIMARY KEY`），无自增 `id`；
 * `setCrosscut(stages)` 采用「整表替换」语义（同一事务内清空重插），
 * 与 `derivation_priority_config` 的逐行维护不同——横切取值是一个集合整体，
 * 业务方配置界面按「当前生效的横切取值集合」整体保存更符合需求 46.14「配置化」的直觉。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, toFlag, updateRow } from './case-convert.js';

/** `stage_card_type_constraint` 除 `id` 外的全部列（snake_case）。 */
export const STAGE_CONSTRAINT_COLUMNS = Object.freeze(['card_type', 'allowed_stage', 'is_auto_fill']);

function toWriteRow(input) {
  const row = pickColumns(input, STAGE_CONSTRAINT_COLUMNS);
  if (row.is_auto_fill !== undefined) row.is_auto_fill = toFlag(row.is_auto_fill);
  return row;
}

// =====================================================================
// stage_card_type_constraint：Stage × 工卡类型允许组合
// =====================================================================

/**
 * 按主键取一条约束行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM stage_card_type_constraint WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 取某工卡类型的允许 Stage 组合行（需求 46.9）。
 * @param {string} cardType
 * @returns {object[]}
 */
export function listByCardType(cardType) {
  const rows = getDb()
    .prepare('SELECT * FROM stage_card_type_constraint WHERE card_type = ? ORDER BY id ASC')
    .all(cardType);
  return rowsToCamel(rows);
}

/**
 * 取全部约束行（运行时权威表全量，供 `normalizeStageConstraintConfig` 归一化）。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb().prepare('SELECT * FROM stage_card_type_constraint ORDER BY card_type ASC, id ASC').all();
  return rowsToCamel(rows);
}

/**
 * 新增一条约束行（config_write 维护，需求 46.14）。
 * @param {object} entry camelCase：`{ cardType, allowedStage, isAutoFill }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'stage_card_type_constraint', toWriteRow(entry));
}

/**
 * 按主键更新一条约束行（部分更新）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'stage_card_type_constraint', id, toWriteRow(patch));
}

/**
 * 按主键删除一条约束行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM stage_card_type_constraint WHERE id = ?').run(id).changes;
}

// =====================================================================
// stage_crosscut：横切 Stage 取值
// =====================================================================

/**
 * 取全部横切 Stage 取值，按字典序升序。
 * @returns {string[]}
 */
export function listCrosscut() {
  const rows = getDb().prepare('SELECT stage FROM stage_crosscut ORDER BY stage ASC').all();
  return rows.map((row) => row.stage);
}

/**
 * 整表替换横切取值集合（需求 46.13、46.14）：同一事务内清空重插，
 * 使「当前生效的横切取值集合」与入参 `stages` 恰好一致（去重、忽略非字符串项）。
 * @param {ReadonlyArray<string>} stages
 * @returns {string[]} 落库后的横切取值集合（同 {@link listCrosscut}）
 */
export function setCrosscut(stages) {
  const unique = [...new Set((Array.isArray(stages) ? stages : []).filter((s) => typeof s === 'string'))];
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM stage_crosscut').run();
    const insert = db.prepare('INSERT INTO stage_crosscut (stage) VALUES (?)');
    for (const stage of unique) insert.run(stage);
  })();
  return listCrosscut();
}

export default {
  findById,
  listByCardType,
  list,
  create,
  update,
  remove,
  listCrosscut,
  setCrosscut,
};
