/**
 * 工卡关联服务（需求 16.4、21.1–21.5、45.8、45.9）。
 *
 * 组合 `domain/relation.js` 的纯函数与 `relationRepo` 的落库操作，承担四件事：
 *
 * 1. **人工关联增删查**（需求 21.1–21.3）：{@link addRelation} / {@link removeRelation} /
 *    {@link listRelations}。增删经编辑态闸门（`card-rules.js` 的 `passesEditableGate`，
 *    操作标识 `relationWrite`——与 `CONTENT_EDIT_OPERATIONS` 词表的登记项同名）；查看不受约束
 *    （需求 49.8）。
 * 2. **执行期自动建立关联**（需求 21.4）：{@link autoLinkFromExecDocument}，供执行期服务
 *    （任务 13.6）在产生 Process Card / Condition Report / Technique Sheet 等衍生单据时调用，
 *    **无需任何人工关联动作**。⚠ 本函数**不经编辑态闸门**：执行期衍生单据产生时，来源工卡
 *    通常已处于 `Effective` 态（已完成释放），若套用「仅 New 态可编辑」的闸门，这一「自动建立、
 *    无需人工介入」的流程会恒被拒绝，与需求 21.4 的字面要求相悖。这不是对工卡编制域内容的
 *    人工编辑，而是系统在执行期对关联关系的自动维护，故不在编辑态闸门约束范围内
 *    （类比需求 49.8 列举的非内容变更操作，但本操作未在该词表中，是因为它压根不是「人」发起的
 *    编辑动作）。
 * 3. **关键信息同步**（需求 21.5）：{@link syncKeyInfoForRelation} / {@link syncKeyInfoForCard}，
 *    在来源当前值（机型/件号/序列号/工卡编号）变更时把 `key_info_snapshot` 刷新为最新值。
 * 4. **暴露 `requiredSignDocTypes`**（需求 16.4、45.8、45.9）：{@link getRequiredSignDocTypes}
 *    供审核服务（任务 13.2）的提交审核校验清单项 (f) 调用，取某工卡关联单据中要求签署的类型
 *    集合。本函数只负责取数并转调 `domain/relation.js` 的同名纯函数，**不重新实现判定逻辑**。
 *
 * ## 错误约定（`lib/service-error.js`，与 `taskCardService.js` 同一口径）
 *
 * 全部导出的写操作（`addRelation` / `removeRelation` / `syncKeyInfoForRelation` /
 * `syncKeyInfoForCard`）在校验失败或前置条件不满足时一律 `throw new ServiceError(code,
 * message, data)`，不返回判别式结果对象——路由层（任务 17）统一 `try/catch ServiceError`
 * 转 `sendFail`。`data` 上仍附带 {@link RELATION_REJECTION} 中的原始拒绝原因码（挂在
 * `error.data.rejection`），供调用方/测试需要区分具体拒绝场景时读取。成功路径返回纯业务
 * 数据（不做 `{ok, data}` 信封包装）。`autoLinkFromExecDocument` 同此约定，但对「已存在
 * 同三元组关联」幂等放行（见其文档，属成功路径不抛错）。`getRequiredSignDocTypes` 是纯数据
 * 查询的直通转发，返回值形状与 `domain/relation.js` 的 `requiredSignDocTypes` 一致
 * （冻结的字符串数组），不涉及错误约定。
 *
 * 需求：16.4、21.1–21.5、45.8、45.9
 */

import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import * as relationRepo from '../repositories/relationRepo.js';
import * as taskCardRepo from '../repositories/taskCardRepo.js';
import { buildRelation, syncRelationKeyInfo, requiredSignDocTypes } from '../domain/relation.js';
import { passesEditableGate } from '../domain/card-rules.js';

/**
 * 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景，
 * 服务层/路由层的 HTTP 状态映射一律以 `ServiceError.code` 为准（见各抛出点注释的映射）。
 */
