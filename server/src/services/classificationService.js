/**
 * 商务执行工卡分类派生服务（任务 13.7 之一，需求 29.1–29.8、43.3–43.5）。
 *
 * 组合 `domain/classification.js` 的纯函数（`deriveCommercialClassification` /
 * `confirmClassification`）、`configService.js` 的 `loadDerivationPriorityCfg()`
 * （**运行时优先级链权威源**，本服务直接复用、不重新读 `derivationPriorityRepo`，见其
 * 模块头注「组装 `domain/classification.js` 可直接消费的 `priorityCfg` 形态」）与
 * `classificationResultRepo`（`commercial_classification_result` 追加式审计轨迹）三者，
 * 完成「聚合 P1–P5 判定源 → 派生 → 追加审计行 → 同步权威值」的完整链路。
 *
 * ## P1–P5 判定源的契约形状
 *
 * `sources` 入参形状与设计文档 `GET /api/classification-sources?cardId=` 契约端点
 * 一次性返回的结构一致：`{ planDummyJob, nrcOriginatingDoc, outsourceEntry, partNature,
 * packageDivision }`（见 `domain/classification.js` 的 `deriveCommercialClassification`
 * 文档）。该只读集成契约端点的路由与仓储由任务 20.4 建立；本服务位于其下游，接受调用方
 * （路由层）已取得的 `sources` 对象作为入参，不在服务层内部重新发起该契约调用——这与
 * `bomService.js` 消费 `lotListBaseRepo`（已落地的只读集成仓储）不同：`classification_source`
 * 目前**无对应本地表/仓储**（`schema.sql` 分节 5 的集成 mock 表未包含它），故本服务不可能
 * 像 `bomService.js` 那样直接 `import` 一个尚不存在的仓储。任务 20.4 落地该契约的仓储后，
 * 调用方（路由）应改为「读仓储 → 组装 `sources` → 调用本服务」，本服务签名不受影响。
 *
 * ## 权威值同步（需求 29.1，本服务的核心不变式）
 *
 * `task_card.commercial_classification`（+ `outsource_subtype`）是**当前权威值**，
 * `commercial_classification_result` 是**追加式审计轨迹**（见 `classificationResultRepo.js`
 * 模块头注）。本服务的每次写操作（{@link deriveClassification} / {@link confirmClassification}）
 * 都在**同一事务**内「追加一行审计记录」+「同步工卡权威值为该行取值」，保证
 * `task_card.commercial_classification` 恒等于该工卡审计轨迹最新一行的 `classification`
 * ——即使该值为 `null`（候选集场景，待人工确认，需求 29.4）。仓储层本身不做这层同步
 * （其模块头注明确「本仓储只管追加与只读查询，不做同步」），同步是本服务层唯一职责。
 *
 * ## 候选集场景不是错误（需求 29.4、29.6，`code:0` 风格）
 *
 * {@link deriveClassification} 在同层多命中或类型 11 双值映射时返回
 * `status: 'requires_confirmation'` 与非空 `candidates`——这是**正常返回值**，不
 * `throw ServiceError`（与 design.md「业务上部分失败但整批成功……一律用 code:0 + data 内
 * 明细承载」的约定一致）。仅当工卡不存在（404）或——{@link confirmClassification}——
 * 选定值越出取值集合 / 确认人缺失（400）时才 `throw`。
 *
 * ## 不经编辑态闸门（需求 29.x，与 tasks.md 13.7 说明一致）
 *
 * 分类派生与人工确认**不**经 `card-rules.js` 的 `isEditable`/`passesEditableGate` 闸门：
 * 派生结果是追加式审计轨迹而非可编辑的工卡内容，且商务分类在工卡生效后仍可能需要派生/
 * 复核（例如工卡类型 11 的兜底判定），若套用「仅 New 态可编辑」闸门会使生效态工卡的分类
 * 永久无法确认——与需求 29.x 的字面意图相悖。
 *
 * ## 错误约定（`lib/service-error.js`，与 `taskCardService.js` 同一口径）
 *
 * 全部导出函数在校验失败或前置条件不满足时一律 `throw new ServiceError(code, message,
 * data)`；成功路径返回纯业务数据，不做 `{ ok, ... }` 信封包装。`data` 上附带
 * {@link CLASSIFICATION_REJECTION} 中的原始拒绝原因码（挂在 `error.data.rejection`）。
 *
 * 需求：29.1–29.8、43.3–43.5
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import {
  deriveCommercialClassification as deriveClassificationDomain,
  confirmClassification as confirmClassificationDomain,
} from '../domain/classification.js';

import taskCardRepo from '../repositories/taskCardRepo.js';
import classificationResultRepo from '../repositories/classificationResultRepo.js';
import * as configService from './configService.js';
import integrationService from './integrationService.js';

/** 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景。 */
export const CLASSIFICATION_REJECTION = Object.freeze({
  /** 工卡不存在 → `CODE.NOT_FOUND`（404） */
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  /** 待确认人身份缺失（需求 29.6：确认须留存确认人） → `CODE.VALIDATION`（400） */
  CONFIRMER_REQUIRED: 'CONFIRMER_REQUIRED',
  /** 该工卡尚无任何派生结果，无法确认（须先调用 {@link deriveClassification}） → `CODE.NOT_FOUND`（404） */
  NO_DERIVATION_TO_CONFIRM: 'NO_DERIVATION_TO_CONFIRM',
  /** 选定分类越出取值集合（需求 29.7，`domain/classification.js` 的 `CLASSIFICATION_NOT_ALLOWED`） → `CODE.VALIDATION`（400） */
  CLASSIFICATION_NOT_ALLOWED: 'CLASSIFICATION_NOT_ALLOWED',
});

