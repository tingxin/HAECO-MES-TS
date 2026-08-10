/**
 * 执行期服务（Execution Service）—— JOB 工序实例的报工、执行期工时、安全警示确认、
 * 电子签章与无纸化归档判定（任务 13.6）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 两域分离（Property 31 / 需求 33.1、33.5–33.7、37.4、37.5）—— 本文件的核心约束
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 工卡级/工序级起止时间**只落 `job` / `job_process` 两表**，`task_card` 一律不含对应列
 * （见 `db/schema.sql` 分节 2 头注）。本文件**不 `import` `repositories/taskCardRepo.js`
 * 的任何写方法**——事实上本文件对 `taskCardRepo` 的唯一使用是只读的 `findById`（供无纸化
 * 归档判定回显工卡标识/编号/版本），不存在、也不会存在任何写路径触及 `task_card` 行。
 * 报工前后 `task_card` 行的逐字段快照恒不变（Property 31 断言点）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 起止时间的聚合口径（Property 18 / 需求 33.3–33.6、33.8）—— 复用 `domain/times.js`
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 报工开始/完成只写被报工的那一条 `job_process.start_time`/`finish_time`；工卡级
 * `job.start_time`/`job.finish_time` 由 {@link module:domain/times.computeCardTimes}
 * 对该 JOB **全部** `job_process` 行重新聚合得出，不在本服务另行实现聚合规则：
 * 开始时间只要任意一道工序已开始即存在（取最早值）；结束时间**当且仅当全部工序均已完成**
 * 时才存在（取最晚值）——只要还有一道未完成，工卡结束时间恒为 `null`，绝不泄漏「已完成
 * 工序中的最晚值」。写回 `job` 行与本次报工写 `job_process` 行包在同一事务内
 * （`getDb().transaction(fn)()`），避免出现「工序已报工、工卡时间未同步」的半态。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 权限闸门（需求 47.7）—— 与 `configService.js`/`versionService.js` 同一 `authorize` 口径
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 执行期工时写入（{@link writeManHours}）经 `job_exec_write` 权限点校验：越权时
 * `throw ServiceError(CODE.FORBIDDEN, ...)` 并写 `access_denial_log`；权限判定本身出现
 * 编码/数据错误（未知角色、未知权限点、矩阵缺行——见 `domain/permission.js` 的
 * `isAuthorizationDecision`）视为服务缺陷而非越权尝试，`throw ServiceError(CODE.INTERNAL,
 * ...)` 且**不**写审计日志。
 *
 * 报工开始/完成、安全警示确认、电子签章签署本身不在本文件内经权限闸门（路由层/中间件——
 * 任务 16、19.3——负责按 `job_exec_write` 等权限点拦截请求；本服务只负责领域动作的落地）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 工时列的可写性（需求 11.4、47.7；⚠ 与需求 11.3 的 PPC 只读带出列区分）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `job_process.effective_man_hours`（有效工时）与 `job_process.actual_man_hours`（实际工时）
 * 两列按 `schema.sql` 头注**均由 Production 报工写入**——不存在「有效工时属只读 PPC 带出、
 * 仅实际工时可写」的分层。真正的只读 PPC 带出列是**另一张表**的另一对列：
 * `process_step.work_category` / `process_step.estimated_man_hours`（需求 11.3，PPC 专属
 * 界面维护，TS 编制界面只读）；`domain/permission.js` 的 `READONLY_DERIVED_FIELDS` 把两组
 * 列都登记为「不可经 TS 编制界面人工写入」，但那是**对 TS 编制界面**的只读声明，不代表
 * `job_process` 的两个工时列彼此之间有可写/不可写之分。故 {@link writeManHours} 同时接受
 * `effectiveManHours` 与 `actualManHours`，仅排除 `job_process` 表其余列（起止时间、条码、
 * 外键——分别由报工/发布服务专属写入）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 安全警示前置门禁（Property 16 / 需求 31.4–31.7）—— 复用 `domain/safety.js`
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * {@link checkEnterExecutionGate} 不重新实现关键工序判定或确认记录完整性判定，一律调用
 * `domain/safety.js` 的 `canEnterExecution(step, acks, userId)`；`step` 直接传入
 * `job_step_snapshot` 行（含 `content` JSON 文本，`canEnterExecution` 内部自行解析），
 * 而非本服务先解析后只传 `content`——这样 `canEnterExecution` 才能同时取到 `jobProcessId`
 * 用于确认记录的跨工序过滤（见 `domain/safety.js` 头注「确认记录的归属」）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 无纸化归档完备性（Property 17 / 需求 32.1–32.4）—— 复用 `domain/signature.js`
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * {@link checkPaperlessArchiveReadiness} 是**非抛出**的读式判定：直接回显
 * `canArchivePaperless(card, requirements, signatures)` 的判定对象（`{ ok, rejection,
 * message, missing, … }`），不把 `ok === false` 转成异常——调用方（如归档状态查询接口）
 * 需要完整的「还差什么」明细，而不仅是一个布尔失败。真正需要在不完备时**中断**流程的
 * 调用点（未来的「完成归档」动作）改用 {@link assertPaperlessArchiveReady}，其在
 * `ok === false` 时 `throw ServiceError(CODE.UNPROCESSABLE, ...)`。
 *
 * 必需签署项集合取自该 JOB 全部工序快照 `content.signatureRequirements` 的并集（需求
 * 32.4、45.6 的唯一来源经 `buildStepSnapshots` 固化在快照里，本服务不重新聚合编制域
 * `signature_requirement` 配置——释放后的必需项集合应与释放当时的快照一致，不随后续
 * 编制域修改而变化，这正是 Property 34 快照隔离在归档判定上的体现）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * JOB 查询与呈现一律读快照（Property 34 / 需求 49.6）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * {@link getJobStepContent} 是本服务对外暴露的 JOB 工序内容读取入口，一律读
 * `jobStepSnapshotRepo`（经 `domain/snapshot.js` 的 `parseSnapshotContent` 解析），
 * **不 `import` `repositories/processStepRepo.js`**——本文件通篇不出现该导入，
 * 从构造上排除「读编制域模板当前内容」的可能。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 服务层错误约定（与 `taskCardService.js`/`releaseService.js` 同一口径）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 校验失败或前置条件不满足时一律 `throw new ServiceError(code, message, data)`；成功路径
 * 返回纯业务数据，不做信封包装。
 *
 * 需求：11.4, 31.5–31.7, 32.1–32.4, 33.1–33.8, 37.4, 37.5, 47.7, 49.6
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import { computeCardTimes, isChronological } from '../domain/times.js';
import { canEnterExecution } from '../domain/safety.js';
import { canArchivePaperless } from '../domain/signature.js';
import { explainPermission } from '../domain/permission.js';
import { parseSnapshotContent } from '../domain/snapshot.js';

import jobRepo from '../repositories/jobRepo.js';
import jobProcessRepo from '../repositories/jobProcessRepo.js';
import jobStepSnapshotRepo from '../repositories/jobStepSnapshotRepo.js';
import safetyAckRepo from '../repositories/safetyAckRepo.js';
import signatureRepo from '../repositories/signatureRepo.js';
import taskCardRepo from '../repositories/taskCardRepo.js'; // ⚠ 本文件仅调用其 findById（只读）
import * as rolePermissionRepo from '../repositories/rolePermissionRepo.js';
import * as accessDenialLogRepo from '../repositories/accessDenialLogRepo.js';

/** 权限点常量（需求 47.7）。 */
const PERMISSION_JOB_EXEC_WRITE = 'job_exec_write';

