/**
 * 工卡编制服务（Task Card Authoring Service）—— 事务边界与编辑态闸门的落地点（任务 13.1）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 服务层错误约定（供任务 13.2–13.11 全部服务模块遵循，详见 `lib/service-error.js`）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 本服务的全部函数在**校验失败或前置条件不满足时一律 `throw new ServiceError(code, message,
 * data)`**（`code` ∈ `lib/response.js` 的 `CODE`：400/401/403/404/409/422/500，与整个系统
 * 「非零 code 恒镜像为同值 HTTP status」的约定同一口径）。成功路径返回**纯业务数据**
 * （camelCase 对象），不做 `{ok, ...}` 或 `ok(data)` 信封包装——信封包装是路由层
 * （任务 17，`routes/*.js`）与统一错误处理中间件（任务 16.3）的职责：路由层 `try/catch`
 * `ServiceError` 并调用 `sendFail(res, error.code, error.message, error.data)`；未被
 * 识别的异常向上抛给应用级错误处理兜底为 500。
 *
 * 领域纯函数层（`domain/*.js`）的 `{ok, rejection, message, records}` 判定对象约定与本约定
 * **不冲突、不混用**：服务层是那些纯函数的消费方，读取其 `ok` 字段后决定是否 `throw
 * ServiceError`，而不是把判定对象原样向上传递。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 编辑态统一闸门（Property 26 / 需求 49.1–49.4、49.8）—— 服务层入口、领域校验之前
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 本服务的**全部内容变更操作**（`assertEditable` 的调用点）在函数体最前面执行闸门检查，
 * 早于任何枚举、Stage×类型、字段过滤等领域校验——闸门检查只依赖工卡当前状态，与其它校验
 * 正交，理应最先短路。闸门复用 `domain/card-rules.js` 的 `passesEditableGate`（内部即
 * `isEditable`），**不重新实现**状态判定逻辑。非 `New` 态一律 `422`（`CODE.UNPROCESSABLE`），
 * 其中 `Effective` 态给出专属提示「变更请先执行升版」（需求 49.3）。
 *
 * 需求 49.8 列举的非内容变更操作（查看/打印/导出/复制/升版/作废/发布）**不经本服务**，
 * 由任务 13.3–13.7 等其它服务实现；那些服务在需要复用编辑态闸门时（如批量替换）应直接
 * `import { passesEditableGate } from '../domain/card-rules.js'` 并传入对应的
 * `CONTENT_EDIT_OPERATIONS` 操作名——不应 import 本文件的内部 `assertEditable`（未导出），
 * 也不应把非内容变更操作包入本服务的任何导出函数。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 变更留痕单点（Property 35 / 需求 19.1–19.3、20.8、42.5）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `domain/change-record.js` 的 `buildChangeRecords` 是本服务**唯一**的 `change_record`
 * 行构造点：任何写路径都不手拼记录行。留痕覆盖面遵循 tasks.md 「关键实现约束 7」的字面
 * 列举——**保存（更新）与删除**两类路径经此留痕；**新增（创建工卡 / 新增工序 / 新增参考
 * 文件 / 新增采集项 / 新增组件 / 新增签署项）不产生留痕**（新增没有「变更前」可比对，
 * 亦不在该约束列举的五条路径——保存、删除、升版、批量替换、作废——之内；升版/批量替换/
 * 作废由任务 13.2/13.3/13.7 的专属服务实现）。
 *
 * 每次「保存」调用（即使净差异为空）仍**必须提供非空 `reason`**——`buildChangeRecords`
 * 在计算差异前先校验 `reason`，为空/纯空白整体拒绝且零产出（需求 19.2）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 只读带出字段剔除（需求 11.3、11.4、26.5、27.3、30.2）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 写入前一律经 {@link stripReadonlyFields} 剔除，复用 `domain/permission.js` 的
 * `isWritableField`（**不重新实现**只读字段判定）。`task_card` 表本身不含任何执行域字段
 * 或 Process Card 字段（两域分离，见 schema.sql 注释），故该表的剔除是空操作；
 * `process_step.operation` / `work_category` / `estimated_man_hours` 三列受此约束，
 * 任何角色经本服务写入均被剔除，即使显式传入亦不落库。
 *
 * 需求：3.1, 4.1, 7.2, 7.4, 9.1–9.3, 10.3, 11.1–11.4, 12.1–12.3, 13.1–13.3, 19.1, 19.2,
 *       26.5, 27.3, 30.2, 36.3, 45.1–45.5, 46.10, 46.11, 49.1–49.4, 49.8
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import { passesEditableGate, statusOf, INITIAL_REVISION, checkDuplicate } from '../domain/card-rules.js';
import { buildChangeRecords } from '../domain/change-record.js';
import { isValidEnumValue } from '../domain/enums.js';
import { validateStageCardType } from '../domain/stage-constraint.js';
import {
  isValidComponentType,
  normalizeComponentPayload,
  normalizeReferenceDocument,
  PayloadError,
} from '../domain/collections.js';
import { isWritableField } from '../domain/permission.js';
import { generateProcessId } from '../domain/process-id.js';

import taskCardRepo, { TASK_CARD_COLUMNS } from '../repositories/taskCardRepo.js';
import referenceDocRepo from '../repositories/referenceDocRepo.js';
import processStepRepo, { PROCESS_STEP_COLUMNS } from '../repositories/processStepRepo.js';
import captureItemRepo from '../repositories/captureItemRepo.js';
import componentRepo from '../repositories/componentRepo.js';
import signatureRequirementRepo from '../repositories/signatureRequirementRepo.js';
import changeRecordRepo from '../repositories/changeRecordRepo.js';
import stageConstraintRepo from '../repositories/stageConstraintRepo.js';
import relationRepo from '../repositories/relationRepo.js';
import attachmentRepo from '../repositories/attachmentRepo.js';
import jobRepo from '../repositories/jobRepo.js';
import jobProcessRepo from '../repositories/jobProcessRepo.js';
import jobStepSnapshotRepo from '../repositories/jobStepSnapshotRepo.js';
import { toCamelCase, toSnakeCase } from '../repositories/case-convert.js';

// =====================================================================
// 一、内部辅助（不导出）
// =====================================================================

/** 今日日期 `YYYY-MM-DD`（需求 7.2 新建默认当天；需求 7.4 保存自动记录 Last Update）。 */
function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果（服务层事务边界的统一入口）。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * 取调用上下文中的操作人标识（`staff_no`），供 `created_by` / `operator_id` 落位与变更留痕
 * 的 `operatorId` 参数。identity 中间件（任务 16）落地前，兼容 `operatorId` / `staffNo` /
 * `userId` 三种写法；缺失一律拒绝——变更须可追溯到人（需求 19.3、7.4）。
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
 * 按主键取工卡，取不到即 `404`（存在性检查先于闸门检查——闸门需要先加载到工卡才能判定状态）。
 * @param {number | string} id
 * @returns {object}
 */
