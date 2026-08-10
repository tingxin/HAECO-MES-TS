/**
 * `exec_document` 仓储（新增，需求 23.1–23.3、38.1–38.3）。纯 SQL 读写封装。
 *
 * 最小实例存储：仅支撑复制（`domain/exec-doc.js` 的 `copyExecDocument`）与关联取数落库，
 * **不含编制界面**（需求 23.3 归属待澄清）。`content` 为 JSON 列——按模块头指示，
 * `copyExecDocument` **不解析、不重新序列化** `content`（字符串形态原样克隆，避免键序变化
 * 破坏 Property 3 的逐字符相等断言），故本仓储的 `content` 出入参**同样原样传递**：
 * 写入时若传入已解析对象才序列化，传入字符串则直接落列；读取时原样返回列取值
 * （字符串），交由调用方按需 `JSON.parse`——这与 `copyExecDocument` 对 `content`
 * 「不做形态转换」的约定一致，避免仓储层的序列化选择反过来破坏复制语义。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

export const EXEC_DOCUMENT_COLUMNS = Object.freeze([
  'exec_doc_type', 'doc_no', 'revision', 'status', 'title', 'content', 'source_card_id',
  'created_by', 'created_at',
]);

/** `content` 传入已解析对象（非字符串）时序列化为 JSON 文本；字符串原样保留（见模块头注）。 */
function normalizeContent(value) {
  if (value === null || value === undefined || typeof value === 'string') return value;
  return JSON.stringify(value);
}

function toWriteRow(input) {
  const row = pickColumns(input, EXEC_DOCUMENT_COLUMNS);
  if (row.revision !== undefined) row.revision = toIntOrNull(row.revision);
  if (row.content !== undefined) row.content = normalizeContent(row.content);
  return row;
}

function toDoc(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.revision !== undefined) camel.revision = toIntOrNull(camel.revision);
  return camel;
}

/**
 * 新增一条执行过程单据（复制落库的入口，需求 23.1、23.2）。
 * @param {object} doc camelCase：`{ execDocType, docNo, revision, status, title, content,
 *   sourceCardId, createdBy, createdAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(doc) {
  return insertRow(getDb(), 'exec_document', toWriteRow(doc));
}

/**
 * 按主键取一条执行过程单据详情。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM exec_document WHERE id = ?').get(id);
  return toDoc(row);
}

/**
 * 按 `(exec_doc_type, doc_no, revision)` 取一条单据（`UNIQUE` 对应的精确取数，
 * 亦用于判重——命中即表示该三元组已存在，需求 23.2、38.1）。
 * @param {string} execDocType
 * @param {string} docNo
 * @param {number} revision
 * @returns {object | null}
 */
export function findByTriple(execDocType, docNo, revision) {
  const row = getDb()
    .prepare('SELECT * FROM exec_document WHERE exec_doc_type = ? AND doc_no = ? AND revision = ?')
    .get(execDocType, docNo, toIntOrNull(revision));
  return toDoc(row);
}

/**
 * 判重：`(exec_doc_type, doc_no, revision)` 三元组是否已存在（需求 23.2、38.1）。
 * @param {string} execDocType
 * @param {string} docNo
 * @param {number} revision
 * @returns {boolean}
 */
export function existsByTriple(execDocType, docNo, revision) {
  return findByTriple(execDocType, docNo, revision) !== null;
}

/**
 * 分页列表查询（默认按单据类型过滤，可选按 `docNo` 子串筛选），按 `id` 降序。
 * @param {{ execDocType?: string, docNo?: string, page?: number, pageSize?: number }} [options]
 * @returns {{ list: object[], total: number, page: number, pageSize: number }}
 */
export function list(options = {}) {
  const { execDocType, docNo, page = 1, pageSize = 20 } = options;
  const safePage = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.trunc(Number(page)) : 1;
  const safePageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.trunc(Number(pageSize))
    : 20;

  const clauses = [];
  const params = [];
  if (execDocType !== undefined && execDocType !== null && String(execDocType).trim() !== '') {
    clauses.push('exec_doc_type = ?');
    params.push(execDocType);
  }
  if (docNo !== undefined && docNo !== null && String(docNo).trim() !== '') {
    clauses.push('doc_no LIKE ? COLLATE NOCASE');
    params.push(`%${docNo}%`);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const db = getDb();

  const total = db.prepare(`SELECT COUNT(*) AS count FROM exec_document ${whereClause}`).get(...params).count;
  const rows = db
    .prepare(`SELECT * FROM exec_document ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, safePageSize, (safePage - 1) * safePageSize);

  return {
    list: rows.map(toDoc),
    total,
    page: safePage,
    pageSize: safePageSize,
  };
}

export default { create, findById, findByTriple, existsByTriple, list };
