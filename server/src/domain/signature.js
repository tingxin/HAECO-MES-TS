/**
 * 签署项聚合与无纸化归档判定领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 9.1 的两项能力：
 * - `aggregateSignatureRequirements(steps)`            必需签署项 = 工卡下**全部工序** `signature_requirement` 的并集（需求 45.6，Property 27）
 * - `canArchivePaperless(card, requirements, signatures)` 无纸化归档完备性（需求 32.2–32.4，Property 17）
 *
 * ## 「必需签署项」的唯一来源（需求 45.6，Property 27）
 *
 * 需求 32.4 判定所用的「必需签署项」集合**恒等于**工卡下全部工序 `signature_requirement`
 * 配置行的并集，不多不少：
 * - **不凭空生成**：本模块不因工序被标记关键、不因单据类型、不因工卡类型自行追加任何签署项。
 *   任一必需项都能回溯到一条配置行（其 `stepId` 指向给定工序集合中的某道工序）——这正是
 *   Property 27「不存在无来源的必需签署项」的字面含义，返回值中的 `orphans` 明示被剔除的无来源行。
 * - **不遗漏**：工序有配置即计入，无论该工序是否关键、是否有安全警示。需求 45.1「工序是否需要
 *   签署」在 `schema.sql` 中**没有独立的布尔列**，其真值即「该工序是否存在 `signature_requirement`
 *   配置行」；故不存在「已勾选需签署但无配置行」的中间态可供本模块推断。
 *
 * ## 与需求 45.8 / 45.9 的分界（勿在此重复实现）
 *
 * 45.8 / 45.9 管的是**另一件事**：「签署要求属性为『签署』的执行过程单据必须至少配置一个签署项，
 * 否则阻止提交审核」。该判定的数据来源是 `card_relation` × `exec_doc_type.sign_rule`，由
 * `relation.js` 的 `requiredSignDocTypes(relations, signRuleCfg)` 给出，再由 `submitReviewChecklist`
 * 的校验项 (f) 组合本模块的聚合结果作出裁定。本模块**只回答「配置了哪些签署项」**，
 * 不回答「按单据类型本该配置几个」——后者需要单据关联与 `sign_rule` 配置，属 `relation.js` 的入参。
 * 二者的接缝即：校验项 (f) = `requiredSignDocTypes(...)` 非空 ∧ `aggregateSignatureRequirements(...).count === 0`
 * → 阻止提交审核。
 *
 * ## 归档完备性的逐项口径（需求 32.2、32.3、45.4、45.5）⚠
 *
 * 需求 32.3 要求签署记录「记录签署人、签章标识与完成日期」，但 `stamp_required` 与 `date_required`
 * 是**逐签署项的开关**（需求 45.4、45.5），故完备性须**按项**判定，不可一刀切：
 *
 * | 签署项配置 | 完备所需字段 |
 * |------------|--------------|
 * | 任何项 | `signed_by`（签署人）非空 |
 * | `stamp_required = 1` | `stamp_id`（签章标识）非空 |
 * | `stamp_required = 0`（列默认值） | `stamp_id` **不作要求**（有则忽略） |
 * | `date_required = 1`（列默认值，需求 45.5） | `signed_at`（完成日期）非空 |
 * | `date_required = 0` | `signed_at` **不作要求** |
 *
 * 把 `stamp_id` 当作无条件必填会让**未要求盖章**的签署项永远无法完备，从而使这类工卡永久无法
 * 无纸化归档——`schema.sql` 明写「`stamp_id`：签章标识，未要求盖章时为 NULL」，无条件必填与
 * 该列语义直接冲突。反向的错（`stamp_required = 1` 却不查 `stamp_id`）则放过了缺章的签署，
 * 使需求 32.3 形同虚设。两侧都不可取，故按项开关判定。
 *
 * 开关取值的**从严方向**：列缺席时取 `schema.sql` 的 DEFAULT（`stamp_required` 0、`date_required` 1）；
 * 取值存在但无法识别为 0/1 时一律视为**需要**（要求更多字段 → 拒绝归档优于误放行）。
 *
 * ## 归档判定的其它边界
 *
 * - **无任何必需签署项** → 真空成立，`ok === true` 且 `vacuous === true`（需求 32.4 的
 *   「全部必需签署项均已认证」对空集恒真）。「涉及需签署单据却零配置」不在此拦截，见上文 45.9 接缝。
 * - **跨卡签署不计入**：工卡标识可判定且签署行 `card_id` 可判定而两者不一致时，该行不参与匹配。
 *   与 `safety.js` 的跨工序确认过滤同构。
 * - **编制态与 JOB 态签署均计入**：`electronic_signature.job_id` 为 NULL 表示编制态签署，
 *   本模块不按 JOB 过滤；需按某个 JOB 收敛时由调用方先过滤 `signatures`。
 * - **一项多记录取其一**：同一签署项存在多条签署记录时，存在任一条完备记录即视为该项已完备；
 *   全不完备则报告**缺项最少**的那条及其缺失字段，便于界面提示「还差什么」。
 *
 * 需求：32.2、32.3、32.4、45.1、45.2、45.3、45.4、45.5、45.6
 */

