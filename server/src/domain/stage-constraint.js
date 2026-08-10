/**
 * Stage × 工卡类型强约束领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 8.2 的四组能力：
 * - `validateStageCardType(stage, cardType, cfg)` 组合合法性校验：允许组合 ∪ 横切取值均通过（需求 46.9–46.11、46.13）
 * - `defaultStageFor(cardType, cfg)`              选定类型后的 Stage **默认值**（需求 46.12）
 * - `selectableStages(cardType, cfg)`             可改选范围 = 该类型允许组合 ∪ 横切取值（需求 46.12、46.13）
 * - `selectableForStandardPackage(card)`          组包取卡**契约谓词**（需求 46.3、46.5）
 *
 * ## Stage 不置只读（需求 46.12 修正后，Property 28）
 *
 * `defaultStageFor` 只给出**默认值**，本模块**不实现任何将 Stage 字段置只读的逻辑**。
 * `selectableStages` 恒包含横切取值，保证 {DMY, NRC, WCC, WFD} 对**任意**工卡类型可达：
 * 若 Stage 置只读，WFD 对类型 01–10 将永久不可标记，需求 46.5 的 WFD 排除逻辑随之退化为空条件。
 *
 * ## 配置驱动（需求 46.14）
 *
 * 运行时权威为 `stage_card_type_constraint` 与 `stage_crosscut` **两张表**，经 `cfg` 注入；
 * `enums.js` 的 `STAGE_CROSSCUT` 仅是种子默认值，仅在 `cfg` **完全未给出**横切取值来源时兜底
 * （给出空数组即视为业务方清空了横切取值，不兜底）。改配置即改校验结果，无需改代码。
 *
 * ## 维度独立性（需求 46.1、46.7、46.8）
 *
 * 本模块只读 Stage / 工卡类型 / 工卡状态，**不派生**其中任何一个：`Stage=WFD` 不触发状态迁移为
 * 「作废(Void)」（作废仍走需求 42 流程），Stage 亦不派生商务分类（见 `classification.js`）。
 *
 * ## 模块边界
 *
 * `selectableForStandardPackage` 是本模块向 **Work Package List 模块**暴露的契约谓词；
 * Load Standard Package 的取卡查询（TPC / A/C Type / Gear Type 过滤与检索）由 WPL 模块实现，
 * **本模块不实现取卡查询**。
 *
 * 需求：46.1、46.3–46.5、46.7–46.14
 */

import { CARD_TYPE_CODES, STAGE, STAGE_CROSSCUT } from './enums.js';
import { statusOf } from './card-rules.js';

/** Load Standard Package 取卡的唯一 Stage（需求 46.3） */
const STAGE_RTN = 'RTN';
/** 待删除标记（需求 46.4–46.6）：恒排除于取卡结果之外 */
const STAGE_WFD = 'WFD';
/** 取卡要求的工卡状态（需求 46.3） */
const STATUS_EFFECTIVE = 'Effective';

/** 校验拒绝原因码 */
export const STAGE_REJECTION = Object.freeze({
  UNKNOWN_STAGE: 'unknownStage',
  UNKNOWN_CARD_TYPE: 'unknownCardType',
  COMBINATION_NOT_ALLOWED: 'combinationNotAllowed',
});

/**
 * 取 `cfg` 上第一个存在的键值，兼容 camelCase / snake_case 两种写法。
 * 返回 `undefined` 表示该来源**完全未给出**（区别于给出空数组）。
 */
function pickConfigSource(cfg, keys) {
  if (cfg === null || typeof cfg !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(cfg, key) && cfg[key] !== null && cfg[key] !== undefined) {
      return cfg[key];
    }
  }
  return undefined;
}