/** 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景。 */
export const EXECUTION_SERVICE_REJECTION = Object.freeze({
  FORBIDDEN_JOB_EXEC_WRITE: 'forbiddenJobExecWrite',
  PERMISSION_CHECK_ERROR: 'permissionCheckError',
  NOT_FOUND: 'notFound',
  VALIDATION: 'validation',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [EXECUTION_SERVICE_REJECTION.FORBIDDEN_JOB_EXEC_WRITE]: CODE.FORBIDDEN,
  [EXECUTION_SERVICE_REJECTION.PERMISSION_CHECK_ERROR]: CODE.INTERNAL,
  [EXECUTION_SERVICE_REJECTION.NOT_FOUND]: CODE.NOT_FOUND,
  [EXECUTION_SERVICE_REJECTION.VALIDATION]: CODE.VALIDATION,
});

function throwRejection(rejection, message, data) {
  throw new ServiceError(REJECTION_CODE[rejection], message, { rejection, ...data });
}

// =====================================================================
// 一、内部辅助（不导出）
// =====================================================================

/** 当前时刻的 ISO 字符串。 */
function nowISO() {
  return new Date().toISOString();
}

/** 取调用上下文中的操作人标识；缺失一律拒绝（写入须可追溯到人）。 */
function operatorIdOf(ctx) {
  const raw = ctx && typeof ctx === 'object' ? ctx.operatorId ?? ctx.staffNo ?? ctx.userId : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new ServiceError(CODE.VALIDATION, '缺少操作人标识（ctx.operatorId）');
  }
  return String(raw);
}

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