import { SIGNATURE_ROLE } from './enums.js';

/** 归档拒绝原因码（服务层据此映射 422） */
export const SIGNATURE_REJECTION = Object.freeze({
  /** 存在未完备签署的必需签署项（需求 32.3、32.4） */
  INCOMPLETE_SIGNATURES: 'INCOMPLETE_SIGNATURES',
});

/** 逐项缺失原因码——服务层与界面据此提示「还差什么」（需求 32.3） */
export const SIGNATURE_GAP = Object.freeze({
  /** 该签署项无任何签署记录 */
  NOT_SIGNED: 'NOT_SIGNED',
  /** 签署记录缺签署人（`signed_by`） */
  MISSING_SIGNER: 'MISSING_SIGNER',
  /** 该项要求盖章（`stamp_required = 1`）而记录缺签章标识（`stamp_id`） */
  MISSING_STAMP: 'MISSING_STAMP',
  /** 该项要求记录完成日期（`date_required = 1`）而记录缺 `signed_at` */
  MISSING_DATE: 'MISSING_DATE',
});

const GAP_LABELS = Object.freeze({
  [SIGNATURE_GAP.NOT_SIGNED]: '未签署',
  [SIGNATURE_GAP.MISSING_SIGNER]: '缺签署人',
  [SIGNATURE_GAP.MISSING_STAMP]: '缺签章标识',
  [SIGNATURE_GAP.MISSING_DATE]: '缺完成日期',
});

/** 工序侧字段：出现其一即可判定该行为工序（`process_step` 行）而非签署项行 */
const STEP_MARKER_KEYS = Object.freeze([
  'card_id', 'cardId', 'process_id', 'processId', 'seq',
  'description_zh', 'descriptionZh', 'description_en', 'descriptionEn',
]);

/** 工序上承载签署项配置的键名（并集来源） */
const NESTED_REQUIREMENT_KEYS = Object.freeze([
  'signatureRequirements', 'signature_requirements',
  'signatureRequirement', 'signature_requirement',
  'requirements', 'signatures',
]);

/** 签署项侧字段：出现其一即可判定该行为 `signature_requirement` 行 */
const REQUIREMENT_MARKER_KEYS = Object.freeze([
  'signature_role', 'signatureRole', 'role',
  'stamp_required', 'stampRequired',
  'date_required', 'dateRequired',
]);

/** 取对象上第一个非 null/undefined 的字段值，兼容 snake_case 与 camelCase。 */
function pickField(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** 对象上是否**出现过**这些键（含取值为 null 的情形，DB 行的空列即如此）。 */
function hasAnyKey(source, keys) {
  if (source === null || typeof source !== 'object') return false;
  return keys.some((key) => key in source);
}

/** 标识归一化：非空字符串（去首尾空白）或有限数值转字符串；否则 `null`。 */
function identity(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/** 原值保留的标识（数值主键保持数值，字符串去空白）；取不到时 `null`。 */
function rawIdentity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text;
  }
  return null;
}

