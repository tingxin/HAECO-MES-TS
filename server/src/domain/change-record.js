/**
 * 变更留痕构造领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * ⚠ 本模块的 {@link buildChangeRecords} 是**全部编辑入口共用的唯一 `change_record` 行构造点**
 * （tasks.md 关键实现约束 7 / Property 35）：保存、工序或参考文件删除、升版、批量替换、作废
 * 五条路径一律经此产出记录行，任何路径自行拼装 `change_record` 行即为缺陷——变更记录是
 * 适航可追溯性的核心证据，不得因入口不同而缺失或形态不一。
 *
 * 设计约定（Property 35 的可断言化）：
 * - 字段级差异：每个**实际发生变化**的字段恰好产出一条记录；未变化字段不产生记录；
 *   `before` 与 `after` 等价时产出空集（不产生幻影记录）。
 * - 整体性变更：`before` / `after` 一侧为 `null` / `undefined`（工序、参考文件等整体删除或整体新增）
 *   时无具体字段可落位，产出**恰好一条** `field: null` 的整体记录，被删除/新增实体的快照
 *   序列化进 `old_value` / `new_value`——与 `schema.sql` 中 `field` / `old_value` / `new_value`
 *   可为 NULL 的设计一致。
 * - 变更原因为空或纯空白：**整体拒绝**，返回 `ok: false` 且 `records` 为空数组（需求 19.2）。
 *   本模块不抛异常，服务层据 `ok === false` 返回 `CODE.VALIDATION`（400）并不落库。
 * - 时间戳可注入（`options.timestamp`）：同一次变更的全部记录共享同一时间戳；缺省取当前时刻，
 *   便于测试完全控制输出。
 *
 * 需求：19.1、19.2、19.3、20.8、42.5
 */

/**
 * 变更类型取值集（`change_record.change_type` 的**表局部**取值集，非全系统枚举，
 * 故不入 `enums.js`；与 `schema.sql` 的字面量 `CHECK` 一一对应）。
 * - `edit`：元数据保存 / 工序与参考文件等内容编辑
 * - `delete`：工序、参考文件等删除
 * - `revise`：升版
 * - `batch_replace`：批量替换（需求 20.8）
 * - `void`：作废（需求 42.5）
 */
export const CHANGE_TYPES = Object.freeze(['edit', 'delete', 'revise', 'batch_replace', 'void']);

/** 拒绝原因词表——服务层据此给出提示文案，一律映射为 400。 */
export const REJECTION = Object.freeze({
  /** 变更原因为空或纯空白（需求 19.2、20.7） */
  REASON_REQUIRED: 'REASON_REQUIRED',
  /** `changeType` 不属于 {@link CHANGE_TYPES} */
  INVALID_CHANGE_TYPE: 'INVALID_CHANGE_TYPE',
  /** 操作人缺失（需求 19.3、7.4：变更须可追溯到人） */
  OPERATOR_REQUIRED: 'OPERATOR_REQUIRED',
});

const REJECTION_MESSAGES = Object.freeze({
  [REJECTION.REASON_REQUIRED]: '变更原因为必填项，不得为空或纯空白',
  [REJECTION.INVALID_CHANGE_TYPE]: `变更类型非法，须为 ${CHANGE_TYPES.join(' / ')} 之一`,
  [REJECTION.OPERATOR_REQUIRED]: '操作人缺失，变更记录须可追溯到人',
});

/**
 * 空白判定：空串、纯空白（含制表/换行与全角空格 U+3000）为空；
 * 数字类取值不为空（工号可能以数字传入）；其余非字符串一律视为空（缺失）。
 */
function isBlank(value) {
  if (typeof value === 'string') {
    return value.trim().length === 0 || /^[\s\u3000]*$/.test(value);
  }
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'bigint') return false;
  return true;
}

/** 归一化为 TEXT 列取值：字符串原样保留（含前后空白，保留输入原貌），其余转字符串。 */
function asText(value) {
  return typeof value === 'string' ? value : String(value);
}

/** 是否为「无快照」（整体删除/新增的另一侧）。 */
function isAbsent(snapshot) {
  return snapshot === null || snapshot === undefined;
}

/** 是否为可逐字段比对的快照对象（普通对象或数组之外的对象一律按整体处理）。 */
function isFieldwiseSnapshot(snapshot) {
  return (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    !Array.isArray(snapshot) &&
    !(snapshot instanceof Date)
  );
}