export const RELATION_REJECTION = Object.freeze({
  /** 工卡不存在 → `CODE.NOT_FOUND`（404） */
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  /** 工卡状态不为新增(New)，不可编辑关联（需求 49.1、49.2、49.4） → `CODE.UNPROCESSABLE`（422） */
  NOT_EDITABLE: 'NOT_EDITABLE',
  /** 关联单据信息不合法（单据类型越界、编号为空等，见 `buildRelation` 的校验） → `CODE.VALIDATION`（400） */
  INVALID_INPUT: 'INVALID_INPUT',
  /** 三元组 `(card_id, exec_doc_type, related_doc_no)` 已存在（需求 21.1） → `CODE.CONFLICT`（409） */
  DUPLICATE_RELATION: 'DUPLICATE_RELATION',
  /** 待删除/待同步的关联记录不存在 → `CODE.NOT_FOUND`（404） */
  RELATION_NOT_FOUND: 'RELATION_NOT_FOUND',
});

const REJECTION_MESSAGES = Object.freeze({
  [RELATION_REJECTION.CARD_NOT_FOUND]: '工卡不存在',
  [RELATION_REJECTION.NOT_EDITABLE]: '工卡状态不为新增(New)，不可编辑关联；如需变更请先执行升版',
  [RELATION_REJECTION.INVALID_INPUT]: '关联单据信息不合法',
  [RELATION_REJECTION.DUPLICATE_RELATION]: '该单据已与本工卡建立关联，不可重复关联',
  [RELATION_REJECTION.RELATION_NOT_FOUND]: '待操作的关联记录不存在',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [RELATION_REJECTION.CARD_NOT_FOUND]: CODE.NOT_FOUND,
  [RELATION_REJECTION.NOT_EDITABLE]: CODE.UNPROCESSABLE,
  [RELATION_REJECTION.INVALID_INPUT]: CODE.VALIDATION,
  [RELATION_REJECTION.DUPLICATE_RELATION]: CODE.CONFLICT,
  [RELATION_REJECTION.RELATION_NOT_FOUND]: CODE.NOT_FOUND,
});

/** `throw new ServiceError(...)` 的统一入口：按拒绝原因码取 `code` 与默认消息。 */
function throwRejection(rejection, message) {
  throw new ServiceError(REJECTION_CODE[rejection], message ?? REJECTION_MESSAGES[rejection], { rejection });
}

/**
 * 内容变更操作标识（需求 49.4）——与 `card-rules.js` 的 `CONTENT_EDIT_OPERATIONS` 词表中
 * `relationWrite`（工卡关联增删）登记项同名，人工增删共用同一操作标识接受编辑态闸门约束。
 */
const RELATION_WRITE_OPERATION = 'relationWrite';

/** 取工卡并经编辑态闸门校验；供人工增删两个入口共用。校验失败 `throw`，通过则返回工卡本身。 */
function loadEditableCard(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(RELATION_REJECTION.CARD_NOT_FOUND);
  if (!passesEditableGate(card, RELATION_WRITE_OPERATION)) {
    throwRejection(RELATION_REJECTION.NOT_EDITABLE);
  }
  return card;
}

/**
 * 人工新增关联（需求 21.1、21.3）：编制期 TS_Engineer 将 Task Card 与全部 11 类执行过程单据
 * 中的任一建立关联。经编辑态闸门；三元组已存在则拒绝（需求 21.1「不重复」）。
 *
 * @param {number|string} cardId 工卡主键
 * @param {object} doc 关联单据（读 `exec_doc_type`/`execDocType` 与
 *   `related_doc_no`/`relatedDocNo`/`doc_no`/`docNo`，可选 `job_id`/`jobId`）——形状同
 *   `domain/relation.js` 的 `buildRelation` 的 `doc` 入参
 * @param {{origin?: 'manual'|'auto', keyInfo?: object, jobId?: number|string|null,
 *   createdBy?: string, createdAt?: Date|string|number}} [options] 缺省 `origin` 时按单据类型
 *   推断（编制期人工关联通常应为 `'manual'`，需要覆盖时显式传入）
 * @returns {object} 新增的关联记录
 * @throws {ServiceError} 工卡不存在（404）、非 New 态（422）、单据信息不合法（400）、
 *   三元组已存在（409）
 */
