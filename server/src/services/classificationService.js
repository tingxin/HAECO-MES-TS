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
 * 模块头注）。每次派生均追加完整状态、候选与证据快照；仅唯一 `derived` 结果会在同一事务中
 * 同步工卡权威值。`requires_confirmation` / `undetermined` 只追加审计行，绝不以 `null` 覆盖
 * 已确认权威值。人工确认则在同一事务中追加 `confirmed` 行并同步选定分类与 Outsource subtype。
 * 仓储层本身不做同步，是否同步由本服务按结果状态唯一决定。
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
  /** 枚举内但不属于当前持久化候选。 */
  CLASSIFICATION_NOT_CANDIDATE: 'CLASSIFICATION_NOT_CANDIDATE',
  /** Outsource 细分缺失、非法或不属于当前候选证据。 */
  OUTSOURCE_SUBTYPE_MISMATCH: 'OUTSOURCE_SUBTYPE_MISMATCH',
  /** 最新结果不是待确认派生，不能确认。 */
  NO_PENDING_DERIVATION: 'NO_PENDING_DERIVATION',
  /** 调用方未绑定待确认派生结果。 */
  DERIVATION_RESULT_REQUIRED: 'DERIVATION_RESULT_REQUIRED',
  /** 调用方绑定的派生结果不是最新待确认结果。 */
  STALE_DERIVATION_RESULT: 'STALE_DERIVATION_RESULT',
});

