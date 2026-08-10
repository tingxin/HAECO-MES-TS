/**
 * 复制、升版与批量替换服务（任务 13.3）。
 *
 * 命名说明：单卡 CRUD 落在 `taskCardService.js`（任务 13.1），审核与版本取代落在
 * `reviewService.js`（任务 13.2，尚待实现）；本文件承载三件**版本管理类**操作——复制
 * （单张 / 批量）、升版（单张 / 批量）、批量替换——它们共同的特征是「产出或改写工卡版本」，
 * 故命名为 `versionService.js`，与 design.md 目录结构中 `services/` 只列「组合 domain +
 * repository（事务边界）」的笼统职责一致（design.md 未对 `services/` 目录给出逐文件清单，
 * 此文件名由本任务自行选定并在此说明）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 服务层错误约定（`lib/service-error.js`，与 `taskCardService.js` / `configService.js` 同一口径）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 全部导出函数在校验失败或前置条件不满足时一律 `throw new ServiceError(code, message, data)`；
 * 成功路径返回纯业务数据，不做信封包装。`data` 上附带 {@link VERSION_REJECTION} 中的原始拒绝
 * 原因码（挂在 `error.data.rejection`）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 复制（需求 3.3、3.4、7.1、7.5、19.1、19.2、20.1–20.10、38.1–38.10、47.9）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - **单卡复制**（{@link copyCard}）：调用方须指定不与现有工卡重复的 Task No（需求 38.1、38.2）。
 * - **批量复制**（{@link copyCardsBatch}）：Task No 由 `domain/task-no.js` 的
 *   `generateTaskNoBatch` 依 `task_no_sequence` 规则批量生成，命中已占用序号自动跳号
 *   （需求 38.8、38.9）；生成结果推进对应 `task_no_sequence.next_seq`（若引用了持久化规则）。
 * - **事后逐张调整**（{@link adjustCopiedTaskNo}）：批量复制完成后允许对单张副本改编号，
 *   仍执行不重复校验（需求 38.10）。
 * - **复制的内容克隆**：`domain/card-rules.js` 的 `copyCard` 只克隆 `task_card` 行本身；
 *   工序、数据采集项、插入组件、签署项配置、参考文件是**子表**，克隆职责在本服务层
 *   （{@link cloneCardChildren}）——按源工卡逐工序取其采集项/组件/签署项后整批插入新工卡，
 *   参考文件按源工卡整批插入，均逐字段一致（不重新赋值除 `id`/归属外键外的任何字段）。
 * - **复制不经编辑态闸门**（需求 49.8）：源工卡可处于任意状态（含 Effective）被复制，
 *   复制产出的副本本身状态恒为 New（`copyCard` 领域函数保证），故本服务不调用
 *   `passesEditableGate` —— 复制在 `NON_CONTENT_OPERATIONS` 词表中，该闸门恒放行，
 *   调用与否结果一致，跳过调用只是省一次判定。
 * - **复制不产生 `change_record`**：新增没有「变更前」可比对，亦不在 tasks.md 关键约束 7
 *   列举的五条留痕路径（保存、删除、升版、批量替换、作废）之内。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 升版（需求 3.4、7.1、7.5、19.1、19.2、38.4–38.6，Property 2、19、35）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - Task No 与原工卡一致且不允许修改（需求 38.4）；版本号默认原版本 +1，允许手动指定并校验
 *   `(task_no, revision)` 唯一，冲突 `409`（需求 7.1、7.5、38.6）；新版本状态置 New（需求 38.5）。
 * - **升版不经编辑态闸门约束源工卡**：源工卡可处于 Effective 等任意态被升版
 *   （升版正是变更已生效工卡内容的**唯一**合法路径，需求 49.3），本服务同样不对源工卡调用
 *   `passesEditableGate`。
 * - **升版经 `buildChangeRecords` 写 `revise` 类型留痕**（tasks.md 关键约束 7）：以「去除 `id`
 *   后的源工卡」为 `before`、「去除 `id` 后的新版本」为 `after` 逐字段比对——业务内容因克隆而
 *   相同，故差异恰好落在 `status`（旧状态 → New）与 `revision`（原版本 → 新版本号）等实际改变
 *   的字段上，`card_id`/`card_revision` 挂在**源版本**（记录「这一版本经由升版产生了新版本」）。
 * - **新版本不继承审核记录历史**：`review_record` 按 `(card_id, card_revision)` 归属，新版本
 *   是全新的 `task_card` 行、全新的 `card_revision`，天然没有历史审核记录与之关联——本服务不做
 *   任何复制审核记录的动作。
 * - **升版同样克隆全部子表内容**（工序/采集项/组件/签署项/参考文件）：升版是「保留内容、改版本」，
 *   与复制的内容克隆职责同构，复用同一 {@link cloneCardChildren} 私有辅助。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 批量替换（需求 19.1、19.2、20.1–20.10、47.9）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 独立权限点 `batch_replace` 校验（{@link authorize}，与 `configService.js` 的
 * `authorize()` 同一模式：越权 `403` 并写 `access_denial_log`；权限判定本身异常
 * ——未知角色/权限点/矩阵缺行——`500` 且不写审计日志）→ `domain/batch-replace.js` 的
 * `batchReplace` 纯函数判定 → 事务写入：逐张被替换的工卡各写一条 `change_record`
 * （领域函数已产出，本服务只落库）。**任一落库语句失败，事务整体回滚**（Property 13
 * 整批回滚部分，任务 14.2 覆盖）。
 *
 * 需求：3.3, 3.4, 7.1, 7.5, 19.1, 19.2, 20.1–20.10, 38.1–38.10, 47.9
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import {
  copyCard as buildCardCopy,
  reviseCard as buildCardRevision,
  nextRevision,
  INITIAL_REVISION,
} from '../domain/card-rules.js';
import { buildChangeRecords } from '../domain/change-record.js';
import { batchReplace, BATCH_REPLACE_OUTCOME } from '../domain/batch-replace.js';
import { generateTaskNoBatch } from '../domain/task-no.js';
import { explainPermission } from '../domain/permission.js';

import taskCardRepo, { TASK_CARD_COLUMNS } from '../repositories/taskCardRepo.js';
import referenceDocRepo from '../repositories/referenceDocRepo.js';
import processStepRepo from '../repositories/processStepRepo.js';
import captureItemRepo from '../repositories/captureItemRepo.js';
import componentRepo from '../repositories/componentRepo.js';
import signatureRequirementRepo from '../repositories/signatureRequirementRepo.js';
import changeRecordRepo from '../repositories/changeRecordRepo.js';
import taskNoSequenceRepo from '../repositories/taskNoSequenceRepo.js';
import rolePermissionRepo from '../repositories/rolePermissionRepo.js';
import accessDenialLogRepo from '../repositories/accessDenialLogRepo.js';
import { toSnakeCase } from '../repositories/case-convert.js';

/** 批量替换权限点常量（需求 20.9、47.9：独立权限点，不由 `card_edit` 继承）。 */
const PERMISSION_BATCH_REPLACE = 'batch_replace';