function loadCardOrThrow(id) {
  const card = taskCardRepo.findById(id);
  if (card === null) {
    throw new ServiceError(CODE.NOT_FOUND, `工卡不存在：${String(id)}`);
  }
  return card;
}

/**
 * 编辑态统一闸门（Property 26 / 需求 49.1–49.4）——**服务层入口、领域校验之前**调用。
 * 复用 `card-rules.js` 的 `passesEditableGate`，非 `New` 态一律 `422`；`Effective` 态给出
 * 专属提示（需求 49.3）。
 * @param {object} card
 * @param {string} operation `card-rules.js` `CONTENT_EDIT_OPERATIONS` 中登记的操作名
 */
function assertEditable(card, operation) {
  if (passesEditableGate(card, operation)) return;
  const status = statusOf(card);
  const message = status === 'Effective'
    ? '该工卡已生效，变更请先执行升版'
    : '当前工卡状态不可编辑';
  throw new ServiceError(CODE.UNPROCESSABLE, message, { status, operation });
}

function assertClassificationNotDirectlyWritten(input) {
  if (input === null || typeof input !== 'object') return;
  const forbidden = ['commercialClassification', 'commercial_classification', 'outsourceSubtype', 'outsource_subtype'];
  const fields = forbidden.filter((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (fields.length > 0) {
    throw new ServiceError(
      CODE.VALIDATION,
      '商务分类及 Outsource subtype 只能通过分类派生/确认接口写入',
      { rejection: 'COMMERCIAL_CLASSIFICATION_DIRECT_WRITE_FORBIDDEN', fields },
    );
  }
}

/**
 * 将入参对象过滤为 `columns`（snake_case 列名集合）中登记的字段，返回 camelCase 键的对象；
 * 入参可为 camelCase 或 snake_case 写法，`undefined` 视为未提供（跳过）。
 * @param {unknown} input
 * @param {readonly string[]} columns
 * @returns {Record<string, unknown>}
 */
function filterToKnownColumns(input, columns) {
  const result = {};
  if (input === null || typeof input !== 'object') return result;
  const allowed = new Set(columns);
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) continue;
    const snake = toSnakeCase(key);
    if (!allowed.has(snake)) continue;
    result[toCamelCase(snake)] = input[key];
  }
  return result;
}

/**
 * 剔除入参对象中的只读带出字段（需求 11.3、11.4、26.5、27.3、30.2）——复用
 * `domain/permission.js` 的 `isWritableField`，按 `<表名>.<字段>` 限定名逐键判定，
 * 不重新实现只读字段判定逻辑。
 * @param {string} tableName snake_case 表名（如 `'process_step'`）
 * @param {Record<string, unknown>} input camelCase 或 snake_case 键的对象
 * @returns {Record<string, unknown>} 剔除只读字段后的新对象（不修改入参）
 */
function stripReadonlyFields(tableName, input) {
  const result = {};
  if (input === null || typeof input !== 'object') return result;
  for (const key of Object.keys(input)) {
    if (!isWritableField(`${tableName}.${key}`)) continue;
    result[key] = input[key];
  }
  return result;
}

/** 工卡元数据枚举字段（camelCase 逻辑字段名），存在即校验，缺省（`null`/`undefined`）放行。 */
const CARD_ENUM_FIELDS = Object.freeze([
  'acType', 'gearType', 'stage', 'skill', 'ctrlCode', 'cardType',
  'commercialClassification', 'outsourceSubtype',
]);

/**
 * 校验工卡元数据的枚举封闭性（需求 6.9），仅校验存在的字段；非法值 `throw` `400`。
 * @param {Record<string, unknown>} card camelCase 工卡对象（可为部分字段）
 */
