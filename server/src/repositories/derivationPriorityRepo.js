/**
 * `derivation_priority_config` 仓储（商务分类派生优先级链，需求 29.8）。纯 SQL 读写封装。
 *
 * ⚠⚠⚠ 本仓储是需求 29.8「改配置不改代码」的**运行时权威落点** ⚠⚠⚠
 *
 * `list()` / `listEnabled()` 的 SQL 语句**本身**带 `ORDER BY tier_order ASC`——顺序在
 * SQL 层就已确定，不依赖 JS 端二次排序，也不依赖行插入顺序。`domain/classification.js`
 * 的 `deriveCommercialClassification` 直接消费本仓储的返回结果作为判定顺序：
 * 改一行 `tier_order` 即改判定结果，业务方无需改代码或重启服务。
 *
 * `tier_order` 与 `tier_code` 均为 `UNIQUE`（schema.sql）：两层同序会使排序结果依赖
 * SQLite 内部实现，同一输入可能得不同分类（Property 23 派生确定性的数据层保障）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, rowsToCamel, toFlag, toIntOrNull, updateRow } from './case-convert.js';

/** `derivation_priority_config` 除 `id` 外的全部列（snake_case）。 */
export const DERIVATION_PRIORITY_COLUMNS = Object.freeze(['tier_code', 'tier_order', 'enabled']);

function toWriteRow(input) {
  const row = pickColumns(input, DERIVATION_PRIORITY_COLUMNS);
  if (row.tier_order !== undefined) row.tier_order = toIntOrNull(row.tier_order);
  if (row.enabled !== undefined) row.enabled = toFlag(row.enabled);
  return row;
}

/**
 * 按主键取一条层级配置行。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM derivation_priority_config WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按层级代码取一条配置行（`tier_code` UNIQUE）。
 * @param {string} tierCode
 * @returns {object | null}
 */
export function findByTierCode(tierCode) {
  const row = getDb().prepare('SELECT * FROM derivation_priority_config WHERE tier_code = ?').get(tierCode);
  return rowToCamel(row);
}

/**
 * 取全部层级配置行，**按 `tier_order` 升序**（运行时权威顺序，需求 29.8）。
 * @returns {object[]}
 */
export function list() {
  const rows = getDb()
    .prepare('SELECT * FROM derivation_priority_config ORDER BY tier_order ASC')
    .all();
  return rowsToCamel(rows);
}

/**
 * 取全部**启用**（`enabled = 1`）层级配置行，**按 `tier_order` 升序**——
 * `deriveCommercialClassification` 的直接输入形态之一（`priorityCfg.tiers`）。
 * @returns {object[]}
 */
export function listEnabled() {
  const rows = getDb()
    .prepare('SELECT * FROM derivation_priority_config WHERE enabled = 1 ORDER BY tier_order ASC')
    .all();
  return rowsToCamel(rows);
}

/**
 * 新增一条层级配置行（config_write 维护，需求 29.8）。
 * @param {object} entry camelCase：`{ tierCode, tierOrder, enabled }`
 * @returns {number | bigint} 新增行 id
 */
export function create(entry) {
  return insertRow(getDb(), 'derivation_priority_config', toWriteRow(entry));
}

/**
 * 按主键更新一条层级配置行（部分更新，含调整 `tier_order` 重排序）。
 * @param {number | string} id
 * @param {object} patch
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  return updateRow(getDb(), 'derivation_priority_config', id, toWriteRow(patch));
}

/**
 * 按主键删除一条层级配置行。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM derivation_priority_config WHERE id = ?').run(id).changes;
}

/**
 * 重排序：按入参数组顺序批量重写 `tier_order`（`1..N`，同一事务内完成）。
 *
 * `tier_order` 带 `UNIQUE` 约束，逐行 `UPDATE` 若中途撞到目标顺序与现有顺序交叉的行会
 * 触发约束冲突，故先将全部涉及行的 `tier_order` 平移至一个不与任何现有值冲突的临时区间
 * （加上行数总和的偏移量），再回写为最终的 `1..N`，两阶段均在同一事务内完成。
 *
 * @param {ReadonlyArray<{ id: number | string, tierOrder: number }>} orderings
 *   `[{ id, tierOrder }, …]`；未出现在入参中的行保持原 `tier_order` 不变。
 * @returns {number} 受影响行数
 */
export function reorder(orderings) {
  const list_ = Array.isArray(orderings) ? orderings : [];
  if (list_.length === 0) return 0;
  const db = getDb();
  return db.transaction(() => {
    const offset = list_.length + 1000;
    for (const { id } of list_) {
      db.prepare('UPDATE derivation_priority_config SET tier_order = tier_order + ? WHERE id = ?').run(offset, id);
    }
    let changes = 0;
    for (const { id, tierOrder } of list_) {
      changes += db
        .prepare('UPDATE derivation_priority_config SET tier_order = ? WHERE id = ?')
        .run(toIntOrNull(tierOrder), id).changes;
    }
    return changes;
  })();
}

export default { findById, findByTierCode, list, listEnabled, create, update, remove, reorder };