/** 批量替换禁止直接改写的字段（状态机/版本/编号/追溯字段一律不可经批量替换绕过）。 */
const BATCH_REPLACE_FORBIDDEN_FIELDS = Object.freeze([
  'id', 'status', 'revision', 'taskNo', 'createdBy', 'operatorId', 'lastUpdate',
]);

/** 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景。 */
export const VERSION_REJECTION = Object.freeze({
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  INVALID_TASK_NO: 'INVALID_TASK_NO',
  DUPLICATE_TASK_NO: 'DUPLICATE_TASK_NO',
  DUPLICATE_REVISION: 'DUPLICATE_REVISION',
  INVALID_MANUAL_REVISION: 'INVALID_MANUAL_REVISION',
  NOT_EDITABLE: 'NOT_EDITABLE',
  OPERATOR_REQUIRED: 'OPERATOR_REQUIRED',
  REASON_REQUIRED: 'REASON_REQUIRED',
  EMPTY_IDS: 'EMPTY_IDS',
  INVALID_FIELD: 'INVALID_FIELD',
  NO_EDITABLE_CARDS: 'NO_EDITABLE_CARDS',
  FORBIDDEN_BATCH_REPLACE: 'FORBIDDEN_BATCH_REPLACE',
  PERMISSION_CHECK_ERROR: 'PERMISSION_CHECK_ERROR',
});

