/**
 * 执行过程单据（含 SWS）复制服务（任务 13.4，需求 23.1、23.2、23.3、38.1–38.3）。
 *
 * 组合 `domain/exec-doc.js` 的纯函数 `copyExecDocument` 与 `execDocumentRepo` 的落库操作，
 * 承担三件事：
 *
 * 1. **复制**（{@link copy}）：取源单据 → `copyExecDocument` → 判重
 *    （`UNIQUE(exec_doc_type, doc_no, revision)`，冲突 `409`）→ 单事务落 `exec_document`。
 * 2. **列表与详情读取**（{@link list} / {@link getById}）：供复制取数与结果查看，
 *    对 `execDocumentRepo` 的只读直通转发，不叠加业务逻辑。
 * 3. ⚠ **不实现 SWS 编制表单**：SWS（`exec_doc_type === 'SW'` 的实例）的编制界面归属
 *    （本模块 / LGS-TS-03-05 独立流程）是需求 23.3 的待澄清项，本服务刻意不提供任何
 *    新增/修改单据内容的入口，只提供复制与只读取数。
 *
 * ## `content` 的传递约定
 *
 * `execDocumentRepo` 的出入参对 `content` 列**不做形态转换**（字符串原样进/出，已解析对象
 * 才序列化），`domain/exec-doc.js` 的 `copyExecDocument` 同样**不解析、不重新序列化**字符串
 * 形态的 `content`。本服务顺着这条链路：取回的源单据 `content` 是什么形态（字符串或对象），
 * 复制副本的 `content` 就保持同一形态，交由仓储层落库时按其既有规则处理——本服务不在中途
 * 对 `content` 做任何 `JSON.parse`/`JSON.stringify`。
 *
 * ## 错误约定（`lib/service-error.js`，与 `taskCardService.js` 同一口径）
 *
 * 全部导出函数在校验失败或前置条件不满足时一律 `throw new ServiceError(code, message, data)`，
 * 成功路径返回纯业务数据（不做 `{ok, data}` 信封包装）——路由层统一 `try/catch ServiceError`
 * 转 `sendFail`。
 *
 * 需求：23.1、23.2、23.3、38.1–38.3
 */

import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import { getDb } from '../db/connection.js';

import { copyExecDocument } from '../domain/exec-doc.js';
import execDocumentRepo from '../repositories/execDocumentRepo.js';
import { toSnakeCase } from '../repositories/case-convert.js';

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果（服务层事务边界的统一入口）。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * 取调用上下文中的操作人标识（`staff_no`），供复制副本的 `created_by` 落位。
 * 与 `taskCardService.js` 的 `operatorIdOf` 同规则：兼容 `operatorId` / `staffNo` /
 * `userId` 三种写法；缺失一律拒绝——变更须可追溯到人（需求 19.3 同源约束）。
 * @param {unknown} ctx
 * @returns {string}
 */
function operatorIdOf(ctx) {
  const raw = ctx && typeof ctx === 'object' ? ctx.operatorId ?? ctx.staffNo ?? ctx.userId : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new ServiceError(CODE.VALIDATION, '缺少操作人标识（ctx.operatorId）');
  }
  return String(raw);
}

/**
 * camelCase 对象 → snake_case 对象（键名逐一转换，值不做任何形态转换）。
 *
 * `execDocumentRepo.findById` 返回 camelCase 对象，而 `domain/exec-doc.js` 的
 * `copyExecDocument` 按**固定 snake_case 键名**（`doc_no`/`status`/`revision`/`id`）
 * 重置复制规则字段——与 `card-rules.js` 的 `copyCard`（用 `ownKeyOf` 兼容两种写法）不同，
 * `copyExecDocument` 要求入参键名即为 `exec_document` 的实际列名。本函数在服务层完成
 * 这一层转换，使复制副本的键集合与源单据一致（不产生「`docNo` 与新增的 `doc_no`
 * 同时存在」这类不一致）。
 * @param {Record<string, unknown>} camelObj
 * @returns {Record<string, unknown>}
 */
