/**
 * 提交审核校验清单与审核动作领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 本模块是一个**组合模块**：不重新实现任一子校验的判定逻辑，只按需求 34.1 的顺序编排既有
 * 领域纯函数并汇总结果。三项能力：
 * - `submitReviewChecklist(card, ctx)`  提交审核完整校验清单 (a)–(h)，返回未通过项清单
 * - `canApprove(card, userId)`          一编一审：审核人 ≠ 编制人（不含权限判定，见下）
 * - `acceptReviewAction(card, action, comment)` 批准/驳回的接受条件（态=审核中 ∧ 意见非空）
 *
 * ## 校验清单 (a)–(h) 的组合来源（需求 34.1，任一未通过即阻止提交）
 *
 * | 项 | 名称 | 组合自 | 数据来源（ctx） |
 * |----|------|--------|------------------|
 * | (a) | 查重 | `card-rules.js` 的 `checkDuplicate(cards, taskNo, revision, excludeId)` | `ctx.cards` |
 * | (b) | 枚举 | `enums.js` 的 `isValidEnumValue(field, value)`，逐一应用于 8 个枚举绑定字段 | 卡自身字段 |
 * | (c) | 必填 | 最小信息集字段集（见下「D-04 派生」） | `ctx.orgName` / `ctx.referenceDocuments` / `ctx.steps` |
 * | (d) | 能力清单 | `capability.js` 的 `checkCapability(card, capabilityList, onDate)` | `ctx.capabilityList` / `ctx.onDate` |
 * | (e) | 变更原因 | 复用 `change-record.js` 的 `isBlank` 判空约定 | `ctx.changeReason` |
 * | (f) | 签署项配置 | `relation.js` 的 `requiredSignDocTypes` + `signature.js` 的 `aggregateSignatureRequirements` | `ctx.relations` / `ctx.signRuleCfg` / `ctx.steps` |
 * | (g) | Stage×工卡类型组合 | `stage-constraint.js` 的 `validateStageCardType(stage, cardType, cfg)` | `ctx.stageConstraintCfg` |
 * | (h) | 商务分类确认 | 最新持久化分类结果须为唯一 `derived` 或人工 `confirmed` | `ctx.latestClassificationResult` |
 *
 * ⚠ 需求 34.3「审核中禁止编辑」**不在本模块校验范围内**：该约束是需求 49.1「仅新增态可编辑」
 * 的一个特例，已由 `card-rules.js` 的 `isEditable` / `isFrozen`（Property 26）覆盖，
 * 服务层入口的编辑态闸门统一拦截，本模块不重复实现。
 *
 * ## `ctx` 的形状与 D-04 派生（必填字段集合）
 *
 * 《临时设计说明》D-04 已明列「必填字段完整性校验」的具体字段集合（需求 34.1(c)）：
 * **组织名称、Task No、Title、参考文件≥1 条、Revision、Date、A/C Type、Gear Type、
 * 工序≥1 道、签署项≥1 项**。其中：
 * - Task No / Title / Revision / Date / A/C Type / Gear Type 直接读自 `card` 本身
 *   （对应 `task_card` 的 `task_no` / `title` / `revision` / `date` / `ac_type` / `gear_type` 列）；
 * - 组织名称是 `system_parameter` 表的单一配置值（需求 35.1、35.3：只读展示，工卡上不单独存储），
 *   本模块无 DB 访问，故须由调用方（服务层已读取该配置）经 `ctx.orgName` 传入；
 * - 参考文件与工序均是**关联集合**，本模块无 DB 访问，须由调用方经 `ctx.referenceDocuments`
 *   （`reference_document` 行集合，属于该工卡）与 `ctx.steps`（`process_step` 行集合）传入；
 * - 「签署项≥1 项」复用 `ctx.steps` 经 `aggregateSignatureRequirements` 聚合的 `count`
 *   （即需求 45.6 的唯一来源），不另设第二份签署项数据入口。
 *
 * `ctx` 的完整形状：
 * ```
 * {
 *   cards:               readonly object[],  // (a) 现存工卡集合（不含本卡自身，或本卡亦可在内——按 id 排除）
 *   orgName:             string,             // (c) 组织名称（system_parameter，需求 35）
 *   referenceDocuments:  readonly object[],  // (c) 本卡的参考文件集合（reference_document 行）
 *   steps:               readonly object[],  // (c)(f) 本卡的工序集合（process_step 行，签署项挂载或扁平均可）
 *   capabilityList:      readonly object[],  // (d) 能力清单全表（capability_list 行）
 *   onDate:              string|Date,        // (d) 校验基准日；缺省取当日（见 capability.js）
 *   changeReason:        string,             // (e) 本次提交的变更原因
 *   relations:            readonly object[], // (f) 本卡的关联单据集合（card_relation 行）
 *   signRuleCfg:          object|Map|array,  // (f) exec_doc_type 的签署要求配置（缺省回落种子常量）
 *   stageConstraintCfg:   object,            // (g) Stage×类型约束配置（stage_card_type_constraint + crosscut）
 *   latestClassificationResult: object|null, // (h) 最新持久化商务分类派生/确认结果
 * }
 * ```
 *
 * ## 缺失数据的处理原则：fail closed（“不可判定即视为未通过”，而非静默跳过）
 *
 * 各子校验函数自身已内建“空输入 → 从严判定”的语义（如 `checkCapability` 对空清单判
 * `NO_EFFECTIVE_REVISION`、`validateStageCardType` 对空约束表仅放行横切取值），本模块直接
 * 复用这些语义，**不**额外发明第二套“缺失”判定——除了一处例外：
 *
 * - **(a) 查重**：`checkDuplicate` 对 `cards` 缺省（`undefined`/`null`）会静默按“空集合”处理而
 *   判定“无重复”，这与“fail closed”背道而驰（没有数据可比对时更应拒绝，而非放行）。故本模块
 *   在调用 `checkDuplicate` 前显式区分“`ctx.cards` 未提供”（`undefined`/`null`，判该项**未通过**，
 *   原因码 `CTX_MISSING_CARDS`）与“`ctx.cards` 显式为空数组”（业务上表示确无其它工卡，交由
 *   `checkDuplicate` 按正常语义判定）。
 *
 * 其余各项（(d) 能力清单、(f) 签署项配置、(g) Stage×类型）在 `ctx` 对应字段缺省时，
 * 子函数自身的空输入语义已经等价于“fail closed”或符合业务真空语义（如 (f) 无关联单据时
 * 本就不要求签署项，真空放行），故本模块不重复包裹。(e) 变更原因缺省（`undefined`）经
 * `isBlank` 判定即为“空”，同样已是 fail closed。
 *
 * 需求：22.1–22.3, 34.1, 34.2, 34.4–34.7, 34.10, 34.11, 39.2, 45.9, 46.10
 */