const REJECTION_MESSAGES = Object.freeze({
  [VERSION_REJECTION.CARD_NOT_FOUND]: '工卡不存在',
  [VERSION_REJECTION.INVALID_TASK_NO]: 'Task No 须为非空字符串',
  [VERSION_REJECTION.DUPLICATE_TASK_NO]: '该 Task No 已存在，不可重复',
  [VERSION_REJECTION.DUPLICATE_REVISION]: '该 Task No 的目标版本号已存在，不可重复',
  [VERSION_REJECTION.INVALID_MANUAL_REVISION]: '手动指定的版本号须为整数',
  [VERSION_REJECTION.NOT_EDITABLE]: '该工卡副本状态不为新增(New)，不可调整编号',
  [VERSION_REJECTION.OPERATOR_REQUIRED]: '缺少操作人标识',
  [VERSION_REJECTION.REASON_REQUIRED]: '变更原因为必填项，不得为空或纯空白',
  [VERSION_REJECTION.EMPTY_IDS]: '须先选择工卡',
  [VERSION_REJECTION.INVALID_FIELD]: '批量替换字段不合法或不可替换',
  [VERSION_REJECTION.NO_EDITABLE_CARDS]: '所选工卡均不为新增(New)，不可执行批量替换',
  [VERSION_REJECTION.FORBIDDEN_BATCH_REPLACE]: '越权：当前角色无 batch_replace 权限',
  [VERSION_REJECTION.PERMISSION_CHECK_ERROR]: '权限判定异常',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [VERSION_REJECTION.CARD_NOT_FOUND]: CODE.NOT_FOUND,
  [VERSION_REJECTION.INVALID_TASK_NO]: CODE.VALIDATION,
  [VERSION_REJECTION.DUPLICATE_TASK_NO]: CODE.CONFLICT,
  [VERSION_REJECTION.DUPLICATE_REVISION]: CODE.CONFLICT,
  [VERSION_REJECTION.INVALID_MANUAL_REVISION]: CODE.VALIDATION,
  [VERSION_REJECTION.NOT_EDITABLE]: CODE.UNPROCESSABLE,
  [VERSION_REJECTION.OPERATOR_REQUIRED]: CODE.VALIDATION,
  [VERSION_REJECTION.REASON_REQUIRED]: CODE.VALIDATION,
  [VERSION_REJECTION.EMPTY_IDS]: CODE.VALIDATION,
  [VERSION_REJECTION.INVALID_FIELD]: CODE.VALIDATION,
  [VERSION_REJECTION.NO_EDITABLE_CARDS]: CODE.UNPROCESSABLE,
  [VERSION_REJECTION.FORBIDDEN_BATCH_REPLACE]: CODE.FORBIDDEN,
  [VERSION_REJECTION.PERMISSION_CHECK_ERROR]: CODE.INTERNAL,
});

function throwRejection(rejection, message, data) {
  throw new ServiceError(REJECTION_CODE[rejection], message ?? REJECTION_MESSAGES[rejection], {
    rejection,
    ...data,
  });
}

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果（服务层事务边界的统一入口）。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 取调用上下文中的操作人标识（`staff_no`）。identity 中间件（任务 16）落地前，
 * 兼容 `operatorId` / `staffNo` / `userId` 三种写法；缺失一律拒绝——变更须可追溯到人。
 * @param {unknown} ctx
 * @returns {string}
 */