const REJECTION_MESSAGES = Object.freeze({
  [CLASSIFICATION_REJECTION.CARD_NOT_FOUND]: '工卡不存在',
  [CLASSIFICATION_REJECTION.CONFIRMER_REQUIRED]: '缺少确认人标识（ctx.confirmedBy），无法记录人工确认',
  [CLASSIFICATION_REJECTION.NO_DERIVATION_TO_CONFIRM]: '该工卡尚无商务分类派生结果，请先执行派生',
  [CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_ALLOWED]: '选定的商务分类取值不属于预定义取值集',
  [CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_CANDIDATE]: '选定的商务分类不属于当前待确认候选集',
  [CLASSIFICATION_REJECTION.OUTSOURCE_SUBTYPE_MISMATCH]: 'Outsource subtype 缺失或不属于当前候选',
  [CLASSIFICATION_REJECTION.NO_PENDING_DERIVATION]: '最新商务分类结果不是待确认派生，请重新派生',
  [CLASSIFICATION_REJECTION.DERIVATION_RESULT_REQUIRED]: '缺少 derivationResultId，无法绑定当前待确认派生结果',
  [CLASSIFICATION_REJECTION.STALE_DERIVATION_RESULT]: '派生结果已过期，请按最新待确认结果确认',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [CLASSIFICATION_REJECTION.CARD_NOT_FOUND]: CODE.NOT_FOUND,
  [CLASSIFICATION_REJECTION.CONFIRMER_REQUIRED]: CODE.VALIDATION,
  [CLASSIFICATION_REJECTION.NO_DERIVATION_TO_CONFIRM]: CODE.NOT_FOUND,
  [CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_ALLOWED]: CODE.VALIDATION,
  [CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_CANDIDATE]: CODE.VALIDATION,
  [CLASSIFICATION_REJECTION.OUTSOURCE_SUBTYPE_MISMATCH]: CODE.VALIDATION,
  [CLASSIFICATION_REJECTION.NO_PENDING_DERIVATION]: CODE.UNPROCESSABLE,
  [CLASSIFICATION_REJECTION.DERIVATION_RESULT_REQUIRED]: CODE.VALIDATION,
  [CLASSIFICATION_REJECTION.STALE_DERIVATION_RESULT]: CODE.CONFLICT,
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
function appendAndSync(cardId, entry, syncAuthority) {
  return withTransaction(() => {
    const id = classificationResultRepo.create({
      cardId,
      classification: entry.classification,
      hitTier: entry.hitTier,
      sourceRef: entry.sourceRef,
      status: entry.status,
      candidatesJson: entry.candidates,
      recommendedClassification: entry.recommendedClassification,
      outsourceSubtype: entry.outsourceSubtype,
      reasonCode: entry.reasonCode,
      evaluatedTiersJson: entry.evaluatedTiers,
      derivationResultId: entry.derivationResultId,
      isManualConfirmed: entry.isManualConfirmed,
      confirmedBy: entry.confirmedBy,
      confirmedAt: entry.confirmedAt,
      createdAt: nowIso(),
    });
    if (syncAuthority) {
      taskCardRepo.update(cardId, {
        commercialClassification: entry.classification,
        outsourceSubtype: entry.outsourceSubtype,
      });
    }
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
 * **正常返回值**，不 `throw`。两者都会持久化完整结果快照，但不会同步 `null` 到工卡，
 * 因而不会覆盖已有的人工确认权威分类；仅唯一 `derived` 结果会自动同步权威值。
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
    status: derivation.status,
    classification: derivation.classification,
    recommendedClassification: derivation.recommendedClassification,
    outsourceSubtype: derivation.outsourceSubtype,
    hitTier: derivation.hitTier,
    sourceRef: derivation.sourceRef,
    candidates: derivation.candidates,
    reasonCode: derivation.reasonCode,
    evaluatedTiers: derivation.evaluatedTiers,
    derivationResultId: null,
    isManualConfirmed: false,
    confirmedBy: null,
    confirmedAt: null,
  }, derivation.status === 'derived');

  return { ...derivation, cardId, resultId: id };
}

/**
 * 人工确认商务分类（需求 29.3、29.4、29.6、29.7）——仅接受最新
 * `requires_confirmation` 审计行中的完整候选选择。
 *
 * 服务从 `commercial_classification_result` 读取已持久化的候选 JSON、推荐、证据与层级快照，
 * 拒绝枚举外值、枚举内非候选、Outsource subtype 不匹配以及调用方绑定的陈旧派生结果。
 * 通过后追加一行 `status='confirmed'`、`is_manual_confirmed=true` 的审计记录，关联原派生行，
 * 并在同一事务内同步工卡权威分类。
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
  if (latest.status !== 'requires_confirmation') {
    throwRejection(CLASSIFICATION_REJECTION.NO_PENDING_DERIVATION, undefined, {
      latestResultId: latest.id,
      latestStatus: latest.status,
    });
  }

  const requestedResultId = choice && typeof choice === 'object'
    ? choice.derivationResultId ?? choice.derivation_result_id
    : undefined;
  if (requestedResultId === undefined || requestedResultId === null
    || String(requestedResultId).trim() === '') {
    throwRejection(CLASSIFICATION_REJECTION.DERIVATION_RESULT_REQUIRED, undefined, {
      latestResultId: latest.id,
    });
  }
  if (String(requestedResultId) !== String(latest.id)) {
    throwRejection(CLASSIFICATION_REJECTION.STALE_DERIVATION_RESULT, undefined, {
      derivationResultId: requestedResultId,
      latestResultId: latest.id,
    });
  }

  const confirmedByRaw = ctx && typeof ctx === 'object'
    ? ctx.confirmedBy ?? ctx.staffNo ?? ctx.operatorId
    : undefined;
  if (confirmedByRaw === null || confirmedByRaw === undefined || String(confirmedByRaw).trim() === '') {
    throwRejection(CLASSIFICATION_REJECTION.CONFIRMER_REQUIRED);
  }
  const confirmedBy = String(confirmedByRaw);
  const confirmedAt = ctx?.confirmedAt ?? nowIso();

  const outcome = confirmClassificationDomain(latest, choice, { confirmedBy, confirmedAt });
  if (!outcome.accepted) {
    const rejectionByReason = {
      CLASSIFICATION_NOT_ALLOWED: CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_ALLOWED,
      CLASSIFICATION_NOT_CANDIDATE: CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_CANDIDATE,
      OUTSOURCE_SUBTYPE_MISMATCH: CLASSIFICATION_REJECTION.OUTSOURCE_SUBTYPE_MISMATCH,
    };
    throwRejection(
      rejectionByReason[outcome.reasonCode] ?? CLASSIFICATION_REJECTION.CLASSIFICATION_NOT_ALLOWED,
      undefined,
      { reasonCode: outcome.reasonCode },
    );
  }

  const { id } = appendAndSync(cardId, {
    status: outcome.result.status,
    classification: outcome.result.classification,
    recommendedClassification: outcome.result.recommendedClassification,
    outsourceSubtype: outcome.result.outsourceSubtype,
    hitTier: outcome.result.hitTier,
    sourceRef: outcome.result.sourceRef,
    candidates: latest.candidates,
    reasonCode: null,
    evaluatedTiers: latest.evaluatedTiers,
    derivationResultId: latest.id,
    isManualConfirmed: true,
    confirmedBy,
    confirmedAt,
  }, true);

  return { ...outcome.result, cardId, derivationResultId: latest.id, resultId: id };
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
 * 取某工卡的最新分类审计结果；其 `status` 可为 pending/undetermined，因而不必然等同于
 * `task_card` 当前权威分类。
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