/**
 * 稳定序列化（键排序、`undefined` 成员剔除、`Date` 取 ISO）——保证嵌套结构的
 * 序列化结果只取决于内容本身，不受键插入顺序影响，差异比对因此可复现。
 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : `"${String(value)}"`;
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

/**
 * 取值序列化规则（`old_value` / `new_value` 为 TEXT 列，须有唯一确定的落库形态）。
 *
 * - `null` / `undefined` → `null`（落 SQL NULL）
 * - 字符串 → 原样（不做 trim，保留操作者输入的原貌）
 * - 数字 / 布尔 / BigInt → `String(value)`；故 `1` 与 `'1'` 序列化后相同，
 *   **不会**被判为字段变化（落库形态未变即无变更，避免幻影记录）
 * - `Date` → ISO 8601 字符串（无效日期取 `String(value)`）
 * - 数组 / 对象 → 稳定 JSON（键排序、`undefined` 成员剔除）
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function serializeChangeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  if (typeof value === 'object') return stableStringify(value);
  return String(value);
}

/** 两个取值在**落库形态**上是否等价（等价即无变更）。 */
function isUnchanged(oldValue, newValue) {
  return serializeChangeValue(oldValue) === serializeChangeValue(newValue);
}

/** 差异字段名集合：两侧自有可枚举键的并集，按字典序排列，保证输出顺序可复现。 */
function unionFieldNames(before, after) {
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...names].sort();
}

function reject(rejection) {
  return Object.freeze({
    ok: false,
    rejection,
    message: REJECTION_MESSAGES[rejection],
    records: Object.freeze([]),
  });
}

function accept(records) {
  return Object.freeze({
    ok: true,
    rejection: null,
    message: 'ok',
    records: Object.freeze(records.map((record) => Object.freeze(record))),
  });
}

/** 归一化注入的时间戳：`Date` / ISO 字符串 / 毫秒数均可；缺省取当前时刻。 */
function normalizeTimestamp(timestamp) {
  if (timestamp === null || timestamp === undefined) return new Date().toISOString();
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString();
  }
  if (typeof timestamp === 'number') {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  return String(timestamp);
}

/**
 * 构造变更记录行集合——**全部编辑入口的唯一留痕构造点**（需求 19.1–19.3、20.8、42.5）。
 *
 * 产出的每条记录形状与 `change_record` 表列一一对应（除自增 `id`）：
 * `{ card_id, card_revision, change_type, field, old_value, new_value, reason, operator_id, timestamp }`，
 * 仓储层可直接落库，无需二次拼装。
 *
 * @param {object|null|undefined} before 变更前快照；`null` / `undefined` 表示整体新增
 * @param {object|null|undefined} after 变更后快照；`null` / `undefined` 表示整体删除
 * @param {string} changeType 变更类型，须 ∈ {@link CHANGE_TYPES}
 * @param {string} reason 变更原因（需求 19.2：为空或纯空白时整体拒绝）
 * @param {string} operatorId 操作人工号（`staff_no`）
 * @param {{timestamp?: Date|string|number, cardId?: number|string|null, cardRevision?: number|null}} [options]
 *   `timestamp` 可注入，同一次变更的全部记录共享该值；`cardId` / `cardRevision` 透传至记录行。
 * @returns {{ok: boolean, rejection: string|null, message: string, records: ReadonlyArray<object>}}
 *   `ok === false` 时 `records` 恒为空数组（整体拒绝，变更不落库）
 */
export function buildChangeRecords(before, after, changeType, reason, operatorId, options = {}) {
  // ① 原因必填（需求 19.2）：为空或纯空白整体拒绝，不产出任何记录
  if (isBlank(reason)) return reject(REJECTION.REASON_REQUIRED);

  // ② 变更类型须属封闭取值集，否则记录无法落库（schema CHECK 会拦），在此提前整体拒绝
  if (typeof changeType !== 'string' || !CHANGE_TYPES.includes(changeType)) {
    return reject(REJECTION.INVALID_CHANGE_TYPE);
  }

  // ③ 操作人必填（需求 19.3、7.4）：无操作人的留痕不具追溯价值
  if (isBlank(operatorId)) return reject(REJECTION.OPERATOR_REQUIRED);

  const timestamp = normalizeTimestamp(options.timestamp);
  const cardId = options.cardId === undefined ? null : options.cardId;
  const cardRevision = options.cardRevision === undefined ? null : options.cardRevision;

  const row = (field, oldValue, newValue) => ({
    card_id: cardId,
    card_revision: cardRevision,
    change_type: changeType,
    field,
    old_value: serializeChangeValue(oldValue),
    new_value: serializeChangeValue(newValue),
    reason: asText(reason),
    operator_id: asText(operatorId),
    timestamp,
  });

  const beforeAbsent = isAbsent(before);
  const afterAbsent = isAbsent(after);

  // 两侧皆无快照：无变更可留痕
  if (beforeAbsent && afterAbsent) return accept([]);

  // 整体性变更（整体删除 / 整体新增 / 非对象快照）：无具体字段可落位，产出恰好一条 field:null 记录
  if (beforeAbsent || afterAbsent || !isFieldwiseSnapshot(before) || !isFieldwiseSnapshot(after)) {
    if (isUnchanged(before, after)) return accept([]);
    return accept([row(null, before, after)]);
  }

  // 字段级差异：每个实际变化的字段恰好一条记录，未变化字段不产生记录
  const records = [];
  for (const field of unionFieldNames(before, after)) {
    if (isUnchanged(before[field], after[field])) continue;
    records.push(row(field, before[field], after[field]));
  }
  return accept(records);
}