function operatorIdOf(ctx) {
  const raw = ctx && typeof ctx === 'object' ? ctx.operatorId ?? ctx.staffNo ?? ctx.userId : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throwRejection(VERSION_REJECTION.OPERATOR_REQUIRED);
  }
  return String(raw);
}

/** 按主键取工卡，取不到即 `404`。 */
function loadCardOrThrow(id) {
  const card = taskCardRepo.findById(id);
  if (card === null) throwRejection(VERSION_REJECTION.CARD_NOT_FOUND, `工卡不存在：${String(id)}`);
  return card;
}

/** Task No 归一化：非空字符串（不 trim，保留原貌）；其余非法。 */
function normalizeTaskNoInput(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throwRejection(VERSION_REJECTION.INVALID_TASK_NO);
  }
  return value;
}

/**
 * 校验 `(taskNo, revision)` 唯一性，命中且非 `excludeId` 自身即 409。
 * @param {string} taskNo
 * @param {number} revision
 * @param {unknown} [excludeId]
 */
function assertTaskNoRevisionUnique(taskNo, revision, excludeId) {
  const existing = taskCardRepo.findByTaskNoAndRevision(taskNo, revision);
  if (existing !== null && (excludeId === undefined || String(existing.id) !== String(excludeId))) {
    throwRejection(
      VERSION_REJECTION.DUPLICATE_TASK_NO,
      `工卡编号 ${taskNo} 的版本 ${revision} 已存在`,
      { conflict: existing },
    );
  }
}

// =====================================================================
// 一、子表内容克隆（复制、升版共用）——不导出，纯 I/O 组合，无业务规则
// =====================================================================

/**
 * 将源工卡的全部子表内容（工序、其下数据采集项/插入组件/签署项配置、参考文件）
 * 逐字段克隆到新工卡（`newCardId`）。除各自的 `id` 与归属外键（`cardId`/`stepId`）外，
 * 全部字段原样搬迁——这正是需求 3.3、23.1「内容副本」在子表层面的落实：
 * `domain/card-rules.js` 的 `copyCard`/`reviseCard` 只处理 `task_card` 行本身，
 * 子表克隆职责在此。调用方须自行包一层事务。
 * @param {number | string} sourceCardId
 * @param {number | string} newCardId
 */
function cloneCardChildren(sourceCardId, newCardId) {
  for (const doc of referenceDocRepo.listByCardId(sourceCardId)) {
    referenceDocRepo.create({ ...doc, id: undefined, cardId: newCardId });
  }

  for (const step of processStepRepo.listByCardId(sourceCardId)) {
    const newStepId = processStepRepo.create({ ...step, id: undefined, cardId: newCardId });

    for (const item of captureItemRepo.listByStepId(step.id)) {
      captureItemRepo.create({ ...item, id: undefined, stepId: newStepId });
    }
    for (const component of componentRepo.listByStepId(step.id)) {
      componentRepo.create({ ...component, id: undefined, stepId: newStepId });
    }
    for (const requirement of signatureRequirementRepo.listByStepId(step.id)) {
      signatureRequirementRepo.create({ ...requirement, id: undefined, stepId: newStepId });
    }
  }
}

// =====================================================================
// 二、复制（需求 3.3、38.1–38.3、38.8–38.10）
// =====================================================================

/**
 * 单卡复制（需求 3.3、38.1–38.3）：调用方须指定不与现有工卡重复的 Task No。
 *
 * **不经编辑态闸门**（需求 49.8）：源工卡可处于任意状态被复制。副本状态恒为 New、
 * 版本号恒为初始版本（{@link INITIAL_REVISION}）。全部子表内容（工序/采集项/组件/
 * 签署项/参考文件）逐字段克隆（见 {@link cloneCardChildren}）。**不产生 `change_record`**
 * （新增没有「变更前」可比对）。
 *
 * @param {number | string} sourceCardId 源工卡主键
 * @param {string} newTaskNo 副本的新工卡编号（须不与现有工卡重复）
 * @param {{operatorId?: string, staffNo?: string}} ctx 调用上下文
 * @returns {object} 新建的副本工卡（camelCase）
 * @throws {ServiceError} 源工卡不存在（404）、`newTaskNo` 非法（400）、编号重复（409）
 */
