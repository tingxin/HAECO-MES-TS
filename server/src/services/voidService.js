/**
 * 工卡作废服务（任务 13.7 之三，需求 29.1–29.8 无关；本文件承载 39.x 之外的
 * 42.1–42.5、43.3–43.5 中的作废部分）。
 *
 * 组合三类引用的聚合（前两类查 `job.exec_status`，第三类查在编工包引用契约）、
 * `domain/void-rules.js` 的 `checkVoidPrecondition`（唯一前置校验判定，本服务不重新
 * 实现）与 `domain/change-record.js` 的 `buildChangeRecords`（唯一留痕构造点），完成
 * 「聚合引用 → 前置校验 → 置 Void + 写 `void` 类型留痕」的完整链路。
 *
 * ## 三类引用的数据来源（需求 42.1）
 *
 * | 类型 | 数据来源 | 本服务的取数方式 |
 * |------|----------|------------------|
 * | (a) 执行中 JOB | `job.exec_status = 'InProgress'` | `jobRepo.listByCardId(cardId)` |
 * | (b) 已生成未开始执行的 JOB | 同上，`exec_status !== 'Completed'` 且非执行中 | 同上 |
 * | (c) 在编（尚未释放）工包已选入 | `GET /api/work-packages/in-progress-refs?cardId=` 契约端点 | 见下 ⚠ |
 *
 * ⚠ **第三类引用的已知缺口**：`schema.sql` 分节 3/4 中不存在承载「在编工包选入了哪些工卡」
 * 这一事实的本地表（`work_package_release` 记录的是**已发布结果**，`released_at`/`result`
 * 语义与「尚未释放、仍在编排中」正相反，见其模块头注「本表同时是……但该业务判断在服务层
 * 完成，本仓储只提供 CRUD/读取」——它提供不了这份数据，因为对应的行尚未产生）。
 * 该契约端点与其数据源（WPL 模块的工包主数据）由任务 20.4 建立，**当前尚不存在**。
 *
 * 本服务对此采用**尽力而为、不留 TODO 注释**的处置：{@link checkVoidPrecondition} /
 * {@link voidCard} 接受可选的 `options.inProgressPackageRefs` 参数——调用方（未来的路由层，
 * 任务 20.4 落地契约端点后）应先调用 `GET /api/work-packages/in-progress-refs?cardId=`
 * 取得该工卡的在编工包引用列表，再将其原样传入本服务。缺省（未传入）时按「该来源当前无可用
 * 数据」处理，即**不产生第三类阻止性引用**——这不是「假定不存在阻止性引用」的静默放行，
 * 而是明确记录在此：**在该契约端点落地前，作废前置校验对第三类引用没有覆盖**，业务方需
 * 知晓这一现状（而非被一个隐藏的 `// TODO` 掩盖）。一旦任务 20.4 的路由/仓储落地，调用方
 * 只需补上「取数 → 传参」这一步，本服务的签名与内部实现均无需改动。
 *
 * ## 前置校验与状态迁移的职责分离
 *
 * `checkVoidPrecondition`（`domain/void-rules.js`）只判「引用 + 原因」两项（见其模块头注
 * 「判定边界」），**不**判状态迁移合法性。本服务在其之外另调用 `card-rules.js` 的
 * `canTransition(status, 'Void')`——`ALLOWED_TRANSITIONS` 中仅 `New`/`Effective` 可迁往
 * `Void`（`UnderReview` 须先驳回或批准，`Superseded`/`Void` 为终态），二者是正交约束，
 * 服务层组合而非在领域层混成一个不可解释的布尔（同 `void-rules.js` 模块头注的既定原则）。
 *
 * ## 不经编辑态闸门（需求 49.8、tasks.md 关键约束 1）
 *
 * 作废是需求 49.8 列举的非内容变更操作之一，即便生效态也必须放行；本服务不调用
 * `passesEditableGate`/`isEditable`，只套用上一段的状态迁移合法性与
 * `checkVoidPrecondition` 两道闸门。
 *
 * ## 事务边界
 *
 * {@link voidCard} 的「工卡状态置 Void」+「写 `change_record`」包裹在单一
 * `better-sqlite3` 事务内：留痕与状态迁移须同生共死，不产生「已作废但无留痕」或反之的半态。
 *
 * 需求：42.1–42.5、43.3–43.5（作废对商务分类结果的影响：本服务不改写
 * `commercial_classification_result`/`task_card.commercial_classification`，作废只改
 * `status`，历史分类判定按需求 29.5 原样保留）
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import { canTransition, statusOf } from '../domain/card-rules.js';
import { checkVoidPrecondition as checkVoidPreconditionDomain } from '../domain/void-rules.js';
import { buildChangeRecords } from '../domain/change-record.js';

import taskCardRepo from '../repositories/taskCardRepo.js';
import jobRepo from '../repositories/jobRepo.js';
import changeRecordRepo from '../repositories/changeRecordRepo.js';

/** 目标状态：作废（需求 42.1，`ALLOWED_TRANSITIONS` 中 `New`/`Effective` 均可迁往）。 */
const STATUS_VOID = 'Void';

