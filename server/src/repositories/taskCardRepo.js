/**
 * `task_card` 仓储（编制域主表）。纯 SQL 读写封装：不校验、不带默认值、不调用领域函数——
 * 那些是服务层（`taskCardService.js`）与领域层（`card-rules.js` 等）的职责。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。`revision` 出入参
 * 保持 **INTEGER**，两位补零展示是打印/导出层的职责，本仓储不做字符串填充。
 *
 * 需求：2.1, 2.2, 3.2, 3.5, 38.6, 38.7, 44.7
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

/** `task_card` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const TASK_CARD_COLUMNS = Object.freeze([
  'task_no', 'revision', 'title', 'date', 'ac_type', 'gear_type', 'stage', 'skill',
  'ctrl_code', 'card_type', 'is_fai', 'template_type', 'status', 'document_type',
  'ref_no', 'document_revision', 'document_desc', 'base_number', 'ipc_item_no',
  'created_by', 'reviewed_by', 'ndt_reviewer', 'ata_chapter', 'check_type',
  'commercial_classification', 'outsource_subtype', 'last_update', 'operator_id',
  'naming_rule_origin',
]);

/** 布尔 INTEGER 列（0/1 归一）。 */
const FLAG_COLUMNS = Object.freeze(['is_fai']);

/** `revision` 出入参恒为 INTEGER（本层不做展示层的两位补零，见模块头注）。 */
function toWriteRow(input) {
  const row = pickColumns(input, TASK_CARD_COLUMNS);
  applyFlags(row, FLAG_COLUMNS);
  if (row.revision !== undefined) row.revision = toIntOrNull(row.revision);
  return row;
}

/** `task_card` 行 → camelCase 对象；`revision`/`is_fai` 转为原生 number/boolean 语义整数。 */
function toCard(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.revision !== undefined) camel.revision = toIntOrNull(camel.revision);
  if (camel.isFai !== undefined) camel.isFai = toIntOrNull(camel.isFai);
  return camel;
}

/**
 * 新增一条工卡（服务层负责补齐默认值：状态 New、Date 当天、Revision 初始 1 等，
 * 本函数只做落库）。
 * @param {object} card camelCase 工卡数据
 * @returns {number | bigint} 新增行 id
 */
export function create(card) {
  const row = toWriteRow(card);
  return insertRow(getDb(), 'task_card', row);
}

/**
 * 按主键更新工卡（服务层负责编辑态闸门 `isEditable` 与字段级校验，本函数只做落库）。
 * @param {number | string} id
 * @param {object} patch camelCase 待更新字段（未提供的字段不写入，即部分更新）
 * @returns {number} 受影响行数
 */
export function update(id, patch) {
  const row = toWriteRow(patch);
  return updateRow(getDb(), 'task_card', id, row);
}

/**
 * 按主键取一条工卡。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM task_card WHERE id = ?').get(id);
  return toCard(row);
}

/**
 * 按 `(task_no, revision)` 取一条工卡（`UNIQUE(task_no, revision)` 对应的精确取数）。
 * @param {string} taskNo
 * @param {number} revision
 * @returns {object | null}
 */
export function findByTaskNoAndRevision(taskNo, revision) {
  const row = getDb()
    .prepare('SELECT * FROM task_card WHERE task_no = ? AND revision = ?')
    .get(taskNo, toIntOrNull(revision));
  return toCard(row);
}

/**
 * 取某工卡编号下当前生效版本（`status = 'Effective'`）。同一 `task_no` 至多一条生效版本
 * （`ux_task_card_effective_task_no` 部分唯一索引兜底），取不到返回 `null`。
 * @param {string} taskNo
 * @returns {object | null}
 */
export function findEffectiveByTaskNo(taskNo) {
  const row = getDb()
    .prepare("SELECT * FROM task_card WHERE task_no = ? AND status = 'Effective'")
    .get(taskNo);
  return toCard(row);
}

/**
 * 取某工卡编号下的全部版本，按 `revision` 升序。
 * @param {string} taskNo
 * @returns {object[]}
 */
export function listVersionsByTaskNo(taskNo) {
  const rows = getDb()
    .prepare('SELECT * FROM task_card WHERE task_no = ? ORDER BY revision ASC')
    .all(taskNo);
  return rows.map(toCard);
}