export function copyCard(sourceCardId, newTaskNo, ctx) {
  const operatorId = operatorIdOf(ctx);
  const source = loadCardOrThrow(sourceCardId);
  const taskNo = normalizeTaskNoInput(newTaskNo);

  assertTaskNoRevisionUnique(taskNo, INITIAL_REVISION);

  const copy = buildCardCopy(source, taskNo);
  copy.createdBy = operatorId;
  copy.operatorId = operatorId;
  copy.lastUpdate = todayISODate();
  delete copy.id;

  return withTransaction(() => {
    const newId = taskCardRepo.create(copy);
    cloneCardChildren(source.id, newId);
    return taskCardRepo.findById(newId);
  });
}

/**
 * 批量复制（需求 38.8、38.9）：按可配置的编号生成规则（前缀/后缀/起始序号/步长）为每张
 * 副本自动生成不重复的 Task No，命中已占用序号自动跳号，无需逐张人工指定。
 *
 * `numbering.sequenceId` 提供时读取并推进该持久化 `task_no_sequence` 规则行
 * （落库 `next_seq`，供下次批量复制续号）；未提供时按 `numbering` 本身
 * （`{prefix, suffix, startSeq|nextSeq, step}`）作一次性规则，不落库推进。
 *
 * 整批复制包一层事务：任一张源工卡不存在即整批回滚（批量复制的编号本身已保证互不冲突，
 * 唯一可能的失败点是源工卡缺失）。
 *
 * @param {ReadonlyArray<number | string>} sourceCardIds 源工卡主键集合
 * @param {{sequenceId?: number|string, prefix?: string, suffix?: string,
 *   startSeq?: number, nextSeq?: number, step?: number}} numbering 编号生成规则
 * @param {{operatorId?: string, staffNo?: string}} ctx 调用上下文
 * @returns {object[]} 新建的副本工卡集合（camelCase），顺序与生成的 Task No 序号升序一致
 * @throws {ServiceError} `sourceCardIds` 为空（400）、某源工卡不存在（404）
 */
export function copyCardsBatch(sourceCardIds, numbering, ctx) {
  const operatorId = operatorIdOf(ctx);
  const ids = Array.isArray(sourceCardIds) ? sourceCardIds : [];
  if (ids.length === 0) throwRejection(VERSION_REJECTION.EMPTY_IDS);

  const options = numbering === null || typeof numbering !== 'object' ? {} : numbering;
  const sequenceRow = options.sequenceId !== undefined && options.sequenceId !== null
    ? taskNoSequenceRepo.findById(options.sequenceId)
    : null;

  const rule = sequenceRow ?? {
    prefix: options.prefix,
    suffix: options.suffix,
    next_seq: options.startSeq ?? options.nextSeq,
    step: options.step,
  };

  const existing = taskCardRepo.listAllTaskNos();
  const batch = generateTaskNoBatch(rule, existing, ids.length);

  return withTransaction(() => {
    const created = [];
    ids.forEach((sourceCardId, index) => {
      const source = loadCardOrThrow(sourceCardId);
      const taskNo = batch.taskNos[index];

      const copy = buildCardCopy(source, taskNo);
      copy.createdBy = operatorId;
      copy.operatorId = operatorId;
      copy.lastUpdate = todayISODate();
      delete copy.id;

      const newId = taskCardRepo.create(copy);
      cloneCardChildren(source.id, newId);
      created.push(taskCardRepo.findById(newId));
    });

    if (sequenceRow !== null) {
      taskNoSequenceRepo.allocate(sequenceRow.id, batch.nextSeq);
    }

    return created;
  });
}