import { statusOf, checkDuplicate } from './card-rules.js';
import { isValidEnumValue } from './enums.js';
import { checkCapability } from './capability.js';
import { validateStageCardType } from './stage-constraint.js';
import { aggregateSignatureRequirements } from './signature.js';
import { requiredSignDocTypes } from './relation.js';

/** 审核动作取值集（`review_record.action` 的表局部取值集，需求 34.4、34.5） */
export const REVIEW_ACTIONS = Object.freeze(['approve', 'reject']);

/** 审核动作接受条件的拒绝原因码（需求 34.6、34.7、34.10） */
export const REVIEW_ACTION_REJECTION = Object.freeze({
  /** `action` 不属于 `REVIEW_ACTIONS` */
  INVALID_ACTION: 'INVALID_ACTION',
  /** 工卡状态不为「审核中(UnderReview)」（需求 34.10） */
  NOT_UNDER_REVIEW: 'NOT_UNDER_REVIEW',
  /** 审核意见为空或纯空白（需求 34.6、34.7、34.11） */
  COMMENT_REQUIRED: 'COMMENT_REQUIRED',
});

const REVIEW_ACTION_MESSAGES = Object.freeze({
  [REVIEW_ACTION_REJECTION.INVALID_ACTION]: `审核动作须为 ${REVIEW_ACTIONS.join(' / ')} 之一`,
  [REVIEW_ACTION_REJECTION.NOT_UNDER_REVIEW]: '工卡状态不为审核中(UnderReview)，不可执行批准或驳回',
  [REVIEW_ACTION_REJECTION.COMMENT_REQUIRED]: '审核意见为空，须填写审核意见方可执行批准或驳回',
});

/** 提交审核校验清单的 8 项标识与中文名（需求 34.1 (a)–(h)） */
const CHECK_LABELS = Object.freeze({
  a: '查重',
  b: '枚举',
  c: '必填',
  d: '能力清单',
  e: '变更原因',
  f: '签署项配置',
  g: 'Stage×工卡类型组合',
  h: '商务分类确认',
});

/** 唯一可执行批准/驳回的状态（需求 34.10） */
const STATUS_UNDER_REVIEW = 'UnderReview';