function validateCardEnums(card) {
  for (const field of CARD_ENUM_FIELDS) {
    const value = card[field];
    if (value === null || value === undefined) continue;
    if (!isValidEnumValue(field, value)) {
      throw new ServiceError(CODE.VALIDATION, `字段 ${field} 取值非法：${String(value)}`, { field, value });
    }
  }
}

/** 取 Stage×工卡类型约束的运行时权威配置（需求 46.14：改配置不改代码）。 */
function loadStageCfg() {
  return {
    constraints: stageConstraintRepo.list(),
    crosscut: stageConstraintRepo.listCrosscut(),
  };
}

/**
 * 校验工卡的 Stage × 工卡类型组合合法性（需求 46.10、46.11），非法组合 `throw` `400`
 * 并附带该类型的可选 Stage 范围提示。仅在 `stage` 已提供时校验（`stage` 列可为空）。
 * @param {Record<string, unknown>} card camelCase 工卡对象
 * @param {unknown} cfg {@link loadStageCfg} 的返回值
 */
function validateStageCardTypeOrThrow(card, cfg) {
  const result = validateStageCardType(card.stage, card.cardType, cfg);
  if (!result.ok) {
    throw new ServiceError(CODE.VALIDATION, result.message, {
      rejection: result.rejection,
      selectableStages: result.selectableStages,
    });
  }
}

/**
 * 取工序所属工卡（供以 stepId 为入口的子实体维护函数复用）；工序不存在即 `404`。
 * @param {number | string} stepId
 * @returns {{ step: object, card: object }}
 */
function loadStepAndCard(stepId) {
  const step = processStepRepo.findById(stepId);
  if (step === null) {
    throw new ServiceError(CODE.NOT_FOUND, `工序不存在：${String(stepId)}`);
  }
  const card = loadCardOrThrow(step.cardId);
  return { step, card };
}

/**
 * 校验 `buildChangeRecords` 判定结果，拒绝时 `throw` `400`（含空/纯空白变更原因）。
 * @param {ReturnType<typeof buildChangeRecords>} diff
 */
function assertChangeRecordOk(diff) {
  if (!diff.ok) {
    throw new ServiceError(CODE.VALIDATION, diff.message, { rejection: diff.rejection });
  }
}

function componentWriteOrThrow(stepId, component, excludedId = null) {
  const type = component?.type;
  if (type !== undefined && type !== null && !isValidComponentType(type)) {
    throw new ServiceError(CODE.VALIDATION, `组件类型非法：${String(type)}`);
  }
  if (type === 'tool' || type === 'consumable') {
    const duplicate = componentRepo.listByStepId(stepId).some((entry) =>
      entry.type === type && String(entry.id) !== String(excludedId));
    if (duplicate) {
      throw new ServiceError(CODE.VALIDATION, `每道工序最多只能有一个${type === 'tool' ? '工具' : '耗材'}表`);
    }
  }
  try {
    return {
      ...component,
      ...(type === undefined ? {} : { payload: normalizeComponentPayload(type, component?.payload) }),
    };
  } catch (error) {
    if (error instanceof PayloadError) throw new ServiceError(CODE.VALIDATION, error.message);
    throw error;
  }
}

function buildRenumberPlan(card, orderedSteps, reason, operatorId) {
  const records = [];
  const updates = orderedSteps.map((before, index) => {
    const after = { ...before, seq: index + 1, processId: generateProcessId(card, index + 1) };
    const diff = buildChangeRecords(before, after, 'edit', reason, operatorId, {
      cardId: card.id,
      cardRevision: card.revision,
    });
    assertChangeRecordOk(diff);
    records.push(...diff.records);
    return { id: before.id, seq: after.seq, processId: after.processId };
  });
  return { updates, records };
}

function applyRenumberPlan(cardId, plan) {
  for (const { id } of plan.updates) {
    processStepRepo.update(id, { processId: `TMP_${cardId}_${id}` });
  }
  for (const update of plan.updates) {
    processStepRepo.update(update.id, { seq: update.seq, processId: update.processId });
  }
}

// =====================================================================
// 二、工卡元数据：创建 / 保存
// =====================================================================

/**
 * 新增工卡（需求 3.1、4.1、7.2、7.4、36.3）。
 *
 * 默认值：`status='New'`（需求 4.1）、`date` 默认当天（需求 7.2）、`isFai` 默认 `false`
 * （需求 36.3）、`revision` 恒为初始版本 {@link INITIAL_REVISION}（不接受客户端指定——与
 * `copyCard`/`reviseCard` 的复制/升版语义区分，创建即是一张全新工卡的第 1 版）。
 * 无既有工卡，不经编辑态闸门（新增恒被允许）；**不产生 `change_record`**（新增没有
 * 「变更前」可比对，亦不在 tasks.md 「保存/删除/升版/批量替换/作废」五条留痕路径之内）。
 *
 * @param {Record<string, unknown>} input camelCase 或 snake_case 工卡字段
 * @param {{operatorId?: string, staffNo?: string}} ctx 调用上下文
 * @returns {object} 新建的工卡（camelCase）
 * @throws {ServiceError} 必填字段缺失（400）、枚举非法（400）、Stage×类型组合非法（400）、
 *   `(taskNo, revision)` 已存在（409）
 */