/**
 * 批量复制完成后事后逐张调整副本 Task No（需求 38.10），仍执行不重复校验。
 * 仅允许对状态为新增(New)的工卡调整（副本恒以 New 诞生，此校验主要防御误调用于非副本工卡）。
 *
 * @param {number | string} cardId 待调整的副本工卡主键
 * @param {string} newTaskNo 调整后的新编号
 * @returns {object} 调整后的工卡（camelCase）
 * @throws {ServiceError} 工卡不存在（404）、`newTaskNo` 非法（400）、非新增态（422）、编号重复（409）
 */
export function adjustCopiedTaskNo(cardId, newTaskNo) {
  const card = loadCardOrThrow(cardId);
  if (card.status !== 'New') {
    throwRejection(VERSION_REJECTION.NOT_EDITABLE, undefined, { status: card.status });
  }
  const taskNo = normalizeTaskNoInput(newTaskNo);
  assertTaskNoRevisionUnique(taskNo, card.revision, cardId);

  return withTransaction(() => {
    taskCardRepo.update(cardId, { taskNo });
    return taskCardRepo.findById(cardId);
  });
}

// =====================================================================
// 三、升版（需求 3.4、7.1、7.5、38.4–38.6，Property 2、19、35）
// =====================================================================

/** 比较用副本：去除 `id`（业务无关键），供 `buildChangeRecords` 逐字段比对。 */
function withoutId(row) {
  const { id, ...rest } = row;
  return rest;
}

/**
 * 单卡升版（需求 3.4、7.1、7.5、38.4–38.6）：保持 Task No 不变，版本号默认原版本 +1
 * （允许手动指定并校验唯一性，冲突 409），状态置 New。**不经编辑态闸门约束源工卡**——
 * 升版正是变更已生效工卡内容的唯一合法入口（需求 49.3）。全部子表内容克隆自源工卡
 * （见 {@link cloneCardChildren}）；新版本天然不继承审核记录历史（`review_record`
 * 按 `(cardId, cardRevision)` 归属，新版本是全新的 `card_id`）。
 *
 * 经 `buildChangeRecords` 写 `revise` 类型留痕（tasks.md 关键约束 7）：以去除 `id` 后的
 * 源工卡为 `before`、去除 `id` 后的新版本为 `after`，记录挂在**源版本**（`cardId`/
 * `cardRevision` 取源工卡），因为这是「该版本经升版产生了新版本」这一事件的发生处。
 *
 * @param {number | string} sourceCardId 源工卡主键
 * @param {string} reason 变更原因（必填，需求 19.2）
 * @param {{operatorId?: string, staffNo?: string}} ctx 调用上下文
 * @param {{revision?: number}} [options] `revision` 手动指定新版本号，缺省取默认值（+1）
 * @returns {object} 新建的版本（camelCase）
 * @throws {ServiceError} 源工卡不存在（404）、手动版本号非法（400）、`(taskNo, revision)`
 *   冲突（409）、变更原因为空（400）
 */
export function reviseCard(sourceCardId, reason, ctx, options = {}) {
  const operatorId = operatorIdOf(ctx);
  const source = loadCardOrThrow(sourceCardId);

  let newRevision;
  try {
    newRevision = nextRevision(source, options.revision);
  } catch (error) {
    throwRejection(VERSION_REJECTION.INVALID_MANUAL_REVISION, error.message);
  }

  assertTaskNoRevisionUnique(source.taskNo, newRevision);

  const revised = buildCardRevision(source, options.revision);
  revised.createdBy = operatorId;
  revised.operatorId = operatorId;
  revised.lastUpdate = todayISODate();
  delete revised.id;

  const diff = buildChangeRecords(withoutId(source), withoutId(revised), 'revise', reason, operatorId, {
    cardId: source.id,
    cardRevision: source.revision,
  });
  if (!diff.ok) throwRejection(VERSION_REJECTION.REASON_REQUIRED, diff.message, { rejection: diff.rejection });

  return withTransaction(() => {
    const newId = taskCardRepo.create(revised);
    cloneCardChildren(source.id, newId);
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return taskCardRepo.findById(newId);
  });
}

