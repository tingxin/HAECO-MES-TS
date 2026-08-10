/**
 * 现有文字格式工卡迁移领域模块（纯函数，无 I/O、无文件解析）。
 *
 * 承载任务 10.4 的唯一能力：
 * - `migrateRecords(rows, existingCards?, stageCfg?)` 逐条校验、失败跳过并记原因分类、
 *   产出迁移报告（成功记录状态置 `New` 并保留原命名规则）。
 *
 * ## 输入边界（design.md「迁移解析层」）
 *
 * 本函数只处理**已解析为结构化记录**的输入：Word/RTF/Excel/CSV 的文件级解析是服务层
 * （任务 13.9）与上游人工确认预览的职责，本模块不触碰文件、不做启发式切分。`rows` 的每一行
 * 即已映射好的工卡字段候选值（camelCase 或 snake_case 均可，与 `task_card` 列对齐）。
 *
 * ## 逐行校验顺序（决定「一行多问题」时的归因，须与本列表保持一致）
 *
 * 1. **必填字段存在性**（`required_missing`）——最小信息集中数据库强制 `NOT NULL` 的字段：
 *    `task_no`、`title`、`card_type`（三者对应 `task_card` DDL 的 `NOT NULL` 列）。
 *    ⚠ 本清单是从需求 6 与 schema.sql 的 `NOT NULL` 约束**独立推导**的最小子集，
 *    非 `review.js`（任务 6.2）`submitReviewChecklist` 校验项 (c) 的完整最小信息集必填清单
 *    ——两者职责不同（迁移准入门槛 vs 提交审核门槛），字段集不要求一致，但存在重复维护风险：
 *    若后续 `review.js` 的必填字段集与此处出现语义分歧，须回头核对是否需要收敛为共用清单。
 * 2. **枚举字段合法性**（`enum_invalid`）——对**已给出**的枚举字段值逐一用 `isValidEnumValue`
 *    校验（`ac_type`/`gear_type`/`stage`/`skill`/`ctrl_code`/`card_type`/
 *    `commercial_classification`/`outsource_subtype`）；未给出的可选枚举字段不视为失败。
 * 3. **Stage × 工卡类型组合合法性**（`stage_card_type_invalid`）——仅当行上给出了 `stage`
 *    时，用 `validateStageCardType` 校验其与 `card_type` 的组合（横切取值同样放行）；
 *    未给出 `stage` 时不做此项校验（迁移不代为填充默认 Stage，默认值填充属编制界面职责）。
 * 4. **编号重复**（`duplicate_task_no`）——用 `checkDuplicate` 校验 `(task_no, revision)`
 *    是否已被**现存工卡集合**或**本批次内已接受的行**占用；`revision` 缺省按 DDL 默认值 1。
 *
 * 每行只在**第一个**命中的检查项上失败并跳过（不多头归因），检查顺序即上表顺序。
 * 一行的问题若同时命中多个类别，只上报最先命中的那个——这正是业务方区分「解析没解出来」
 * （必填/枚举，通常是源文档解析或人工录入问题）与「约束不匹配」（Stage×类型组合/重复编号，
 * 通常是历史数据本就不满足新约束）两类根因的依据（《临时设计说明》A4-4）。
 *
 * ## 成功行的产出（需求 17.1、17.2、41.6）
 *
 * 状态强制置 `'New'`；`task_no` 本身**不被改写**——`naming_rule_origin` 另外记录原始编号，
 * 仅作「保留原命名规则」的溯源标记，不是对编号的二次生成。产出对象可直接交仓储层落库
 * （结构化、可编辑，需求 17.2）。
 *
 * @module domain/migrate-card
 */

import { isValidEnumValue } from './enums.js';
import { validateStageCardType } from './stage-constraint.js';
import { checkDuplicate, INITIAL_REVISION } from './card-rules.js';

/** 迁移准入的最小必填字段集（见模块头注释——独立于 review.js 的必填清单）。 */
export const REQUIRED_FIELDS = Object.freeze(['task_no', 'title', 'card_type']);

/** 需逐值校验合法性的枚举字段集（未给出的可选枚举字段不视为失败）。 */
const ENUM_FIELDS = Object.freeze([
  'ac_type', 'gear_type', 'stage', 'skill', 'ctrl_code',
  'card_type', 'commercial_classification', 'outsource_subtype',
]);

/** 失败原因分类词表——逐字对应 `migration_record.failure_category` 的 `CHECK` 取值集（需求 41.5）。 */
export const FAILURE_CATEGORY = Object.freeze({
  ENUM_INVALID: 'enum_invalid',
  REQUIRED_MISSING: 'required_missing',
  STAGE_CARD_TYPE_INVALID: 'stage_card_type_invalid',
  DUPLICATE_TASK_NO: 'duplicate_task_no',
});