/** 按主键取 JOB 工序实例，取不到即 404。 */
function loadJobProcessOrThrow(id) {
  const jobProcess = jobProcessRepo.findById(id);
  if (jobProcess === null) {
    throw new ServiceError(CODE.NOT_FOUND, `JOB 工序实例不存在：${String(id)}`);
  }
  return jobProcess;
}

/** 按主键取 JOB，取不到即 404。 */
function loadJobOrThrow(id) {
  const job = jobRepo.findById(id);
  if (job === null) {
    throw new ServiceError(CODE.NOT_FOUND, `JOB 不存在：${String(id)}`);
  }
  return job;
}

/**
 * 重新聚合某 JOB 全部工序的起止时间并写回 `job` 行（需求 33.5、33.6，Property 18）。
 * 复用 `domain/times.js` 的 `computeCardTimes`，不在本服务重新实现聚合规则。
 * @param {number | string} jobId
 * @returns {ReturnType<typeof computeCardTimes>}
 */
function recomputeAndWriteCardTimes(jobId) {
  const processes = jobProcessRepo.listByJobId(jobId);
  const times = computeCardTimes(
    processes.map((process) => ({
      startTime: process.startTime,
      finishTime: process.finishTime,
      processId: process.processId,
    })),
  );
  const execStatus = times.allFinished
    ? 'Completed'
    : times.startedCount > 0
      ? 'InProgress'
      : 'Pending';
  jobRepo.update(jobId, {
    startTime: times.startTime,
    finishTime: times.finishTime,
    execStatus,
  });
  return times;
}

/**
 * 权限闸门（与 `configService.js` 的 `authorize` 同一口径）。`actor` 形态：
 * `{ staffNo, role, method?, path?, now? }`。授权通过直接返回；越权 `throw
 * ServiceError(CODE.FORBIDDEN, ...)` 并已写入 `access_denial_log`；权限判定本身异常
 * （未知角色/权限点、矩阵缺行等编码或数据错误）`throw ServiceError(CODE.INTERNAL, ...)`
 * 且不写审计日志——该分支不代表一次真实的越权尝试。
 * @param {{staffNo?: string, role?: string, method?: string, path?: string, now?: string}} actor
 * @param {string} permissionPoint
 * @param {string} rejectionCode {@link EXECUTION_SERVICE_REJECTION} 中对应的 403 拒绝原因码
 */
function authorize(actor, permissionPoint, rejectionCode) {
  const role = actor?.role ?? null;
  const cfg = rolePermissionRepo.list();
  const { allowed, reason, isAuthorizationDecision } = explainPermission(role, permissionPoint, cfg);

  if (allowed) return;

  if (!isAuthorizationDecision) {
    throwRejection(
      EXECUTION_SERVICE_REJECTION.PERMISSION_CHECK_ERROR,
      `权限判定异常（${reason}）：角色=${String(role)}，权限点=${permissionPoint}`,
    );
  }

  accessDenialLogRepo.create({
    staffNo: actor?.staffNo ?? null,
    role,
    permissionPoint,
    method: actor?.method ?? 'SERVICE',
    path: actor?.path ?? `executionService:${permissionPoint}`,
    deniedAt: actor?.now ?? nowISO(),
  });

  throwRejection(
    rejectionCode,
    `越权：角色 ${String(role)} 无 ${permissionPoint} 权限写入执行期数据`,
  );
}

// =====================================================================
// 二、报工开始/完成（需求 33.3–33.6、33.8，Property 18、Property 31）
// =====================================================================

