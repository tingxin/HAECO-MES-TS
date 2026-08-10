/**
 * 打印模板选用领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 职责边界（需求 40.3、40.4）：**只负责「给定对象与模板行集，选出用哪一条模板」**。
 * - 模板正文的渲染在前端（`template_body` 为 Handlebars 语法子集的 HTML 串，design.md）；
 * - 打印模型的字段投影由 `card-rules.js` 的 `printProjection` 负责——需求 40.5「模板不展示
 *   工卡分类」的实际保证点在投影侧（模型里根本没有 `cardType` 可渲染），**不在本模块**。
 *   本模块不读、不写、不校验 `template_body` 的内容。
 *
 * 回退链（需求 40.4「某类型未配置专属模板则采用默认模板」）自上而下四级，见
 * {@link TEMPLATE_MATCH}。回退级别随返回值一并给出（`matchLevel` / `isFallback`），
 * 服务层可据此在响应或日志中标明「本次用的是占位默认模板」。
 *
 * ⚠ 种子数据现状：`seed.js` 只写入 `('card_type','01', is_default=1)` 一条
 * （11 类工卡 + 11 类单据的纸质样张待业务方提供，tasks.md「被业务方阻塞的三项」）。
 * 故当前除 `card_type='01'` 外的一切目标都只能靠 L3/L4 兜到这条上——L4（跨类目）
 * 正是为「打印执行过程单据时 `exec_doc_type` 一条模板都没有」而存在。
 * 待补种子时建议为两个 `target_kind` 各写一条 `target_code='*'` 的通配默认行
 * （见 {@link WILDCARD_TARGET_CODES}），使兜底不再借用某个具体类型的专属模板。
 *
 * 需求：40.1–40.5
 */

import { CARD_TYPE_CODES, EXEC_DOC_TYPE } from './enums.js';

/** `print_template.target_kind` 的取值集（与 schema.sql 的 CHECK 同源） */
export const TEMPLATE_TARGET_KIND = Object.freeze({
  CARD_TYPE: 'card_type',
  EXEC_DOC_TYPE: 'exec_doc_type',
});

const TARGET_KINDS = Object.freeze([
  TEMPLATE_TARGET_KIND.CARD_TYPE,
  TEMPLATE_TARGET_KIND.EXEC_DOC_TYPE,
]);

/**
 * 通配目标代码：视为「该 `target_kind` 的通用默认模板」，不绑定任何具体类型。
 * 空串与 `null` 同义（`target_code` 为 NOT NULL，实际落库多为 `'*'`）。
 */
export const WILDCARD_TARGET_CODES = Object.freeze(['*', 'ALL', 'DEFAULT', '']);

/** 模板命中级别（回退链，需求 40.3、40.4） */
export const TEMPLATE_MATCH = Object.freeze({
  /** L1 该类型专属模板：`target_kind` 与 `target_code` 均精确匹配（需求 40.3） */
  EXACT: 'exact',
  /** L2/L3 同类目默认模板：通配行优先，其次同类目内 `is_default = 1` 的行（需求 40.4） */
  KIND_DEFAULT: 'kind_default',
  /** L4 跨类目默认模板：该类目一条模板都没有时借用另一类目的默认模板（种子占位期，需求 40.4） */
  GLOBAL_DEFAULT: 'global_default',
  /** 无任何可用模板：模板表为空或全为非法行 */
  NONE: 'none',
});