/** 逐条结果状态词表——对应 `migration_record.status` 的 `CHECK` 取值集。 */
export const RECORD_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
});

/** 迁移成功后强制赋予的工卡状态（需求 41.6）。 */
const STATUS_NEW = 'New';

/** 取对象上第一个存在（非 null/undefined）的字段，兼容 camelCase / snake_case。 */
function pickField(row, keys) {
  if (row === null || typeof row !== 'object') return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** 字段名 → 候选键集合（snake_case 与其 camelCase 写法）。 */
const FIELD_KEYS = Object.freeze({
  task_no: ['task_no', 'taskNo'],
  title: ['title'],
  card_type: ['card_type', 'cardType'],
  ac_type: ['ac_type', 'acType'],
  gear_type: ['gear_type', 'gearType'],
  stage: ['stage'],
  skill: ['skill'],
  ctrl_code: ['ctrl_code', 'ctrlCode'],
  commercial_classification: ['commercial_classification', 'commercialClassification'],
  outsource_subtype: ['outsource_subtype', 'outsourceSubtype'],
  revision: ['revision', 'card_revision', 'cardRevision'],
});

/** 取行上某逻辑字段的原始值（未做空白判定）。 */
function rawFieldOf(row, field) {
  return pickField(row, FIELD_KEYS[field] ?? [field]);
}

/** 空白判定：`null`/`undefined`/纯空白字符串一律视为「未填」（含全角空格 U+3000）。 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0 || /^[\s\u3000]*$/.test(value);
  return false;
}

/** 归一化为可读文本；空白值返回 `null`。 */
function asText(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/**
 * 版本号归一化：整数或整数字面量字符串直接采用；缺省（含空白/非法值）时回退 `INITIAL_REVISION`
 * （与 `task_card.revision` 的 DDL 默认值 1 一致），保证迁移行必有可比较的版本号用于查重。
 */
function normalizeRevisionOrDefault(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return INITIAL_REVISION;
}

/**
 * 深克隆输入行的自有字段，避免产出对象与输入行共享可变引用。
 * 与 `card-rules.js` 内同名实现同构（仅服务于本模块，不复用其私有函数）。
 */
function cloneRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  }
  return out;
}

/** 单行必填字段校验（检查顺序第 1 项）。缺失字段全部列出，便于一次性提示。 */
function checkRequiredFields(row) {
  const missing = REQUIRED_FIELDS.filter((field) => isBlank(rawFieldOf(row, field)));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    category: FAILURE_CATEGORY.REQUIRED_MISSING,
    reason: `缺少必填字段：${missing.join('、')}`,
  };
}

/** 单行枚举合法性校验（检查顺序第 2 项）。仅校验行上**已给出**的枚举字段。 */
function checkEnumFields(row) {
  const invalid = [];
  for (const field of ENUM_FIELDS) {
    const value = rawFieldOf(row, field);
    if (isBlank(value)) continue; // 未给出的可选枚举字段不视为失败
    if (!isValidEnumValue(field, value)) invalid.push(`${field}=${asText(value)}`);
  }
  if (invalid.length === 0) return { ok: true };
  return {
    ok: false,
    category: FAILURE_CATEGORY.ENUM_INVALID,
    reason: `枚举取值不合法：${invalid.join('、')}`,
  };
}

/** 单行 Stage × 工卡类型组合校验（检查顺序第 3 项）。行上未给出 Stage 时不做此项校验。 */
function checkStageCardType(row, stageCfg) {
  const stage = rawFieldOf(row, 'stage');
  if (isBlank(stage)) return { ok: true };
  const cardType = rawFieldOf(row, 'card_type');
  const result = validateStageCardType(stage, cardType, stageCfg);
  if (result.ok) return { ok: true };
  return {
    ok: false,
    category: FAILURE_CATEGORY.STAGE_CARD_TYPE_INVALID,
    reason: `Stage×工卡类型组合不合法：${result.message}`,
  };
}

/** 单行编号重复校验（检查顺序第 4 项）。对比现存工卡集合 ∪ 本批次内已接受的行。 */
function checkDuplicateTaskNo(taskNo, revision, priorRows) {
  const dup = checkDuplicate(priorRows, taskNo, revision);
  if (dup.ok) return { ok: true };
  return {
    ok: false,
    category: FAILURE_CATEGORY.DUPLICATE_TASK_NO,
    reason: `工卡编号重复：${dup.message}`,
  };
}

