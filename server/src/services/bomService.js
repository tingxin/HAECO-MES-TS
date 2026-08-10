/**
 * BOM Base 输出服务（需求 48.1–48.8）。
 *
 * 组合 `lotLinkRepo`（IR Lot 卡与 Lot List 的关联增删）、只读集成仓储 `lotListBaseRepo`
 * （`GET /api/lot-lists/:lotListRef/bases` 的数据源，本模块只读见其模块头注）、
 * `domain/bom.js` 的 `aggregateBomBase`（两来源并集的唯一汇总实现，本服务不重新实现）与
 * `bomBaseRepo`（`bom_base_output` 落库）四者，完成「Lot 关联增删 → 取回 Base 集合 →
 * 汇总 → 落库」的完整链路。
 *
 * ## 为什么每次都整表重算并覆盖式重建输出（需求 48.8）
 *
 * `aggregateBomBase` 是**无状态纯投影**（其模块头注「零缓存」）：给定当前的 `cards` +
 * `lotLinks`（已补齐 Base 明细）即得到当前应有的完整输出集合，不存在「增量补丁」的概念——
 * 两来源均不支持记录级别的「谁变了」增量比对（IR 卡的 `base_number` 属工卡元数据，Lot List
 * 的 Base 集合是外部 mock，均无变更事件）。故本服务把 `refreshBomBase` 实现为
 * 「先删除该卡现有全部 `bom_base_output` 行，再整批重新插入汇总结果」的覆盖式刷新，
 * 而不是尝试对既有输出行做增量增删。这是需求 48.8「Lot List 的 Base 集合发生变更时
 * 输出同步更新」在**无变更事件、只能显式触发重算**的集成约束下的落实方式：Lot 关联增删后
 * 与「事后被动发现 Lot List Base 集合变了」两种场景统一调用同一入口，调用方无需区分。
 *
 * ## 事务边界
 *
 * {@link refreshBomBase} 的删除旧输出 + 插入新输出包裹在单一 `better-sqlite3` 事务内：
 * 若插入过程中途失败（如 `aggregateBomBase` 遇到非法明细抛错，见其文档「Lot Number 取不到」
 * 分支），整批回滚，不产生「旧输出已删、新输出未全部写入」的半态。{@link addLotLink} /
 * {@link removeLotLink} 各自的「关联增删 + 刷新输出」同样各包一层事务：Lot 关联的落库
 * 与因此触发的 BOM 输出刷新须同生共死，否则会出现「关联已增删、BOM 输出未同步」的裂缝
 * ——这正是需求 48.8 要求同步更新的场景，若不同事务则「同步」二字无事务保证。
 *
 * ## 错误约定（`lib/service-error.js`，与 `taskCardService.js` 同一口径）
 *
 * 全部写操作在校验失败或前置条件不满足时一律 `throw new ServiceError(code, message, data)`，
 * 不返回判别式结果对象——路由层统一 `try/catch ServiceError` 转 `sendFail`。`data` 上附带
 * {@link BOM_REJECTION} 中的原始拒绝原因码（挂在 `error.data.rejection`）。只读查询
 * （{@link listLotLinks} / {@link listBomBases}）成功直接返回纯业务数据。
 *
 * 需求：16.4（间接，Lot 关联同属工卡关联范畴）、48.1–48.8
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import * as lotLinkRepo from '../repositories/lotLinkRepo.js';
import * as bomBaseRepo from '../repositories/bomBaseRepo.js';
import * as lotListBaseRepo from '../repositories/lotListBaseRepo.js';
import * as taskCardRepo from '../repositories/taskCardRepo.js';
import { aggregateBomBase, IR_LOT_CARD_TYPE } from '../domain/bom.js';
import { passesEditableGate } from '../domain/card-rules.js';

/**
 * 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景，
 * 服务层/路由层的 HTTP 状态映射一律以 `ServiceError.code` 为准（见各抛出点注释的映射）。
 */
export const BOM_REJECTION = Object.freeze({
  /** 工卡不存在 → `CODE.NOT_FOUND`（404） */
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  /** 工卡状态不为新增(New)，不可编辑 Lot 关联（需求 49.1、49.2、49.4） → `CODE.UNPROCESSABLE`（422） */
  NOT_EDITABLE: 'NOT_EDITABLE',
  /** 工卡类型非 05（IR Lot 卡），不适用 Lot List 关联（需求 48.1） → `CODE.UNPROCESSABLE`（422） */
  NOT_IR_LOT_CARD: 'NOT_IR_LOT_CARD',
  /** Lot Number 为空（`lot_list_link.lot_number` 为 NOT NULL，需求 48.2） → `CODE.VALIDATION`（400） */
  INVALID_INPUT: 'INVALID_INPUT',
  /** 待删除的 Lot 关联不存在或不属于该工卡 → `CODE.NOT_FOUND`（404） */
  LOT_LINK_NOT_FOUND: 'LOT_LINK_NOT_FOUND',
});

