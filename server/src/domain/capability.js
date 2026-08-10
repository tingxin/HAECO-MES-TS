/**
 * 能力清单范围校验领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 8.3 的两项规则：
 * - `currentCapabilityRevision(list, onDate)` 在给定记录集合中取「当前有效版本号」
 * - `checkCapability(card, capabilityList, onDate)`（机型, 起落架类型, Skill）是否处于
 *   当前有效版本的能力范围内，不通过时给出**可区分的原因码**
 *
 * ── 判定口径（需求 39.4）────────────────────────────────────────────
 * 需求 39.4 的原文规则为：「在生效期间覆盖校验当日的记录中（`effective_from ≤ 校验日` 且
 * `effective_to ≥ 校验日`，`effective_to` 为空视为长期有效）取版本号（revision）最大者」。
 *
 * 版本选取的**作用域取 (机型, 起落架类型, Skill) 三元组**，而非全表一次性取全局最大 revision。
 * 依据：
 * ① `schema.sql` 的 `capability_list` 注释与 `UNIQUE (ac_type, gear_type, skill, revision)`
 *    约束明示「同一 (ac_type, gear_type, skill) 可有多条 revision……同期多条取 revision 最大者」，
 *    revision 是**能力项自身的版本**，不是整张清单的快照版本；
 * ② `schema.test.js` / `seed.test.js` 中「查出当前生效版本」的既有查询一律先按三元组过滤再取
 *    `MAX(revision)`，本模块与数据层口径保持一致；
 * ③ `SEED_CAPABILITY_LIST` 中 `320/MLG/GR` 有 rev 2、3 同期并存，而 `747/NLG/IR`、`737/BLG/NT`
 *    仅有 rev 1。若按全局最大 revision（=3）裁剪，后两项会被误判为超范围——与种子数据「这些
 *    组合均属已批准能力」的意图相悖。故作用域必须是三元组级。
 *
 * 由此，`currentCapabilityRevision` 被设计为**作用域无关**：它只在调用方给定的记录集合内取
 * 「覆盖当日 ∧ revision 最大」者。作用域裁剪由 {@link checkCapability} 负责（先按三元组过滤，
 * 再调用本函数），使「怎样算当前有效版本」与「在哪个范围内选」两个决策彼此独立、各自可测。
 *
 * ── 日期比较 ────────────────────────────────────────────────────
 * `effective_from` / `effective_to` 为 `'YYYY-MM-DD'` 定宽零填充 TEXT，**按字典序直接比较**，
 * 不做 `Date` 解析：定宽零填充下字典序与时间序等价，且可回避 `new Date('YYYY-MM-DD')` 按 UTC
 * 解析、本地时区取日期时前后错一天的经典陷阱。非该格式的取值一律视为不可判定（见下）。
 *
 * ── 不通过的原因码 ──────────────────────────────────────────────
 * 服务层据 {@link CAPABILITY_REJECTION} 映射 422（见 design.md 错误处理表）：
 * - `NO_EFFECTIVE_REVISION`：整张清单无任何覆盖校验当日的记录 → 「能力清单缺失或已过期」（需求 39.1、39.4）
 * - `OUT_OF_SCOPE`：清单有当前有效版本，但该三元组不在其中 → 「超出已批准能力范围」（需求 39.3）
 * - `INVALID_ON_DATE`：校验日期格式非法，无法判定生效期 → 拒绝优于放行
 * 返回值为**判别式结果对象**（非裸布尔），服务层与属性测试均消费 `ok` + `rejection`。
 *
 * 需求：39.1、39.2、39.3、39.4
 */

/** 不通过原因码（服务层据此给出可区分提示，一律映射 422） */
export const CAPABILITY_REJECTION = Object.freeze({
  /** 无当前有效版本：整张清单无任何记录覆盖校验当日（需求 39.1、39.4） */
  NO_EFFECTIVE_REVISION: 'NO_EFFECTIVE_REVISION',
  /** 三元组不在当前有效版本的能力范围内（需求 39.2、39.3） */
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  /** 校验日期非 'YYYY-MM-DD' 格式，生效期无法判定 */
  INVALID_ON_DATE: 'INVALID_ON_DATE',
});

const REJECTION_MESSAGES = Object.freeze({
  [CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION]: '能力清单缺失或已过期（无当前有效版本），无法校验能力范围',
  [CAPABILITY_REJECTION.OUT_OF_SCOPE]: '机型、起落架类型与专业组合超出已批准能力范围',
  [CAPABILITY_REJECTION.INVALID_ON_DATE]: '校验日期格式非法，须为 YYYY-MM-DD',
});

/** `'YYYY-MM-DD'` 定宽日期 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 归一化日期入参：`'YYYY-MM-DD'` 字符串原样返回；`Date` 取其 ISO 日期部分；
 * `null` / `undefined` 取当日；其余（含非法格式字符串）返回 `null` 表示不可判定。
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeDate(value) {
  if (value === null || value === undefined) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return DATE_PATTERN.test(text) ? text : null;
}

/**
 * 取字段值，兼容 snake_case（DB 行）与 camelCase（服务层对象）两种写法，
 * 去除首尾空白；取不到非空字符串时返回 `null`。
 * @param {object} row
 * @param {string} snake
 * @param {string} camel
 * @returns {string | null}
 */
function textField(row, snake, camel) {
  const raw = row[snake] ?? row[camel];
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text === '' ? null : text;
}

/**
 * 记录的生效期是否覆盖 `onDate`（需求 39.4）。
 *
 * `effective_from` 缺失或非法格式时视为**不可判定 → 不覆盖**（拒绝优于放行；`schema.sql` 中该列
 * 为 NOT NULL，出现此情形即数据异常）。`effective_to` 为空视为长期有效；非法格式同样视为不覆盖。
 * @param {object} row
 * @param {string} onDate `'YYYY-MM-DD'`
 * @returns {boolean}
 */
