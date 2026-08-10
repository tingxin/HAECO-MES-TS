/**
 * 统一响应信封与错误码契约（design.md「统一响应信封」/「Error Handling」）
 *
 * 全部 REST 接口一律返回 `{ code, message, data }`：
 *   - `code: 0` 为成功，恒对应 HTTP 200
 *   - 非零 `code` 恒**镜像**为同值 HTTP status（`code:403` ⇒ HTTP 403）
 *
 * 前端 axios 拦截器据此只依 HTTP status 做统一分支（401 跳身份选择、403 越权提示），
 * 业务分支再读 `code` 与 `message`。
 *
 * 「部分失败但整批成功」的业务场景——迁移逐条失败、商务分类待人工确认、集成数据缺失——
 * 一律用 `code: 0` + `data` 内明细承载，**不占用错误码**（见 CODE 注释与 design.md Error Handling 表末三行）。
 */

/** 错误码词表：0 成功，其余与 HTTP status 同值。 */
export const CODE = Object.freeze({
  /** 成功。业务上的部分失败（迁移逐条失败 / 分类待确认 / 集成数据缺失）亦用此码，明细放 data。 */
  OK: 0,
  /** 校验失败：枚举非法、必填缺失、Stage×类型组合非法、审核意见为空、原因为空、空 ids[] 等。 */
  VALIDATION: 400,
  /** 未识别身份：请求未携带有效 token，user-context 无法解析当前用户。 */
  UNAUTHENTICATED: 401,
  /** 越权：authorize 中间件拒绝并写 access_denial_log。 */
  FORBIDDEN: 403,
  /** 未找到：目标资源不存在。 */
  NOT_FOUND: 404,
  /** 重复冲突：Task No + Revision 查重命中、单据编号重复等。 */
  CONFLICT: 409,
  /** 状态或前置条件非法：非新增态被编辑、发布未生效工卡、作废存在引用、签署项未齐等。 */
  UNPROCESSABLE: 422,
  /** 服务器异常：事务回滚、未捕获错误。 */
  INTERNAL: 500,
});

/** 全部合法 code 取值（含 0）。 */
const VALID_CODES = new Set(Object.values(CODE));

/** 各错误码的默认中文消息，调用方未显式给出 message 时使用。 */
const DEFAULT_MESSAGES = Object.freeze({
  [CODE.OK]: 'ok',
  [CODE.VALIDATION]: '校验失败',
  [CODE.UNAUTHENTICATED]: '未识别身份',
  [CODE.FORBIDDEN]: '越权操作',
  [CODE.NOT_FOUND]: '未找到',
  [CODE.CONFLICT]: '重复冲突',
  [CODE.UNPROCESSABLE]: '状态或前置条件非法',
  [CODE.INTERNAL]: '服务器异常',
});

/**
 * 成功信封。
 * @param {*} [data=null] 业务数据；「部分失败但整批成功」的明细也放这里。
 * @param {string} [message] 人类可读消息（中文），缺省 'ok'。
 * @returns {{code: 0, message: string, data: *}}
 */
export function ok(data = null, message = DEFAULT_MESSAGES[CODE.OK]) {
  return { code: CODE.OK, message, data };
}

/**
 * 失败信封。`code` 必须是 CODE 中的非零错误码——镜像约定要求每个非零 code 都能作为 HTTP status。
 * @param {number} code 非零错误码（400/401/403/404/409/422/500）。
 * @param {string} [message] 人类可读消息（中文），缺省取该码的默认消息。
 * @param {*} [data=null] 附加明细（如未通过校验项清单、被拒工卡与原因）。
 * @returns {{code: number, message: string, data: *}}
 */
export function fail(code, message, data = null) {
  if (!VALID_CODES.has(code) || code === CODE.OK) {
    throw new TypeError(
      `fail() 需传入非零错误码（${Object.values(CODE)
        .filter((c) => c !== CODE.OK)
        .join(' / ')}），收到：${String(code)}`,
    );
  }
  return {
    code,
    message: message === undefined || message === null ? DEFAULT_MESSAGES[code] : message,
    data,
  };
}

/**
 * code → HTTP status 的镜像映射：`0` ⇒ 200，非零 ⇒ 同值。
 * @param {number} code
 * @returns {number}
 */
export function httpStatusFor(code) {
  if (!VALID_CODES.has(code)) {
    throw new TypeError(`未知 code：${String(code)}`);
  }
  return code === CODE.OK ? 200 : code;
}

/**
 * 按镜像约定把信封写入 Express 响应。
 * @param {{status: Function, json: Function}} res
 * @param {{code: number, message: string, data: *}} envelope
 */
export function send(res, envelope) {
  return res.status(httpStatusFor(envelope.code)).json(envelope);
}

/** 成功响应快捷方式：HTTP 200 + `code:0`。 */
export function sendOk(res, data, message) {
  return send(res, ok(data, message));
}

/** 失败响应快捷方式：HTTP status 与 code 同值。 */
export function sendFail(res, code, message, data) {
  return send(res, fail(code, message, data));
}