const REJECTION_MESSAGES = Object.freeze({
  [BOM_REJECTION.CARD_NOT_FOUND]: '工卡不存在',
  [BOM_REJECTION.NOT_EDITABLE]: '工卡状态不为新增(New)，不可编辑 Lot List 关联；如需变更请先执行升版',
  [BOM_REJECTION.NOT_IR_LOT_CARD]: '仅工卡类型 05（IR Lot 卡）可关联 Lot List',
  [BOM_REJECTION.INVALID_INPUT]: 'Lot Number 不可为空',
  [BOM_REJECTION.LOT_LINK_NOT_FOUND]: '待删除的 Lot List 关联不存在',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [BOM_REJECTION.CARD_NOT_FOUND]: CODE.NOT_FOUND,
  [BOM_REJECTION.NOT_EDITABLE]: CODE.UNPROCESSABLE,
  [BOM_REJECTION.NOT_IR_LOT_CARD]: CODE.UNPROCESSABLE,
  [BOM_REJECTION.INVALID_INPUT]: CODE.VALIDATION,
  [BOM_REJECTION.LOT_LINK_NOT_FOUND]: CODE.NOT_FOUND,
});

/** `throw new ServiceError(...)` 的统一入口：按拒绝原因码取 `code` 与默认消息。 */
function throwRejection(rejection, message) {
  throw new ServiceError(REJECTION_CODE[rejection], message ?? REJECTION_MESSAGES[rejection], { rejection });
}

/**
 * 内容变更操作标识（需求 49.4）——Lot List 关联属需求 49.1「工卡关联」编制域内容的一种，
 * 与 `relationService.js` 的人工关联增删共用同一操作标识 `relationWrite`：两者在
 * `card-rules.js` 的 `CONTENT_EDIT_OPERATIONS` 词表中都归属「工卡关联增删」这一登记项，
 * 分设第二个操作名不会改变闸门判定结果，故不重复登记。
 */
const RELATION_WRITE_OPERATION = 'relationWrite';

function cardTypeOf(card) {
  return card.cardType ?? card.card_type ?? null;
}

/** 取工卡、校验存在 + 编辑态 + 类型 05；供 Lot 关联增删两个入口共用。校验失败 `throw`。 */
function loadEditableIrLotCard(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(BOM_REJECTION.CARD_NOT_FOUND);
  if (!passesEditableGate(card, RELATION_WRITE_OPERATION)) {
    throwRejection(BOM_REJECTION.NOT_EDITABLE);
  }
  if (cardTypeOf(card) !== IR_LOT_CARD_TYPE) {
    throwRejection(BOM_REJECTION.NOT_IR_LOT_CARD);
  }
  return card;
}