/** 取对象上第一个存在的键值（兼容 snake_case / camelCase 的行记录） */
function pick(obj, ...keys) {
  if (obj === null || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/** 布尔化 SQLite 的 0/1 / '0'/'1' / true/false；缺省视为否 */
function toFlag(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !['0', 'false', 'no', ''].includes(value.trim().toLowerCase());
  return Boolean(value);
}

/** 代码归一化：非空字符串去空白后原样；数字转字符串；其余为 `null` */
function toCode(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 通配目标代码判定（`target_code` 缺失/空串亦视为通配） */
export function isWildcardTargetCode(targetCode) {
  if (targetCode === undefined || targetCode === null) return true;
  if (typeof targetCode !== 'string') return false;
  return WILDCARD_TARGET_CODES.includes(targetCode.trim().toUpperCase())
    || WILDCARD_TARGET_CODES.includes(targetCode.trim());
}

/**
 * 解析打印对象的模板目标（需求 40.1–40.3）。
 *
 * 识别顺序（先显式、后按实体列推断）：
 * 1. 显式指定 `{ target_kind, target_code }`（配置界面预览模板时直接给目标）；
 * 2. `exec_doc_type` 存在 → 执行过程单据，`target_kind = 'exec_doc_type'`（需求 40.2）；
 * 3. `card_type`（含 `wbs` 别名，需求 6.8 WBS 与工卡类型同字段）→ `target_kind = 'card_type'`；
 * 4. 均取不到 → `{ targetKind: null, targetCode: null }`，选模板退化为纯默认回退。
 *
 * `isKnownCode` 标示代码是否属于对应枚举值域（`CARD_TYPE_CODES` / `EXEC_DOC_TYPE`）。
 * **未知代码不阻断选模板**——照常走精确匹配再回退，避免枚举扩充时打印直接不可用。
 *
 * @param {unknown} target 工卡行 / 执行过程单据行 / `{ target_kind, target_code }`
 * @returns {{targetKind: string|null, targetCode: string|null, isKnownCode: boolean}}
 */
export function resolveTemplateTarget(target) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return Object.freeze({ targetKind: null, targetCode: null, isKnownCode: false });
  }

  const explicitKind = toCode(pick(target, 'target_kind', 'targetKind'));
  const explicitCode = toCode(pick(target, 'target_code', 'targetCode'));
  if (explicitKind !== null && TARGET_KINDS.includes(explicitKind)) {
    return Object.freeze({
      targetKind: explicitKind,
      targetCode: explicitCode,
      isKnownCode: explicitKind === TEMPLATE_TARGET_KIND.CARD_TYPE
        ? CARD_TYPE_CODES.includes(explicitCode)
        : EXEC_DOC_TYPE.includes(explicitCode),
    });
  }

  const execDocType = toCode(pick(target, 'exec_doc_type', 'execDocType'));
  if (execDocType !== null) {
    return Object.freeze({
      targetKind: TEMPLATE_TARGET_KIND.EXEC_DOC_TYPE,
      targetCode: execDocType,
      isKnownCode: EXEC_DOC_TYPE.includes(execDocType),
    });
  }

  const cardType = toCode(pick(target, 'card_type', 'cardType', 'wbs', 'WBS'));
  if (cardType !== null) {
    return Object.freeze({
      targetKind: TEMPLATE_TARGET_KIND.CARD_TYPE,
      targetCode: cardType,
      isKnownCode: CARD_TYPE_CODES.includes(cardType),
    });
  }

  return Object.freeze({ targetKind: null, targetCode: null, isKnownCode: false });
}

/**
 * 归一化模板行：`target_kind` 越出两值 CHECK 的行一律剔除（非法配置不参与选用）。
 * `index` 保留入参次序，仅作最末位的稳定排序键。
 */
function normalizeTemplates(templates) {
  if (!Array.isArray(templates)) return [];
  const rows = [];
  templates.forEach((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return;
    const targetKind = toCode(pick(row, 'target_kind', 'targetKind'));
    if (targetKind === null || !TARGET_KINDS.includes(targetKind)) return;
    const rawCode = pick(row, 'target_code', 'targetCode');
    const targetCode = toCode(rawCode);
    const rawId = pick(row, 'id');
    rows.push({
      row,
      targetKind,
      targetCode,
      isWildcard: isWildcardTargetCode(rawCode === undefined ? null : rawCode),
      isDefault: toFlag(pick(row, 'is_default', 'isDefault')),
      id: Number.isFinite(Number(rawId)) ? Number(rawId) : null,
      index,
    });
  });
  return rows;
}

/**
 * 候选排序——**与入参数组顺序无关**（仓储层 `SELECT` 不带 `ORDER BY` 亦得同一结果）：
 * 默认模板优先 → 通配行优先 → `target_code` 升序 → `id` 升序 → 入参次序。
 */
function preferred(candidates) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.isWildcard !== b.isWildcard) return a.isWildcard ? -1 : 1;
    const codeA = a.targetCode ?? '';
    const codeB = b.targetCode ?? '';
    if (codeA !== codeB) return codeA < codeB ? -1 : 1;
    if (a.id !== b.id) {
      if (a.id === null) return 1;
      if (b.id === null) return -1;
      return a.id - b.id;
    }
    return a.index - b.index;
  });
  return sorted[0];
}