const REJECTION_MESSAGES = Object.freeze({
  [CLASSIFICATION_REJECTION.CARD_NOT_FOUND]: '工卡不存在',
  [CLASSIFICATION_REJECTION.CONFIRMER_REQUIRED]: '缺少确认人标识（ctx.confirmedBy），无法记录人工确认',
  [CLASSIFICATION_REJECTION.NO_DERIVATION_TO_CONFIRM]: '该工卡尚无商务分类派生结果，请先执行派生',
  [CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_ALLOWED]: '选定的商务分类取值不属于预定义取值集',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [CLASSIFICATION_REJECTION.CARD_NOT_FOUND]: CODE.NOT_FOUND,
  [CLASSIFICATION_REJECTION.CONFIRMER_REQUIRED]: CODE.VALIDATION,
  [CLASSIFICATION_REJECTION.NO_DERIVATION_TO_CONFIRM]: CODE.NOT_FOUND,
  [CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_ALLOWED]: CODE.VALIDATION,
});

function throwRejection(rejection, message, data) {
  throw new ServiceError(REJECTION_CODE[rejection], message ?? REJECTION_MESSAGES[rejection], {
    rejection,
    ...data,
  });
}

function nowIso() {
  return new Date().toISOString();
}

function loadCardOrThrow(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throwRejection(CLASSIFICATION_REJECTION.CARD_NOT_FOUND);
  return card;
}

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果（服务层事务边界的统一入口）。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * 将审计行落库并同步工卡权威值（需求 29.1、29.5、29.6）——两次写入须在同一事务内完成，
 * 否则「权威值恒等于轨迹最新行」这一不变式在事务边界之间可被观察到短暂违反。
 *
 * @param {number|string} cardId
 * @param {{classification: string|null, outsourceSubtype: string|null, hitTier: string|null,
 *   sourceRef: string|null, isManualConfirmed: boolean, confirmedBy: string|null,
 *   confirmedAt: string|null}} entry
 * @returns {{id: number|bigint}}
 */
function appendAndSync(cardId, entry) {
  return withTransaction(() => {
    const id = classificationResultRepo.create({
      cardId,
      classification: entry.classification,
      hitTier: entry.hitTier,
      sourceRef: entry.sourceRef,
      isManualConfirmed: entry.isManualConfirmed,
      confirmedBy: entry.confirmedBy,
      confirmedAt: entry.confirmedAt,
      createdAt: nowIso(),
    });
    taskCardRepo.update(cardId, {
      commercialClassification: entry.classification,
      outsourceSubtype: entry.outsourceSubtype,
    });
    return { id };
  });
}

/**
 * 按优先级链派生商务执行工卡分类（需求 29.1–29.5、43.3、43.4）。
 *
 * 流程：取工卡 → 经 `configService.loadDerivationPriorityCfg()` 取运行时权威优先级链
 * （**不直接读 `derivationPriorityRepo`**，复用 configService 已组装好的
 * `{ tiers, cardTypeMap }` 形态）→ `deriveCommercialClassification` 纯函数派生 →
 * 追加一行 `commercial_classification_result` 并同步 `task_card.commercial_classification`
 * / `outsource_subtype`（同一事务）。
 *
 * 候选集场景（`status: 'requires_confirmation'`）与全未命中（`'undetermined'`）均为
 * **正常返回值**，不 `throw`——此时 `classification` 为 `null`，追加行与工卡权威值同步为
 * `null`，等待 {@link confirmClassification} 补齐。
 *
 * @param {number|string} cardId 工卡主键
 * @param {object} sources P1–P5 判定源聚合，形状同 `GET /api/classification-sources` 的
 *   返回：`{ planDummyJob, nrcOriginatingDoc, outsourceEntry, partNature, packageDivision }`
 * @returns {object} 派生结果（`domain/classification.js` 的 `deriveCommercialClassification`
 *   返回值），另附 `resultId`（本次追加的审计行主键）
 * @throws {ServiceError} 工卡不存在（404）
 */
