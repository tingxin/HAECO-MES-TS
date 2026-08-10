/**
 * 工卡审核服务（Review Service，任务 13.2）—— 提交审核、批准（含版本取代）、驳回。
 *
 * 组合三处既有领域纯函数，**不重新实现**任一判定逻辑：
 * - `domain/review.js` 的 `submitReviewChecklist(card, ctx)` / `canApprove(card, userId)` /
 *   `acceptReviewAction(card, action, comment)`；
 * - `domain/supersede.js` 的 `supersedeOnApprove(cards, approvedCard)` +
 *   `runSupersedePlan(plan, applyOperation)`（批准生效时的版本取代方案与其**强制执行顺序**）；
 * - `relationService.js` 的 `getRequiredSignDocTypes(cardId)`（提交审核校验项 (f) 的数据来源，
 *   已在 `relationService.js` 落地，本服务只转调，不重复取数逻辑）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 服务层错误约定（`lib/service-error.js`，与 `taskCardService.js` / `relationService.js` 同一口径）
 * ══════════════════════════════════════════════════════════════════════════════
 * 全部导出函数在校验失败或前置条件不满足时一律 `throw new ServiceError(code, message, data)`，
 * 不返回判别式结果对象；成功路径返回纯业务数据，不做 `{ok, data}` 信封包装。`data` 上附带
 * {@link REVIEW_REJECTION} 中的原始拒绝原因码（挂在 `error.data.rejection`）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ⚠⚠⚠ 批准事务的语句顺序为强制约束（Property 25，需求 44.1–44.3、44.7、44.8） ⚠⚠⚠
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `task_card` 上的 `UNIQUE(task_no) WHERE status='Effective'` 是 SQLite **部分唯一索引**，
 * 校验发生在**每条语句执行的瞬间**（语句级立即校验），而非事务提交时——SQLite 不支持
 * 延迟约束（`DEFERRABLE INITIALLY DEFERRED` 对 `UNIQUE` 部分索引不适用）。因此 {@link approve}
 * 内部执行的 SQL 语句**必须**按以下顺序排列，同处**一个** `better-sqlite3` 事务：
 *
 * ```
 * ① UPDATE task_card SET status='Superseded' WHERE task_no=? AND revision=<原生效版本>
 * ② INSERT INTO supersede_record (...)
 * ③ UPDATE task_card SET status='Effective'  WHERE task_no=? AND revision=<本版本>
 * ④ INSERT INTO review_record (...)
 * ```
 *
 * 若颠倒顺序（先 ③ 后 ①），则 ③ 执行的瞬间同一 `task_no` 下同时存在两个 `status='Effective'`
 * 的行，索引立即报错并触发回滚——**结果是任何版本都无法生效，包括原本应该成功的这一次批准**。
 * 这不是「小概率并发问题」，是**单线程、无并发场景下必然触发**的确定性错误（better-sqlite3
 * 同步执行，SQLite 单写者）。
 *
 * 本服务不自行遍历语句顺序，而是把顺序执行权**完全交给** `domain/supersede.js` 的
 * {@link runSupersedePlan}：该函数在应用每条操作前先调用 `assertSupersedeOperationOrder`
 * 校验序列未被重排，本服务的 `applyOperation` 回调只管「给定一条操作，把它落成一条 SQL」，
 * 不参与顺序决策——顺序错误在这里是**结构上不可能**发生的，而不是靠人工审查保证。
 * 首个版本批准（无原生效版本）时 `operations` 只含 ③，`supersedeRecords` 为空，
 * ①② 天然跳过，本服务无需额外分支。
 *
 * 步骤 ④（写 `review_record`）在 {@link runSupersedePlan} 返回（即 ①②③ 全部落库）之后
 * 才执行，仍在同一事务内：若 ④ 失败（理论上仅 `comment` 校验缺失会失败，但那已在
 * `acceptReviewAction` 阶段被拦截），事务整体回滚，①②③ 的效果一并撤销
 * ——「任一步失败则该次批准整体回滚，新版本不生效且原生效版本保持生效」（需求 44.8）
 * 因此对整个批准动作（不仅取代方案本身）成立。
 *
 * 需求：22.3, 34.1–34.11, 39.2, 44.1–44.3, 44.7, 44.8, 45.9, 46.10
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import { statusOf, canTransition } from '../domain/card-rules.js';
import { submitReviewChecklist, canApprove, acceptReviewAction } from '../domain/review.js';
import {
  supersedeOnApprove,
  runSupersedePlan,
  SUPERSEDE_OP,
  SUPERSEDE_REJECTION,
} from '../domain/supersede.js';

import * as taskCardRepo from '../repositories/taskCardRepo.js';
import * as reviewRecordRepo from '../repositories/reviewRecordRepo.js';
import * as supersedeRecordRepo from '../repositories/supersedeRecordRepo.js';
import * as referenceDocRepo from '../repositories/referenceDocRepo.js';
import * as processStepRepo from '../repositories/processStepRepo.js';
import * as signatureRequirementRepo from '../repositories/signatureRequirementRepo.js';
import * as capabilityRepo from '../repositories/capabilityRepo.js';
import * as stageConstraintRepo from '../repositories/stageConstraintRepo.js';
import * as relationRepo from '../repositories/relationRepo.js';
import * as execDocTypeRepo from '../repositories/execDocTypeRepo.js';
import * as systemParameterRepo from '../repositories/systemParameterRepo.js';

/**
 * 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景，
 * 服务层/路由层的 HTTP 状态映射一律以 `ServiceError.code` 为准（见各抛出点注释的映射）。
 */