function toSnakeRow(camelObj) {
  const result = {};
  for (const key of Object.keys(camelObj)) {
    result[toSnakeCase(key)] = camelObj[key];
  }
  return result;
}

/**
 * 按主键取源单据，取不到即 `404`。
 * @param {number | string} id
 * @returns {object} camelCase 单据
 */
function loadDocOrThrow(id) {
  const doc = execDocumentRepo.findById(id);
  if (doc === null) {
    throw new ServiceError(CODE.NOT_FOUND, `执行过程单据不存在：${String(id)}`);
  }
  return doc;
}

/**
 * 复制执行过程单据（含 SWS，需求 23.1、23.2、38.1–38.3）。
 *
 * 1. 按 `id` 取源单据，不存在 `404`；
 * 2. 转 snake_case 后交 `copyExecDocument` 产出副本（内容与业务字段逐字段克隆，
 *    `doc_no` 取 `newDocNo`，`status` 置 `New`，`revision` 置初始版本）——`newDocNo`
 *    为空/纯空白/非法时 `copyExecDocument` 抛 `TypeError`，本函数转译为 `400`；
 * 3. 按 `(exec_doc_type, doc_no, revision)` 判重（`UNIQUE` 索引对应维度），命中即 `409`
 *    （需求 38.2「编号重复则阻止复制并提示」）；
 * 4. 覆盖 `created_by`/`created_at` 为本次复制的操作人与时间（`copyExecDocument`
 *    本身不擅自改写业务字段，由服务层按需要覆盖，见该函数文档）；
 * 5. 单事务落 `exec_document`。
 *
 * @param {{ id: number | string, newDocNo: string | number }} params
 * @param {{operatorId?: string, staffNo?: string, userId?: string}} ctx 调用上下文
 * @returns {object} 新建的单据副本（camelCase）
 * @throws {ServiceError} 源单据不存在（404）、`newDocNo` 为空/非法（400）、
 *   `(exec_doc_type, doc_no, revision)` 已存在（409）
 */
export function copy(params, ctx) {
  const operatorId = operatorIdOf(ctx);
  const { id, newDocNo } = params ?? {};

  const source = loadDocOrThrow(id);

  let copyRow;
  try {
    copyRow = copyExecDocument(toSnakeRow(source), newDocNo);
  } catch (error) {
    throw new ServiceError(CODE.VALIDATION, error.message ?? '复制失败：新单据编号不合法');
  }

  const execDocType = copyRow.exec_doc_type;
  const docNo = copyRow.doc_no;
  const revision = copyRow.revision;

  if (execDocumentRepo.existsByTriple(execDocType, docNo, revision)) {
    throw new ServiceError(
      CODE.CONFLICT,
      `单据编号 ${String(docNo)}（类型 ${String(execDocType)}，版本 ${String(revision)}）已存在`,
      { rejection: 'DUPLICATE_DOC_NO' },
    );
  }

  copyRow.created_by = operatorId;
  copyRow.created_at = new Date().toISOString();

  return withTransaction(() => {
    const insertedId = execDocumentRepo.create(copyRow);
    return execDocumentRepo.findById(insertedId);
  });
}

/**
 * 分页列表查询（需求 23.3：供复制取数与结果查看的只读直通转发）。
 * @param {{ execDocType?: string, docNo?: string, page?: number, pageSize?: number }} [options]
 * @returns {{ list: object[], total: number, page: number, pageSize: number }}
 */
export function list(options = {}) {
  return execDocumentRepo.list(options);
}

/**
 * 按主键取单据详情（需求 23.3：只读，非内容变更操作，不经任何编辑态闸门）。
 * @param {number | string} id
 * @returns {object} camelCase 单据
 * @throws {ServiceError} 不存在（404）
 */
export function getById(id) {
  return loadDocOrThrow(id);
}

export default { copy, list, getById };