/**
 * 报工开始：写该 JOB 工序实例的 `start_time`，并在同一事务内重新聚合该 JOB 全部工序的
 * 起止时间写回 `job` 行（需求 33.3、33.5）。绝不触及 `task_card` 行（Property 31）。
 * @param {number | string} jobProcessId
 * @param {{now?: string}} [ctx] `now` 供测试注入固定时间戳，缺省取当前时刻
 * @returns {{jobProcess: object, cardTimes: ReturnType<typeof computeCardTimes>}}
 * @throws {ServiceError} JOB 工序实例不存在（404）
 */
export function startJobProcess(jobProcessId, ctx = {}) {
  const jobProcess = loadJobProcessOrThrow(jobProcessId);
  const startTime = ctx?.now ?? nowISO();

  // 进入执行状态前必须先通过关键工序安全门禁。非关键工序由领域规则直接放行。
  checkEnterExecutionGate(jobProcessId, ctx?.operatorId ?? ctx?.staffNo ?? ctx?.userId);

  return withTransaction(() => {
    jobProcessRepo.update(jobProcessId, { startTime });
    const cardTimes = recomputeAndWriteCardTimes(jobProcess.jobId);
    return { jobProcess: jobProcessRepo.findById(jobProcessId), cardTimes };
  });
}

/**
 * 报工完成：写该 JOB 工序实例的 `finish_time`，并在同一事务内重新聚合该 JOB 全部工序的
 * 起止时间写回 `job` 行——工卡结束时间仅在**全部**工序均已完成后才被写入，只要还有工序
 * 未完成即恒为 `null`（需求 33.4、33.6，Property 18）。绝不触及 `task_card` 行（Property 31）。
 * @param {number | string} jobProcessId
 * @param {{now?: string}} [ctx] `now` 供测试注入固定时间戳，缺省取当前时刻
 * @returns {{jobProcess: object, cardTimes: ReturnType<typeof computeCardTimes>}}
 * @throws {ServiceError} JOB 工序实例不存在（404）
 */
export function finishJobProcess(jobProcessId, ctx = {}) {
  const jobProcess = loadJobProcessOrThrow(jobProcessId);
  const finishTime = ctx?.now ?? nowISO();

  if (jobProcess.startTime === null || jobProcess.startTime === undefined) {
    throw new ServiceError(CODE.UNPROCESSABLE, '工序尚未开始，不可报工完成', {
      rejection: 'processNotStarted',
    });
  }
  if (!isChronological(jobProcess.startTime, finishTime)) {
    throw new ServiceError(CODE.UNPROCESSABLE, '工序结束时间不得早于开始时间', {
      rejection: 'finishBeforeStart',
      startTime: jobProcess.startTime,
      finishTime,
    });
  }

  return withTransaction(() => {
    jobProcessRepo.update(jobProcessId, { finishTime });
    const cardTimes = recomputeAndWriteCardTimes(jobProcess.jobId);
    return { jobProcess: jobProcessRepo.findById(jobProcessId), cardTimes };
  });
}

// =====================================================================
// 三、执行期工时写入（需求 11.4、47.7，`job_exec_write` 权限点）
// =====================================================================

/**
 * 从入参中挑出 `job_process` 的两个可写工时列（`effectiveManHours`/`actualManHours`，
 * 需求 11.4；两者均由 Production 报工写入，schema.sql 头注同等对待，非「一读一写」分层——
 * 见本文件头注「工时列的可写性」）。兼容 camelCase 与 snake_case 写法；`undefined` 视为
 * 未提供（跳过），其余表列（起止时间、条码、外键）恒不经本函数写入。
 * @param {unknown} patch
 * @returns {{effectiveManHours?: number|null, actualManHours?: number|null}}
 */
function pickManHoursFields(patch) {
  const result = {};
  if (patch === null || typeof patch !== 'object') return result;
  if (patch.effectiveManHours !== undefined) result.effectiveManHours = patch.effectiveManHours;
  else if (patch.effective_man_hours !== undefined) result.effectiveManHours = patch.effective_man_hours;
  if (patch.actualManHours !== undefined) result.actualManHours = patch.actualManHours;
  else if (patch.actual_man_hours !== undefined) result.actualManHours = patch.actual_man_hours;
  return result;
}