/**
 * 批量升版（需求 3.4、38.4、38.5）：对每张所选工卡按默认规则（原版本 +1）创建新版本，
 * 不支持批量场景下的手动版本号覆盖（手动指定属单卡精细操作，见 {@link reviseCard}）。
 * 整批包一层事务：任一张升版失败（版本号冲突等）即整批回滚。
 *
 * @param {ReadonlyArray<number | string>} sourceCardIds 源工卡主键集合
 * @param {string} reason 变更原因（必填，逐卡各自写入一条 `revise` 记录）
 * @param {{operatorId?: string, staffNo?: string}} ctx 调用上下文
 * @returns {object[]} 新建的版本集合（camelCase），顺序与 `sourceCardIds` 一致
 * @throws {ServiceError} `sourceCardIds` 为空（400）、某源工卡不存在（404）、
 *   版本号冲突（409）、变更原因为空（400）
 */
export function reviseCardsBatch(sourceCardIds, reason, ctx) {
  const operatorId = operatorIdOf(ctx);
  const ids = Array.isArray(sourceCardIds) ? sourceCardIds : [];
  if (ids.length === 0) throwRejection(VERSION_REJECTION.EMPTY_IDS);

  return withTransaction(() => {
    const created = [];
    for (const sourceCardId of ids) {
      const source = loadCardOrThrow(sourceCardId);
      const newRevision = nextRevision(source);
      assertTaskNoRevisionUnique(source.taskNo, newRevision);

      const revised = buildCardRevision(source);
      revised.createdBy = operatorId;
      revised.operatorId = operatorId;
      revised.lastUpdate = todayISODate();
      delete revised.id;

      const diff = buildChangeRecords(withoutId(source), withoutId(revised), 'revise', reason, operatorId, {
        cardId: source.id,
        cardRevision: source.revision,
      });
      if (!diff.ok) {
        throwRejection(VERSION_REJECTION.REASON_REQUIRED, diff.message, { rejection: diff.rejection });
      }

      const newId = taskCardRepo.create(revised);
      cloneCardChildren(source.id, newId);
      if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
      created.push(taskCardRepo.findById(newId));
    }
    return created;
  });
}

// =====================================================================
// 四、批量替换（需求 19.1、19.2、20.1–20.10、47.9）
// =====================================================================

/**
 * 独立权限点闸门（需求 20.9、47.9）——与 `configService.js` 的 `authorize()` 同一模式：
 * 授权通过直接返回；越权 `throw ServiceError(CODE.FORBIDDEN, ...)` 并写 `access_denial_log`；
 * 权限判定本身异常（未知角色/权限点/矩阵缺行）`throw ServiceError(CODE.INTERNAL, ...)`
 * 且不写审计日志（非真实越权尝试）。
 * @param {{staffNo?: string, role?: string, method?: string, path?: string, now?: string}} actor
 */
function authorizeBatchReplace(actor) {
  const role = actor?.role ?? null;
  const cfg = rolePermissionRepo.list();
  const { allowed, reason, isAuthorizationDecision } = explainPermission(role, PERMISSION_BATCH_REPLACE, cfg);

  if (allowed) return;

  if (!isAuthorizationDecision) {
    throwRejection(
      VERSION_REJECTION.PERMISSION_CHECK_ERROR,
      `权限判定异常（${reason}）：角色=${String(role)}，权限点=${PERMISSION_BATCH_REPLACE}`,
    );
  }

  accessDenialLogRepo.create({
    staffNo: actor?.staffNo ?? null,
    role,
    permissionPoint: PERMISSION_BATCH_REPLACE,
    method: actor?.method ?? 'SERVICE',
    path: actor?.path ?? 'versionService:batchReplaceCards',
    deniedAt: actor?.now ?? new Date().toISOString(),
  });

  throwRejection(
    VERSION_REJECTION.FORBIDDEN_BATCH_REPLACE,
    `越权：角色 ${String(role)} 无 ${PERMISSION_BATCH_REPLACE} 权限执行批量替换`,
  );
}