/** 筛选维度 → SQL 匹配口径，与 `domain/filter.js` 的 {@link FILTER_FIELDS} 表格同口径。 */
const FILTER_SPECS = Object.freeze({
  acType: Object.freeze({ column: 'ac_type', match: 'exact' }),
  taskNo: Object.freeze({ column: 'task_no', match: 'substring' }),
  gearType: Object.freeze({ column: 'gear_type', match: 'exact' }),
  title: Object.freeze({ column: 'title', match: 'substring' }),
  status: Object.freeze({ column: 'status', match: 'exact' }),
  stage: Object.freeze({ column: 'stage', match: 'exact' }),
  cardType: Object.freeze({ column: 'card_type', match: 'exact' }),
});

/** 每个筛选维度可用的入参键名别名（camelCase 优先，snake_case 兼容）。 */
const FILTER_KEY_ALIASES = Object.freeze({
  acType: Object.freeze(['acType', 'ac_type']),
  taskNo: Object.freeze(['taskNo', 'task_no', 'taskCardNo']),
  gearType: Object.freeze(['gearType', 'gear_type']),
  title: Object.freeze(['title']),
  status: Object.freeze(['status', 'cardStatus', 'card_status']),
  stage: Object.freeze(['stage']),
  cardType: Object.freeze(['cardType', 'card_type']),
});

/** 取 `filters` 上该维度第一个非空字符串取值；取不到返回 `null`。 */
function pickFilterValue(filters, aliases) {
  if (filters === null || typeof filters !== 'object') return null;
  for (const key of aliases) {
    if (!Object.prototype.hasOwnProperty.call(filters, key)) continue;
    const value = filters[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * 依 `filters` 构造 `WHERE` 子句片段与对应参数（非空条件 AND 组合，空条件全通过——
 * 与 `domain/filter.js` 的 `matchesFilters` 同语义，此处直接落 SQL 而非全表扫描后过滤）。
 * @param {unknown} filters
 * @returns {{ clause: string, params: unknown[] }}
 */
function buildWhere(filters) {
  const clauses = [];
  const params = [];
  for (const [field, spec] of Object.entries(FILTER_SPECS)) {
    const value = pickFilterValue(filters, FILTER_KEY_ALIASES[field]);
    if (value === null) continue;
    if (spec.match === 'substring') {
      clauses.push(`${spec.column} LIKE ? COLLATE NOCASE`);
      params.push(`%${value}%`);
    } else {
      clauses.push(`${spec.column} = ?`);
      params.push(value);
    }
  }
  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/**
 * 分页 + 筛选清单查询（需求 2.1、2.2）。
 * @param {{ filters?: unknown, page?: number, pageSize?: number }} [options]
 * @returns {{ list: object[], total: number, page: number, pageSize: number }}
 */
export function list(options = {}) {
  const { filters = {}, page = 1, pageSize = 20 } = options;
  const safePage = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.trunc(Number(page)) : 1;
  const safePageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.trunc(Number(pageSize))
    : 20;

  const { clause, params } = buildWhere(filters);
  const db = getDb();

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM task_card ${clause}`)
    .get(...params).count;

  const rows = db
    .prepare(
      `SELECT * FROM task_card ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, safePageSize, (safePage - 1) * safePageSize);

  return {
    list: rows.map(toCard),
    total,
    page: safePage,
    pageSize: safePageSize,
  };
}

/**
 * 取全部工卡编号（Task No），供批量复制的编号生成校验现存占用（需求 38.8、38.9：
 * `domain/task-no.js` 的 `generateTaskNoBatch` 需要完整的 `existing` 集合才能正确跳号）。
 * 不去重、不按版本过滤——`generateTaskNoBatch` 内部按值判占用，同一 Task No 出现多次
 * （多版本）不影响判定。
 * @returns {string[]}
 */
export function listAllTaskNos() {
  const rows = getDb().prepare('SELECT task_no FROM task_card').all();
  return rows.map((row) => row.task_no);
}

export default {
  create,
  update,
  findById,
  findByTaskNoAndRevision,
  findEffectiveByTaskNo,
  listVersionsByTaskNo,
  listAllTaskNos,
  list,
};