/**
 * 逐条校验迁移记录并产出报告（需求 17.1、17.2、41.1、41.3–41.6、46.10，Property 32）。
 *
 * @param {unknown} rows 已解析为结构化记录的迁移候选行集合（数组）；`null`/`undefined` 视为空批次
 * @param {unknown} [existingCards] 现存工卡集合（供编号重复校验对比，需求 41.3）；
 *   缺省为空数组（即仅对比批次内部）
 * @param {unknown} [stageCfg] Stage × 工卡类型约束配置，转交 `validateStageCardType`；
 *   缺省时该函数退回其内部种子默认值
 * @returns {{
 *   successCount: number, failureCount: number, totalCount: number,
 *   records: ReadonlyArray<{
 *     rowNo: number, sourceTaskNo: string|null, status: 'success'|'failed',
 *     card: object|null, failureCategory: string|null, reason: string|null,
 *   }>,
 *   byCategory: { enum_invalid: number, required_missing: number,
 *                 stage_card_type_invalid: number, duplicate_task_no: number },
 * }}
 * @throws {TypeError} `rows` 既非 `null`/`undefined` 亦非数组
 */
export function migrateRecords(rows, existingCards, stageCfg) {
  if (rows === null || rows === undefined) {
    return buildReport([]);
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('migrateRecords：rows 须为数组（或 null/undefined 表示空批次）');
  }

  const baseline = Array.isArray(existingCards) ? existingCards : [];
  // 查重对比池：现存工卡集合 + 本批次内已被接受的行（累积增长，保证批次内部重复也能拦住）
  const acceptedPool = [...baseline];

  const records = rows.map((row, index) => {
    const rowNo = index + 1;
    const sourceTaskNo = row !== null && typeof row === 'object' ? asText(rawFieldOf(row, 'task_no')) : null;

    const fail = (category, reason) => Object.freeze({
      rowNo,
      sourceTaskNo,
      status: RECORD_STATUS.FAILED,
      card: null,
      failureCategory: category,
      reason,
    });

    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return fail(FAILURE_CATEGORY.REQUIRED_MISSING, '记录不是合法的结构化对象');
    }

    // 1. 必填字段存在性
    const requiredCheck = checkRequiredFields(row);
    if (!requiredCheck.ok) return fail(requiredCheck.category, requiredCheck.reason);

    // 2. 枚举字段合法性（含 card_type 自身的取值合法性）
    const enumCheck = checkEnumFields(row);
    if (!enumCheck.ok) return fail(enumCheck.category, enumCheck.reason);

    // 3. Stage × 工卡类型组合合法性
    const stageCheck = checkStageCardType(row, stageCfg);
    if (!stageCheck.ok) return fail(stageCheck.category, stageCheck.reason);

    // 4. 编号重复（对比现存工卡集合 ∪ 批次内已接受的行）
    const taskNo = asText(rawFieldOf(row, 'task_no'));
    const revision = normalizeRevisionOrDefault(rawFieldOf(row, 'revision'));
    const dupCheck = checkDuplicateTaskNo(taskNo, revision, acceptedPool);
    if (!dupCheck.ok) return fail(dupCheck.category, dupCheck.reason);

    // 全部通过：产出成功记录——状态置 New，task_no 不改写，naming_rule_origin 记录原命名溯源
    const card = cloneRow(row);
    card.status = STATUS_NEW;
    card[FIELD_KEYS.task_no.find((k) => Object.prototype.hasOwnProperty.call(row, k)) ?? 'task_no'] = taskNo;
    card[FIELD_KEYS.revision.find((k) => Object.prototype.hasOwnProperty.call(row, k)) ?? 'revision'] = revision;
    card.naming_rule_origin = taskNo;

    // 计入批次内查重池，使后续行能检出与本行相同的编号
    acceptedPool.push({ task_no: taskNo, revision });

    return Object.freeze({
      rowNo,
      sourceTaskNo,
      status: RECORD_STATUS.SUCCESS,
      card: Object.freeze(card),
      failureCategory: null,
      reason: null,
    });
  });

  return buildReport(records);
}

/** 由逐行结果集合汇总报告（成功/失败条数、按原因类型分组统计）。 */
function buildReport(records) {
  const byCategory = {
    [FAILURE_CATEGORY.ENUM_INVALID]: 0,
    [FAILURE_CATEGORY.REQUIRED_MISSING]: 0,
    [FAILURE_CATEGORY.STAGE_CARD_TYPE_INVALID]: 0,
    [FAILURE_CATEGORY.DUPLICATE_TASK_NO]: 0,
  };
  let successCount = 0;
  let failureCount = 0;
  for (const record of records) {
    if (record.status === RECORD_STATUS.SUCCESS) {
      successCount += 1;
    } else {
      failureCount += 1;
      if (record.failureCategory !== null && Object.prototype.hasOwnProperty.call(byCategory, record.failureCategory)) {
        byCategory[record.failureCategory] += 1;
      }
    }
  }

  return Object.freeze({
    successCount,
    failureCount,
    totalCount: records.length,
    records: Object.freeze(records),
    byCategory: Object.freeze(byCategory),
  });
}
