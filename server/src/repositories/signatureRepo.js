/**
 * `electronic_signature` 仓储（电子签章记录，需求 32.2–32.4、45.4、45.5）。
 * 纯 SQL 读写封装：不校验、不带业务逻辑——归档完备性判定在 `domain/signature.js` 的
 * `canArchivePaperless`，本仓储只提供签署记录的落库与查询。
 *
 * ⚠ `electronic_signature` 表本身**不含 `job_process_id` 列**（仅 `card_id` / `job_id` /
 *   `signature_requirement_id`）：签署项挂在工序（`signature_requirement.step_id`）上，
 *   签署记录挂在 JOB（`job_id`，编制态为 `NULL`）与签署项上，二者的交点才对应到某个
 *   JOB 工序实例。因此 `listByJobProcessId` 经 `job_process`（取其 `job_id`/`step_id`）
 *   与 `signature_requirement`（取其 `step_id`）联表求出——JOIN 逻辑封装在仓储内，
 *   调用方无需关心该间接关系。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `electronic_signature` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const SIGNATURE_COLUMNS = Object.freeze([
  'card_id', 'job_id', 'signature_requirement_id', 'signed_by', 'stamp_id', 'signed_at',
]);

const INT_COLUMNS = Object.freeze(['card_id', 'job_id', 'signature_requirement_id']);

function toWriteRow(input) {
  const row = pickColumns(input, SIGNATURE_COLUMNS);
  for (const column of INT_COLUMNS) {
    if (row[column] !== undefined) row[column] = toIntOrNull(row[column]);
  }
  return row;
}

function toSignature(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.cardId !== undefined) camel.cardId = toIntOrNull(camel.cardId);
  if (camel.jobId !== undefined) camel.jobId = toIntOrNull(camel.jobId);
  if (camel.signatureRequirementId !== undefined) {
    camel.signatureRequirementId = toIntOrNull(camel.signatureRequirementId);
  }
  return camel;
}

/**
 * 新增一条电子签章记录（`jobId` 为 `null` 表示编制态签署，不绑定具体 JOB）。
 * @param {object} signature camelCase：`{ cardId, jobId, signatureRequirementId, signedBy,
 *   stampId, signedAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(signature) {
  return insertRow(getDb(), 'electronic_signature', toWriteRow(signature));
}

/**
 * 按主键取一条签署记录。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM electronic_signature WHERE id = ?').get(id);
  return toSignature(row);
}

/**
 * 取某 JOB 工序实例对应的全部签署记录（先取该 `job_process` 行的 `job_id`/`step_id`，
 * 再按「同一 JOB ∧ 签署项属于同一来源工序」联表求出，见模块头注），按 `id` 升序。
 * `job_process_id` 查无对应行时返回空数组。
 * @param {number | string} jobProcessId
 * @returns {object[]}
 */
export function listByJobProcessId(jobProcessId) {
  const db = getDb();
  const jobProcess = db
    .prepare('SELECT job_id, step_id FROM job_process WHERE id = ?')
    .get(jobProcessId);
  if (jobProcess === undefined) return [];

  const rows = db
    .prepare(
      `SELECT es.* FROM electronic_signature es
         JOIN signature_requirement sr ON sr.id = es.signature_requirement_id
        WHERE es.job_id = ? AND sr.step_id = ?
        ORDER BY es.id ASC`,
    )
    .all(jobProcess.job_id, jobProcess.step_id);
  return rows.map(toSignature);
}

/**
 * 取某 JOB（跨全部工序）的全部签署记录，按 `id` 升序——无纸化归档完备性检查（需求 32.2–32.4）
 * 按 JOB 收敛必需签署项时的取数入口。
 * @param {number | string} jobId
 * @returns {object[]}
 */
export function listByJobId(jobId) {
  const rows = getDb()
    .prepare('SELECT * FROM electronic_signature WHERE job_id = ? ORDER BY id ASC')
    .all(jobId);
  return rows.map(toSignature);
}

/**
 * 取某工卡的全部签署记录（含编制态 `job_id IS NULL` 与全部 JOB 态），按 `id` 升序——
 * 供 `canArchivePaperless` 按卡收敛必需签署项的完整取数入口。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listByCardId(cardId) {
  const rows = getDb()
    .prepare('SELECT * FROM electronic_signature WHERE card_id = ? ORDER BY id ASC')
    .all(cardId);
  return rows.map(toSignature);
}

export default { create, findById, listByJobProcessId, listByJobId, listByCardId };