export function createCard(input, ctx) {
  assertClassificationNotDirectlyWritten(input);
  const operatorId = operatorIdOf(ctx);
  const source = input === null || typeof input !== 'object' ? {} : input;

  const taskNo = source.taskNo ?? source.task_no;
  const title = source.title;
  const cardType = source.cardType ?? source.card_type;
  if (typeof taskNo !== 'string' || taskNo.trim() === '') {
    throw new ServiceError(CODE.VALIDATION, 'Task No 为必填项');
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new ServiceError(CODE.VALIDATION, 'Title 为必填项');
  }
  if (typeof cardType !== 'string' || cardType.trim() === '') {
    throw new ServiceError(CODE.VALIDATION, '工卡类型（WBS）为必填项');
  }

  const filtered = filterToKnownColumns(source, TASK_CARD_COLUMNS);
  const today = todayISODate();

  const card = {
    ...filtered,
    taskNo,
    title,
    cardType,
    revision: INITIAL_REVISION,
    status: 'New',
    date: filtered.date ?? today,
    isFai: filtered.isFai ?? false,
    createdBy: operatorId,
    operatorId,
    lastUpdate: today,
  };

  validateCardEnums(card);
  if (card.stage !== undefined && card.stage !== null) {
    validateStageCardTypeOrThrow(card, loadStageCfg());
  }

  const duplicate = taskCardRepo.findByTaskNoAndRevision(card.taskNo, card.revision);
  if (duplicate !== null) {
    throw new ServiceError(
      CODE.CONFLICT,
      `工卡编号 ${card.taskNo} 的版本 ${card.revision} 已存在`,
      { rejection: 'DUPLICATE_TASK_NO' },
    );
  }

  return withTransaction(() => {
    const id = taskCardRepo.create(card);
    return taskCardRepo.findById(id);
  });
}

/**
 * 保存（更新）工卡元数据（需求 3.1、7.4、46.10、46.11，Property 26、Property 35）。
 *
 * 入口即执行编辑态闸门（非 `New` 态 `422`）。`status` / `revision` / `taskNo` 不接受经
 * 本函数改写——状态迁移由审核/作废专属服务管理（任务 13.2、13.7），版本号与编号由升版/
 * 复制专属服务管理（任务 13.3），本函数擅自改写会绕开各自的三道防线校验。`lastUpdate` /
 * `operatorId` 恒由本函数重新戳记（需求 7.4），不接受客户端指定。
 *
 * 每次调用都须提供非空 `reason`（需求 19.2），经 `buildChangeRecords` 产出并写入
 * `change_record`（Property 35 唯一构造点）；净差异为空时仍要求 `reason`，但不产生记录行。
 *
 * @param {number | string} id
 * @param {Record<string, unknown>} patch camelCase 或 snake_case 待更新字段
 * @param {{operatorId?: string, staffNo?: string}} ctx 调用上下文
 * @param {string} reason 变更原因（必填）
 * @returns {object} 更新后的工卡（camelCase）
 * @throws {ServiceError} 工卡不存在（404）、非 New 态（422）、枚举非法（400）、
 *   Stage×类型组合非法（400）、变更原因为空（400）
 */
export function updateCard(id, patch, ctx, reason) {
  assertClassificationNotDirectlyWritten(patch);
  const before = loadCardOrThrow(id);
  assertEditable(before, 'cardSave');
  const operatorId = operatorIdOf(ctx);

  const filteredPatch = filterToKnownColumns(patch, TASK_CARD_COLUMNS);
  delete filteredPatch.status;      // 状态迁移由审核/作废专属服务管理
  delete filteredPatch.revision;    // 版本号由升版专属服务管理
  delete filteredPatch.taskNo;      // 编号由升版/复制专属服务管理
  delete filteredPatch.lastUpdate;  // 恒由本函数重新戳记
  delete filteredPatch.operatorId;  // 恒由本函数重新戳记

  const today = todayISODate();
  const after = { ...before, ...filteredPatch, operatorId, lastUpdate: today };

  validateCardEnums(after);
  if (after.stage !== undefined && after.stage !== null) {
    validateStageCardTypeOrThrow(after, loadStageCfg());
  }

  const diff = buildChangeRecords(before, after, 'edit', reason, operatorId, {
    cardId: Number(id),
    cardRevision: after.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    taskCardRepo.update(id, { ...filteredPatch, operatorId, lastUpdate: today });
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return taskCardRepo.findById(id);
  });
}

/**
 * 按主键取工卡（只读，需求 3.5 查看详情）——非内容变更操作，**不经编辑态闸门**（需求 49.8）。
 * @param {number | string} id
 * @returns {object} camelCase 工卡
 * @throws {ServiceError} 不存在（404）
 */
export function getCard(id) {
  return loadCardOrThrow(id);
}

/** List task cards using the repository's AND-combined filters and pagination semantics. */
export function listCards(options = {}) {
  const parsePositive = (value, fallback, label) => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ServiceError(CODE.VALIDATION, `${label} 必须为正整数`);
    }
    return parsed;
  };
  return taskCardRepo.list({
    ...options,
    page: parsePositive(options.page, 1, 'page'),
    pageSize: parsePositive(options.pageSize, 20, 'pageSize'),
  });
}

