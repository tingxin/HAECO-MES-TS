/**
 * `job_step_snapshot` 仓储（工序内容快照，需求 37.5、44.6、49.5–49.7）。
 * 纯 SQL 读写封装：不校验、不带默认值、不调用领域函数。
 *
 * ⚠⚠⚠ 本仓储**只写不改，无更新方法（无 `update`/`remove` 导出）** ⚠⚠⚠
 *
 * 这不是遗漏，而是 Property 34（工序快照隔离/不可变性）的仓储层落实：
 * `job_process.step_id` 直接引用**可变的**编制域模板行 `process_step`；JOB 的执行与呈现
 * 一律只读 `job_step_snapshot.content`，`step_id` 仅作溯源，不作读取依赖。若本仓储提供
 * 更新入口，就等于给「追溯性篡改历史 JOB 呈现内容」开了一条后门——释放后修改编制域模板
 * 不得改变既有 JOB 的作业内容，而这条不变式恰恰依赖「快照一旦写入即不可变」。
 * 因此本文件**故意**不导出任何 update/remove 函数；如需修正快照内容，唯一合法路径是
 * （由服务层决策）作废该 JOB 重新释放，产出新的快照行，而不是就地改写旧快照。
 *
 * `content` 列为 JSON TEXT，其形状由 `domain/snapshot.js` 的 `buildStepSnapshots` /
 * `serializeSnapshotContent` / `parseSnapshotContent` 唯一定义（见 SNAPSHOT_CONTENT_FIELDS）。
 * 本仓储按 `execDocumentRepo.js` 对 `content` 列的既有约定处理：写入时若传入已解析对象则
 * 序列化落列，传入字符串则原样落列；读取时原样返回列取值（字符串），交由调用方按需
 * `JSON.parse`（或复用 `domain/snapshot.js` 的 `parseSnapshotContent`）——不在仓储层重新
 * 解析/重新序列化，避免键序变化影响快照内容的逐字节可比对性。
 *
 * 列名 snake_case，出入参一律 camelCase（`case-convert.js` 承担转换）。
 */

import { getDb } from '../db/connection.js';
import { insertRow, pickColumns, rowToCamel, toIntOrNull } from './case-convert.js';

/** `job_step_snapshot` 除 `id` 外的全部列（snake_case），供 {@link pickColumns} 白名单使用。 */
export const JOB_STEP_SNAPSHOT_COLUMNS = Object.freeze([
  'job_process_id', 'source_step_id', 'source_card_revision', 'content', 'snapshot_at',
]);

/** `content` 传入已解析对象（非字符串）时序列化为 JSON 文本；字符串原样保留（见模块头注）。 */
function normalizeContent(value) {
  if (value === null || value === undefined || typeof value === 'string') return value;
  return JSON.stringify(value);
}

function toWriteRow(input) {
  const row = pickColumns(input, JOB_STEP_SNAPSHOT_COLUMNS);
  if (row.job_process_id !== undefined) row.job_process_id = toIntOrNull(row.job_process_id);
  if (row.source_step_id !== undefined) row.source_step_id = toIntOrNull(row.source_step_id);
  if (row.source_card_revision !== undefined) {
    row.source_card_revision = toIntOrNull(row.source_card_revision);
  }
  if (row.content !== undefined) row.content = normalizeContent(row.content);
  return row;
}

function toSnapshot(row) {
  const camel = rowToCamel(row);
  if (camel === null) return null;
  if (camel.jobProcessId !== undefined) camel.jobProcessId = toIntOrNull(camel.jobProcessId);
  if (camel.sourceStepId !== undefined) camel.sourceStepId = toIntOrNull(camel.sourceStepId);
  if (camel.sourceCardRevision !== undefined) {
    camel.sourceCardRevision = toIntOrNull(camel.sourceCardRevision);
  }
  return camel;
}

/**
 * 新增一条工序内容快照（释放服务在写入 `job_process` 后于同一事务内回填
 * `job_process_id` 并落库，本函数只做落库；不做校验，`NOT NULL` 由 DB 层兜底）。
 * @param {object} snapshot camelCase：`{ jobProcessId, sourceStepId, sourceCardRevision,
 *   content, snapshotAt }`
 * @returns {number | bigint} 新增行 id
 */
export function create(snapshot) {
  return insertRow(getDb(), 'job_step_snapshot', toWriteRow(snapshot));
}

/**
 * 批量新增工序内容快照（一次释放通常产出多条快照，在**同一事务**内逐条插入；
 * 事务边界由调用方——服务层——负责，本函数不自行开启事务）。
 * @param {ReadonlyArray<object>} snapshots camelCase 快照数据集合
 * @returns {(number | bigint)[]} 新增行 id 集合，与入参顺序一致
 */
export function createMany(snapshots) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  return list.map((snapshot) => create(snapshot));
}

/**
 * 按主键取一条快照。
 * @param {number | string} id
 * @returns {object | null}
 */
export function findById(id) {
  const row = getDb().prepare('SELECT * FROM job_step_snapshot WHERE id = ?').get(id);
  return toSnapshot(row);
}

/**
 * 按 `job_process_id` 取一条快照（`UNIQUE(job_process_id)` 对应的精确取数，
 * 一对一绑定 JOB 工序实例）。
 * @param {number | string} jobProcessId
 * @returns {object | null}
 */
export function findByJobProcessId(jobProcessId) {
  const row = getDb()
    .prepare('SELECT * FROM job_step_snapshot WHERE job_process_id = ?')
    .get(jobProcessId);
  return toSnapshot(row);
}

/**
 * 取某 JOB（跨全部工序）的全部快照，按关联 `job_process.process_id` 升序。
 * @param {number | string} jobId
 * @returns {object[]}
 */
export function listByJobId(jobId) {
  const rows = getDb()
    .prepare(
      `SELECT jss.* FROM job_step_snapshot jss
         JOIN job_process jp ON jp.id = jss.job_process_id
        WHERE jp.job_id = ?
        ORDER BY jp.process_id ASC, jss.id ASC`,
    )
    .all(jobId);
  return rows.map(toSnapshot);
}

/**
 * 按 `job_id` + `step_id`（`process_step.id`，来源工序模板溯源）取快照。`step_id` 仅作
 * 溯源查询，**不作为读取执行内容的依赖路径**（执行内容一律读 `content`）。
 * @param {number | string} jobId
 * @param {number | string} stepId
 * @returns {object | null}
 */
export function findByJobIdAndStepId(jobId, stepId) {
  const row = getDb()
    .prepare(
      `SELECT jss.* FROM job_step_snapshot jss
         JOIN job_process jp ON jp.id = jss.job_process_id
        WHERE jp.job_id = ? AND jss.source_step_id = ?`,
    )
    .get(jobId, stepId);
  return toSnapshot(row);
}

export default {
  create,
  createMany,
  findById,
  findByJobProcessId,
  listByJobId,
  findByJobIdAndStepId,
};