export const REVIEW_REJECTION = Object.freeze({
  /** 工卡不存在 → `CODE.NOT_FOUND`（404） */
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  /** 提交审核时工卡状态不为「新增(New)」（不允许 New→UnderReview 迁移） → `CODE.UNPROCESSABLE`（422） */
  NOT_NEW: 'NOT_NEW',
  /** 提交审核校验清单 (a)–(g) 存在未通过项（需求 34.1、34.2） → `CODE.VALIDATION`（400） */
  CHECKLIST_FAILED: 'CHECKLIST_FAILED',
  /** 批准/驳回时工卡状态不为「审核中(UnderReview)」（需求 34.10） → `CODE.UNPROCESSABLE`（422） */
  NOT_UNDER_REVIEW: 'NOT_UNDER_REVIEW',
  /** 审核意见为空或纯空白（需求 34.6、34.7、34.11） → `CODE.VALIDATION`（400） */
  COMMENT_REQUIRED: 'COMMENT_REQUIRED',
  /** 审核动作被 `acceptReviewAction` 判定为非法（理论上不会触发，见其调用点注释） → `CODE.INTERNAL`（500） */
  INVALID_ACTION: 'INVALID_ACTION',
  /** 审核人与编制人为同一用户，违反一编一审（需求 22.3） → `CODE.UNPROCESSABLE`（422） */
  SAME_REVIEWER_AS_CREATOR: 'SAME_REVIEWER_AS_CREATOR',
  /** 版本取代方案生成失败（数据完整性问题：取不到版本列表/编号/版本号，理论上不会触发） → `CODE.INTERNAL`（500） */
  SUPERSEDE_PLAN_FAILED: 'SUPERSEDE_PLAN_FAILED',
});

const REJECTION_MESSAGES = Object.freeze({
  [REVIEW_REJECTION.CARD_NOT_FOUND]: '工卡不存在',
  [REVIEW_REJECTION.NOT_NEW]: '工卡状态不为新增(New)，不可提交审核',
  [REVIEW_REJECTION.CHECKLIST_FAILED]: '提交审核校验未通过，工卡状态保持新增(New)',
  [REVIEW_REJECTION.NOT_UNDER_REVIEW]: '工卡状态不为审核中(UnderReview)，不可执行批准或驳回',
  [REVIEW_REJECTION.COMMENT_REQUIRED]: '审核意见为空，须填写审核意见方可执行批准或驳回',
  [REVIEW_REJECTION.INVALID_ACTION]: '审核动作非法',
  [REVIEW_REJECTION.SAME_REVIEWER_AS_CREATOR]: '审核人与编制人为同一用户，违反一编一审约束',
  [REVIEW_REJECTION.SUPERSEDE_PLAN_FAILED]: '版本取代方案生成失败，批准操作已中止',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [REVIEW_REJECTION.CARD_NOT_FOUND]: CODE.NOT_FOUND,
  [REVIEW_REJECTION.NOT_NEW]: CODE.UNPROCESSABLE,
  [REVIEW_REJECTION.CHECKLIST_FAILED]: CODE.VALIDATION,
  [REVIEW_REJECTION.NOT_UNDER_REVIEW]: CODE.UNPROCESSABLE,
  [REVIEW_REJECTION.COMMENT_REQUIRED]: CODE.VALIDATION,
  [REVIEW_REJECTION.INVALID_ACTION]: CODE.INTERNAL,
  [REVIEW_REJECTION.SAME_REVIEWER_AS_CREATOR]: CODE.UNPROCESSABLE,
  [REVIEW_REJECTION.SUPERSEDE_PLAN_FAILED]: CODE.INTERNAL,
});

