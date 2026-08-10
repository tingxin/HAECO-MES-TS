/**
 * `attachment` 仓储（需求 5.3、13.2、13.3、18、31.2）。纯 SQL 读写封装。
 * 文件名生成、MIME 白名单与大小上限校验均属服务层职责，本仓储只做落库与取数。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel } from './case-convert.js';

export const ATTACHMENT_COLUMNS = Object.freeze([
  'kind', 'original_name', 'stored_path', 'mime_type', 'byte_size', 'sha256',
  'uploaded_by', 'uploaded_at',
]);

function toWriteRow(input) {
  return pickColumns(input, ATTACHMENT_COLUMNS);
}

/**
 * 新增一条附件记录。
 * @param {object} attachment camelCase：`{ kind, originalName, storedPath, mimeType, byteSize, sha256, uploadedBy, uploadedAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(attachment) {
  return insertRow(getDb(), 'attachment', toWriteRow(attachment));
}

/**
 * 按主键删除一条附件记录。
 * @param {number | string} id
 * @returns {number} 受影响行数
 */
export function remove(id) {
  return getDb().prepare('DELETE FROM attachment WHERE id = ?').run(id).changes;
}

/**
 * 按主键取一条附件记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM attachment WHERE id = ?').get(id);
  return rowToCamel(row);
}

/**
 * 按内容摘要取附件记录（去重与完整性核对，需求场景下常见查询）。
 * @param {string} sha256
 * @returns {object | null}
 */
export function findBySha256(sha256) {
  const row = getDb().prepare('SELECT * FROM attachment WHERE sha256 = ?').get(sha256);
  return rowToCamel(row);
}

export default { create, remove, findById, findBySha256 };