/**
 * 执行期工时写入（需求 11.4、47.7）：仅 `job_exec_write` 权限点可写，写 `job_process`
 * 的 `effective_man_hours`/`actual_man_hours`，不触及起止时间、条码等其余列。
 * @param {number | string} jobProcessId
 * @param {{effectiveManHours?: number|null, actualManHours?: number|null}} patch
 * @param {{staffNo?: string, role?: string}} actor 权限闸门所需的调用者身份
 * @returns {object} 更新后的 JOB 工序实例（camelCase）
 * @throws {ServiceError} 越权（403）、JOB 工序实例不存在（404）、未提供任一工时字段（400）、
 *   权限判定异常（500）
 */
export function writeManHours(jobProcessId, patch, actor) {
  authorize(actor, PERMISSION_JOB_EXEC_WRITE, EXECUTION_SERVICE_REJECTION.FORBIDDEN_JOB_EXEC_WRITE);

  loadJobProcessOrThrow(jobProcessId);

  const writable = pickManHoursFields(patch);
  if (Object.keys(writable).length === 0) {
    throwRejection(
      EXECUTION_SERVICE_REJECTION.VALIDATION,
      '至少须提供 effectiveManHours 或 actualManHours 之一',
    );
  }

  jobProcessRepo.update(jobProcessId, writable);
  return jobProcessRepo.findById(jobProcessId);
}

// =====================================================================
// 四、安全警示查看确认与执行前置门禁（需求 31.5–31.7，Property 16）
// =====================================================================

/**
 * 记录一条安全警示查看确认（需求 31.5、31.7）。写 `safety_acknowledgement` 行，
 * 含确认人与确认时间（完整性由 `domain/safety.js` 的 `isCompleteAcknowledgement` 校验，
 * 本函数只保证不写出缺失确认人的空记录）。
 * @param {number | string} jobProcessId
 * @param {string} userId 确认人标识（工号），须与执行期身份同一口径
 * @param {{now?: string}} [ctx] `now` 供测试注入固定时间戳，缺省取当前时刻
 * @returns {object} 新增的确认记录（camelCase）
 * @throws {ServiceError} `userId` 缺失或空白（400）
 */
export function acknowledgeSafetyWarning(jobProcessId, userId, ctx = {}) {
  loadJobProcessOrThrow(jobProcessId);
  const acknowledgedBy = userId === null || userId === undefined ? '' : String(userId).trim();
  if (acknowledgedBy === '') {
    throw new ServiceError(CODE.VALIDATION, '缺少确认人标识（userId）');
  }

  const id = safetyAckRepo.create({
    jobProcessId,
    acknowledgedBy,
    acknowledgedAt: ctx?.now ?? nowISO(),
  });
  return safetyAckRepo.findById(id);
}

/**
 * 关键工序执行前置门禁（需求 31.4–31.7，Property 16）：加载该 JOB 工序实例的快照
 * （供 `domain/safety.js` 判定 `isCritical` 与 `job_process_id` 归属过滤）与其安全警示
 * 确认记录集合，交由 `domain/safety.js` 的 `canEnterExecution` 裁定——**不重新实现**
 * 关键标记判定或确认记录完整性判定。
 * @param {number | string} jobProcessId
 * @param {string | number | null | undefined} userId 操作人员标识
 * @returns {ReturnType<typeof canEnterExecution>} `ok === true` 时的判定详情
 * @throws {ServiceError} 门禁未通过（422，`data.rejection` 携带 `domain/safety.js` 的
 *   `SAFETY_REJECTION` 原始拒绝原因码）
 */
export function checkEnterExecutionGate(jobProcessId, userId) {
  const step = jobStepSnapshotRepo.findByJobProcessId(jobProcessId);
  const acks = safetyAckRepo.listByJobProcessId(jobProcessId);

  const result = canEnterExecution(step, acks, userId);
  if (!result.ok) {
    throw new ServiceError(CODE.UNPROCESSABLE, result.message, { rejection: result.rejection });
  }
  return result;
}

// =====================================================================
// 五、电子签章签署（需求 32.2、32.3、45.4、45.5）
// =====================================================================