/** `throw new ServiceError(...)` 的统一入口：按拒绝原因码取 `code` 与默认消息。 */
function throwRejection(rejection, message, data) {
  throw new ServiceError(REJECTION_CODE[rejection], message ?? REJECTION_MESSAGES[rejection], {
    rejection,
    ...data,
  });
}

/** `acceptReviewAction` 的拒绝原因码 → 本服务的 {@link REVIEW_REJECTION} 码。 */
const ACCEPT_ACTION_REJECTION_MAP = Object.freeze({
  INVALID_ACTION: REVIEW_REJECTION.INVALID_ACTION,
  NOT_UNDER_REVIEW: REVIEW_REJECTION.NOT_UNDER_REVIEW,
  COMMENT_REQUIRED: REVIEW_REJECTION.COMMENT_REQUIRED,
});

/** `supersedeOnApprove` 的拒绝原因码 → 本服务的 {@link REVIEW_REJECTION} 码。 */
const SUPERSEDE_PLAN_REJECTION_MAP = Object.freeze({
  [SUPERSEDE_REJECTION.CARDS_REQUIRED]: REVIEW_REJECTION.SUPERSEDE_PLAN_FAILED,
  [SUPERSEDE_REJECTION.TASK_NO_REQUIRED]: REVIEW_REJECTION.SUPERSEDE_PLAN_FAILED,
  [SUPERSEDE_REJECTION.REVISION_REQUIRED]: REVIEW_REJECTION.SUPERSEDE_PLAN_FAILED,
  [SUPERSEDE_REJECTION.ILLEGAL_TRANSITION]: REVIEW_REJECTION.NOT_UNDER_REVIEW,
});

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果（与 `taskCardService.js` 同一事务边界约定）。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * 取调用上下文中的操作人标识（`staff_no`），与 `taskCardService.js` 的 `operatorIdOf` 同约定：
 * 兼容 `operatorId` / `staffNo` / `userId` 三种写法；缺失一律拒绝。
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

/** 按主键取工卡，取不到即 404。 */
function loadCardOrThrow(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(REVIEW_REJECTION.CARD_NOT_FOUND, `工卡不存在：${String(cardId)}`);
  return card;
}

function nowIso() {
  return new Date().toISOString();
}

// =====================================================================
// 一、提交审核（需求 22.3、34.1、34.2、39.2、45.9、46.10，Property 19）
// =====================================================================

/**
 * 组装 `submitReviewChecklist` 所需的 `ctx`（见 `domain/review.js` 模块头注「`ctx` 的形状」）。
 * 逐项取数，**不重新实现**任一子校验的判定逻辑：
 * - (a) 查重：同 Task No 下的全部版本（含本版本自身，`checkDuplicate` 按 `card.id` 自动排除）；
 * - (c) 必填：组织名称（`system_parameter`）+ 参考文件 + 工序；
 * - (d) 能力清单：`capability_list` 全表；
 * - (e) 变更原因：调用方经 `ctx.changeReason` / `ctx.reason` 传入的本次提交原因；
 * - (f) 签署项配置：本卡关联单据 + `exec_doc_type` 签署要求配置 + 工序签署项（嵌套挂载）；
 * - (g) Stage×工卡类型组合：`stage_card_type_constraint` + `stage_crosscut`。
 *
 * @param {object} card 工卡对象
 * @param {unknown} changeReason 本次提交审核的变更原因
 * @returns {object} 供 `submitReviewChecklist(card, ctx)` 消费的 `ctx`
 */