/** 文本归一化：去首尾空白后非空则返回，否则 `null`（含全角空格视为空白）。 */
function text(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

/** 整数归一化（`sort_order`）：非有限数值 → `null`。 */
function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'string' ? Number(value.trim()) : Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/**
 * 0/1 开关归一化。
 * @param {unknown} value
 * @param {boolean} whenMissing 列缺席 / 空串时的取值（取 `schema.sql` 的 DEFAULT）
 * @param {boolean} whenUnknown 取值存在但无法识别时的取值（一律取「需要」，从严）
 */
function toFlag(value, whenMissing, whenUnknown) {
  if (value === null || value === undefined) return whenMissing;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : whenUnknown;
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (key === '') return whenMissing;
    if (key === '0' || key === 'false' || key === 'no' || key === 'n') return false;
    if (key === '1' || key === 'true' || key === 'yes' || key === 'y') return true;
    return whenUnknown;
  }
  return whenUnknown;
}

/** 取工序标识（`process_step.id`）；取不到时 `null`。 */
function stepIdOf(step) {
  return rawIdentity(pickField(step, ['id', 'stepId', 'step_id']));
}

/** 取工卡标识（`task_card.id`）；取不到时 `null`。 */
function cardIdOf(card) {
  if (typeof card === 'number' || typeof card === 'string' || typeof card === 'bigint') {
    return identity(card);
  }
  return identity(pickField(card, ['id', 'cardId', 'card_id']));
}

/**
 * 归一化一条 `signature_requirement` 配置行为**必需签署项**。
 *
 * `stampRequired` / `dateRequired` 的缺省与从严方向见模块头注。`roleValid` 标示角色是否落在
 * {@link SIGNATURE_ROLE}（需求 45.2，⚠ Hotfix 假定）内——**取值非法不剔除该项**：配置行存在即
 * 为必需项（需求 45.6 的唯一来源语义），角色合法性由编制期校验与 `CHECK` 约束把关，此处剔除
 * 反而会造出「有配置却不必签」的漏洞。
 *
 * @param {unknown} row `signature_requirement` 行或等价对象（camelCase 亦可）
 * @param {unknown} [fallbackStepId] 行上无 `step_id` 时的归属工序标识（嵌套形态由所属工序补齐）
 * @param {string} [fallbackKey] 身份键兜底（`id` 与「工序+角色」均不可判定时使用，见 {@link requirementKeyOf}）
 * @returns {Readonly<{id: number|string|null, stepId: number|string|null, signatureRole: string|null,
 *   roleValid: boolean, stampRequired: boolean, dateRequired: boolean, sortOrder: number|null, key: string}>}
 */
export function normalizeSignatureRequirement(row, fallbackStepId, fallbackKey) {
  const source = row === null || typeof row !== 'object' ? {} : row;
  const id = rawIdentity(pickField(source, ['id', 'requirementId', 'requirement_id',
    'signatureRequirementId', 'signature_requirement_id']));
  const stepId = rawIdentity(pickField(source, ['stepId', 'step_id'])) ?? rawIdentity(fallbackStepId);
  const signatureRole = text(pickField(source, ['signatureRole', 'signature_role', 'role']));
  const existingKey = typeof source.key === 'string' && source.key.trim() !== '' ? source.key : null;

  const normalized = {
    id,
    stepId,
    signatureRole,
    roleValid: signatureRole !== null && SIGNATURE_ROLE.includes(signatureRole),
    stampRequired: toFlag(pickField(source, ['stampRequired', 'stamp_required']), false, true),
    dateRequired: toFlag(pickField(source, ['dateRequired', 'date_required']), true, true),
    sortOrder: toIntegerOrNull(pickField(source, ['sortOrder', 'sort_order'])),
  };
  normalized.key = existingKey ?? requirementKeyOf(normalized, fallbackKey);
  return Object.freeze(normalized);
}

/**
 * 必需签署项的身份键。
 *
 * 已落库项以 `id` 为身份（`signature_requirement.id` 为主键，签署记录正是经
 * `electronic_signature.signature_requirement_id` 引用它）；未落库项退化为「工序 + 角色」结构键
 * （编制界面尚未保存的配置无 `id`）；两者均不可判定时用 `fallbackKey`（按入参位置生成的唯一键）
 * ——**绝不把不可判定的项彼此折叠**：折叠会减少必需项数量，等于放宽归档条件。
 *
 * @param {{id: unknown, stepId: unknown, signatureRole: unknown}} item
 * @param {string} [fallbackKey]
 * @returns {string}
 */