/** Return the complete authoring aggregate, optionally enriched with immutable JOB execution data. */
export function getCardDetail(id, jobNo) {
  const card = loadCardOrThrow(id);
  const steps = processStepRepo.listByCardId(id).map((step) => ({
    ...step,
    captureItems: captureItemRepo.listByStepId(step.id),
    components: componentRepo.listByStepId(step.id),
    signatureRequirements: signatureRequirementRepo.listByStepId(step.id),
  }));
  const detail = {
    ...card,
    referenceDocuments: referenceDocRepo.listByCardId(id),
    steps,
    signatureRequirements: signatureRequirementRepo.listByCardId(id),
    relations: relationRepo.listByCardId(id),
    changeRecords: changeRecordRepo.listByCardId(id),
  };

  if (jobNo === undefined || jobNo === null || String(jobNo).trim() === '') return detail;
  const job = jobRepo.findByJobNo(String(jobNo).trim());
  if (job === null || String(job.cardId) !== String(id)) {
    throw new ServiceError(CODE.NOT_FOUND, `JOB 不存在或不属于该工卡：${String(jobNo)}`);
  }
  const snapshotsByProcess = new Map(
    jobStepSnapshotRepo.listByJobId(job.id).map((snapshot) => [String(snapshot.jobProcessId), snapshot]),
  );
  const processes = jobProcessRepo.listByJobId(job.id).map((process) => {
    const snapshot = snapshotsByProcess.get(String(process.id)) ?? null;
    return {
      ...process,
      snapshot: snapshot === null
        ? null
        : { ...snapshot, content: typeof snapshot.content === 'string' ? JSON.parse(snapshot.content) : snapshot.content },
    };
  });
  return { ...detail, jobContext: { ...job, processes } };
}

export function listCardVersions(id) {
  const card = loadCardOrThrow(id);
  return taskCardRepo.listVersionsByTaskNo(card.taskNo);
}

export function checkCardDuplicate(taskNo, revision, excludeId) {
  if (typeof taskNo !== 'string' || taskNo.trim() === '') {
    throw new ServiceError(CODE.VALIDATION, 'taskNo 为必填项');
  }
  const numericRevision = Number(revision);
  if (!Number.isInteger(numericRevision)) {
    throw new ServiceError(CODE.VALIDATION, 'revision 必须为整数');
  }
  const existing = taskCardRepo.findByTaskNoAndRevision(taskNo, numericRevision);
  return checkDuplicate(existing === null ? [] : [existing], taskNo, numericRevision, excludeId);
}

/** Bind an uploaded attachment into a card step through the existing component-write gate. */
export function bindAttachmentReference(cardId, input, ctx) {
  const stepId = input?.stepId ?? input?.step_id;
  const attachmentId = input?.attachmentId ?? input?.attachment_id;
  const step = processStepRepo.findById(stepId);
  if (step === null || String(step.cardId) !== String(cardId)) {
    throw new ServiceError(CODE.NOT_FOUND, `工序不存在或不属于该工卡：${String(stepId)}`);
  }
  const attachment = attachmentRepo.findById(attachmentId);
  if (attachment === null) {
    throw new ServiceError(CODE.NOT_FOUND, `附件不存在：${String(attachmentId)}`);
  }
  const type = input?.type ?? attachment.kind;
  if (type !== attachment.kind || !isValidComponentType(type)) {
    throw new ServiceError(CODE.VALIDATION, '附件类型与组件类型不一致');
  }
  const payload = {
    ...(input?.payload && typeof input.payload === 'object' ? input.payload : {}),
    attachmentId: attachment.id,
    url: `/api/attachments/${attachment.id}`,
  };
  return addComponent(stepId, { type, payload, sortOrder: input?.sortOrder }, ctx);
}

// =====================================================================
// 三、参考文件增删（需求 9.1–9.3）
// =====================================================================

/**
 * 新增参考文件（需求 9.1、9.3）。经编辑态闸门；新增不产生 `change_record`。
 * @param {number | string} cardId
 * @param {Record<string, unknown>} doc `{docType, refNo, docRevision, ataChapter}`
 * @param {{operatorId?: string}} ctx
 * @returns {object} 新增的参考文件
 */
export function addReferenceDocument(cardId, doc, ctx) {
  const card = loadCardOrThrow(cardId);
  assertEditable(card, 'referenceDocAdd');
  operatorIdOf(ctx);

  const normalized = normalizeReferenceDocument({ ...doc, cardId });
  return withTransaction(() => {
    const id = referenceDocRepo.create({
      cardId,
      docType: normalized.docType,
      refNo: normalized.refNo,
      docRevision: normalized.docRevision,
      ataChapter: normalized.ataChapter,
    });
    return referenceDocRepo.findById(id);
  });
}

/**
 * 删除参考文件（需求 9.2）。经编辑态闸门；经 `buildChangeRecords` 写 `delete` 类型留痕
 * （tasks.md 关键约束 7「工序/参考文件删除」）。
 * @param {number | string} cardId
 * @param {number | string} docId
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {{removed: true, id: number|string}}
 */
export function removeReferenceDocument(cardId, docId, ctx, reason) {
  const card = loadCardOrThrow(cardId);
  assertEditable(card, 'referenceDocDelete');
  const operatorId = operatorIdOf(ctx);

  const before = referenceDocRepo.findById(docId);
  if (before === null || String(before.cardId) !== String(cardId)) {
    throw new ServiceError(CODE.NOT_FOUND, `参考文件不存在：${String(docId)}`);
  }

  const diff = buildChangeRecords(before, null, 'delete', reason, operatorId, {
    cardId: Number(cardId),
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    referenceDocRepo.remove(docId);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return { removed: true, id: docId };
  });
}