/** Lot Number 归一化：非空字符串去首尾空白后非空；其余（含纯空白、null、非字符串）为 null。 */
function normalizeLotNumber(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 取某工卡（类型 05）关联的全部 Lot List，并为每条关联补齐 Base 明细
 * （经 `lotListBaseRepo.listBasesByLotListRef`，即 `GET /api/lot-lists/:lotListRef/bases`
 * 的数据源），形状即 `aggregateBomBase` 的 `lotLinks` 入参可直接消费的形态。
 *
 * @param {number|string} cardId
 * @returns {Array<object>} `lot_list_link` 行数组，每行追加 `bases: [{baseNumber, lotNumber}]`
 */
function loadLotLinksWithBases(cardId) {
  const links = lotLinkRepo.listByCardId(cardId);
  return links.map((link) => {
    const bases = link.lotListRef === null || link.lotListRef === undefined
      ? []
      : lotListBaseRepo.listBasesByLotListRef(link.lotListRef);
    return { ...link, bases };
  });
}

/**
 * 重新汇总并刷新某工卡的 BOM Base 输出（需求 48.3–48.6、48.8）。
 *
 * 取该工卡 + 其 Lot 关联（已补齐 Base 明细）→ `aggregateBomBase` 汇总 → 单事务内先清空该卡
 * 现有 `bom_base_output` 行，再整批插入汇总结果（见模块头注「覆盖式刷新」）。
 *
 * 可独立调用（需求 48.8：Lot List 的 Base 集合发生变更时手动/显式触发重算），
 * 亦由 {@link addLotLink} / {@link removeLotLink} 在关联增删后自动调用。
 *
 * @param {number|string} cardId 工卡主键（类型 04 或 05 均可——非 IR/IR Lot 卡的工卡
 *   汇总结果恒为空数组，见 `aggregateBomBase` 对类型的过滤，此处不额外拒绝）
 * @returns {object[]} 刷新后的 BOM Base 输出集合
 * @throws {ServiceError} 工卡不存在（404）
 */
export function refreshBomBase(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(BOM_REJECTION.CARD_NOT_FOUND);

  const lotLinks = loadLotLinksWithBases(cardId);
  const rows = aggregateBomBase([card], lotLinks);

  const db = getDb();
  const runInTransaction = db.transaction(() => {
    for (const existing of bomBaseRepo.listByCardId(cardId)) {
      bomBaseRepo.remove(existing.id);
    }
    for (const row of rows) {
      bomBaseRepo.create({
        cardId: row.cardId,
        baseNumber: row.baseNumber,
        source: row.source,
        lotNumber: row.lotNumber,
      });
    }
  });
  runInTransaction();

  return bomBaseRepo.listByCardId(cardId);
}

/**
 * 新增一条 Lot List 关联（需求 48.1、48.2）：仅工卡类型 05 可用，经编辑态闸门；
 * 落库后单事务内同步刷新该卡的 BOM Base 输出（需求 48.8）。
 *
 * @param {number|string} cardId 工卡主键
 * @param {{lotNumber: string, lotListRef?: string|null}} link
 * @returns {object} 新增的 Lot List 关联记录
 * @throws {ServiceError} 工卡不存在（404）、非 New 态（422）、非 IR Lot 卡（422）、
 *   Lot Number 为空（400）
 */
export function addLotLink(cardId, link) {
  loadEditableIrLotCard(cardId);

  const lotNumber = normalizeLotNumber(link?.lotNumber ?? link?.lot_number);
  if (lotNumber === null) throwRejection(BOM_REJECTION.INVALID_INPUT);
  const lotListRef = link?.lotListRef ?? link?.lot_list_ref ?? null;

  const db = getDb();
  let created;
  const runInTransaction = db.transaction(() => {
    const id = lotLinkRepo.create({ cardId, lotNumber, lotListRef });
    created = lotLinkRepo.findById(id);
    refreshWithinTransaction(cardId);
  });
  runInTransaction();

  return created;
}

/**
 * 删除一条 Lot List 关联（需求 48.1、48.2 的对称操作）：经编辑态闸门；关联须属于该工卡且存在；
 * 落库后单事务内同步刷新该卡的 BOM Base 输出（需求 48.8）。
 *
 * @param {number|string} cardId 工卡主键
 * @param {number|string} linkId 待删除关联的主键
 * @returns {{id: number|string, removed: boolean}}
 * @throws {ServiceError} 工卡不存在（404）、非 New 态（422）、非 IR Lot 卡（422）、
 *   关联不存在或不属于该工卡（404）
 */
export function removeLotLink(cardId, linkId) {
  loadEditableIrLotCard(cardId);

  const existing = lotLinkRepo.findById(linkId);
  if (existing === null || String(existing.cardId) !== String(cardId)) {
    throwRejection(BOM_REJECTION.LOT_LINK_NOT_FOUND);
  }

  const db = getDb();
  const runInTransaction = db.transaction(() => {
    lotLinkRepo.remove(linkId);
    refreshWithinTransaction(cardId);
  });
  runInTransaction();

  return { id: linkId, removed: true };
}

/**
 * `refreshBomBase` 的核心逻辑，供 {@link addLotLink} / {@link removeLotLink} 在**已开启的
 * 事务内**调用（不可直接调用 `refreshBomBase`——那会另起一层 `db.transaction`，
 * better-sqlite3 不支持嵌套事务）。假定 `cardId` 对应的工卡已在调用方确认存在。
 */
function refreshWithinTransaction(cardId) {
  const card = taskCardRepo.findById(cardId);
  const lotLinks = loadLotLinksWithBases(cardId);
  const rows = aggregateBomBase([card], lotLinks);

  for (const existing of bomBaseRepo.listByCardId(cardId)) {
    bomBaseRepo.remove(existing.id);
  }
  for (const row of rows) {
    bomBaseRepo.create({
      cardId: row.cardId,
      baseNumber: row.baseNumber,
      source: row.source,
      lotNumber: row.lotNumber,
    });
  }
}

/**
 * 查看某工卡的全部 Lot List 关联（需求 48.1 的查看侧）。查看不受编辑态闸门约束（需求 49.8）。
 *
 * @param {number|string} cardId 工卡主键
 * @returns {object[]}
 * @throws {ServiceError} 工卡不存在（404）
 */
export function listLotLinks(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(BOM_REJECTION.CARD_NOT_FOUND);
  return lotLinkRepo.listByCardId(cardId);
}

/**
 * 查看某工卡的 BOM Base 输出（需求 48.5、48.6：`GET /api/task-cards/:id/bom-bases` 的服务层实现）。
 * 查看不受编辑态闸门约束（需求 49.8）。
 *
 * @param {number|string} cardId 工卡主键
 * @returns {object[]}
 * @throws {ServiceError} 工卡不存在（404）
 */
export function listBomBases(cardId) {
  const rows = refreshBomBase(cardId);
  const card = taskCardRepo.findById(cardId);
  return rows.map((row) => ({
    ...row,
    taskNo: card.taskNo,
    taskTitle: card.title,
  }));
}

export default {
  refreshBomBase,
  addLotLink,
  removeLotLink,
  listLotLinks,
  listBomBases,
};