/** 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景。 */
export const VOID_REJECTION = Object.freeze({
  /** 工卡不存在 → `CODE.NOT_FOUND`（404） */
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  /** 当前状态不可迁往 Void（`UnderReview`/`Superseded`/`Void` 自身） → `CODE.UNPROCESSABLE`（422） */
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  /** 存在需求 42.1 所列任一阻止性引用 → `CODE.UNPROCESSABLE`（422） */
  BLOCKING_REFERENCES: 'BLOCKING_REFERENCES',
  /** 作废原因为空或纯空白（需求 42.5） → `CODE.VALIDATION`（400） */
  REASON_REQUIRED: 'REASON_REQUIRED',
  /** 操作人标识缺失（需求 19.3、7.4：变更须可追溯到人；`buildChangeRecords` 的
   *  `OPERATOR_REQUIRED` 拒绝在留痕构造阶段的映射） → `CODE.VALIDATION`（400） */
  OPERATOR_REQUIRED: 'OPERATOR_REQUIRED',
});

const REJECTION_MESSAGES = Object.freeze({
  [VOID_REJECTION.CARD_NOT_FOUND]: '工卡不存在',
  [VOID_REJECTION.INVALID_TRANSITION]: '当前工卡状态不可作废（审核中须先驳回或批准；已被取代/已作废为终态）',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [VOID_REJECTION.CARD_NOT_FOUND]: CODE.NOT_FOUND,
  [VOID_REJECTION.INVALID_TRANSITION]: CODE.UNPROCESSABLE,
  [VOID_REJECTION.BLOCKING_REFERENCES]: CODE.UNPROCESSABLE,
  [VOID_REJECTION.REASON_REQUIRED]: CODE.VALIDATION,
  [VOID_REJECTION.OPERATOR_REQUIRED]: CODE.VALIDATION,
});

function throwRejection(rejection, message, data) {
  throw new ServiceError(REJECTION_CODE[rejection], message ?? REJECTION_MESSAGES[rejection], {
    rejection,
    ...data,
  });
}

function loadCardOrThrow(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(VOID_REJECTION.CARD_NOT_FOUND);
  return card;
}

/**
 * 聚合某工卡的作废前置引用（需求 42.1）——供 {@link checkVoidPrecondition} / {@link voidCard}
 * 共用。前两类（执行中 / 已生成未开始的 JOB）经 `jobRepo.listByCardId` 取得全部 JOB 后原样
 * 交给 `classifyVoidReferences`（其内部按 `exec_status` 归类，`Completed` 自动排除，见
 * `domain/void-rules.js`）。第三类见模块头注「已知缺口」。
 *
 * @param {number|string} cardId
 * @param {{inProgressPackageRefs?: object[]}} [options]
 * @returns {{jobs: object[], inProgressPackages: object[]}} 供 `checkVoidPrecondition`
 *   （领域纯函数）直接消费的 `refs` 形态
 */
function aggregateReferences(cardId, options = {}) {
  const jobs = jobRepo.listByCardId(cardId);
  const inProgressPackages = Array.isArray(options.inProgressPackageRefs)
    ? options.inProgressPackageRefs
    : []; // 已知缺口：契约端点未落地前无数据可取，见模块头注
  return { jobs, inProgressPackages };
}