export function addRelation(cardId, doc, options = {}) {
  const card = loadEditableCard(cardId);

  let relation;
  try {
    relation = buildRelation(card, doc, options.origin, options);
  } catch (error) {
    throwRejection(RELATION_REJECTION.INVALID_INPUT, error.message);
  }

  const existing = relationRepo.findByTriple(relation.card_id, relation.exec_doc_type, relation.related_doc_no);
  if (existing !== null) throwRejection(RELATION_REJECTION.DUPLICATE_RELATION);

  const id = relationRepo.create(relation);
  return relationRepo.findById(id);
}

/**
 * 人工删除关联（需求 21.1 的对称操作）：经编辑态闸门；关联须属于该工卡且存在，否则拒绝。
 *
 * @param {number|string} cardId 工卡主键
 * @param {number|string} relationId 待删除关联的主键
 * @returns {{id: number|string, removed: boolean}}
 * @throws {ServiceError} 工卡不存在（404）、非 New 态（422）、关联不存在或不属于该工卡（404）
 */
export function removeRelation(cardId, relationId) {
  loadEditableCard(cardId);

  const existing = relationRepo.findById(relationId);
  if (existing === null || String(existing.cardId) !== String(cardId)) {
    throwRejection(RELATION_REJECTION.RELATION_NOT_FOUND);
  }

  relationRepo.remove(relationId);
  return { id: relationId, removed: true };
}

/**
 * 查看某工卡的全部关联单据（需求 21.2）。查看属需求 49.8 列举的非内容变更操作，不经编辑态闸门。
 *
 * @param {number|string} cardId 工卡主键
 * @returns {object[]}
 * @throws {ServiceError} 工卡不存在（404）
 */
export function listRelations(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(RELATION_REJECTION.CARD_NOT_FOUND);
  return relationRepo.listByCardId(cardId);
}

/**
 * 执行期自动建立关联（需求 21.4）——供执行期服务（任务 13.6）在产生 Process Card /
 * Condition Report / Technique Sheet 等衍生单据时调用，无需任何人工关联动作。
 *
 * **不经编辑态闸门**（见模块头注第 2 点）。`origin` 缺省按 `buildRelation` 的推断规则
 * 取 `'auto'`（PC/CR/TS 或携带 `job_id` 的单据），显式传参仍可覆盖。
 *
 * **幂等**：三元组已存在时直接返回该既有关联，不视为错误——自动建立流程可能被执行期服务
 * 在同一单据上下文中重复调用（如报工重试），重复调用不应报错中断执行期流程。
 *
 * @param {number|string} cardId 来源工卡主键
 * @param {object} doc 衍生单据（形状同 `addRelation` 的 `doc` 入参）
 * @param {{origin?: 'manual'|'auto', keyInfo?: object, jobId?: number|string|null,
 *   createdBy?: string, createdAt?: Date|string|number}} [options]
 * @returns {object} 关联记录（新建或既有）
 * @throws {ServiceError} 工卡不存在（404）、单据信息不合法（400）
 */
export function autoLinkFromExecDocument(cardId, doc, options = {}) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(RELATION_REJECTION.CARD_NOT_FOUND);

  let relation;
  try {
    relation = buildRelation(card, doc, options.origin, options);
  } catch (error) {
    throwRejection(RELATION_REJECTION.INVALID_INPUT, error.message);
  }

  const existing = relationRepo.findByTriple(relation.card_id, relation.exec_doc_type, relation.related_doc_no);
  if (existing !== null) return existing;

  const id = relationRepo.create(relation);
  return relationRepo.findById(id);
}