export function deriveClassification(cardId, sources) {
  const card = loadCardOrThrow(cardId);
  const resolvedSources = sources === undefined
    ? integrationService.getClassificationSources(cardId).data
    : sources;
  const priorityCfg = configService.loadDerivationPriorityCfg();

  const derivation = deriveClassificationDomain(card, resolvedSources ?? {}, priorityCfg);

  const { id } = appendAndSync(cardId, {
    classification: derivation.classification,
    outsourceSubtype: derivation.outsourceSubtype,
    hitTier: derivation.hitTier,
    sourceRef: derivation.sourceRef,
    isManualConfirmed: false,
    confirmedBy: null,
    confirmedAt: null,
  });

  return { ...derivation, cardId, resultId: id };
}

/**
 * 人工确认 / 指定商务分类（需求 29.3、29.4、29.6、29.7）——供候选集场景（同层多命中、
 * 类型 11 双值映射）或人工另行指定时调用。
 *
 * 取该工卡**最新**一条派生结果（{@link deriveClassification} 或此前的确认记录）作为
 * `domain/classification.js` 的 `confirmClassification` 的 `derivation` 入参：审计表本身
 * 不持久化候选集明细（`commercial_classification_result` 无 `candidates` 列，只有
 * `classification`/`hit_tier`/`source_ref`），故 `choice` 若显式携带 `outsourceSubtype`
 * 由调用方（通常即前端就地回传派生接口给出的候选值）负责补齐，而非依赖本服务从历史候选集
 * 中重新匹配——这与 `confirmClassification` 纯函数「候选缺失时按 `derivation.hitTier` /
 * `sourceRef` 兜底、`outsourceSubtype` 以显式入参优先」的既有兜底语义一致。
 *
 * 通过后追加一行 `is_manual_confirmed = true` 的审计记录并同步工卡权威值（同一事务）。
 *
 * @param {number|string} cardId 工卡主键
 * @param {string|{classification: string, outsourceSubtype?: string}} choice 选定分类
 * @param {{confirmedBy?: string, staffNo?: string, operatorId?: string, confirmedAt?: string}} ctx
 *   确认人标识（`confirmedBy`/`staffNo`/`operatorId` 任一）与确认时间（缺省取当前时刻）
 * @returns {object} 确认后的结果（`domain/classification.js` 的 `confirmClassification`
 *   的 `result`），另附 `resultId`（本次追加的审计行主键）
 * @throws {ServiceError} 工卡不存在（404）、尚无派生结果可确认（404）、确认人缺失（400）、
 *   选定分类越出取值集合（400）
 */
export function confirmClassification(cardId, choice, ctx) {
  loadCardOrThrow(cardId);

  const latest = classificationResultRepo.findLatestByCardId(cardId);
  if (latest === null) throwRejection(CLASSIFICATION_REJECTION.NO_DERIVATION_TO_CONFIRM);

  const confirmedByRaw = ctx && typeof ctx === 'object'
    ? ctx.confirmedBy ?? ctx.staffNo ?? ctx.operatorId
    : undefined;
  if (confirmedByRaw === null || confirmedByRaw === undefined || String(confirmedByRaw).trim() === '') {
    throwRejection(CLASSIFICATION_REJECTION.CONFIRMER_REQUIRED);
  }
  const confirmedBy = String(confirmedByRaw);
  const confirmedAt = ctx?.confirmedAt ?? nowIso();

  const derivationLike = {
    classification: latest.classification,
    outsourceSubtype: null, // 未持久化候选明细；由 choice 显式携带补齐（见模块头注）
    hitTier: latest.hitTier,
    sourceRef: latest.sourceRef,
    candidates: [],
  };

  const outcome = confirmClassificationDomain(derivationLike, choice, { confirmedBy, confirmedAt });
  if (!outcome.accepted) {
    throwRejection(CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_ALLOWED, undefined, {
      reasonCode: outcome.reasonCode,
    });
  }

  const { id } = appendAndSync(cardId, {
    classification: outcome.result.classification,
    outsourceSubtype: outcome.result.outsourceSubtype,
    hitTier: outcome.result.hitTier,
    sourceRef: outcome.result.sourceRef,
    isManualConfirmed: true,
    confirmedBy,
    confirmedAt,
  });

  return { ...outcome.result, cardId, resultId: id };
}

/**
 * 取某工卡的商务分类派生/确认历史（追加顺序，需求 29.5 的可追溯性）。
 * 查看不受编辑态闸门约束（需求 49.8）。
 * @param {number|string} cardId
 * @returns {object[]}
 * @throws {ServiceError} 工卡不存在（404）
 */
export function listClassificationHistory(cardId) {
  loadCardOrThrow(cardId);
  return classificationResultRepo.listByCardId(cardId);
}

/**
 * 取某工卡的最新分类结果（即当前权威值所同步的那一行）。
 * @param {number|string} cardId
 * @returns {object|null}
 * @throws {ServiceError} 工卡不存在（404）
 */
export function getLatestClassification(cardId) {
  loadCardOrThrow(cardId);
  return classificationResultRepo.findLatestByCardId(cardId);
}

export default {
  deriveClassification,
  confirmClassification,
  listClassificationHistory,
  getLatestClassification,
};