/**
 * 作废前置校验（需求 42.1、42.2、42.5）——只读判定，不落库、不 `throw`，返回
 * `domain/void-rules.js` 的 `checkVoidPrecondition` 判别式结果对象，供 `GET
 * /api/task-cards/:id/void-precheck` 等只读预检场景直接消费。
 *
 * @param {number|string} cardId
 * @param {string} reason 拟填写的作废原因（可先行校验，不要求已确定最终值）
 * @param {{inProgressPackageRefs?: object[]}} [options] 见 {@link aggregateReferences}
 * @returns {object} `checkVoidPrecondition` 的返回值（`{ ok, rejection, message,
 *   blockingRefs, blockingTypes, historicalRefs, reasonMissing, card }`）
 * @throws {ServiceError} 工卡不存在（404）
 */
export function checkVoidPrecondition(cardId, reason, options) {
  const card = loadCardOrThrow(cardId);
  const refs = aggregateReferences(cardId, options);
  return checkVoidPreconditionDomain(card, refs, reason);
}

/**
 * 作废（需求 42.1–42.5，tasks.md 关键约束 1「非内容变更操作在生效态必须放行」）。
 *
 * 1. 取工卡，校验状态可迁往 `Void`（`canTransition`，与前置引用/原因校验正交，见模块头注）；
 * 2. 聚合三类引用 → `checkVoidPrecondition`：存在阻止性引用或原因为空即拒绝；
 * 3. 通过则单事务内：`task_card.status = 'Void'` + 经 `buildChangeRecords`
 *    （`change_type = 'void'`）写 `change_record`（原因必填，需求 42.5）。
 *
 * 不经编辑态闸门（需求 49.8）。
 *
 * @param {number|string} cardId 工卡主键
 * @param {string} reason 作废原因（必填，需求 42.5）
 * @param {{operatorId?: string, staffNo?: string, userId?: string}} ctx 调用上下文
 * @param {{inProgressPackageRefs?: object[]}} [options] 见 {@link aggregateReferences}
 * @returns {object} 作废后的工卡（camelCase）
 * @throws {ServiceError} 工卡不存在（404）、状态不可迁往 Void（422）、
 *   存在阻止性引用（422，`data.blockingRefs`/`data.blockingTypes` 附具体引用明细）、
 *   原因为空或纯空白（400）
 */
export function voidCard(cardId, reason, ctx, options) {
  const card = loadCardOrThrow(cardId);

  const status = statusOf(card);
  if (!canTransition(status, STATUS_VOID)) {
    throwRejection(VOID_REJECTION.INVALID_TRANSITION, undefined, { status });
  }

  const operatorIdRaw = ctx && typeof ctx === 'object' ? ctx.operatorId ?? ctx.staffNo ?? ctx.userId : undefined;
  if (operatorIdRaw === null || operatorIdRaw === undefined || String(operatorIdRaw).trim() === '') {
    throwRejection(VOID_REJECTION.OPERATOR_REQUIRED, '缺少操作人标识（ctx.operatorId），变更须可追溯到人');
  }
  const operatorId = String(operatorIdRaw);

  const refs = aggregateReferences(cardId, options);
  const precondition = checkVoidPreconditionDomain(card, refs, reason);
  if (!precondition.ok) {
    if (precondition.rejection === 'BLOCKING_REFERENCES') {
      throwRejection(VOID_REJECTION.BLOCKING_REFERENCES, precondition.message, {
        blockingRefs: precondition.blockingRefs,
        blockingTypes: precondition.blockingTypes,
      });
    }
    throwRejection(VOID_REJECTION.REASON_REQUIRED, precondition.message);
  }

  const after = { ...card, status: STATUS_VOID };
  const diff = buildChangeRecords(card, after, 'void', reason, operatorId, {
    cardId: card.id,
    cardRevision: card.revision,
  });
  if (!diff.ok) {
    // 与 checkVoidPreconditionDomain 的空白判定同义同码（见 void-rules.js 模块头注），
    // 正常流程（reason 已过 precondition、operatorId 已校验非空）不会在此处触发；仅作二次防线。
    throwRejection(VOID_REJECTION.REASON_REQUIRED, diff.message);
  }

  return getDb().transaction(() => {
    taskCardRepo.update(cardId, { status: STATUS_VOID });
    if (diff.records.length > 0) changeRecordRepo.createMany(diff.records);
    return taskCardRepo.findById(cardId);
  })();
}

export default { checkVoidPrecondition, voidCard };