function buildSubmitReviewCtx(card, changeReason) {
  const steps = processStepRepo.listByCardId(card.id).map((step) => ({
    ...step,
    signatureRequirements: signatureRequirementRepo.listByStepId(step.id),
  }));

  return {
    cards: taskCardRepo.listVersionsByTaskNo(card.taskNo),
    orgName: systemParameterRepo.get('organizationName'),
    referenceDocuments: referenceDocRepo.listByCardId(card.id),
    steps,
    capabilityList: capabilityRepo.list(),
    onDate: nowIso().slice(0, 10),
    changeReason,
    relations: relationRepo.listByCardId(card.id),
    signRuleCfg: execDocTypeRepo.list(),
    stageConstraintCfg: {
      constraints: stageConstraintRepo.list(),
      crosscut: stageConstraintRepo.listCrosscut(),
    },
  };
}

/**
 * 提交审核（需求 34.1、34.2）：TS_Engineer 对状态为「新增(New)」的工卡依次执行完整校验
 * 清单 (a)–(g)（查重 / 枚举 / 必填 / 能力清单 / 变更原因 / 签署项配置 / Stage×工卡类型组合），
 * 全部通过方将工卡状态置为「审核中(UnderReview)」；任一未通过则**保持「新增」**并返回全部
 * 未通过项（不止首个）。
 *
 * 校验清单的判定逻辑**全部**委托给 `domain/review.js` 的 `submitReviewChecklist`（本函数只
 * 负责组装其 `ctx` 并按结果分派），签署项配置校验项 (f) 所需的关联单据数据经
 * {@link buildSubmitReviewCtx} 直读 `relationRepo`——与 `relationService.js` 的
 * `getRequiredSignDocTypes` 转调同一份数据来源（`domain/relation.js` 的
 * `requiredSignDocTypes`），不重复实现判定逻辑。
 *
 * 提交审核本身不产生 `change_record`：状态迁移不在 tasks.md「关键实现约束 7」列举的
 * 「保存/删除/升版/批量替换/作废」五条留痕路径之内。
 *
 * @param {number|string} cardId 工卡主键
 * @param {{operatorId?: string, staffNo?: string, userId?: string,
 *   changeReason?: string, reason?: string}} ctx 调用上下文（`changeReason`/`reason`
 *   为校验项 (e) 的本次提交原因，二者任取其一）
 * @returns {object} 更新后的工卡（camelCase，`status === 'UnderReview'`）
 * @throws {ServiceError} 工卡不存在（404）、状态不为新增(422)、校验清单未通过（400，
 *   `data.failedChecks` 给出全部未通过项）
 */
export function submitForReview(cardId, ctx) {
  const card = loadCardOrThrow(cardId);
  operatorIdOf(ctx);

  if (!canTransition(statusOf(card), 'UnderReview')) {
    throwRejection(REVIEW_REJECTION.NOT_NEW, undefined, { status: statusOf(card) });
  }

  const changeReason = ctx && typeof ctx === 'object' ? ctx.changeReason ?? ctx.reason : undefined;
  const checklistCtx = buildSubmitReviewCtx(card, changeReason);
  const result = submitReviewChecklist(card, checklistCtx);

  if (!result.ok) {
    // 任一校验项未通过：工卡状态保持「新增」——本分支不落任何库操作，天然满足此约束
    throwRejection(REVIEW_REJECTION.CHECKLIST_FAILED, undefined, {
      failedChecks: result.failedChecks,
    });
  }

  return withTransaction(() => {
    taskCardRepo.update(cardId, { status: 'UnderReview' });
    return taskCardRepo.findById(cardId);
  });
}

// =====================================================================
// 二、批准（需求 22.3、34.4、34.6–34.11、44.1–44.3、44.7、44.8，Property 25）
// =====================================================================