/** 取行上第一个存在的字段，兼容 camelCase / snake_case */
function pickRowField(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** `is_auto_fill` 归一化：SQLite 存 0/1，亦接受布尔与 `'1'` / `'true'` */
function toAutoFillFlag(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

/**
 * 归一化 Stage × 类型约束配置。
 *
 * 接受形态（均为 `stage_card_type_constraint` / `stage_crosscut` 的行集合）：
 * - `{ constraints | stageCardTypeConstraint | stage_card_type_constraint, crosscut | crosscutStages | stageCrosscut | stage_crosscut }`
 * - 直接传入约束行数组（此时横切取值取种子默认值）
 * - `null` / `undefined`（此时允许组合为空、横切取值取种子默认值）
 *
 * 约束行：`{ card_type, allowed_stage, is_auto_fill }`（camelCase 亦可）。
 * 横切行：`'WFD'` 或 `{ stage: 'WFD' }`。
 *
 * `card_type` 不属 `CARD_TYPE_CODES`、`stage` 不属 `STAGE` 的行**静默忽略**——本模块不抛异常，
 * 配置合法性由写端点（`PUT /api/stage-constraints`）与表级 `CHECK` 把关。
 *
 * ⚠ `allowedByCardType` / `autoFillByCardType` 的键集合覆盖全部 `CARD_TYPE_CODES`，但**枚举顺序
 * 不保证**为 01–11（`'10'` / `'11'` 属 JS 整数索引键会被引擎前置）；按键取值，勿依赖遍历顺序。
 * 各类型的 Stage 数组则保持配置行顺序。
 *
 * @param {unknown} cfg
 * @returns {{ allowedByCardType: Readonly<Record<string, readonly string[]>>,
 *             autoFillByCardType: Readonly<Record<string, readonly string[]>>,
 *             crosscutStages: readonly string[] }}
 */
export function normalizeStageConstraintConfig(cfg) {
  const rawConstraints = Array.isArray(cfg)
    ? cfg
    : pickConfigSource(cfg, ['constraints', 'stageCardTypeConstraint', 'stage_card_type_constraint', 'allowedCombinations']);
  const rawCrosscut = Array.isArray(cfg)
    ? undefined
    : pickConfigSource(cfg, ['crosscut', 'crosscutStages', 'stageCrosscut', 'stage_crosscut']);

  const allowed = Object.create(null);
  const autoFill = Object.create(null);
  for (const cardType of CARD_TYPE_CODES) {
    allowed[cardType] = [];
    autoFill[cardType] = [];
  }

  if (Array.isArray(rawConstraints)) {
    for (const row of rawConstraints) {
      if (row === null || typeof row !== 'object') continue;
      const cardType = pickRowField(row, ['card_type', 'cardType']);
      const stage = pickRowField(row, ['allowed_stage', 'allowedStage', 'stage']);
      if (typeof cardType !== 'string' || !CARD_TYPE_CODES.includes(cardType)) continue;
      if (typeof stage !== 'string' || !STAGE.includes(stage)) continue;
      if (!allowed[cardType].includes(stage)) allowed[cardType].push(stage);
      if (toAutoFillFlag(pickRowField(row, ['is_auto_fill', 'isAutoFill'])) && !autoFill[cardType].includes(stage)) {
        autoFill[cardType].push(stage);
      }
    }
  }

  // 横切取值来源未给出时才取种子默认值；给出空数组即视为业务方清空（需求 46.14）
  const crosscutRows = Array.isArray(rawCrosscut) ? rawCrosscut : STAGE_CROSSCUT;
  const crosscut = [];
  for (const row of crosscutRows) {
    const stage = typeof row === 'string'
      ? row
      : (row !== null && typeof row === 'object' ? pickRowField(row, ['stage', 'allowed_stage', 'allowedStage']) : undefined);
    if (typeof stage !== 'string' || !STAGE.includes(stage)) continue;
    if (!crosscut.includes(stage)) crosscut.push(stage);
  }

  const freezeMap = (map) => Object.freeze(
    Object.fromEntries(Object.entries(map).map(([key, value]) => [key, Object.freeze([...value])])),
  );

  return Object.freeze({
    allowedByCardType: freezeMap(allowed),
    autoFillByCardType: freezeMap(autoFill),
    crosscutStages: Object.freeze(crosscut),
  });
}

/**
 * 该工卡类型在**约束表**中的允许 Stage 组合（不含横切取值）（需求 46.9）。
 * 类型未知或无配置行时为空数组。
 * @param {unknown} cardType
 * @param {unknown} cfg
 * @returns {readonly string[]}
 */
export function allowedStagesFor(cardType, cfg) {
  const { allowedByCardType } = normalizeStageConstraintConfig(cfg);
  if (typeof cardType !== 'string') return Object.freeze([]);
  return allowedByCardType[cardType] ?? Object.freeze([]);
}

/**
 * 运行时横切取值集合（需求 46.13、46.14）：以 `cfg` 的 `stage_crosscut` 为权威，
 * 未给出该来源时取 `enums.js` 的种子默认值。
 * @param {unknown} cfg
 * @returns {readonly string[]}
 */
export function crosscutStagesOf(cfg) {
  return normalizeStageConstraintConfig(cfg).crosscutStages;
}

/**
 * Stage × 工卡类型组合合法性校验（需求 46.10、46.11、46.13）。
 *
 * 通过当且仅当：组合属于约束表允许组合，**或** Stage 属于运行时横切取值集合。
 * 未知 Stage / 未知工卡类型一律拒绝（拒绝优于放行）。不抛异常，服务层据 `ok === false`
 * 返回 `CODE.VALIDATION`（400），并以 `selectableStages` 提示该类型可取的 Stage 范围。
 *
 * @param {unknown} stage
 * @param {unknown} cardType
 * @param {unknown} cfg 见 {@link normalizeStageConstraintConfig}
 * @returns {{ ok: boolean, rejection: string | null, message: string,
 *             viaCrosscut: boolean, allowedStages: readonly string[], selectableStages: readonly string[] }}
 */
export function validateStageCardType(stage, cardType, cfg) {
  const normalized = normalizeStageConstraintConfig(cfg);
  const allowed = (typeof cardType === 'string' && normalized.allowedByCardType[cardType]) || Object.freeze([]);
  const crosscut = normalized.crosscutStages;
  const selectable = Object.freeze([...allowed, ...crosscut.filter((s) => !allowed.includes(s))]);

  const result = (ok, rejection, message, viaCrosscut) => Object.freeze({
    ok,
    rejection,
    message,
    viaCrosscut,
    allowedStages: allowed,
    selectableStages: selectable,
  });

  if (typeof cardType !== 'string' || !CARD_TYPE_CODES.includes(cardType)) {
    return result(false, STAGE_REJECTION.UNKNOWN_CARD_TYPE, `未知工卡类型：${String(cardType)}`, false);
  }
  if (typeof stage !== 'string' || !STAGE.includes(stage)) {
    return result(false, STAGE_REJECTION.UNKNOWN_STAGE, `未知 Stage 取值：${String(stage)}`, false);
  }
  if (crosscut.includes(stage)) {
    // 横切取值不受工卡类型约束，可与任意类型共存（需求 46.13）
    return result(true, null, 'ok', true);
  }
  if (allowed.includes(stage)) {
    return result(true, null, 'ok', false);
  }
  return result(
    false,
    STAGE_REJECTION.COMBINATION_NOT_ALLOWED,
    `工卡类型 ${cardType} 不允许 Stage=${stage}；可取值范围：${selectable.join(' / ') || '（无）'}`,
    false,
  );
}

/**
 * 选定工卡类型后 Stage 的**默认值**（需求 46.12）。
 *
 * 候选集取约束表中该类型的 `is_auto_fill=1` 行；无此类行时退化为该类型全部允许组合。
 * 候选唯一时返回该 Stage，否则返回 `null`（如类型 11 的 CUS / MOD 并存，须人工选择）。
 *
 * ⚠ 返回值仅为默认值：**Stage 字段不置只读**，可改选范围见 {@link selectableStages}。
 * 默认值恒属于该类型的允许组合，绝不返回仅存在于横切取值中的 Stage（Property 28）。
 *
 * @param {unknown} cardType
 * @param {unknown} cfg
 * @returns {string | null}
 */
export function defaultStageFor(cardType, cfg) {
  if (typeof cardType !== 'string') return null;
  const { allowedByCardType, autoFillByCardType } = normalizeStageConstraintConfig(cfg);
  const allowed = allowedByCardType[cardType];
  if (!allowed || allowed.length === 0) return null;
  const autoFill = autoFillByCardType[cardType] ?? [];
  const candidates = autoFill.length > 0 ? autoFill : allowed;
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Stage 的可改选范围（需求 46.12、46.13，Property 28）：
 * **该类型允许组合 ∪ 运行时横切取值集合**。
 *
 * 横切取值恒在结果内，故 {DMY, NRC, WCC, WFD} 对**任意**工卡类型可达——这是需求 46.12
 * 由「只读」修正为「默认值 + 可改选」后的可达性保证。类型未知时仅返回横切取值。
 *
 * 结果与 {@link validateStageCardType} 的放行集合恒一致（同一份 `cfg` 下）。
 *
 * @param {unknown} cardType
 * @param {unknown} cfg
 * @returns {readonly string[]}
 */
export function selectableStages(cardType, cfg) {
  const normalized = normalizeStageConstraintConfig(cfg);
  const allowed = (typeof cardType === 'string' && normalized.allowedByCardType[cardType]) || [];
  return Object.freeze([...allowed, ...normalized.crosscutStages.filter((s) => !allowed.includes(s))]);
}

/** 取工卡 Stage；取不到合法 Stage 时返回 `null`。 */
export function stageOf(card) {
  if (typeof card === 'string') return STAGE.includes(card) ? card : null;
  if (card === null || typeof card !== 'object') return null;
  const raw = card.stage ?? card.card_stage ?? card.cardStage;
  return typeof raw === 'string' && STAGE.includes(raw) ? raw : null;
}

/**
 * Load Standard Package 组包取卡**契约谓词**（需求 46.3、46.5）：
 * 为真当且仅当 `stage === 'RTN' && status === 'Effective'`；`stage === 'WFD'` 恒为假
 * （即使状态仍为「生效」）。
 *
 * ⚠ 本函数为本模块向 **Work Package List 模块**暴露的契约谓词。TPC / A/C Type / Gear Type
 * 维度的过滤与取卡查询由 WPL 模块实现，**本模块不实现取卡查询**。
 *
 * 需求 46.7：`Stage=WFD` 不使工卡状态迁移为「作废」，仅影响本谓词的取值。
 *
 * @param {unknown} card 工卡对象（`{ stage, status }`，兼容 snake_case）
 * @returns {boolean}
 */
export function selectableForStandardPackage(card) {
  const stage = stageOf(card);
  if (stage === STAGE_WFD) return false; // 待删除标记恒排除（需求 46.5）
  if (stage !== STAGE_RTN) return false;
  return statusOf(card) === STATUS_EFFECTIVE;
}