// =====================================================================
// 四、工序增删改与排序（需求 10.1–10.3、11.1–11.4、12.1–12.3、30.1、30.2）
// =====================================================================

/**
 * 新增一道工序（需求 11.1：自动生成 Process ID；需求 30.1、30.2、11.3、11.4：只读带出字段
 * 恒被剔除）。`seq` 缺省取该工卡当前工序数 + 1（追加至末尾）；`processId` 由
 * `generateProcessId` 依 `seq` 生成，不接受客户端指定（需求 11.1「按固定规则自动生成」）。
 * 经编辑态闸门；新增不产生 `change_record`。
 *
 * @param {number | string} cardId
 * @param {Record<string, unknown>} input camelCase 或 snake_case 工序字段
 *   （`operation`/`workCategory`/`estimatedManHours` 即使传入亦被剔除，见需求 30.2、11.3）
 * @param {{operatorId?: string}} ctx
 * @returns {object} 新增的工序（camelCase）
 */
export function addProcessStep(cardId, input, ctx, reason) {
  const card = loadCardOrThrow(cardId);
  assertEditable(card, 'stepCreate');
  const operatorId = operatorIdOf(ctx);

  const filtered = filterToKnownColumns(input, PROCESS_STEP_COLUMNS);
  const writable = stripReadonlyFields('process_step', filtered);

  if (writable.skill !== undefined && writable.skill !== null && !isValidEnumValue('skill', writable.skill)) {
    throw new ServiceError(CODE.VALIDATION, `Skill 取值非法：${String(writable.skill)}`);
  }

  const existing = processStepRepo.listByCardId(cardId);
  const seq = writable.seq ?? existing.reduce(
    (maximum, step) => Math.max(maximum, Number(step.seq) || 0),
    0,
  ) + 1;
  const processId = generateProcessId(card, seq);

  return withTransaction(() => {
    const id = processStepRepo.create({ ...writable, cardId, seq, processId });
    const created = processStepRepo.findById(id);
    if (reason !== undefined) {
      const diff = buildChangeRecords(null, created, 'edit', reason, operatorId, {
        cardId: card.id,
        cardRevision: card.revision,
      });
      assertChangeRecordOk(diff);
      if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    }
    return created;
  });
}

/**
 * 更新一道工序（需求 12.1、11.2；需求 30.2、11.3、11.4：只读带出字段恒被剔除）。
 * 经编辑态闸门（依工序所属工卡状态判定）；经 `buildChangeRecords` 写 `edit` 类型留痕，
 * 变更原因必填（需求 19.2）。`processId` / `cardId` 不接受经本函数改写。
 *
 * @param {number | string} stepId
 * @param {Record<string, unknown>} patch
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {object} 更新后的工序（camelCase）
 */
export function updateProcessStep(stepId, patch, ctx, reason) {
  const { step: before, card } = loadStepAndCard(stepId);
  assertEditable(card, 'stepUpdate');
  const operatorId = operatorIdOf(ctx);

  const filtered = filterToKnownColumns(patch, PROCESS_STEP_COLUMNS);
  const writable = stripReadonlyFields('process_step', filtered);
  delete writable.processId;
  delete writable.cardId;

  if (writable.skill !== undefined && writable.skill !== null && !isValidEnumValue('skill', writable.skill)) {
    throw new ServiceError(CODE.VALIDATION, `Skill 取值非法：${String(writable.skill)}`);
  }

  const after = { ...before, ...writable };
  const diff = buildChangeRecords(before, after, 'edit', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    processStepRepo.update(stepId, writable);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return processStepRepo.findById(stepId);
  });
}

/**
 * 删除一道工序（`ON DELETE CASCADE` 联动清除其下采集项/组件/签署项）。经编辑态闸门；
 * 经 `buildChangeRecords` 写 `delete` 类型留痕（tasks.md 关键约束 7）。
 *
 * @param {number | string} stepId
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {{removed: true, id: number|string}}
 */