/**
 * 版本取代方案的单条操作 → 一次仓储写入（`runSupersedePlan` 的 `applyOperation` 回调）。
 *
 * 本函数**不决定执行顺序**——顺序完全由 `supersedeOnApprove` 产出的 `operations` 数组与
 * `runSupersedePlan` 内部的 `assertSupersedeOperationOrder` 守卫保证，此处只管把单条操作
 * 翻译成一条 SQL 语句。降级 / 生效两类操作按 `(task_no, revision)` 定位目标行
 * （`taskCardRepo` 无按 `(task_no, revision)` 直接 UPDATE 的方法，故先 `findByTaskNoAndRevision`
 * 取 `id` 再 `update`——这一间接查询发生在同一事务内，不影响语句执行顺序）。
 *
 * @param {object} operation {@link supersedeOnApprove} 产出的单条操作
 * @returns {unknown} 该操作的执行结果（受影响行数或新增行 id），供 `runSupersedePlan` 收集
 * @throws {ServiceError} 目标行按 `(task_no, revision)` 定位不到（500，数据完整性问题）
 */
function applySupersedeOperation(operation) {
  switch (operation.op) {
    case SUPERSEDE_OP.DEMOTE_INCUMBENT:
    case SUPERSEDE_OP.PROMOTE_APPROVED: {
      const target = taskCardRepo.findByTaskNoAndRevision(operation.where.task_no, operation.where.revision);
      if (target === null) {
        throw new ServiceError(
          CODE.INTERNAL,
          `版本取代失败：找不到工卡 ${operation.where.task_no} rev.${operation.where.revision}`,
        );
      }
      return taskCardRepo.update(target.id, { status: operation.set.status });
    }
    case SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD:
      return supersedeRecordRepo.create(operation.row);
    default:
      throw new ServiceError(CODE.INTERNAL, `未知的版本取代操作：${String(operation.op)}`);
  }
}

/**
 * 批准（需求 34.4、34.6、34.7、22.3、44.1–44.3、44.7、44.8）：
 *
 * 单事务内**严格按以下顺序**执行（见模块头注「批准事务的语句顺序为强制约束」）：
 * ① 原生效版本（若存在）→ `Superseded` + 写 `supersede_record`；
 * ② 本版本 → `Effective`；
 * ③ 写 `review_record`（`action='approve'`）。
 *
 * 顺序由 {@link runSupersedePlan} 与其内部的 `assertSupersedeOperationOrder` 守卫保证，
 * 本函数不自行遍历语句——这是**结构性**保证，不是「写代码时注意顺序」的约定。任一步失败
 * （撞唯一索引、`review_record.comment NOT NULL` 兜底等）均使整个 `better-sqlite3` 事务
 * 回滚：新版本不进入生效态，原生效版本（若存在）保持生效（需求 44.8）。
 *
 * 前置条件按序校验（任一不满足即 `throw`，不产生任何副作用）：
 * 1. 工卡存在（404）；
 * 2. `acceptReviewAction`：状态为「审核中(UnderReview)」且审核意见非空（422 / 400）；
 * 3. `canApprove`：一编一审，审核人 ≠ 编制人（422，需求 22.3）。
 *
 * ⚠ 本函数**不**校验审卡权限（`checkPermission(role, 'card_review', cfg)`）——审卡权限判定
 * 与一编一审是两件不同的事（`domain/review.js` 的 `canApprove` 文档已明确二者职责分离），
 * 前者由路由层的权限校验中间件（任务 16.2）负责，与 `relationService.js` / `bomService.js`
 * 等既有服务「服务层只判定编辑态/业务前置，权限判定留给中间件」的既定分工一致。
 *
 * @param {number|string} cardId 工卡主键
 * @param {{operatorId?: string, staffNo?: string, userId?: string}} ctx 调用上下文
 *   （`operatorId` 亦作一编一审的审核人身份与 `review_record.reviewer`）
 * @param {string} reviewComment 审核意见（必填）
 * @returns {object} 更新后的工卡（camelCase，`status === 'Effective'`）
 * @throws {ServiceError} 工卡不存在（404）、非审核中态（422）、审核意见为空（400）、
 *   同人既编又审（422）
 */