export function requirementKeyOf(item, fallbackKey) {
  const id = identity(pickField(item, ['id', 'requirementId', 'requirement_id',
    'signatureRequirementId', 'signature_requirement_id']));
  if (id !== null) return `id:${id}`;
  const stepId = identity(pickField(item, ['stepId', 'step_id']));
  const role = text(pickField(item, ['signatureRole', 'signature_role', 'role']));
  if (stepId !== null || role !== null) {
    return `step:${stepId ?? '∅'}|role:${role ?? '∅'}`;
  }
  return fallbackKey ?? 'anon:0';
}

/** 元素形态判别：`'step'`（工序行）或 `'requirement'`（签署项行）。 */
function classifyRow(row, defaultKind) {
  if (row === null || typeof row !== 'object') return null;
  if (hasAnyKey(row, NESTED_REQUIREMENT_KEYS)) return 'step';
  if (hasAnyKey(row, STEP_MARKER_KEYS)) return 'step';
  if (hasAnyKey(row, REQUIREMENT_MARKER_KEYS)) return 'requirement';
  if (hasAnyKey(row, ['step_id', 'stepId'])) return 'requirement';
  return defaultKind;
}

/** 取工序上挂载的签署项配置数组；未挂载或非数组（单个对象亦接受）时归一为数组。 */
function nestedRequirementsOf(step) {
  const raw = pickField(step, NESTED_REQUIREMENT_KEYS);
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return [raw]; // 单项配置直接挂对象的写法
  return [];
}

/**
 * 必需签署项聚合（需求 45.6、32.4，Property 27）——工卡下**全部工序**签署项配置的并集。
 *
 * ## 接受的入参形态
 *
 * ```
 * // ① 工序数组，签署项嵌套挂在工序上（编制界面 / 服务层装配后的常见形态）
 * [{ id: 7, process_id: 'A', signatureRequirements: [{ id: 1, signature_role: 'Operator' }] }]
 *
 * // ② 工序 + 扁平签署项两个集合（仓储分别查两张表的常见形态）
 * { steps: [{ id: 7 }], requirements: [{ id: 1, step_id: 7, signature_role: 'QC' }] }
 *
 * // ③ 扁平签署项数组（已按卡 JOIN 取数；元素带角色 / 开关 / step_id 即可识别）
 * [{ id: 1, step_id: 7, signature_role: 'QC', stamp_required: 1 }]
 * ```
 *
 * `null` / `undefined` / 非数组非对象一律视为空集合（无工序即无必需签署项）。混合形态亦可：
 * 数组中的工序行按 ① 展开，可识别为签署项行的元素按 ③ 计入。
 *
 * ## 无来源项的剔除（Property 27）
 *
 * 当入参中**存在可判定的工序集合**时，扁平签署项行的 `step_id` 必须命中其中某道工序，
 * 否则计入 `orphans` 并**不进入** `requirements`：它不属于本工卡任何工序，作为必需项即为
 * 「无来源」。工序集合无从判定时（形态 ③）不做该过滤——此时调用方已按卡取数，本模块不再按卡过滤。
 *
 * ## 并集的折叠口径
 *
 * 同身份行（见 {@link requirementKeyOf}）只保留首次出现的一条，`duplicates` 给出折叠条数
 * ——JOIN 取数重复行不应让同一签署项被计两次。身份不可判定的行按入参位置各自成键，绝不折叠。
 *
 * 输出顺序与入参顺序一致（工序按给定次序、工序内按给定次序），不重排：`sort_order` 原样回显，
 * 展示排序由调用方按需应用（仓储查询已按 `ix_signature_requirement_step (step_id, sort_order)` 有序）。
 *
 * @param {unknown} steps 见上
 * @returns {Readonly<{requirements: ReadonlyArray<object>, keys: readonly string[],
 *   byStep: ReadonlyArray<Readonly<{stepId: number|string|null, requirements: ReadonlyArray<object>}>>,
 *   stepIds: readonly (number|string)[], count: number, duplicates: number,
 *   orphans: ReadonlyArray<object>}>}
 *   `requirements` 即需求 32.4 的「必需签署项」集合（唯一来源）；`count === requirements.length`
 */
