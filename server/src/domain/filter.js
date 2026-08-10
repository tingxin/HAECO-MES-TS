/**
 * 工卡清单筛选领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 10.6 的筛选能力：`matchesFilters(card, filters)` —— 非空条件 **AND** 组合，
 * 空条件全通过（Property 4）。筛选维度与 `GET /api/task-cards` 的查询参数一一对应
 * （design.md §1.1）：`acType` / `taskNo` / `gearType` / `title` / `status` / `stage` / `cardType`。
 *
 * ## AND 语义与空条件（需求 1.2、1.3、1.4、4.4、46.6）
 *
 * - **AND**：命中当且仅当**全部非空条件**同时成立（需求 1.2）。
 * - **空条件全通过**：条件为 `null` / `undefined` / 空串 / 纯空白 / 空数组时不参与判定
 *   （需求 1.3「未填写任何筛选条件时返回全部工卡」）。全部条件为空时 {@link matchesFilters}
 *   **恒为真**（空合取的真空真），因此 {@link filterCards} 的结果恒等于全集。
 * - **无匹配即空集**（需求 1.4）：本模块只作判定，「保留已输入的筛选条件」属前端职责。
 * - 状态（需求 1.5、4.4）、Stage（需求 46.6，含 `WFD` 待删除筛选）、工卡类型（需求 2.1）
 *   与前四维同为一等筛选条件，无特殊分支。
 *
 * ## 匹配口径（与仓储层 SQL 对齐）
 *
 * 需求 1.1 将四个基础维度分为「输入」与「选择」两类，本模块据此定两种口径：
 *
 * | 维度 | 需求 1.1 交互 | 口径 | 对应 SQL |
 * |------|--------------|------|----------|
 * | `acType` / `gearType` / `status` / `stage` / `cardType` | 选择（封闭值域） | 精确、大小写敏感 | `col = ?` |
 * | `taskNo` / `title` | 输入（自由文本） | 子串包含、大小写不敏感 | `col LIKE '%'||?||'%'` |
 *
 * 「输入」类取子串包含：需求 1.1 明确工卡标题为「标题**描述**」筛选，逐字全等无法服务
 * 描述性检索；Task Card No 亦按前缀/片段定位工卡（需求 1 的 User Story「快速定位」）。
 * 大小写不敏感与 SQLite `LIKE` 对 ASCII 的默认行为一致；「选择」类的大小写敏感与 SQLite
 * `=` 一致——两类口径均可由仓储层用等价 SQL 复现，域判定与库查询不会给出不同结果。
 *
 * ## 值域校验不在本模块
 *
 * 本模块**不校验**筛选值是否属于对应枚举：非法值自然匹配不到任何工卡（退化为需求 1.4 的
 * 空结果），无需额外分支；枚举合法性由路由层入参校验与表级 `CHECK` 把关。
 *
 * 需求：1.1–1.5、2.1、4.4、46.6
 */

/** 匹配口径 */
const MATCH_EXACT = 'exact';
const MATCH_SUBSTRING = 'substring';

/**
 * 筛选维度定义（design.md §1.1 的 7 个查询参数）。
 *
 * - `filterKeys`：`filters` 入参中该维度可用的键名（camelCase 与 snake_case 皆可）
 * - `cardKeys`：工卡对象上该维度可能的字段名（仓储层 camelCase 与原始 snake_case 皆可）
 * - `match`：匹配口径，见模块头表格
 */
export const FILTER_FIELDS = Object.freeze({
  acType: Object.freeze({
    filterKeys: Object.freeze(['acType', 'ac_type']),
    cardKeys: Object.freeze(['acType', 'ac_type']),
    match: MATCH_EXACT,
  }),
  taskNo: Object.freeze({
    filterKeys: Object.freeze(['taskNo', 'task_no', 'taskCardNo']),
    cardKeys: Object.freeze(['taskNo', 'task_no']),
    match: MATCH_SUBSTRING,
  }),
  gearType: Object.freeze({
    filterKeys: Object.freeze(['gearType', 'gear_type']),
    cardKeys: Object.freeze(['gearType', 'gear_type']),
    match: MATCH_EXACT,
  }),
  title: Object.freeze({
    filterKeys: Object.freeze(['title']),
    cardKeys: Object.freeze(['title']),
    match: MATCH_SUBSTRING,
  }),
  status: Object.freeze({
    filterKeys: Object.freeze(['status', 'cardStatus', 'card_status']),
    cardKeys: Object.freeze(['status', 'cardStatus', 'card_status']),
    match: MATCH_EXACT,
  }),
  stage: Object.freeze({
    filterKeys: Object.freeze(['stage']),
    cardKeys: Object.freeze(['stage']),
    match: MATCH_EXACT,
  }),
  cardType: Object.freeze({
    filterKeys: Object.freeze(['cardType', 'card_type']),
    cardKeys: Object.freeze(['cardType', 'card_type']),
    match: MATCH_EXACT,
  }),
});

/** 全部可筛选维度名（顺序即需求 1.1 的呈现顺序，状态/Stage/类型在后）。 */
export const FILTER_FIELD_NAMES = Object.freeze(Object.keys(FILTER_FIELDS));