/** 按路径工卡与 JOB 引用解析执行实例，并强制二者归属一致。 */
function loadJobForCardOrThrow(cardId, reference) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) {
    throw new ServiceError(CODE.NOT_FOUND, `工卡不存在：${String(cardId)}`);
  }

  const source = reference === null || typeof reference !== 'object' ? {} : reference;
  const jobId = source.jobId ?? source.job_id;
  const jobNo = source.jobNo ?? source.job_no;
  if ((jobId === null || jobId === undefined || jobId === '')
      && (jobNo === null || jobNo === undefined || String(jobNo).trim() === '')) {
    throw new ServiceError(CODE.VALIDATION, '缺少 JOB 标识（jobId 或 jobNo）');
  }

  const job = jobId !== null && jobId !== undefined && jobId !== ''
    ? jobRepo.findById(jobId)
    : jobRepo.findByJobNo(String(jobNo));
  if (job === null) {
    throw new ServiceError(CODE.NOT_FOUND, 'JOB 不存在');
  }
  if (String(job.cardId) !== String(card.id)) {
    throw new ServiceError(CODE.UNPROCESSABLE, 'JOB 不属于路径所指定的工卡', {
      rejection: 'jobCardMismatch',
      cardId: card.id,
      jobId: job.id,
    });
  }
  return { card, job };
}

/** 从指定 JOB 的不可变工序快照中查找签署项，绝不回读编制域当前配置。 */
function findSnapshotSignatureRequirement(jobId, requirementId) {
  for (const jobProcess of jobProcessRepo.listByJobId(jobId)) {
    const snapshot = jobStepSnapshotRepo.findByJobProcessId(jobProcess.id);
    if (snapshot === null) continue;
    const content = parseSnapshotContent(snapshot.content);
    const requirements = Array.isArray(content?.signatureRequirements)
      ? content.signatureRequirements
      : [];
    const requirement = requirements.find(({ id }) => String(id) === String(requirementId));
    if (requirement !== undefined) return requirement;
  }
  return null;
}

/**
 * 电子签章签署。`cardId` 取自路由路径，`jobId/jobNo` 必须指向该工卡的 JOB，且签署项
 * 必须存在于该 JOB 的不可变快照中，杜绝跨卡、跨 JOB 伪造归档证据。
 */
export function signDocument(input, ctx) {
  const signedBy = operatorIdOf(ctx);
  const source = input === null || typeof input !== 'object' ? {} : input;
  const signatureRequirementId = source.signatureRequirementId ?? source.signature_requirement_id;
  if (signatureRequirementId === null || signatureRequirementId === undefined) {
    throw new ServiceError(CODE.VALIDATION, '缺少签署项标识（signatureRequirementId）');
  }

  const { card, job } = loadJobForCardOrThrow(source.cardId ?? source.card_id, source);
  const requirement = findSnapshotSignatureRequirement(job.id, signatureRequirementId);
  if (requirement === null) {
    throw new ServiceError(CODE.UNPROCESSABLE, '签署项不属于指定 JOB 的工序快照', {
      rejection: 'signatureRequirementJobMismatch',
      signatureRequirementId,
      jobId: job.id,
    });
  }

  const stampId = source.stampId ?? source.stamp_id ?? null;
  if ((requirement.stampRequired === 1 || requirement.stampRequired === true)
      && (stampId === null || String(stampId).trim() === '')) {
    throw new ServiceError(CODE.VALIDATION, '该签署项要求提供签章标识（stampId）');
  }

  const id = signatureRepo.create({
    cardId: card.id,
    jobId: job.id,
    signatureRequirementId,
    signedBy,
    stampId,
    signedAt: source.signedAt ?? source.signed_at ?? nowISO(),
  });
  return signatureRepo.findById(id);
}

// =====================================================================
// 六、无纸化归档完备性判定（需求 32.1–32.4，Property 17）
// =====================================================================

/**
 * 汇总某 JOB 全部工序快照 `content.signatureRequirements` 的并集（需求 32.4、45.6 的
 * 必需签署项唯一来源，已在释放时固化于快照——本函数不重新聚合编制域配置）。
 * @param {ReadonlyArray<object>} jobProcesses `jobProcessRepo.listByJobId` 的结果
 * @returns {object[]} 扁平化的签署项配置集合
 */
function gatherSignatureRequirementsFromSnapshots(jobProcesses) {
  const requirements = [];
  for (const jobProcess of jobProcesses) {
    const snapshot = jobStepSnapshotRepo.findByJobProcessId(jobProcess.id);
    if (snapshot === null) continue;
    const content = parseSnapshotContent(snapshot.content);
    if (Array.isArray(content?.signatureRequirements)) {
      requirements.push(...content.signatureRequirements);
    }
  }
  return requirements;
}