export function aggregateSignatureRequirements(steps) {
  const source = steps === null || steps === undefined ? [] : steps;
  const rows = Array.isArray(source)
    ? source
    : typeof source === 'object'
      ? [...(Array.isArray(source.steps) ? source.steps : []),
        ...(Array.isArray(source.requirements) ? source.requirements : []),
        ...(Array.isArray(source.signatureRequirements) ? source.signatureRequirements : [])]
      : [];

  // ① 先分拣：哪些是工序行、哪些是扁平签署项行（工序集合决定无来源项的判定）
  const stepRows = [];
  const flatRows = [];
  rows.forEach((row, index) => {
    const kind = classifyRow(row, 'step');
    if (kind === 'step') stepRows.push({ row, index });
    else if (kind === 'requirement') flatRows.push({ row, index });
  });

  const knownStepIds = new Set();
  for (const { row } of stepRows) {
    const id = stepIdOf(row);
    if (id !== null) knownStepIds.add(String(id));
  }

  const requirements = [];
  const orphans = [];
  const seen = new Set();
  let duplicates = 0;

  /** 收录一条归一化必需签署项（同身份折叠）。 */
  const collect = (item) => {
    if (seen.has(item.key)) {
      duplicates += 1;
      return;
    }
    seen.add(item.key);
    requirements.push(item);
  };

  // ② 来源：各工序嵌套的签署项配置（需求 45.3 允许同一工序多个签署角色）
  const byStep = stepRows.map(({ row, index }) => {
    const stepId = stepIdOf(row);
    const items = nestedRequirementsOf(row)
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry, entryIndex) =>
        normalizeSignatureRequirement(entry, stepId, `anon:step${index}#${entryIndex}`));
    items.forEach(collect);
    return Object.freeze({ stepId, requirements: Object.freeze(items) });
  });

  // ③ 来源：扁平签署项行；工序集合可判定时须命中某道工序，否则为无来源项（Property 27）
  for (const { row, index } of flatRows) {
    const item = normalizeSignatureRequirement(row, null, `anon:flat${index}`);
    if (knownStepIds.size > 0) {
      const stepKey = item.stepId === null ? null : String(item.stepId);
      if (stepKey === null || !knownStepIds.has(stepKey)) {
        orphans.push(item);
        continue;
      }
    }
    collect(item);
  }

  // 扁平行归入其所属工序的分组（byStep 恒为 requirements 的一个划分，便于逐工序呈现签署栏）
  const grouped = byStep.map((group) => ({ stepId: group.stepId, requirements: [...group.requirements] }));
  for (const item of requirements) {
    if (item.stepId === null) continue;
    const group = grouped.find((entry) => entry.stepId !== null && String(entry.stepId) === String(item.stepId));
    if (group !== undefined && !group.requirements.includes(item)) group.requirements.push(item);
  }

  return Object.freeze({
    requirements: Object.freeze(requirements),
    keys: Object.freeze(requirements.map((item) => item.key)),
    byStep: Object.freeze(
      grouped.map((group) =>
        Object.freeze({ stepId: group.stepId, requirements: Object.freeze(group.requirements) })),
    ),
    stepIds: Object.freeze([...knownStepIds]),
    count: requirements.length,
    duplicates,
    orphans: Object.freeze(orphans),
  });
}

/**
 * 解析 `canArchivePaperless` 的 `requirements` 入参为必需签署项集合。
 *
 * 接受：{@link aggregateSignatureRequirements} 的返回值、`{steps, requirements}`、工序数组、
 * 扁平签署项数组，以及三者混合。数组元素形态不明时**按签署项行**解释（多一个必需项 → 拒绝归档，
 * 从严；若按工序解释则可能把签署项行当作「无配置的工序」而静默放行归档）。
 */
function resolveRequirements(requirements) {
  if (requirements === null || requirements === undefined) {
    return { requirements: [], orphans: [] };
  }
  // 已是聚合结果
  if (!Array.isArray(requirements) && typeof requirements === 'object'
    && Array.isArray(requirements.requirements) && !hasAnyKey(requirements, REQUIREMENT_MARKER_KEYS)) {
    const aggregate = aggregateSignatureRequirements(requirements.requirements.some(
      (item) => classifyRow(item, 'requirement') === 'step',
    )
      ? requirements.requirements
      : { steps: Array.isArray(requirements.steps) ? requirements.steps : [], requirements: requirements.requirements });
    return { requirements: aggregate.requirements, orphans: aggregate.orphans };
  }
  if (!Array.isArray(requirements) && typeof requirements === 'object' && Array.isArray(requirements.steps)) {
    const aggregate = aggregateSignatureRequirements(requirements);
    return { requirements: aggregate.requirements, orphans: aggregate.orphans };
  }

  const rows = Array.isArray(requirements) ? requirements : [requirements];
  const items = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object') return;
    if (classifyRow(row, 'requirement') === 'step') {
      const stepId = stepIdOf(row);
      nestedRequirementsOf(row)
        .filter((entry) => entry !== null && typeof entry === 'object')
        .forEach((entry, entryIndex) => {
          items.push(normalizeSignatureRequirement(entry, stepId, `anon:step${index}#${entryIndex}`));
        });
      return;
    }
    items.push(normalizeSignatureRequirement(row, null, `anon:flat${index}`));
  });

  const unique = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    unique.push(item);
  }
  return { requirements: unique, orphans: [] };
}