export function removeProcessStep(stepId, ctx, reason) {
  const { step: before, card } = loadStepAndCard(stepId);
  assertEditable(card, 'stepDelete');
  const operatorId = operatorIdOf(ctx);
  const existing = processStepRepo.listByCardId(card.id);
  if (existing.length <= 1) {
    throw new ServiceError(CODE.UNPROCESSABLE, '工卡至少须保留一道工序', {
      rejection: 'LAST_PROCESS_STEP',
    });
  }

  const deletion = buildChangeRecords(before, null, 'delete', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(deletion);
  const renumber = buildRenumberPlan(
    card,
    existing.filter((step) => String(step.id) !== String(stepId)),
    reason,
    operatorId,
  );

  return withTransaction(() => {
    for (const { id } of renumber.updates) {
      processStepRepo.update(id, { processId: `TMP_${card.id}_${id}` });
    }
    processStepRepo.remove(stepId);
    for (const update of renumber.updates) {
      processStepRepo.update(update.id, { seq: update.seq, processId: update.processId });
    }
    const records = [...deletion.records, ...renumber.records];
    if (records.length > 0) changeRecordRepo.createMany(records);
    return { removed: true, id: stepId, steps: processStepRepo.listByCardId(card.id) };
  });
}

/**
 * 工序排序：验证提交的是当前工卡全部工序的无重复精确集合，并在单事务内通过临时
 * Process ID 避免唯一键碰撞，最终同时重建连续 seq 与 A…Z/AA Process ID。
 */
export function reorderProcessSteps(cardId, orderedStepIds, ctx, reason) {
  const card = loadCardOrThrow(cardId);
  assertEditable(card, 'stepReorder');
  const operatorId = operatorIdOf(ctx);

  const existing = processStepRepo.listByCardId(cardId);
  const existingIds = new Set(existing.map((step) => String(step.id)));
  const orderedIds = Array.isArray(orderedStepIds) ? orderedStepIds.map(String) : [];
  const sameSet = orderedIds.length === existing.length
    && new Set(orderedIds).size === existing.length
    && orderedIds.every((id) => existingIds.has(id));
  if (!sameSet) {
    throw new ServiceError(CODE.VALIDATION, '排序列表须恰好包含该工卡现有的全部工序，不多不少');
  }

  const byId = new Map(existing.map((step) => [String(step.id), step]));
  const plan = buildRenumberPlan(card, orderedIds.map((id) => byId.get(id)), reason, operatorId);
  return withTransaction(() => {
    applyRenumberPlan(cardId, plan);
    if (plan.records.length > 0) changeRecordRepo.createMany(plan.records);
    return processStepRepo.listByCardId(cardId);
  });
}

// =====================================================================
// 五、数据采集项维护（需求 12.2、12.3）
// =====================================================================

/**
 * 新增数据采集项（需求 12.2、12.3）。经编辑态闸门（依工序所属工卡）；新增不产生
 * `change_record`。`type` 须属 13 类组件类型（与插入组件共用类型定义，需求 12.2）。
 * @param {number | string} stepId
 * @param {Record<string, unknown>} item `{type, itemKey, label, config, required, sortOrder}`
 * @param {{operatorId?: string}} ctx
 * @returns {object} 新增的采集项（camelCase，`config` 已解析回对象）
 */
export function addCaptureItem(stepId, item, ctx) {
  const { card } = loadStepAndCard(stepId);
  assertEditable(card, 'captureItemWrite');
  operatorIdOf(ctx);

  if (item?.type !== undefined && !isValidComponentType(item.type)) {
    throw new ServiceError(CODE.VALIDATION, `采集项类型非法：${String(item.type)}`);
  }

  return withTransaction(() => {
    const id = captureItemRepo.create({ ...item, stepId });
    return captureItemRepo.findById(id);
  });
}

/**
 * 更新数据采集项（整行覆盖式写入，与仓储层序列化管道一致）。经编辑态闸门；
 * 经 `buildChangeRecords` 写 `edit` 类型留痕。
 * @param {number | string} itemId
 * @param {Record<string, unknown>} patch
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {object} 更新后的采集项
 */
export function updateCaptureItem(itemId, patch, ctx, reason) {
  const before = captureItemRepo.findById(itemId);
  if (before === null) throw new ServiceError(CODE.NOT_FOUND, `数据采集项不存在：${String(itemId)}`);
  const { card } = loadStepAndCard(before.stepId);
  assertEditable(card, 'captureItemWrite');
  const operatorId = operatorIdOf(ctx);

  if (patch?.type !== undefined && !isValidComponentType(patch.type)) {
    throw new ServiceError(CODE.VALIDATION, `采集项类型非法：${String(patch.type)}`);
  }

  const after = { ...before, ...patch };
  const diff = buildChangeRecords(before, after, 'edit', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    captureItemRepo.update(itemId, after);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return captureItemRepo.findById(itemId);
  });
}

/**
 * 删除数据采集项。经编辑态闸门；经 `buildChangeRecords` 写 `delete` 类型留痕。
 * @param {number | string} itemId
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {{removed: true, id: number|string}}
 */
export function removeCaptureItem(itemId, ctx, reason) {
  const before = captureItemRepo.findById(itemId);
  if (before === null) throw new ServiceError(CODE.NOT_FOUND, `数据采集项不存在：${String(itemId)}`);
  const { card } = loadStepAndCard(before.stepId);
  assertEditable(card, 'captureItemWrite');
  const operatorId = operatorIdOf(ctx);

  const diff = buildChangeRecords(before, null, 'delete', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    captureItemRepo.remove(itemId);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return { removed: true, id: itemId };
  });
}

// =====================================================================
// 六、插入组件维护（需求 13.1–13.3、18.1、18.2）
// =====================================================================

/**
 * 新增插入组件（需求 13.1–13.3）。经编辑态闸门；新增不产生 `change_record`。
 * @param {number | string} stepId
 * @param {Record<string, unknown>} component `{type, payload, sortOrder}`
 * @param {{operatorId?: string}} ctx
 * @returns {object} 新增的组件（camelCase，`payload` 已解析回对象）
 */
export function addComponent(stepId, component, ctx) {
  const { card } = loadStepAndCard(stepId);
  assertEditable(card, 'componentWrite');
  operatorIdOf(ctx);
  const writable = componentWriteOrThrow(stepId, component);

  return withTransaction(() => {
    try {
      const id = componentRepo.create({ ...writable, stepId });
      return componentRepo.findById(id);
    } catch (error) {
      if (error instanceof PayloadError) throw new ServiceError(CODE.VALIDATION, error.message);
      throw error;
    }
  });
}

/**
 * 更新插入组件（整行覆盖式写入）。经编辑态闸门；经 `buildChangeRecords` 写 `edit` 类型留痕。
 * @param {number | string} componentId
 * @param {Record<string, unknown>} patch
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {object} 更新后的组件
 */