/** 校验项 (b) 涉及的 8 个枚举绑定字段：`[逻辑字段名, snake_case 列名]` */
const ENUM_FIELD_KEYS = Object.freeze([
  ['acType', 'ac_type'],
  ['gearType', 'gear_type'],
  ['stage', 'stage'],
  ['skill', 'skill'],
  ['ctrlCode', 'ctrl_code'],
  ['cardType', 'card_type'],
  ['commercialClassification', 'commercial_classification'],
  ['outsourceSubtype', 'outsource_subtype'],
]);

/** 校验项 (c) 中直接读自卡自身的文本/标量必填字段：`[逻辑字段名, ...候选列名, 展示名]` */
const REQUIRED_CARD_FIELDS = Object.freeze([
  { label: 'Task No', keys: ['taskNo', 'task_no'] },
  { label: 'Title', keys: ['title'] },
  { label: 'Revision', keys: ['revision', 'card_revision', 'cardRevision'] },
  { label: 'Date', keys: ['date'] },
  { label: 'A/C Type', keys: ['acType', 'ac_type'] },
  { label: 'Gear Type', keys: ['gearType', 'gear_type'] },
]);

/** 取对象上第一个非 null/undefined 的字段值，兼容 camelCase / snake_case。 */
function pick(source, ...keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * 空白判定——与 `change-record.js` 的 `isBlank` 逐字一致（需求 19.2 的判空约定复用）：
 * 空串、纯空白（含全角空格）为空；有限数字不为空；BigInt 不为空；其余非字符串一律视为空。
 */
function isBlank(value) {
  if (typeof value === 'string') {
    return value.trim().length === 0 || /^[\s\u3000]*$/.test(value);
  }
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'bigint') return false;
  return true;
}