/**
 * 无纸化归档完备性判定（需求 32.1–32.4，Property 17）——**非抛出**的读式判定，直接
 * 回显 `domain/signature.js` 的 `canArchivePaperless(card, requirements, signatures)`
 * 判定对象。必需签署项取该 JOB 全部工序快照的并集；签署记录取该 JOB 的全部
 * `electronic_signature` 行；`card` 经 `taskCardRepo.findById`**只读**取得，仅用于
 * 结果回显与签署记录的工卡归属过滤，不参与完备性口径本身。
 * @param {number | string} jobId
 * @returns {ReturnType<typeof canArchivePaperless>}
 * @throws {ServiceError} JOB 不存在（404）
 */
export function checkPaperlessArchiveReadiness(jobId) {
  const job = loadJobOrThrow(jobId);
  const card = job.cardId === null || job.cardId === undefined ? null : taskCardRepo.findById(job.cardId);

  const jobProcesses = jobProcessRepo.listByJobId(jobId);
  const requirements = gatherSignatureRequirementsFromSnapshots(jobProcesses);
  const signatures = signatureRepo.listByJobId(jobId).filter(
    (signature) => String(signature.cardId) === String(job.cardId)
      && String(signature.jobId) === String(job.id),
  );

  return canArchivePaperless(card ?? job.cardId ?? null, requirements, signatures);
}

/** 路由级归档查询：先验证 path card 与 JOB 归属，再执行快照签署完备性判定。 */
export function checkCardArchiveReadiness(cardId, reference) {
  const { job } = loadJobForCardOrThrow(cardId, reference);
  return {
    jobId: job.id,
    jobNo: job.jobNo,
    ...checkPaperlessArchiveReadiness(job.id),
  };
}

/**
 * {@link checkPaperlessArchiveReadiness} 的**抛出**变体：不完备时 `throw
 * ServiceError(CODE.UNPROCESSABLE, ...)`，供未来「完成归档」一类需要中断流程的动作复用，
 * 不重新实现完备性判定。
 * @param {number | string} jobId
 * @returns {ReturnType<typeof canArchivePaperless>} `ok === true` 时的判定详情
 * @throws {ServiceError} JOB 不存在（404）；归档条件不完备（422，`data` 携带
 *   `domain/signature.js` 的 `rejection`/`missing` 明细）
 */
export function assertPaperlessArchiveReady(jobId) {
  const result = checkPaperlessArchiveReadiness(jobId);
  if (!result.ok) {
    throw new ServiceError(CODE.UNPROCESSABLE, result.message, {
      rejection: result.rejection,
      missing: result.missing,
    });
  }
  return result;
}

// =====================================================================
// 七、JOB 工序内容读取（Property 34 / 需求 49.6）—— 一律读快照
// =====================================================================

/**
 * 取某 JOB 工序实例的内容快照（需求 49.6，Property 34）——一律读
 * `jobStepSnapshotRepo`，**不读** `process_step` 当前内容（本文件通篇未导入
 * `processStepRepo.js`）。`content` 经 `domain/snapshot.js` 的 `parseSnapshotContent`
 * 解析为已冻结对象。
 * @param {number | string} jobProcessId
 * @returns {object} `{ id, jobProcessId, sourceStepId, sourceCardRevision, snapshotAt,
 *   content }`（`content` 为解析后的对象）
 * @throws {ServiceError} 该 JOB 工序实例尚无快照（404）
 */
export function getJobStepContent(jobProcessId) {
  const snapshot = jobStepSnapshotRepo.findByJobProcessId(jobProcessId);
  if (snapshot === null) {
    throw new ServiceError(CODE.NOT_FOUND, `工序内容快照不存在：${String(jobProcessId)}`);
  }
  return { ...snapshot, content: parseSnapshotContent(snapshot.content) };
}

export default {
  startJobProcess,
  finishJobProcess,
  writeManHours,
  acknowledgeSafetyWarning,
  checkEnterExecutionGate,
  signDocument,
  checkPaperlessArchiveReadiness,
  checkCardArchiveReadiness,
  assertPaperlessArchiveReady,
  getJobStepContent,
};
