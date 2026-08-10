/**
 * 商务执行工卡分类派生领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 核心约定（需求 29.8、43.3、43.5）：
 * - **优先级顺序的运行时权威源是 `derivation_priority_config` 表**，由调用方以 `priorityCfg`
 *   传入（`{ tier_code, tier_order, enabled }` 行集）。本模块**不遍历** `enums.js` 的
 *   `DERIVATION_PRIORITY` 常量决定顺序——该常量仅用于校验层级代码字面量是否已知。
 *   改配置表即改判定结果，不改代码。
 * - **P6 兜底映射的权威源是 `card_type_commercial_map` 表**，同样由调用方传入，
 *   不在代码中硬编码 01→Gear Inspection 之类的映射，且**永不覆盖 P1–P5 的命中结果**。
 * - 同层多命中（需求 29.4）与工卡类型多值映射（需求 29.3、43.4）**不自动裁决**，
 *   产出候选集并要求人工确认。
 * - 每条结果与每个候选值均携带**命中层级**（`hitTier`）与**依据来源**（`sourceRef`），
 *   对应 `commercial_classification_result.hit_tier` / `source_ref`（需求 29.5）。
 * - 纯函数：相同输入恒得相同输出（不读时钟、不用随机数），人工确认时间由调用方传入。
 *
 * 需求：29.1–29.8、43.2–43.5
 */

import {
  COMMERCIAL_CLASSIFICATION,
  OUTSOURCE_SUBTYPE,
  DERIVATION_PRIORITY,
} from './enums.js';

/** 层级代码字面量（仅用于识别已知层级，顺序一律取自 `priorityCfg`） */
export const TIER_P1 = 'P1_PlanSetting';
export const TIER_P2 = 'P2_OriginatingDoc';
export const TIER_P3 = 'P3_OutsourceList';
export const TIER_P4 = 'P4_PartNature';
export const TIER_P5 = 'P5_PackageDivision';
export const TIER_P6 = 'P6_CardTypeFallback';

/** P5 工包划分的合法派生值域（需求 29.2 P5） */
export const PACKAGE_DIVISION_CLASSIFICATIONS = Object.freeze([
  'Routine', 'Material Special Replacement', 'Configuration(MOD)',
]);

/** 派生状态 */
export const DERIVATION_STATUS = Object.freeze({
  DERIVED: 'derived',                             // 单一命中，已确定
  REQUIRES_CONFIRMATION: 'requires_confirmation', // 候选集，待 TS 确认（不自动裁决）
  UNDETERMINED: 'undetermined',                   // 无任何层级命中
  CONFIRMED: 'confirmed',                         // 经人工确认/指定
});

/** 不可派生 / 待确认的原因码（可区分，便于前端提示与测试断言） */
export const DERIVATION_REASON = Object.freeze({
  MULTI_HIT_IN_TIER: 'MULTI_HIT_IN_TIER',           // 同层多命中（需求 29.4）
  CARD_TYPE_MULTI_MAP: 'CARD_TYPE_MULTI_MAP',       // 类型映射多值，如 01、11（需求 29.3、43.4）
  NO_TIER_HIT: 'NO_TIER_HIT',                       // P1–P6 均未命中
  PRIORITY_CONFIG_MISSING: 'PRIORITY_CONFIG_MISSING', // 优先级链配置缺失或全部停用
  CLASSIFICATION_NOT_ALLOWED: 'CLASSIFICATION_NOT_ALLOWED', // 人工指定越出取值集合（需求 29.7）
});

/** 分类取值封闭性判定（需求 29.1、29.7） */
export function isValidCommercialClassification(value) {
  return typeof value === 'string' && COMMERCIAL_CLASSIFICATION.includes(value);
}

/** 外包二级细分取值封闭性判定（需求 29.3） */
export function isValidOutsourceSubtype(value) {
  return typeof value === 'string' && OUTSOURCE_SUBTYPE.includes(value);
}