/** 身份标识归一化（去空白字符串 / 有限数字 / BigInt 转字符串）；取不到时 `null`。 */
function normalizeIdentity(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/** 构造一条未通过项记录。 */
function failed(check, rejection, message, detail) {
  return Object.freeze({
    check,
    label: CHECK_LABELS[check],
    rejection,
    message,
    detail: detail === undefined ? null : detail,
  });
}

// =====================================================================
// 校验项 (a)–(h)：每项返回 `null`（通过）或一条未通过记录
// =====================================================================

/** (a) 查重（需求 10.4、10.5、38.6）：组合 `card-rules.js` 的 `checkDuplicate`。 */
function checkDuplicateItem(card, ctx) {
  if (!Array.isArray(ctx?.cards)) {
    return failed(
      'a',
      'CTX_MISSING_CARDS',
      'ctx.cards 未提供，无法校验工卡编号是否重复（fail closed：视为未通过）',
    );
  }
  const taskNo = pick(card, 'taskNo', 'task_no');
  const revision = pick(card, 'revision', 'card_revision', 'cardRevision');
  const excludeId = pick(card, 'id', 'cardId', 'card_id');
  const result = checkDuplicate(ctx.cards, taskNo, revision, excludeId);
  if (!result.ok) {
    return failed('a', result.rejection, result.message, result.conflict);
  }
  return null;
}

/** (b) 枚举（需求 6.9）：组合 `enums.js` 的 `isValidEnumValue`，逐一应用于 8 个绑定字段。 */
function checkEnumItem(card) {
  const invalid = [];
  for (const [field, snake] of ENUM_FIELD_KEYS) {
    const value = pick(card, field, snake);
    if (value === undefined) continue; // 缺省字段的合法性不在本项判定（多数为可选字段，交由 (c)/(g) 处理）
    if (!isValidEnumValue(field, value)) invalid.push({ field, value });
  }
  if (invalid.length > 0) {
    const detailText = invalid.map((item) => `${item.field}=${String(item.value)}`).join('、');
    return failed('b', 'INVALID_ENUM_VALUE', `以下字段取值不属于预定义取值集：${detailText}`, invalid);
  }
  return null;
}

/**
 * (c) 必填（需求 34.1(c)，字段集合见《临时设计说明》D-04）：
 * 组织名称、Task No、Title、参考文件≥1 条、Revision、Date、A/C Type、Gear Type、
 * 工序≥1 道、签署项≥1 项。
 */
function checkRequiredItem(card, ctx) {
  const missing = [];

  if (isBlank(ctx?.orgName)) missing.push('组织名称');
  for (const field of REQUIRED_CARD_FIELDS) {
    if (isBlank(pick(card, ...field.keys))) missing.push(field.label);
  }

  const referenceDocuments = Array.isArray(ctx?.referenceDocuments) ? ctx.referenceDocuments : [];
  if (referenceDocuments.length < 1) missing.push('参考文件（至少 1 条）');

  const steps = Array.isArray(ctx?.steps) ? ctx.steps : [];
  if (steps.length < 1) missing.push('工序（至少 1 道）');

  // 「签署项」的唯一来源是需求 45.6 的工序聚合（与校验项 (f) 共用同一份 ctx.steps）
  const signatureCount = aggregateSignatureRequirements(steps).count;
  if (signatureCount < 1) missing.push('签署项（至少 1 项）');

  if (missing.length > 0) {
    return failed('c', 'MISSING_REQUIRED_FIELD', `以下必填项缺失：${missing.join('、')}`, missing);
  }
  return null;
}

/** (d) 能力清单（需求 39.2、39.3）：组合 `capability.js` 的 `checkCapability`。 */
function checkCapabilityItem(card, ctx) {
  const result = checkCapability(card, ctx?.capabilityList, ctx?.onDate);
  if (!result.ok) {
    return failed('d', result.rejection, result.message, result.scope);
  }
  return null;
}

/** (e) 变更原因（需求 19.2）：复用 `isBlank` 判空约定。 */
function checkChangeReasonItem(ctx) {
  if (isBlank(ctx?.changeReason)) {
    return failed('e', 'REASON_REQUIRED', '变更原因为空或纯空白，须填报变更原因方可提交审核');
  }
  return null;
}

/**
 * (f) 签署项配置（需求 45.8、45.9）：组合 `relation.js` 的 `requiredSignDocTypes` 与
 * `signature.js` 的 `aggregateSignatureRequirements`——两者的“接缝”：关联单据中存在要求签署
 * 的类型，而工卡下全部工序的签署项聚合为空，即未通过。
 */
function checkSignatureConfigItem(ctx) {
  const requiredTypes = requiredSignDocTypes(ctx?.relations, ctx?.signRuleCfg);
  if (requiredTypes.length === 0) return null; // 无需签署的关联单据类型，真空通过

  const steps = Array.isArray(ctx?.steps) ? ctx.steps : [];
  const aggregate = aggregateSignatureRequirements(steps);
  if (aggregate.count === 0) {
    return failed(
      'f',
      'MISSING_SIGNATURE_CONFIG',
      `以下要求签署的关联单据类型未配置任何签署项：${requiredTypes.join('、')}`,
      requiredTypes,
    );
  }
  return null;
}

/** (g) Stage×工卡类型组合（需求 46.10、46.11）：组合 `stage-constraint.js` 的 `validateStageCardType`。 */
function checkStageCardTypeItem(card, ctx) {
  const stage = pick(card, 'stage');
  const cardType = pick(card, 'cardType', 'card_type');
  const result = validateStageCardType(stage, cardType, ctx?.stageConstraintCfg);
  if (!result.ok) {
    return failed('g', result.rejection, result.message, result.selectableStages);
  }
  return null;
}

function checkClassificationItem(ctx) {
  const latest = ctx?.latestClassificationResult ?? ctx?.classificationResult;
  if (latest === null || latest === undefined || typeof latest !== 'object') {
    return failed('h', 'CLASSIFICATION_RESULT_MISSING', '尚无持久化商务分类派生结果，不可提交审核');
  }
  const candidates = Array.isArray(latest.candidates) ? latest.candidates : [];
  const confirmed = latest.status === 'confirmed'
    && (latest.isManualConfirmed === 1 || latest.isManualConfirmed === true);
  const unambiguousDerived = latest.status === 'derived'
    && typeof latest.classification === 'string'
    && candidates.length === 1;
  if (!confirmed && !unambiguousDerived) {
    return failed(
      'h',
      'COMMERCIAL_CLASSIFICATION_CONFIRMATION_REQUIRED',
      '商务分类尚未唯一派生或人工确认，不可提交审核',
      { resultId: latest.id ?? null, status: latest.status ?? null, candidates },
    );
  }
  return null;
}

/**
 * 提交审核完整校验清单（需求 34.1、34.2，Property 19）——**组合模块**，依需求 34.1 的
 * (a)–(h) 顺序执行既有领域纯函数并汇总结果，不重新实现任一子校验的判定逻辑。
 *
 * 全部 8 项通过时 `ok === true`；任一未通过时 `ok === false`，`failedChecks` 给出
 * **全部**未通过项（不止首个，便于界面一次性展示需修正的全部问题），顺序即 (a)–(h)。
 *
 * @param {object} card 待提交审核的工卡对象（`task_card` 行或等价对象）
 * @param {object} [ctx] 校验所需的外部数据（见模块头注「`ctx` 的形状」）
 * @returns {Readonly<{ok: boolean, failedChecks: ReadonlyArray<Readonly<{
 *   check: 'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h', label: string, rejection: string, message: string,
 *   detail: unknown}>>}>}
 */
export function submitReviewChecklist(card, ctx = {}) {
  const results = [
    checkDuplicateItem(card, ctx),
    checkEnumItem(card),
    checkRequiredItem(card, ctx),
    checkCapabilityItem(card, ctx),
    checkChangeReasonItem(ctx),
    checkSignatureConfigItem(ctx),
    checkStageCardTypeItem(card, ctx),
    checkClassificationItem(ctx),
  ];
  const failedChecks = results.filter((item) => item !== null);
  return Object.freeze({
    ok: failedChecks.length === 0,
    failedChecks: Object.freeze(failedChecks),
  });
}

/**
 * 一编一审（需求 22.3，Property 14）——**仅**编码「审核人 ≠ 编制人」这一条规则。
 *
 * ⚠ 本函数**不**校验审卡权限：审卡权限判定是 `permission.js` 的 `checkPermission(role,
 * 'card_review', cfg)`，由服务层在调用本函数之外另行判定（需求 22.2）。二者职责分离：
 * 本函数窄化为「防同一用户既编又审」这一件事，不与权限判定折叠。
 *
 * 为真当且仅当：`userId` 可判定为有效身份（非空白），且与该工卡的编制人（`created_by`）
 * 不同。`userId` 为空白时身份不可判定，返回 `false`（无法确认「不是编制人」，fail closed）。
 *
 * @param {object} card 工卡对象（读 `created_by` / `createdBy`）
 * @param {unknown} userId 待判定的审核人身份（工号）
 * @returns {boolean}
 */
export function canApprove(card, userId) {
  const reviewer = normalizeIdentity(userId);
  if (reviewer === null) return false;
  const creator = normalizeIdentity(pick(card, 'createdBy', 'created_by'));
  return reviewer !== creator;
}

/**
 * 审核动作（批准/驳回）的接受条件（需求 34.4–34.7、34.10、34.11，Property 19）。
 *
 * 接受当且仅当：`action` ∈ {@link REVIEW_ACTIONS}，工卡状态为「审核中(UnderReview)」，
 * 且审核意见非空（复用 `isBlank` 判空约定）。
 *
 * ⚠ 本函数**不**执行状态迁移：批准态转「生效」须先经 `supersede.js` 的 `supersedeOnApprove`
 * （同一事务内先降级原生效版本、后置本版本生效，Property 25）；驳回态转「新增」是纯粹的状态
 * 置回，均由服务层在本函数返回 `ok: true` 之后执行——本函数只回答「这次批准/驳回是否成立」。
 *
 * @param {object} card 工卡对象（读状态，见 `card-rules.js` 的 `statusOf`）
 * @param {unknown} action 审核动作，须 ∈ {@link REVIEW_ACTIONS}
 * @param {unknown} comment 审核意见
 * @returns {Readonly<{ok: boolean, rejection: string|null, message: string, action: string|null}>}
 */
export function acceptReviewAction(card, action, comment) {
  if (typeof action !== 'string' || !REVIEW_ACTIONS.includes(action)) {
    return Object.freeze({
      ok: false,
      rejection: REVIEW_ACTION_REJECTION.INVALID_ACTION,
      message: REVIEW_ACTION_MESSAGES[REVIEW_ACTION_REJECTION.INVALID_ACTION],
      action: null,
    });
  }
  if (statusOf(card) !== STATUS_UNDER_REVIEW) {
    return Object.freeze({
      ok: false,
      rejection: REVIEW_ACTION_REJECTION.NOT_UNDER_REVIEW,
      message: REVIEW_ACTION_MESSAGES[REVIEW_ACTION_REJECTION.NOT_UNDER_REVIEW],
      action: null,
    });
  }
  if (isBlank(comment)) {
    return Object.freeze({
      ok: false,
      rejection: REVIEW_ACTION_REJECTION.COMMENT_REQUIRED,
      message: REVIEW_ACTION_MESSAGES[REVIEW_ACTION_REJECTION.COMMENT_REQUIRED],
      action: null,
    });
  }
  return Object.freeze({ ok: true, rejection: null, message: 'ok', action });
}