export function updateComponent(componentId, patch, ctx, reason) {
  const before = componentRepo.findById(componentId);
  if (before === null) throw new ServiceError(CODE.NOT_FOUND, `插入组件不存在：${String(componentId)}`);
  const { card } = loadStepAndCard(before.stepId);
  assertEditable(card, 'componentWrite');
  const operatorId = operatorIdOf(ctx);
  const after = componentWriteOrThrow(before.stepId, { ...before, ...patch }, componentId);
  const diff = buildChangeRecords(before, after, 'edit', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    try {
      componentRepo.update(componentId, after);
      if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
      return componentRepo.findById(componentId);
    } catch (error) {
      if (error instanceof PayloadError) throw new ServiceError(CODE.VALIDATION, error.message);
      throw error;
    }
  });
}

/**
 * 删除插入组件。经编辑态闸门；经 `buildChangeRecords` 写 `delete` 类型留痕。
 * @param {number | string} componentId
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {{removed: true, id: number|string}}
 */
export function removeComponent(componentId, ctx, reason) {
  const before = componentRepo.findById(componentId);
  if (before === null) throw new ServiceError(CODE.NOT_FOUND, `插入组件不存在：${String(componentId)}`);
  const { card } = loadStepAndCard(before.stepId);
  assertEditable(card, 'componentWrite');
  const operatorId = operatorIdOf(ctx);

  const diff = buildChangeRecords(before, null, 'delete', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    componentRepo.remove(componentId);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return { removed: true, id: componentId };
  });
}

// =====================================================================
// 七、签署项配置（需求 45.1–45.5）
// =====================================================================

/**
 * 新增签署项配置（需求 45.1–45.5）。经编辑态闸门；新增不产生 `change_record`。
 * `signatureRole` 存在时校验枚举封闭性（需求 45.2）。
 * @param {number | string} stepId
 * @param {Record<string, unknown>} requirement `{signatureRole, stampRequired, dateRequired, sortOrder}`
 * @param {{operatorId?: string}} ctx
 * @returns {object} 新增的签署项
 */
export function addSignatureRequirement(stepId, requirement, ctx) {
  const { card } = loadStepAndCard(stepId);
  assertEditable(card, 'signatureRequirementWrite');
  operatorIdOf(ctx);

  const role = requirement?.signatureRole;
  if (role !== undefined && role !== null && !isValidEnumValue('signatureRole', role)) {
    throw new ServiceError(CODE.VALIDATION, `签署角色取值非法：${String(role)}`);
  }

  return withTransaction(() => {
    const id = signatureRequirementRepo.create({ ...requirement, stepId });
    return signatureRequirementRepo.findById(id);
  });
}

/**
 * 更新签署项配置。经编辑态闸门；经 `buildChangeRecords` 写 `edit` 类型留痕。
 * @param {number | string} requirementId
 * @param {Record<string, unknown>} patch
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {object} 更新后的签署项
 */
export function updateSignatureRequirement(requirementId, patch, ctx, reason) {
  const before = signatureRequirementRepo.findById(requirementId);
  if (before === null) {
    throw new ServiceError(CODE.NOT_FOUND, `签署项不存在：${String(requirementId)}`);
  }
  const { card } = loadStepAndCard(before.stepId);
  assertEditable(card, 'signatureRequirementWrite');
  const operatorId = operatorIdOf(ctx);

  const role = patch?.signatureRole;
  if (role !== undefined && role !== null && !isValidEnumValue('signatureRole', role)) {
    throw new ServiceError(CODE.VALIDATION, `签署角色取值非法：${String(role)}`);
  }

  const after = { ...before, ...patch };
  const diff = buildChangeRecords(before, after, 'edit', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    signatureRequirementRepo.update(requirementId, after);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return signatureRequirementRepo.findById(requirementId);
  });
}

/**
 * 删除签署项配置。经编辑态闸门；经 `buildChangeRecords` 写 `delete` 类型留痕。
 * @param {number | string} requirementId
 * @param {{operatorId?: string}} ctx
 * @param {string} reason 变更原因（必填）
 * @returns {{removed: true, id: number|string}}
 */
export function removeSignatureRequirement(requirementId, ctx, reason) {
  const before = signatureRequirementRepo.findById(requirementId);
  if (before === null) {
    throw new ServiceError(CODE.NOT_FOUND, `签署项不存在：${String(requirementId)}`);
  }
  const { card } = loadStepAndCard(before.stepId);
  assertEditable(card, 'signatureRequirementWrite');
  const operatorId = operatorIdOf(ctx);

  const diff = buildChangeRecords(before, null, 'delete', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  assertChangeRecordOk(diff);

  return withTransaction(() => {
    signatureRequirementRepo.remove(requirementId);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return { removed: true, id: requirementId };
  });
}

export default {
  createCard,
  updateCard,
  getCard,
  listCards,
  getCardDetail,
  listCardVersions,
  checkCardDuplicate,
  bindAttachmentReference,
  addReferenceDocument,
  removeReferenceDocument,
  addProcessStep,
  updateProcessStep,
  removeProcessStep,
  reorderProcessSteps,
  addCaptureItem,
  updateCaptureItem,
  removeCaptureItem,
  addComponent,
  updateComponent,
  removeComponent,
  addSignatureRequirement,
  updateSignatureRequirement,
  removeSignatureRequirement,
};