function coversDate(row, onDate) {
  const from = textField(row, 'effective_from', 'effectiveFrom');
  if (from === null || !DATE_PATTERN.test(from)) return false;
  if (from > onDate) return false; // 尚未生效

  const to = textField(row, 'effective_to', 'effectiveTo');
  if (to === null) return true; // 空 = 长期有效
  if (!DATE_PATTERN.test(to)) return false;
  return to >= onDate; // 已过期则不覆盖
}

/**
 * 取记录的 revision（整数）；非有限整数时返回 `null`，该行不参与版本选取
 * （版本号不可判定的行无法作为「当前有效版本」的依据，从严处理）。
 * @param {object} row
 * @returns {number | null}
 */
function revisionOf(row) {
  const raw = row.revision;
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * 当前有效版本号（需求 39.4）——在 `list` 内取「生效期覆盖 `onDate` ∧ revision 最大」者。
 *
 * **作用域无关**：只在调用方给定的集合内选取。按三元组作用域选版本时，调用方须先过滤
 * （{@link checkCapability} 即如此）；传入全表则得到全表范围内覆盖当日的最大 revision，
 * 该值用于判定「清单是否存在当前有效版本」。
 *
 * @param {ReadonlyArray<object>|null|undefined} list 能力清单记录集合（DB 行或等价对象）
 * @param {string|Date|null} [onDate] 校验日期，`'YYYY-MM-DD'` 或 `Date`；缺省取当日
 * @returns {number | null} 最大 revision；无覆盖当日的记录（或日期非法）时为 `null`
 */
export function currentCapabilityRevision(list, onDate) {
  const date = normalizeDate(onDate);
  if (date === null || !Array.isArray(list)) return null;

  let max = null;
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue;
    if (!coversDate(row, date)) continue;
    const revision = revisionOf(row);
    if (revision === null) continue;
    if (max === null || revision > max) max = revision;
  }
  return max;
}

/**
 * 工卡的（机型, 起落架类型, Skill）三元组，兼容 snake_case / camelCase；缺任一项时该项为 `null`。
 * @param {unknown} card
 * @returns {{acType: string|null, gearType: string|null, skill: string|null}}
 */
function scopeOf(card) {
  if (card === null || typeof card !== 'object') {
    return { acType: null, gearType: null, skill: null };
  }
  return {
    acType: textField(card, 'ac_type', 'acType'),
    gearType: textField(card, 'gear_type', 'gearType'),
    skill: textField(card, 'skill', 'skill'),
  };
}

/** 记录是否落在给定三元组作用域内（大小写敏感的精确匹配，枚举取值本身为大写） */
function inScope(row, scope) {
  return (
    textField(row, 'ac_type', 'acType') === scope.acType &&
    textField(row, 'gear_type', 'gearType') === scope.gearType &&
    textField(row, 'skill', 'skill') === scope.skill
  );
}

function result(ok, rejection, revision, scope, onDate) {
  return Object.freeze({
    ok,
    rejection,
    message: rejection === null ? 'ok' : REJECTION_MESSAGES[rejection],
    revision,
    scope: Object.freeze(scope),
    onDate,
  });
}

/**
 * 能力清单范围校验（需求 39.1–39.4）——提交审核校验清单的第 (d) 项。
 *
 * 通过当且仅当：清单存在覆盖 `onDate` 的记录（即存在当前有效版本），**且**工卡的
 * （机型, 起落架类型, Skill）三元组在该日仍有生效记录。两类不通过以原因码区分：
 * 清单整体无有效版本 → `NO_EFFECTIVE_REVISION`；清单有效但组合不在其中 → `OUT_OF_SCOPE`。
 *
 * 三元组任一项缺失的工卡必然落入 `OUT_OF_SCOPE`：`capability_list` 三列均为 NOT NULL，
 * 缺项无从匹配（其字段完整性由提交审核校验项 (c) 另行拦截）。
 *
 * @param {object|null|undefined} card 工卡对象（`ac_type`/`acType` 等两种写法均可）
 * @param {ReadonlyArray<object>|null|undefined} capabilityList 能力清单全表记录
 * @param {string|Date|null} [onDate] 校验日期，`'YYYY-MM-DD'` 或 `Date`；缺省取当日
 * @returns {{ok: boolean, rejection: string|null, message: string, revision: number|null,
 *   scope: {acType: string|null, gearType: string|null, skill: string|null}, onDate: string|null}}
 *   `ok === true` 时 `revision` 为该三元组作用域内的当前有效版本号
 */
export function checkCapability(card, capabilityList, onDate) {
  const scope = scopeOf(card);
  const date = normalizeDate(onDate);
  if (date === null) {
    return result(false, CAPABILITY_REJECTION.INVALID_ON_DATE, null, scope, null);
  }

  const list = Array.isArray(capabilityList) ? capabilityList : [];

  // ① 清单是否存在当前有效版本（需求 39.1、39.4）：全表范围内是否有记录覆盖校验当日
  if (currentCapabilityRevision(list, date) === null) {
    return result(false, CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION, null, scope, date);
  }

  // ② 三元组作用域内取当前有效版本（需求 39.4）；取不到即超出已批准范围（需求 39.2、39.3）
  const scoped = list.filter((row) => row !== null && typeof row === 'object' && inScope(row, scope));
  const revision = currentCapabilityRevision(scoped, date);
  if (revision === null) {
    return result(false, CAPABILITY_REJECTION.OUT_OF_SCOPE, null, scope, date);
  }

  return result(true, null, revision, scope, date);
}