/** 签署记录所引用的签署项身份键；结构键回退见 {@link requirementKeyOf}。 */
function signatureRequirementKeyOf(signature) {
  const id = identity(pickField(signature, ['signature_requirement_id', 'signatureRequirementId',
    'requirementId', 'requirement_id']));
  if (id !== null) return `id:${id}`;
  const stepId = identity(pickField(signature, ['stepId', 'step_id']));
  const role = text(pickField(signature, ['signatureRole', 'signature_role', 'role']));
  if (stepId !== null || role !== null) return `step:${stepId ?? '∅'}|role:${role ?? '∅'}`;
  return null; // 无从判定所属签署项的记录不参与匹配（不能拿它顶任何一项）
}

/**
 * 单条签署记录对某必需签署项是否**完备**（需求 32.3、45.4、45.5）。
 *
 * 完备条件：签署人非空 ∧（该项要求盖章 → 签章标识非空）∧（该项要求完成日期 → 完成日期非空）。
 * 逐项开关的判定理由见模块头注。
 *
 * @param {unknown} requirement 必需签署项（原始行或归一化项均可）
 * @param {unknown} signature `electronic_signature` 行或等价对象
 * @returns {Readonly<{ok: boolean, gaps: readonly string[], signedBy: string|null,
 *   stampId: string|null, signedAt: string|null}>}
 */
export function isCompleteSignature(requirement, signature) {
  const item = requirement !== null && typeof requirement === 'object' && typeof requirement.key === 'string'
    ? requirement
    : normalizeSignatureRequirement(requirement);
  const signedBy = text(pickField(signature, ['signed_by', 'signedBy']));
  const stampId = text(pickField(signature, ['stamp_id', 'stampId']));
  const signedAt = text(pickField(signature, ['signed_at', 'signedAt']));

  const gaps = [];
  if (signature === null || typeof signature !== 'object') {
    gaps.push(SIGNATURE_GAP.NOT_SIGNED);
  } else {
    if (signedBy === null) gaps.push(SIGNATURE_GAP.MISSING_SIGNER);
    if (item.stampRequired && stampId === null) gaps.push(SIGNATURE_GAP.MISSING_STAMP);
    if (item.dateRequired && signedAt === null) gaps.push(SIGNATURE_GAP.MISSING_DATE);
  }

  return Object.freeze({
    ok: gaps.length === 0,
    gaps: Object.freeze(gaps),
    signedBy,
    stampId,
    signedAt,
  });
}

/** 按签署项身份键归组签署记录，并按工卡归属过滤（跨卡签署不计入）。 */
function indexSignatures(signatures, cardId) {
  const index = new Map();
  if (!Array.isArray(signatures)) return index;
  for (const signature of signatures) {
    if (signature === null || typeof signature !== 'object') continue;
    if (cardId !== null) {
      const rowCardId = identity(pickField(signature, ['card_id', 'cardId']));
      if (rowCardId !== null && rowCardId !== cardId) continue; // 跨卡签署不解锁本卡归档
    }
    const key = signatureRequirementKeyOf(signature);
    if (key === null) continue;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [signature]);
    else bucket.push(signature);
  }
  return index;
}

/** 拼装拒绝提示：逐项给出「工序 / 角色 / 缺失字段」。 */
function describeMissing(missing) {
  const detail = missing
    .map(({ requirement, gaps }) => {
      const where = requirement.stepId === null ? '工序未知' : `工序 ${requirement.stepId}`;
      const role = requirement.signatureRole ?? '未指定角色';
      const why = gaps.map((gap) => GAP_LABELS[gap] ?? gap).join('、');
      return `${where} · ${role}（${why}）`;
    })
    .join('；');
  return `存在未完成电子签章认证的必需签署项，不可无纸化归档：${detail}`;
}