function result(entry, matchLevel, target) {
  return Object.freeze({
    template: entry?.row ?? null,
    templateId: entry?.id ?? null,
    templateBody: entry === null ? null : (pick(entry.row, 'template_body', 'templateBody') ?? null),
    targetKind: target.targetKind,
    targetCode: target.targetCode,
    matchedKind: entry?.targetKind ?? null,
    matchedCode: entry?.targetCode ?? null,
    isDefaultTemplate: entry?.isDefault ?? false,
    matchLevel,
    isFallback: matchLevel !== TEMPLATE_MATCH.EXACT,
    isKnownCode: target.isKnownCode,
  });
}

/**
 * 选用打印模板（需求 40.3、40.4）。
 *
 * 回退链自上而下取首个非空级别：
 * - **L1 专属**（`EXACT`）：同 `target_kind` 且 `target_code` 精确相等的行；同目标多行时
 *   取 `is_default = 1` 者（部分唯一索引 `ux_print_template_default` 保证至多一条），
 *   全非默认则按稳定序取首条。
 * - **L2/L3 同类目默认**（`KIND_DEFAULT`）：该类型无专属行时，取同 `target_kind` 下的
 *   通配行（`target_code = '*'`），其次取同 `target_kind` 下 `is_default = 1` 的行。
 * - **L4 跨类目默认**（`GLOBAL_DEFAULT`）：该类目一条模板都没有时，借用另一类目的
 *   通配 / 默认行——种子期只有 `('card_type','01')` 一条默认模板，打印执行过程单据
 *   全靠此级；补齐样张后此级自然不再被命中。
 * - 全部落空 → `matchLevel = 'none'`、`template = null`，由服务层决定报错还是渲染内置兜底。
 *
 * 目标不可识别（`card` 既无 `card_type` 也无 `exec_doc_type`）时跳过 L1–L3，直接进 L4。
 *
 * @param {object} card 工卡行 / 执行过程单据行 / `{ target_kind, target_code }`（见 {@link resolveTemplateTarget}）
 * @param {Array<object>} templates `print_template` 行集（`{ id, target_kind, target_code, template_body, is_default }`）
 * @returns {object} 冻结的选用结果：`{ template, templateId, templateBody, targetKind, targetCode, matchedKind, matchedCode, isDefaultTemplate, matchLevel, isFallback, isKnownCode }`
 */
export function selectPrintTemplate(card, templates) {
  const target = resolveTemplateTarget(card);
  const rows = normalizeTemplates(templates);
  if (rows.length === 0) return result(null, TEMPLATE_MATCH.NONE, target);

  if (target.targetKind !== null) {
    const sameKind = rows.filter((entry) => entry.targetKind === target.targetKind);

    // L1 专属模板（需求 40.3）——通配行不算专属，故排除
    if (target.targetCode !== null) {
      const exact = preferred(sameKind.filter(
        (entry) => !entry.isWildcard && entry.targetCode === target.targetCode,
      ));
      if (exact !== null) return result(exact, TEMPLATE_MATCH.EXACT, target);
    }

    // L2 同类目通配默认 → L3 同类目 is_default（需求 40.4）
    const kindDefault = preferred(sameKind.filter((entry) => entry.isWildcard))
      ?? preferred(sameKind.filter((entry) => entry.isDefault));
    if (kindDefault !== null) return result(kindDefault, TEMPLATE_MATCH.KIND_DEFAULT, target);
  }

  // L4 跨类目默认（种子占位期）
  const globalDefault = preferred(rows.filter((entry) => entry.isWildcard))
    ?? preferred(rows.filter((entry) => entry.isDefault));
  if (globalDefault !== null) return result(globalDefault, TEMPLATE_MATCH.GLOBAL_DEFAULT, target);

  return result(null, TEMPLATE_MATCH.NONE, target);
}