/** 取对象上第一个存在的键值（兼容 snake_case / camelCase 的行记录） */
function pick(obj, ...keys) {
  if (obj === null || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/** 布尔化配置列：SQLite 的 0/1、'0'/'1'、true/false 均可识别；缺省视为启用 */
function toEnabled(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !['0', 'false', 'no', ''].includes(value.toLowerCase());
  return Boolean(value);
}

function toSourceRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * 归一化优先级链配置（需求 29.8）——**判定顺序的唯一来源**。
 *
 * 入参为 `derivation_priority_config` 行集：`{ tier_code, tier_order, enabled }`
 * （亦接受 camelCase 与「层级代码字符串数组」两种简写）。处理规则：
 * - `enabled = 0 / false` 的层级**跳过**，不参与判定；
 * - 按 `tier_order` 升序排列（缺失 `tier_order` 者排在末尾，并保持入参相对次序，排序稳定）；
 * - 未知层级代码（不在 `DERIVATION_PRIORITY` 内）无对应判定器，予以剔除；
 * - 同一层级代码重复出现时仅保留 `tier_order` 最小的一条。
 *
 * @param {unknown} rows 配置行集
 * @returns {Array<{tierCode: string, tierOrder: number|null}>} 已排序的启用层级
 */
export function normalizePriorityTiers(rows) {
  if (!Array.isArray(rows)) return [];
  const decorated = [];
  rows.forEach((row, index) => {
    const tierCode = typeof row === 'string' ? row : pick(row, 'tier_code', 'tierCode', 'code');
    if (typeof tierCode !== 'string' || !DERIVATION_PRIORITY.includes(tierCode)) return;
    if (typeof row !== 'string' && !toEnabled(pick(row, 'enabled', 'is_enabled', 'isEnabled'))) return;
    const rawOrder = typeof row === 'string' ? undefined : pick(row, 'tier_order', 'tierOrder', 'order');
    const tierOrder = Number.isFinite(Number(rawOrder)) ? Number(rawOrder) : null;
    decorated.push({ tierCode, tierOrder, index });
  });
  decorated.sort((a, b) => {
    if (a.tierOrder === b.tierOrder) return a.index - b.index;
    if (a.tierOrder === null) return 1;
    if (b.tierOrder === null) return -1;
    return a.tierOrder - b.tierOrder;
  });
  const seen = new Set();
  const tiers = [];
  for (const item of decorated) {
    if (seen.has(item.tierCode)) continue;
    seen.add(item.tierCode);
    tiers.push({ tierCode: item.tierCode, tierOrder: item.tierOrder });
  }
  return tiers;
}

/**
 * 归一化 `card_type_commercial_map` 行集为 `工卡类型 → 分类数组`（需求 43.1、43.2、43.5）。
 * 保持行集给出的顺序，去重；越出 `COMMERCIAL_CLASSIFICATION` 的值剔除。
 *
 * @param {unknown} rows `{ card_type, commercial_classification }` 行集
 * @returns {Record<string, string[]>}
 */
export function normalizeCardTypeMap(rows) {
  const map = Object.create(null);
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    const cardType = pick(row, 'card_type', 'cardType');
    const classification = pick(
      row, 'commercial_classification', 'commercialClassification', 'classification',
    );
    if (typeof cardType !== 'string') continue;
    if (!isValidCommercialClassification(classification)) continue;
    if (map[cardType] === undefined) map[cardType] = [];
    if (!map[cardType].includes(classification)) map[cardType].push(classification);
  }
  return map;
}

/**
 * 解析派生配置。`priorityCfg` 规范形态为 `{ tiers, cardTypeMap }`：
 * - `tiers`：`derivation_priority_config` 行集（亦接受直接传入行集数组）；
 * - `cardTypeMap`：`card_type_commercial_map` 行集，或已归一化的 `{ '01': [...] }` 对象。
 *
 * `priorityCfg` 直接传数组时，P6 映射从 `sources.cardTypeMap` 取（两处皆无则 P6 不命中）。
 */
function resolveConfig(priorityCfg, sources) {
  const rawTiers = Array.isArray(priorityCfg)
    ? priorityCfg
    : pick(priorityCfg, 'tiers', 'priority', 'priorityTiers', 'rows');
  const rawMap = (Array.isArray(priorityCfg) ? undefined
    : pick(priorityCfg, 'cardTypeMap', 'card_type_commercial_map', 'cardTypeCommercialMap'))
    ?? pick(sources, 'cardTypeMap', 'card_type_commercial_map', 'cardTypeCommercialMap');
  const cardTypeMap = Array.isArray(rawMap)
    ? normalizeCardTypeMap(rawMap)
    : (rawMap !== undefined && rawMap !== null && typeof rawMap === 'object' ? rawMap : Object.create(null));
  return { tiers: normalizePriorityTiers(rawTiers), cardTypeMap };
}

/** 判定源归一化为「条目数组」：null/false → 无条目；true → 一条空证据条目；对象 → 一条；数组 → 逐条 */
function toEntries(value) {
  if (value === undefined || value === null || value === false) return [];
  if (value === true) return [{}];
  if (Array.isArray(value)) return value.flatMap((item) => toEntries(item));
  if (typeof value === 'object') return [value];
  if (typeof value === 'string') return value.length > 0 ? [{ ref: value }] : [];
  return [{}];
}

/** 条目证据来源：优先显式 `sourceRef`，其次各类业务单据号/引用键 */
function entrySourceRef(entry, fallback) {
  const ref = pick(
    entry,
    'sourceRef', 'source_ref', 'ref', 'docNo', 'doc_no', 'documentNo',
    'listRef', 'list_ref', 'entryId', 'entry_id', 'packageRef', 'package_ref',
    'planRef', 'plan_ref', 'partNo', 'part_no', 'id',
  );
  return toSourceRef(ref) ?? fallback;
}

/** 显式否定标记：`{ isDummyJob: false }` 之类明确表示「不命中」 */
function isExplicitlyNegative(entry, ...flags) {
  for (const flag of flags) {
    if (entry !== null && typeof entry === 'object' && entry[flag] === false) return true;
  }
  return false;
}

function candidate(classification, hitTier, sourceRef, outsourceSubtype = null) {
  return Object.freeze({ classification, outsourceSubtype, hitTier, sourceRef });
}

/** P1 计划设置 → Dummy Job（需求 29.2 P1） */
function evaluateP1(card, sources) {
  return toEntries(pick(sources, 'planDummyJob', 'plan_dummy_job'))
    .filter((entry) => !isExplicitlyNegative(entry, 'isDummyJob', 'is_dummy_job', 'dummyJob'))
    .map((entry) => candidate('Dummy Job', TIER_P1, entrySourceRef(entry, 'planDummyJob')));
}

/** P2 实际发起单据 → NRC（需求 29.2 P2） */
function evaluateP2(card, sources) {
  return toEntries(pick(sources, 'nrcOriginatingDoc', 'nrc_originating_doc'))
    .map((entry) => candidate('NRC', TIER_P2, entrySourceRef(entry, 'nrcOriginatingDoc')));
}

/** P3 实际外包清单 → Outsource（+ L sub / 工序外委）（需求 29.2 P3、29.3） */
function evaluateP3(card, sources) {
  return toEntries(pick(sources, 'outsourceEntry', 'outsource_entry', 'outsourceList'))
    .map((entry) => {
      const raw = pick(entry, 'subtype', 'subType', 'outsource_subtype', 'outsourceSubtype');
      const subtype = isValidOutsourceSubtype(raw) ? raw : null;
      return candidate('Outsource', TIER_P3, entrySourceRef(entry, 'outsourceEntry'), subtype);
    });
}

/** P4 零件性质（寿命件）→ LLP（需求 29.2 P4） */
function evaluateP4(card, sources) {
  return toEntries(pick(sources, 'partNature', 'part_nature'))
    .filter((entry) => !isExplicitlyNegative(
      entry, 'isLifeLimited', 'is_life_limited', 'isLLP', 'is_llp', 'lifeLimited',
    ))
    .map((entry) => candidate('LLP', TIER_P4, entrySourceRef(entry, 'partNature')));
}

/** P5 工包划分 → Routine / Material Special Replacement / Configuration(MOD)（需求 29.2 P5） */
function evaluateP5(card, sources) {
  return toEntries(pick(sources, 'packageDivision', 'package_division'))
    .map((entry) => {
      const raw = typeof entry === 'object'
        ? pick(entry, 'classification', 'commercial_classification', 'commercialClassification', 'division')
        : undefined;
      if (!PACKAGE_DIVISION_CLASSIFICATIONS.includes(raw)) return null;
      return candidate(raw, TIER_P5, entrySourceRef(entry, 'packageDivision'));
    })
    .filter((item) => item !== null);
}

/**
 * P6 工卡类型兜底（需求 29.2 P6、43.2–43.4）——仅在 P1–P5 全部未命中时才被求值，
 * 故结构上不可能覆盖 P1–P5；类型 01、11 映射双值时产出候选集不自动裁决。
 */
function evaluateP6(card, cardTypeMap) {
  const cardType = pick(card, 'card_type', 'cardType');
  if (typeof cardType !== 'string') return [];
  const mapped = cardTypeMap[cardType];
  if (!Array.isArray(mapped)) return [];
  return mapped
    .filter((classification) => isValidCommercialClassification(classification))
    .map((classification) => candidate(classification, TIER_P6, `card_type:${cardType}`));
}

const TIER_EVALUATORS = Object.freeze({
  [TIER_P1]: (card, sources) => evaluateP1(card, sources),
  [TIER_P2]: (card, sources) => evaluateP2(card, sources),
  [TIER_P3]: (card, sources) => evaluateP3(card, sources),
  [TIER_P4]: (card, sources) => evaluateP4(card, sources),
  [TIER_P5]: (card, sources) => evaluateP5(card, sources),
  [TIER_P6]: (card, sources, cardTypeMap) => evaluateP6(card, cardTypeMap),
});

/** 候选去重：同 (分类, 外包细分) 视为同一候选，保留首个证据来源 */
function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    const key = `${item.classification}|${item.outsourceSubtype ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * 按优先级链派生商务执行工卡分类（需求 29.1–29.5、43.2–43.4）。
 *
 * 自上而下遍历 `priorityCfg` 给出的启用层级，取**首个命中层级**的结果：
 * - 该层唯一命中 → `status='derived'`，`classification` 即为派生值；
 * - 该层多条命中（含类型 01/11 的双值映射）→ `status='requires_confirmation'`，
 *   `classification` 恒为 `null`（**不自动裁决**），全部命中值置于 `candidates`；
 * - 全部层级均未命中 → `status='undetermined'`。
 *
 * @param {object} card 工卡对象（P6 仅用到 `card_type`）
 * @param {object} sources P1–P5 判定源聚合，即 `GET /api/classification-sources` 的返回：
 *   `{ planDummyJob, nrcOriginatingDoc, outsourceEntry, partNature, packageDivision }`；
 *   各项可为 `false`/`null`（未命中）、对象（单条依据）或数组（多条依据 → 同层多命中）。
 * @param {object|Array} priorityCfg `{ tiers, cardTypeMap }`，`tiers` 为 `derivation_priority_config`
 *   行集（`{ tier_code, tier_order, enabled }`），`cardTypeMap` 为 `card_type_commercial_map` 行集。
 *   **顺序与启用状态一律以此为准，不读取 `DERIVATION_PRIORITY` 常量顺序。**
 * @returns {object} 派生结果，含 `hitTier` / `sourceRef` / `candidates` / `reasonCode` / `evaluatedTiers`
 */
export function deriveCommercialClassification(card, sources, priorityCfg) {
  const { tiers, cardTypeMap } = resolveConfig(priorityCfg, sources);
  const cardId = pick(card, 'id', 'card_id', 'cardId') ?? null;
  const base = {
    cardId,
    status: DERIVATION_STATUS.UNDETERMINED,
    classification: null,
    outsourceSubtype: null,
    hitTier: null,
    sourceRef: null,
    candidates: [],
    requiresManualConfirmation: false,
    isManualConfirmed: false,
    confirmedBy: null,
    confirmedAt: null,
    reasonCode: DERIVATION_REASON.NO_TIER_HIT,
    evaluatedTiers: [],
  };

  if (tiers.length === 0) {
    return Object.freeze({ ...base, reasonCode: DERIVATION_REASON.PRIORITY_CONFIG_MISSING });
  }

  const evaluatedTiers = [];
  for (const tier of tiers) {
    const evaluator = TIER_EVALUATORS[tier.tierCode];
    const hits = dedupeCandidates(evaluator(card, sources, cardTypeMap));
    evaluatedTiers.push(Object.freeze({
      tierCode: tier.tierCode, tierOrder: tier.tierOrder, hitCount: hits.length,
    }));
    if (hits.length === 0) continue;

    if (hits.length === 1) {
      const [hit] = hits;
      return Object.freeze({
        ...base,
        status: DERIVATION_STATUS.DERIVED,
        classification: hit.classification,
        outsourceSubtype: hit.outsourceSubtype,
        hitTier: hit.hitTier,
        sourceRef: hit.sourceRef,
        candidates: Object.freeze([hit]),
        reasonCode: null,
        evaluatedTiers: Object.freeze(evaluatedTiers),
      });
    }

    // 同层多命中 / 类型多值映射：不自动裁决，产出候选集要求人工确认（需求 29.3、29.4、43.4）
    return Object.freeze({
      ...base,
      status: DERIVATION_STATUS.REQUIRES_CONFIRMATION,
      classification: null,
      hitTier: tier.tierCode,
      sourceRef: null,
      candidates: Object.freeze(hits),
      requiresManualConfirmation: true,
      reasonCode: tier.tierCode === TIER_P6
        ? DERIVATION_REASON.CARD_TYPE_MULTI_MAP
        : DERIVATION_REASON.MULTI_HIT_IN_TIER,
      evaluatedTiers: Object.freeze(evaluatedTiers),
    });
  }

  return Object.freeze({ ...base, evaluatedTiers: Object.freeze(evaluatedTiers) });
}

/**
 * 人工确认 / 指定商务分类（需求 29.6、29.7）。
 *
 * - `choice` 越出 `COMMERCIAL_CLASSIFICATION` 时**拒绝**并给出原因码（需求 29.7）；
 * - 接受时标记 `isManualConfirmed`，记录确认人与确认时间（时间由调用方传入，保持纯函数）；
 * - 命中层级与依据来源沿用派生结果：选中候选值时取该候选的 `hitTier` / `sourceRef`，
 *   人工另行指定（不在候选集内）时保留派生层级并标记 `isCandidateChoice = false`（需求 29.5）。
 *
 * @param {object} derivation {@link deriveCommercialClassification} 的返回值
 * @param {string|object} choice 选定分类，或 `{ classification, outsourceSubtype }`
 * @param {{confirmedBy: string, confirmedAt: string}} ctx 确认人与确认时间
 * @returns {{accepted: boolean, reasonCode: string|null, result: object|null}}
 */
export function confirmClassification(derivation, choice, ctx = {}) {
  const classification = typeof choice === 'string'
    ? choice
    : pick(choice, 'classification', 'commercial_classification', 'commercialClassification');
  if (!isValidCommercialClassification(classification)) {
    return Object.freeze({
      accepted: false,
      reasonCode: DERIVATION_REASON.CLASSIFICATION_NOT_ALLOWED,
      result: null,
    });
  }

  const rawSubtype = typeof choice === 'string'
    ? undefined
    : pick(choice, 'outsourceSubtype', 'outsource_subtype', 'subtype');
  const candidates = Array.isArray(derivation?.candidates) ? derivation.candidates : [];
  const matched = candidates.find((item) => item.classification === classification
    && (rawSubtype === undefined || item.outsourceSubtype === rawSubtype)) ?? null;
  const outsourceSubtype = classification === 'Outsource'
    ? (isValidOutsourceSubtype(rawSubtype) ? rawSubtype : (matched?.outsourceSubtype ?? null))
    : null;

  return Object.freeze({
    accepted: true,
    reasonCode: null,
    result: Object.freeze({
      ...(derivation ?? {}),
      status: DERIVATION_STATUS.CONFIRMED,
      classification,
      outsourceSubtype,
      hitTier: matched?.hitTier ?? derivation?.hitTier ?? null,
      sourceRef: matched?.sourceRef ?? derivation?.sourceRef ?? null,
      requiresManualConfirmation: false,
      isManualConfirmed: true,
      isCandidateChoice: matched !== null,
      confirmedBy: ctx.confirmedBy ?? null,
      confirmedAt: ctx.confirmedAt ?? null,
      reasonCode: null,
    }),
  });
}