/**
 * 无纸化归档完备性判定（需求 32.2–32.4，Property 17）。
 *
 * `ok === true` **当且仅当**全部必需签署项均已存在**完备**的电子签章签署记录：含签署人；
 * 要求盖章的项含签章标识；要求记录完成日期的项含完成日期（逐项开关口径见模块头注）。
 * 必需签署项集合的唯一来源是 {@link aggregateSignatureRequirements}（需求 45.6）——
 * 本函数不自行追加任何签署项，故不存在无配置来源的必需项。
 *
 * 必需项为空集时真空成立（`ok === true`、`vacuous === true`）；「涉及需签署单据却零配置」
 * 由 `relation.js` 的 `requiredSignDocTypes` 在提交审核环节拦截（需求 45.9），不在此重复判定。
 *
 * @param {unknown} card 工卡对象（`{ id, task_no, revision }`，camelCase 亦可）或工卡标识；
 *   仅用于**签署记录归属过滤**与结果回显，不参与完备性口径
 * @param {unknown} requirements 必需签署项：{@link aggregateSignatureRequirements} 的返回值、
 *   `{steps, requirements}`、工序数组或扁平签署项数组（见 {@link resolveRequirements}）
 * @param {unknown} signatures `electronic_signature` 记录集合（编制态 `job_id = NULL` 与 JOB 态均计入）
 * @returns {Readonly<{ok: boolean, rejection: string|null, message: string, vacuous: boolean,
 *   card: Readonly<{id: unknown, taskNo: string|null, revision: unknown}>,
 *   requirements: ReadonlyArray<object>, total: number, satisfiedCount: number,
 *   satisfied: ReadonlyArray<Readonly<{requirement: object, signature: object}>>,
 *   missing: ReadonlyArray<Readonly<{requirement: object, gaps: readonly string[], signature: object|null}>>,
 *   missingKeys: readonly string[], orphans: ReadonlyArray<object>}>}
 */
export function canArchivePaperless(card, requirements, signatures) {
  const { requirements: items, orphans } = resolveRequirements(requirements);
  const cardId = cardIdOf(card);
  const index = indexSignatures(signatures, cardId);

  const satisfied = [];
  const missing = [];

  for (const item of items) {
    const candidates = index.get(item.key) ?? [];
    let best = null;
    for (const candidate of candidates) {
      const check = isCompleteSignature(item, candidate);
      if (check.ok) {
        best = { signature: candidate, gaps: [] };
        break;
      }
      // 全不完备时报告缺项最少的那条，界面提示「还差什么」最贴近事实
      if (best === null || check.gaps.length < best.gaps.length) {
        best = { signature: candidate, gaps: check.gaps };
      }
    }

    if (best !== null && best.gaps.length === 0) {
      satisfied.push(Object.freeze({ requirement: item, signature: best.signature }));
      continue;
    }
    missing.push(Object.freeze({
      requirement: item,
      gaps: Object.freeze(best === null ? [SIGNATURE_GAP.NOT_SIGNED] : best.gaps),
      signature: best === null ? null : best.signature,
    }));
  }

  const ok = missing.length === 0;
  return Object.freeze({
    ok,
    rejection: ok ? null : SIGNATURE_REJECTION.INCOMPLETE_SIGNATURES,
    message: ok ? 'ok' : describeMissing(missing),
    vacuous: items.length === 0,
    card: Object.freeze({
      id: pickField(card, ['id', 'cardId', 'card_id']) ?? (typeof card === 'object' ? null : card ?? null),
      taskNo: text(pickField(card, ['task_no', 'taskNo'])),
      revision: pickField(card, ['revision', 'card_revision', 'cardRevision']) ?? null,
    }),
    requirements: Object.freeze(items),
    total: items.length,
    satisfiedCount: satisfied.length,
    satisfied: Object.freeze(satisfied),
    missing: Object.freeze(missing),
    missingKeys: Object.freeze(missing.map(({ requirement }) => requirement.key)),
    orphans: Object.freeze(orphans),
  });
}