/** 校验批量替换的目标字段：须为 `task_card` 合法列且不属状态机/版本/追溯保留字段。 */
function assertReplaceableField(field) {
  if (typeof field !== 'string' || field.trim() === '') {
    throwRejection(VERSION_REJECTION.INVALID_FIELD, '批量替换字段名须为非空字符串');
  }
  if (BATCH_REPLACE_FORBIDDEN_FIELDS.includes(field)) {
    throwRejection(VERSION_REJECTION.INVALID_FIELD, `字段 ${field} 不可通过批量替换修改`);
  }
  if (!TASK_CARD_COLUMNS.includes(toSnakeCase(field))) {
    throwRejection(VERSION_REJECTION.INVALID_FIELD, `字段 ${field} 不是工卡的合法字段`);
  }
}

/**
 * 批量替换（需求 19.1、20.1–20.10、47.9）：独立权限点 `batch_replace` 校验 →
 * `domain/batch-replace.js` 的 `batchReplace` 纯函数判定（态限制/原因必填/幂等）→
 * 事务写入（逐张被替换的工卡各写一条 `change_record`）。**任一落库语句失败，
 * 整批回滚**（better-sqlite3 事务的原生保证，Property 13 整批回滚部分见任务 14.2）。
 *
 * @param {ReadonlyArray<number | string>} cardIds 所选工卡主键集合
 * @param {{field: string, from?: unknown, to?: unknown}} spec 替换规格
 * @param {string} reason 替换原因（必填）
 * @param {{operatorId?: string, staffNo?: string, role?: string}} ctx 调用上下文
 *   （须携带 `role` 供权限校验）
 * @returns {{ items: ReadonlyArray<object>, totalCount: number, affectedCount: number,
 *   rejectedCount: number, unaffectedCount: number }} 逐卡判定结果与汇总统计
 * @throws {ServiceError} `cardIds` 为空（400）、越权（403）、字段不合法（400）、
 *   某工卡不存在（404）、原因/操作人为空（400）
 */
export function batchReplaceCards(cardIds, spec, reason, ctx) {
  authorizeBatchReplace(ctx);
  const operatorId = operatorIdOf(ctx);

  const ids = Array.isArray(cardIds) ? cardIds : [];
  if (ids.length === 0) throwRejection(VERSION_REJECTION.EMPTY_IDS);

  assertReplaceableField(spec?.field);

  const cards = ids.map((id) => loadCardOrThrow(id));

  const result = batchReplace(cards, spec, reason, operatorId);
  if (!result.ok) {
    throwRejection(
      result.rejection === 'REASON_REQUIRED'
        ? VERSION_REJECTION.REASON_REQUIRED
        : VERSION_REJECTION.OPERATOR_REQUIRED,
      result.message,
    );
  }

  // A selection containing no editable card is an edit-gate failure, not a successful no-op.
  // Mixed selections retain the domain contract: editable New cards are processed while frozen
  // cards remain individually reported as rejected_not_editable.
  if (result.totalCount > 0 && result.rejectedCount === result.totalCount) {
    throwRejection(VERSION_REJECTION.NO_EDITABLE_CARDS, undefined, {
      items: result.items,
      totalCount: result.totalCount,
      rejectedCount: result.rejectedCount,
    });
  }

  return withTransaction(() => {
    for (const item of result.items) {
      if (item.outcome !== BATCH_REPLACE_OUTCOME.REPLACED) continue;
      taskCardRepo.update(item.card.id, { [spec.field]: item.after });
    }
    if (result.changeRecords.length > 0) changeRecordRepo.createMany(result.changeRecords);

    return {
      items: result.items,
      totalCount: result.totalCount,
      affectedCount: result.affectedCount,
      rejectedCount: result.rejectedCount,
      unaffectedCount: result.unaffectedCount,
    };
  });
}

export default {
  copyCard,
  copyCardsBatch,
  adjustCopiedTaskNo,
  reviseCard,
  reviseCardsBatch,
  batchReplaceCards,
};