/**
 * 归一化为可比较文本；不可比较（缺失、对象、非有限数）时返回 `null`。
 * SQLite 的 TEXT 列出参恒为字符串，数字与布尔按 `String()` 归一以容忍调用方传入原生取值。
 */
function toComparable(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/** 单个候选取值是否为空条件（不参与判定）。 */
function isBlankCandidate(value) {
  const text = toComparable(value);
  return text === null || text.trim().length === 0;
}

/**
 * 归一化一个维度的候选取值集合。
 *
 * 标量 → 单元素集合；数组 → 逐项归一（支持多选筛选，任一命中即该维度成立）；
 * 空条件（空/纯空白/空数组/全空数组）→ 空集合，表示该维度不参与判定。
 * 候选取值一律 `trim`——前端输入框的首尾空白不应改变筛选结果。
 */
function normalizeCandidates(value) {
  const raw = Array.isArray(value) ? value : [value];
  const candidates = [];
  for (const item of raw) {
    if (isBlankCandidate(item)) continue;
    const text = toComparable(item).trim();
    if (!candidates.includes(text)) candidates.push(text);
  }
  return candidates;
}

/** 取 `filters` 上该维度第一个**非空**的键值（键名别名见 {@link FILTER_FIELDS}）。 */
function pickFilterValue(filters, filterKeys) {
  for (const key of filterKeys) {
    if (!Object.prototype.hasOwnProperty.call(filters, key)) continue;
    const candidates = normalizeCandidates(filters[key]);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

/** 取工卡上该维度的取值（字段名别名见 {@link FILTER_FIELDS}）；取不到返回 `null`。 */
function pickCardValue(card, cardKeys) {
  for (const key of cardKeys) {
    const text = toComparable(card[key]);
    if (text !== null) return text;
  }
  return null;
}

/**
 * 解析出**实际生效**的筛选条件（空条件已剔除）。
 *
 * 服务层与仓储层可据此拼 SQL：`conditions` 为空即「未填写任何筛选条件」，返回全集
 * （需求 1.3）。同一维度的多个候选取值为 **OR** 关系，维度之间为 **AND** 关系。
 *
 * @param {unknown} filters 筛选条件对象；非对象（含 `null`）视为无条件
 * @returns {ReadonlyArray<{field: string, candidates: readonly string[], match: string}>}
 */
export function normalizeFilters(filters) {
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    return Object.freeze([]);
  }
  const conditions = [];
  for (const field of FILTER_FIELD_NAMES) {
    const spec = FILTER_FIELDS[field];
    const candidates = pickFilterValue(filters, spec.filterKeys);
    if (candidates.length === 0) continue; // 空条件不参与判定（需求 1.3）
    conditions.push(Object.freeze({
      field,
      candidates: Object.freeze(candidates),
      match: spec.match,
    }));
  }
  return Object.freeze(conditions);
}

/** 实际生效的维度名集合（便于前端回显与日志）。 */
export function activeFilterFields(filters) {
  return Object.freeze(normalizeFilters(filters).map((condition) => condition.field));
}

/** 单个维度的判定：候选取值中任一命中即成立。 */
function matchesCondition(card, condition) {
  const cardValue = pickCardValue(card, FILTER_FIELDS[condition.field].cardKeys);
  // 工卡该字段无值：任何非空条件均不成立（NULL 不匹配任何筛选值，与 SQL 一致）
  if (cardValue === null) return false;

  if (condition.match === MATCH_SUBSTRING) {
    const haystack = cardValue.toLowerCase();
    return condition.candidates.some((needle) => haystack.includes(needle.toLowerCase()));
  }
  return condition.candidates.some((candidate) => cardValue === candidate);
}

/**
 * 清单筛选判定（Property 4）：命中当且仅当工卡同时满足**全部非空**筛选条件。
 *
 * 全部条件为空时恒为真（需求 1.3：返回全部工卡），此时不读取 `card` 的任何字段，
 * 故与 `card` 的形态无关。存在非空条件而工卡缺该字段时为假。
 *
 * @param {unknown} card 工卡对象（camelCase 或 snake_case 字段皆可）
 * @param {unknown} filters 筛选条件，见 {@link FILTER_FIELDS}
 * @returns {boolean}
 */
export function matchesFilters(card, filters) {
  const conditions = normalizeFilters(filters);
  if (conditions.length === 0) return true; // 空条件全通过（需求 1.3）
  if (card === null || typeof card !== 'object') return false;
  return conditions.every((condition) => matchesCondition(card, condition));
}

/**
 * 对工卡集合应用筛选，保持原顺序（需求 1.2、1.4）。
 *
 * 空条件时结果恒等于全集；无匹配时为空数组——「保留已输入的筛选条件」由前端承担，
 * 本模块不涉及分页（分页在仓储层）。
 *
 * @param {unknown} cards 工卡集合；非数组视为空集
 * @param {unknown} filters
 * @returns {ReadonlyArray<unknown>}
 */
export function filterCards(cards, filters) {
  if (!Array.isArray(cards)) return Object.freeze([]);
  const conditions = normalizeFilters(filters);
  if (conditions.length === 0) return Object.freeze([...cards]);
  return Object.freeze(cards.filter(
    (card) => card !== null
      && typeof card === 'object'
      && conditions.every((condition) => matchesCondition(card, condition)),
  ));
}