export function approve(cardId, ctx, reviewComment) {
  const card = loadCardOrThrow(cardId);
  const operatorId = operatorIdOf(ctx);

  const acceptance = acceptReviewAction(card, 'approve', reviewComment);
  if (!acceptance.ok) {
    throwRejection(ACCEPT_ACTION_REJECTION_MAP[acceptance.rejection] ?? REVIEW_REJECTION.INVALID_ACTION);
  }

  if (!canApprove(card, operatorId)) {
    throwRejection(REVIEW_REJECTION.SAME_REVIEWER_AS_CREATOR);
  }

  const plan = supersedeOnApprove(taskCardRepo.listVersionsByTaskNo(card.taskNo), card);
  if (!plan.ok) {
    throwRejection(SUPERSEDE_PLAN_REJECTION_MAP[plan.rejection] ?? REVIEW_REJECTION.SUPERSEDE_PLAN_FAILED);
  }

  return withTransaction(() => {
    // ①② 严格按 supersedeOnApprove 给定的顺序执行：先降级原生效版本 + 写取代记录，
    //    最后才把本版本置为生效——顺序由 runSupersedePlan 内部守卫保证，本函数不参与决策
    runSupersedePlan(plan, applySupersedeOperation);

    // ③ 写审核记录（批准）——发生在①②之后，仍在同一事务内；若此步失败（理论上仅
    //    comment 校验缺失会失败，但已在上面的 acceptReviewAction 阶段拦截），
    //    整个事务回滚，①②的效果一并撤销
    reviewRecordRepo.create({
      cardId: card.id,
      cardRevision: card.revision,
      action: 'approve',
      reviewer: operatorId,
      comment: reviewComment,
      reviewedAt: nowIso(),
    });

    return taskCardRepo.findById(cardId);
  });
}

// =====================================================================
// 三、驳回（需求 34.5、34.6、34.7）
// =====================================================================

/**
 * 驳回（需求 34.5、34.6、34.7）：将工卡状态由「审核中(UnderReview)」置回「新增(New)」
 * 以便编制人重新编辑，并写入一条 `review_record`（`action='reject'`）。审核意见为空一律拒绝。
 *
 * 与 {@link approve} 不同，驳回不涉及版本取代——`task_card.status` 只有一处 UPDATE，
 * 不存在语句顺序约束。仍包一层事务，使「状态回退」与「留痕」同生共死。
 *
 * ⚠ 与批准一致，本函数**不**校验审卡权限，交由路由层的权限校验中间件（任务 16.2）负责。
 * 驳回**不**受一编一审约束（需求 22.3 仅约束批准/审核动作与编制人的关系，`canApprove` 之名
 * 虽含「Approve」，但其判定的是「谁能审核这张卡」这一更一般的关系；驳回同样是审核动作，
 * 理应同受一编一审约束——`acceptReviewAction` 本身不含该判定，故此处显式复用 `canApprove`）。
 *
 * @param {number|string} cardId 工卡主键
 * @param {{operatorId?: string, staffNo?: string, userId?: string}} ctx 调用上下文
 * @param {string} reviewComment 审核意见（必填）
 * @returns {object} 更新后的工卡（camelCase，`status === 'New'`）
 * @throws {ServiceError} 工卡不存在（404）、非审核中态（422）、审核意见为空（400）、
 *   同人既编又审（422）
 */
export function reject(cardId, ctx, reviewComment) {
  const card = loadCardOrThrow(cardId);
  const operatorId = operatorIdOf(ctx);

  const acceptance = acceptReviewAction(card, 'reject', reviewComment);
  if (!acceptance.ok) {
    throwRejection(ACCEPT_ACTION_REJECTION_MAP[acceptance.rejection] ?? REVIEW_REJECTION.INVALID_ACTION);
  }

  if (!canApprove(card, operatorId)) {
    throwRejection(REVIEW_REJECTION.SAME_REVIEWER_AS_CREATOR);
  }

  return withTransaction(() => {
    taskCardRepo.update(cardId, { status: 'New' });
    reviewRecordRepo.create({
      cardId: card.id,
      cardRevision: card.revision,
      action: 'reject',
      reviewer: operatorId,
      comment: reviewComment,
      reviewedAt: nowIso(),
    });
    return taskCardRepo.findById(cardId);
  });
}

export default { submitForReview, approve, reject };