/**
 * 关键信息变更同步至单条关联记录（需求 21.5）。
 *
 * @param {number|string} relationId 关联主键
 * @param {object} keyInfoSource 变更后的关键信息，或任意携带关键信息的来源行（工卡/JOB/单据）；
 *   形状同 `domain/relation.js` 的 `syncRelationKeyInfo` 的 `keyInfo` 入参（合并语义，
 *   未出现的字段保留快照原值）
 * @returns {object} 同步后的关联记录
 * @throws {ServiceError} 关联不存在（404）、`keyInfoSource` 形态不合法（400）
 */
export function syncKeyInfoForRelation(relationId, keyInfoSource) {
  const relation = relationRepo.findById(relationId);
  if (relation === null) throwRejection(RELATION_REJECTION.RELATION_NOT_FOUND);
  loadEditableCard(relation.cardId);

  let synced;
  try {
    synced = syncRelationKeyInfo(relation, keyInfoSource);
  } catch (error) {
    throwRejection(RELATION_REJECTION.INVALID_INPUT, error.message);
  }

  relationRepo.updateKeyInfoSnapshot(relationId, synced.keyInfoSnapshot ?? synced.key_info_snapshot);
  return relationRepo.findById(relationId);
}

/**
 * 关键信息变更同步至某工卡下的全部关联记录（需求 21.5）。
 *
 * 逐条同步，任一条同步失败即整体拒绝且不落库任何一条（与 `buildChangeRecords` 等模块的
 * 「校验失败即无副作用」约定一致）——`keyInfoSource` 的形态错误属输入错误，不应部分生效。
 *
 * @param {number|string} cardId 工卡主键
 * @param {object} keyInfoSource 变更后的关键信息或来源行（同 {@link syncKeyInfoForRelation}）
 * @returns {object[]} 同步后的关联记录集合
 * @throws {ServiceError} 工卡不存在（404）、`keyInfoSource` 形态不合法（400）
 */
export function syncKeyInfoForCard(cardId, keyInfoSource) {
  loadEditableCard(cardId);

  const relations = relationRepo.listByCardId(cardId);
  const synced = [];
  for (const relation of relations) {
    try {
      synced.push({ id: relation.id, snapshot: syncRelationKeyInfo(relation, keyInfoSource) });
    } catch (error) {
      throwRejection(RELATION_REJECTION.INVALID_INPUT, error.message);
    }
  }

  for (const { id, snapshot } of synced) {
    relationRepo.updateKeyInfoSnapshot(id, snapshot.keyInfoSnapshot ?? snapshot.key_info_snapshot);
  }
  return relationRepo.listByCardId(cardId);
}

/**
 * 某工卡关联单据中要求签署的类型集合（需求 16.4、45.8、45.9）——审核服务（任务 13.2）
 * 提交审核校验清单项 (f) 的数据来源。直接转调 `domain/relation.js` 的
 * `requiredSignDocTypes(relations, signRuleCfg)`，本函数只负责取数，不重新实现判定逻辑。
 *
 * 工卡不存在时按「无关联」处理，返回空数组（fail closed 由审核服务在校验层面负责，
 * 本函数是纯取数直通，不越权代为判定工卡是否存在）。
 *
 * @param {number|string} cardId 工卡主键
 * @param {ReadonlyArray<object>|Record<string,string>|Map<string,string>|null} [signRuleCfg]
 *   `exec_doc_type` 表行集合或等价映射；缺省回落至领域层的种子常量
 * @returns {readonly string[]} 冻结的类型码数组（去重，规范顺序），形状同
 *   `domain/relation.js` 的 `requiredSignDocTypes` 返回值
 */
export function getRequiredSignDocTypes(cardId, signRuleCfg) {
  const relations = relationRepo.listByCardId(cardId);
  return requiredSignDocTypes(relations, signRuleCfg);
}
