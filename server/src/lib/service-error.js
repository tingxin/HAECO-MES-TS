/**
 * 服务层错误约定（Service Layer Error Convention）—— 任务 13.1 建立，供任务 13.2–13.11
 * 全部服务模块统一遵循，避免各服务各自发明错误传递方式。
 *
 * ## 约定内容
 *
 * 服务层函数校验失败或前置条件不满足时，**一律 `throw new ServiceError(code, message, data)`**，
 * 不返回 `{ ok, ... }` 形态的判定对象（那是领域纯函数层——`domain/*.js`——的约定，服务层是它们的
 * 消费方而非复用方）。服务层函数在成功路径上返回**纯业务数据**（如新建/更新后的工卡行），
 * 不做 `ok(data)` 信封包装——信封包装是路由层（`routes/*.js`）职责，由统一错误处理中间件
 * （任务 16.3）完成「service 抛错 → HTTP 响应」的转译，例如：
 *
 * ```js
 * // 路由层
 * try {
 *   const card = taskCardService.updateCard(req.params.id, req.body, ctx);
 *   return sendOk(res, card);
 * } catch (error) {
 *   if (error instanceof ServiceError) return sendFail(res, error.code, error.message, error.data);
 *   throw error; // 未预期异常交由更外层的统一错误处理兜底为 500
 * }
 * ```
 *
 * ## `code` 与 `httpStatus`
 *
 * `ServiceError.code` 取值**一律来自 `lib/response.js` 的 `CODE` 枚举**（400/401/403/404/409/422/500），
 * 与整个系统「非零 code 恒镜像为同值 HTTP status」的约定（design.md「Error Handling」）保持单一口径——
 * 服务层不发明另一套错误码。`ServiceError.httpStatus` 由 `httpStatusFor(code)` 派生，仅为方便调用方
 * 直接读取 HTTP 状态码，取值恒等于 `code`（`code:0` 不适用于错误，故 `ServiceError` 不接受 `CODE.OK`）。
 *
 * ## 何时使用 `ServiceError` vs 让异常原样抛出
 *
 * - **业务规则拒绝**（编辑态闸门、枚举非法、Stage×类型组合非法、重复冲突、越权、未找到、变更原因为空等）：
 *   一律 `throw new ServiceError(...)`——这是「预期内的失败」，路由层需要将其映射为对应 HTTP status。
 * - **数据库层约束兜底**（`UNIQUE`/`CHECK` 撞库）：服务层捕获 `better-sqlite3` 的
 *   `SqliteError`（`error.code` 形如 `SQLITE_CONSTRAINT_UNIQUE`），转译为 `ServiceError(CODE.CONFLICT, ...)`
 *   或 `ServiceError(CODE.VALIDATION, ...)` 后重新抛出，而不是让原始 `SqliteError` 泄漏到路由层。
 * - **意外异常**（编程错误、未捕获的领域函数 `TypeError` 等）：不包装，原样向上抛出，交由应用级
 *   统一错误处理（任务 16.3）记日志并返回 `CODE.INTERNAL`（500）。
 *
 * 需求：通用（Error Handling 统一约定），供任务 13.1–13.11 服务层共用。
 */

import { CODE, httpStatusFor } from './response.js';

/**
 * 服务层判定失败的统一异常形态。
 */
export class ServiceError extends Error {
  /**
   * @param {number} code 非零错误码，须 ∈ `CODE`（`lib/response.js`）
   * @param {string} [message] 人类可读消息（中文）
   * @param {*} [data=null] 附加明细（如未通过校验项清单、冲突记录、可选 Stage 范围提示）
   */
  constructor(code, message, data = null) {
    if (code === CODE.OK) {
      throw new TypeError('ServiceError 不接受 CODE.OK：成功路径不应构造错误对象');
    }
    super(message ?? `服务层错误（code=${String(code)}）`);
    this.name = 'ServiceError';
    this.code = code;
    this.httpStatus = httpStatusFor(code);
    this.data = data;
  }
}

/**
 * 判定某异常是否为 `better-sqlite3` 的约束冲突错误（`UNIQUE` / `CHECK` 等）。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSqliteConstraintError(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 将 `better-sqlite3` 约束冲突错误转译为 `ServiceError`（数据库层为最后防线时的兜底映射）。
 * 非约束冲突错误、已是 `ServiceError` 的错误原样返回，不做二次包装。
 *
 * @param {unknown} error
 * @param {{ conflictMessage?: string, validationMessage?: string }} [messages]
 * @returns {ServiceError | unknown} 转译后的 `ServiceError`，或原始 `error`（不应包装的情形）
 */
export function translateSqliteError(error, messages = {}) {
  if (error instanceof ServiceError) return error;
  if (!isSqliteConstraintError(error)) return error;
  if (error.code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || error.code === 'SQLITE_CONSTRAINT') {
    return new ServiceError(
      CODE.CONFLICT,
      messages.conflictMessage ?? '数据已存在，违反唯一性约束',
      { cause: error.message },
    );
  }
  return new ServiceError(
    CODE.VALIDATION,
    messages.validationMessage ?? '数据不满足约束条件',
    { cause: error.message },
  );
}

export default ServiceError;
