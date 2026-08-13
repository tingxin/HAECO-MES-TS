/**
 * 集合辅助与 JSON 载荷序列化领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * ⚠ 本模块**不在 design.md「领域纯函数模块」的关键函数表内**——该表只列各模块的*关键函数*，
 * 而 Property 9（参考文件集合完整性）与 Property 12（组件序列化往返）需要一处可断言的落位；
 * 本模块即这两条属性的**补充承载体**（tasks.md 任务 10.6），不引入表外的新业务规则。
 *
 * 承载两组能力：
 *
 * 1. **参考文件集合增删**（需求 9.1–9.3，Property 9）：新增后集合包含该条，删除后不再包含该条，
 *    **其它条目原值原序不受影响**。全部操作返回新数组，**绝不原地修改**入参——服务层依赖
 *    「校验失败即无副作用」，原地修改会让失败路径留下半改集合。
 * 2. **组件 / 采集项载荷往返**（需求 13.1–13.3、18.1、18.2、12.2，Property 12）：
 *    `inserted_component.payload` 与 `capture_item.config` 均为 JSON TEXT 列，
 *    `serialize` → `parse` 须回到等价对象，且组件与所属工序的 `step_id` 绑定关系保持不变。
 *
 * ## 与 `change-record.js` 的分工（不重复实现）
 *
 * `change-record.js` 的 `serializeChangeValue` 服务于**审计取值落 TEXT 列**：它把任意取值
 * （含数字、`Date`）压成可比较的单一文本形态，是**有损**的（`1` 与 `'1'` 同形，以避免幻影记录）。
 * 本模块的 {@link serializePayload} 服务于**结构化载荷往返**：类型必须**无损**保留
 * （`1` 与 `'1'` 是不同 payload），故只接受 JSON 原生取值。两者目标相反，不可互相复用；
 * 但**键排序稳定序列化**这一手法与其一致——同一 payload 的落库文本恒唯一，便于比对与去重。
 *
 * 需求：9.1–9.3、12.2、13.1–13.3、18.1、18.2
 */

import { COMPONENT_TYPE } from './enums.js';

// =====================================================================
// 一、通用集合增删（按身份键，不影响其它条目）
// =====================================================================

/**
 * 按身份键新增一个条目：返回**追加于末尾**的新数组，入参不变。
 *
 * 不做去重——参考文件、组件等集合在 `schema.sql` 中均无唯一约束（需求 9.3 允许一张工卡
 * 关联多条参考文件），是否重复由业务方判断。
 *
 * @template T
 * @param {readonly T[] | null | undefined} list 原集合；非数组视为空集
 * @param {T} item 待新增条目
 * @returns {readonly T[]} 新集合（冻结）
 */
export function addItem(list, item) {
  const base = Array.isArray(list) ? list : [];
  return Object.freeze([...base, item]);
}

/**
 * 按身份键移除条目：返回移除后的新数组，入参不变，**其余条目原值原序保留**。
 *
 * 同键条目**全部移除**（Property 9「删除某条后不再包含该条」的字面语义：删除后集合中不得
 * 再存在与该条同身份的条目）；`removed` 给出实际移除条数，服务层可据此判断「删除的条目不存在」。
 *
 * @template T
 * @param {readonly T[] | null | undefined} list 原集合；非数组视为空集
 * @param {unknown} target 待移除条目（或其身份键）
 * @param {(item: unknown) => string} keyOf 身份键函数
 * @returns {{list: readonly T[], removed: number}}
 */
export function removeItem(list, target, keyOf) {
  const base = Array.isArray(list) ? list : [];
  const targetKey = typeof target === 'string' ? target : keyOf(target);
  const kept = base.filter((item) => keyOf(item) !== targetKey);
  return Object.freeze({
    list: Object.freeze(kept),
    removed: base.length - kept.length,
  });
}

/**
 * 集合中是否存在与 `target` 同身份的条目。
 * @template T
 * @param {readonly T[] | null | undefined} list
 * @param {unknown} target 条目或其身份键
 * @param {(item: unknown) => string} keyOf
 * @returns {boolean}
 */
export function hasItem(list, target, keyOf) {
  if (!Array.isArray(list)) return false;
  const targetKey = typeof target === 'string' ? target : keyOf(target);
  return list.some((item) => keyOf(item) === targetKey);
}

// =====================================================================
// 二、参考文件集合（需求 9.1–9.3，Property 9）
// =====================================================================

/**
 * 参考文件的业务字段（需求 9.1：文件类型、参考号、版本号、ATA 章节号）。
 * 键为 camelCase 逻辑字段名，值为 `reference_document` 的列名。
 */
export const REFERENCE_DOC_FIELDS = Object.freeze({
  docType: 'doc_type',
  refNo: 'ref_no',
  docRevision: 'doc_revision',
  ataChapter: 'ata_chapter',
});

/** 取对象上第一个存在（非 `null` / `undefined`）的字段。 */
function pickField(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** 文本归一：`null` / `undefined` → `null`；其余转字符串（不 trim，保留输入原貌）。 */
function toTextOrNull(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * 归一化一条参考文件为 camelCase 形态（`snake_case` 入参亦可），仅保留需求 9.1 的四个业务
 * 字段与 `id` / `cardId` 归属键——多余键不进结果，保证身份键只取决于业务内容。
 *
 * @param {unknown} doc
 * @returns {Readonly<{id: number|string|null, cardId: number|string|null,
 *                     docType: string|null, refNo: string|null,
 *                     docRevision: string|null, ataChapter: string|null}>}
 */
export function normalizeReferenceDocument(doc) {
  const id = pickField(doc, ['id']);
  const cardId = pickField(doc, ['cardId', 'card_id']);
  return Object.freeze({
    id: id === undefined ? null : id,
    cardId: cardId === undefined ? null : cardId,
    docType: toTextOrNull(pickField(doc, ['docType', 'doc_type'])),
    refNo: toTextOrNull(pickField(doc, ['refNo', 'ref_no'])),
    docRevision: toTextOrNull(pickField(doc, ['docRevision', 'doc_revision', 'revision'])),
    ataChapter: toTextOrNull(pickField(doc, ['ataChapter', 'ata_chapter'])),
  });
}

/**
 * 参考文件的身份键。
 *
 * 已落库条目以 `id` 为身份（`reference_document.id` 为主键，最可靠）；尚未落库（`id` 为空）
 * 的条目退化为**四个业务字段 + 归属工卡**的结构键——编制界面上「未保存即删除」的条目没有 `id`，
 * 若无结构键回退则无法定位。
 *
 * @param {unknown} doc
 * @returns {string}
 */
export function referenceDocumentKey(doc) {
  const normalized = normalizeReferenceDocument(doc);
  if (normalized.id !== null) return `id:${String(normalized.id)}`;
  return `ref:${stableStringify({
    cardId: normalized.cardId,
    docType: normalized.docType,
    refNo: normalized.refNo,
    docRevision: normalized.docRevision,
    ataChapter: normalized.ataChapter,
  })}`;
}

/**
 * 新增一条参考文件（需求 9.1、9.3）：返回追加了归一化条目的新集合，原集合不变。
 * @param {unknown} list
 * @param {unknown} doc
 * @returns {readonly object[]}
 */
export function addReferenceDocument(list, doc) {
  return addItem(list, normalizeReferenceDocument(doc));
}

/**
 * 删除一条参考文件（需求 9.2）：仅移除同身份条目，**其它条目原值原序不受影响**（Property 9）。
 * @param {unknown} list
 * @param {unknown} target 条目对象或身份键
 * @returns {{list: readonly object[], removed: number}}
 */
export function removeReferenceDocument(list, target) {
  return removeItem(list, target, referenceDocumentKey);
}

/**
 * 集合中是否包含该参考文件。
 * @param {unknown} list
 * @param {unknown} target 条目对象或身份键
 * @returns {boolean}
 */
export function hasReferenceDocument(list, target) {
  return hasItem(list, target, referenceDocumentKey);
}

// =====================================================================
// 三、组件 / 采集项载荷序列化往返（需求 13、18、12.2，Property 12）
// =====================================================================

/**
 * 各组件类型的 `payload` 字段约定（design.md `inserted_component` 节，13 类）。
 *
 * 供属性测试按类型构造合法 payload，亦作服务层的形状参考。**本模块不据此拒绝额外字段**：
 * `payload` 为 JSON 列而非展开列，形状约定属编辑器契约，往返能力对任意 JSON 取值成立。
 * 图片 / 视频 / 音频不内联二进制，一律以 `attachmentId` 引用 `attachment` 表（需求 13.2、18.1）。
 */
export const COMPONENT_PAYLOAD_FIELDS = Object.freeze({
  measurement: Object.freeze(['label', 'unit', 'nominal']),
  range: Object.freeze(['label', 'unit', 'min', 'max']),
  table: Object.freeze(['columns', 'rows']),
  text: Object.freeze(['html']),
  tool: Object.freeze(['toolPn', 'toolDesc', 'qty']),
  consumable: Object.freeze(['materialNo', 'desc', 'qty', 'unit']),
  image: Object.freeze(['attachmentId', 'url', 'annotations']),
  video: Object.freeze(['attachmentId', 'url', 'duration']),
  audio: Object.freeze(['attachmentId', 'url', 'duration']),
  time: Object.freeze(['label', 'format']),
  dataGroup: Object.freeze(['label', 'items']),
  custom: Object.freeze(['schema']),
  signature: Object.freeze(['requirementId']),
});

/**
 * 类型是否属于 13 类组件类型（采集项与组件**共用**该类型定义，需求 12.2）。
 * @param {unknown} type
 * @returns {boolean}
 */
export function isValidComponentType(type) {
  return typeof type === 'string' && COMPONENT_TYPE.includes(type);
}

/** 载荷序列化 / 解析失败。服务层据此返回 `CODE.VALIDATION`（400）。 */
export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

/**
 * 稳定序列化：对象键按字典序排列、`undefined` 成员剔除——同一 payload 的落库文本恒唯一，
 * 不受键插入顺序影响，便于比对、去重与快照。
 *
 * 只接受 JSON 原生取值（`string` / 有限 `number` / `boolean` / `null` / 数组 / 普通对象）；
 * 其余取值（`Date`、函数、`Symbol`、`NaN`、`BigInt`）**不属合法 payload**，一律抛
 * {@link PayloadError}——静默降级会让往返在毫无提示的情况下失真（`Date` 回来会是字符串）。
 */
function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PayloadError(`payload 不支持非有限数值：${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // 数组成员的 undefined 在 JSON 中恒为 null，与 JSON.stringify 行为一致
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PayloadError(`payload 仅支持 JSON 原生取值，收到：${Object.prototype.toString.call(value)}`);
    }
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  throw new PayloadError(`payload 仅支持 JSON 原生取值，收到：${typeof value}`);
}

/**
 * 载荷序列化：JSON 取值 → JSON TEXT（`inserted_component.payload` / `capture_item.config` 列）。
 *
 * `null` / `undefined` → `null`（落 SQL NULL，表示该组件无类型特定数据）。
 * 键排序稳定，故同一内容的落库文本唯一。
 *
 * @param {unknown} payload
 * @returns {string | null}
 * @throws {PayloadError} payload 含非 JSON 原生取值
 */
export function serializePayload(payload) {
  if (payload === null || payload === undefined) return null;
  return stableStringify(payload);
}

/**
 * 载荷解析：JSON TEXT → JSON 取值（{@link serializePayload} 的逆）。
 *
 * `null` / `undefined` / 空串 → `null`（对应 SQL NULL 与空列）；已是对象/数组时原样返回
 * （仓储层可能已解析，重复解析不应报错）。非法 JSON 抛 {@link PayloadError}。
 *
 * @param {unknown} text
 * @returns {unknown}
 * @throws {PayloadError} 文本不是合法 JSON
 */
export function parsePayload(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'object') return text; // 已解析，幂等返回
  if (typeof text !== 'string') {
    throw new PayloadError(`payload 列取值应为 JSON 文本，收到：${typeof text}`);
  }
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PayloadError(`payload 不是合法 JSON：${error.message}`);
  }
}

function objectPayload(payload, label) {
  const parsed = parsePayload(payload);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PayloadError(`${label} payload 必须为对象`);
  }
  return parsed;
}
function requiredText(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new PayloadError(`${label} 为必填项`);
  }
  return String(value);
}
function hasFinitePoint(value) {
  if (Array.isArray(value)) return value.length >= 2 && value.every((item) => Number.isFinite(Number(item)));
  return value !== null && typeof value === 'object'
    && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y));
}
function normalizeAnnotations(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PayloadError('annotations 必须为数组');
  return value.map((annotation, index) => {
    if (annotation === null || typeof annotation !== 'object' || Array.isArray(annotation)) {
      throw new PayloadError(`第 ${index + 1} 条标注必须为对象`);
    }
    const aliases = { rectangle: 'rect', freehand: 'pen' };
    const type = aliases[annotation.type] ?? annotation.type;
    if (!['rect', 'pen', 'arrow', 'text'].includes(type)) {
      throw new PayloadError(`标注类型非法：${String(annotation.type)}`);
    }
    const color = requiredText(annotation.color, '标注颜色');
    const points = annotation.points ?? annotation.path;
    if (!Array.isArray(points) || points.length === 0 || !points.every(hasFinitePoint)) {
      throw new PayloadError(`第 ${index + 1} 条标注须包含有效坐标或路径`);
    }
    const text = type === 'text' ? requiredText(annotation.text, '文字标注内容') : annotation.text;
    const normalized = { ...annotation, type, points, color };
    delete normalized.path;
    if (text !== undefined) normalized.text = text;
    return normalized;
  });
}
function normalizeRows(payload, fields, aliases, label) {
  if (payload.rows !== undefined && !Array.isArray(payload.rows)) {
    throw new PayloadError(`${label} rows 必须为数组`);
  }
  const sourceRows = Array.isArray(payload.rows) ? payload.rows : [payload];
  return sourceRows.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new PayloadError(`${label}第 ${index + 1} 行必须为对象`);
    }
    return Object.fromEntries(fields.map((field) => {
      const value = aliases[field].map((key) => row[key]).find((item) => item !== undefined);
      return [field, requiredText(value, `${label}第 ${index + 1} 行 ${field}`)];
    }));
  });
}

export function normalizeComponentPayload(type, payload) {
  if (!['image', 'tool', 'consumable'].includes(type)) return parsePayload(payload);
  const source = objectPayload(payload, type);
  if (type === 'image') {
    const hasInlineImage = (value) => {
      if (typeof value === 'string') return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim());
      if (Array.isArray(value)) return value.some(hasInlineImage);
      return value !== null && typeof value === 'object' && Object.values(value).some(hasInlineImage);
    };
    if (Object.keys(source).some((key) =>
      /base64|data[_-]?url|image[_-]?data|original[_-]?image/i.test(key))
      || hasInlineImage(source)) {
      throw new PayloadError('图片 payload 不得内联 Base64 原图');
    }
    const attachmentId = source.attachmentId ?? source.attachment_id;
    if (attachmentId === null || attachmentId === undefined || attachmentId === '') {
      throw new PayloadError('图片 payload 须保留 attachmentId');
    }
    const normalized = { ...source, attachmentId, annotations: normalizeAnnotations(source.annotations) };
    delete normalized.attachment_id;
    return normalized;
  }
  if (type === 'tool') {
    return { rows: normalizeRows(source, ['partNo', 'description'], {
      partNo: ['partNo', 'toolPn', 'part_no', 'code', 'name'],
      description: ['description', 'toolDesc', 'desc', 'details'],
    }, '工具') };
  }
  return { rows: normalizeRows(source, ['partNo', 'description', 'qty', 'category'], {
    partNo: ['partNo', 'materialNo', 'part_no', 'name'],
    description: ['description', 'desc', 'details'],
    qty: ['qty', 'quantity'], category: ['category', 'unit'],
  }, '耗材') };
}

/** 数值归一（`sort_order` 等 INTEGER 列）：非数值 → `null`。 */
function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/** 0/1 归一（`required` 列）：SQLite 存 0/1，亦接受布尔与 `'1'` / `'true'`。 */
function toFlag(value) {
  if (value === true) return 1;
  if (typeof value === 'number') return value !== 0 ? 1 : 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true' ? 1 : 0;
  return 0;
}

/** `step_id` 归一：数字或字符串原样保留（自增主键为 INTEGER，测试可传字符串）；缺失 → `null`。 */
function toStepId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return null;
}

/**
 * 插入组件 → `inserted_component` 行（`payload` 序列化为 JSON TEXT）。
 *
 * **`step_id` 绑定关系随行落位**（需求 18.2、Property 12）：组件与所属工序的对应关系由
 * `step_id` 承载，序列化不得丢弃它——每个工序与其关联图片的对应关系正依赖此列。
 *
 * @param {object} component `{ id?, stepId|step_id, type, payload, sortOrder|sort_order }`
 * @returns {Readonly<{id: number|string|null, step_id: number|string|null, type: string|null,
 *                     payload: string|null, sort_order: number|null}>}
 * @throws {PayloadError} payload 含非 JSON 原生取值
 */
export function serializeComponent(component) {
  const source = component === null || typeof component !== 'object' ? {} : component;
  const id = pickField(source, ['id']);
  const type = pickField(source, ['type', 'component_type', 'componentType']);
  const normalizedType = typeof type === 'string' ? type : null;
  const rawPayload = pickField(source, ['payload']);
  return Object.freeze({
    id: id === undefined ? null : id,
    step_id: toStepId(pickField(source, ['stepId', 'step_id'])),
    type: normalizedType,
    payload: serializePayload(normalizedType === null ? rawPayload : normalizeComponentPayload(normalizedType, rawPayload)),
    sort_order: toIntegerOrNull(pickField(source, ['sortOrder', 'sort_order'])),
  });
}

/**
 * `inserted_component` 行 → 插入组件（`payload` 解析回对象），{@link serializeComponent} 的逆。
 *
 * 往返等价（Property 12）：`parseComponent(serializeComponent(c))` 与 `c` 在
 * `stepId` / `type` / `payload` / `sortOrder` 四者上等价——`payload` 的键顺序被稳定化，
 * 内容不变；`stepId` 绑定关系两次转换后保持不变。
 *
 * @param {object} row
 * @returns {Readonly<{id: number|string|null, stepId: number|string|null, type: string|null,
 *                     payload: unknown, sortOrder: number|null}>}
 * @throws {PayloadError} `payload` 列不是合法 JSON
 */
export function parseComponent(row) {
  const source = row === null || typeof row !== 'object' ? {} : row;
  const id = pickField(source, ['id']);
  const type = pickField(source, ['type', 'component_type', 'componentType']);
  const normalizedType = typeof type === 'string' ? type : null;
  const rawPayload = pickField(source, ['payload']);
  return Object.freeze({
    id: id === undefined ? null : id,
    stepId: toStepId(pickField(source, ['stepId', 'step_id'])),
    type: normalizedType,
    payload: normalizedType === null ? parsePayload(rawPayload) : normalizeComponentPayload(normalizedType, rawPayload),
    sortOrder: toIntegerOrNull(pickField(source, ['sortOrder', 'sort_order'])),
  });
}

/**
 * 数据采集项 → `capture_item` 行（`config` 序列化为 JSON TEXT）。
 *
 * `config` 的约定同 `inserted_component.payload`，`type` 与组件**共用同一类型定义**
 * （需求 12.2），故两者走同一序列化管道，仅列名不同。
 *
 * @param {object} item `{ id?, stepId|step_id, type, itemKey|item_key, label, config, required, sortOrder|sort_order }`
 * @returns {Readonly<object>} `capture_item` 行形状
 * @throws {PayloadError} config 含非 JSON 原生取值
 */
export function serializeCaptureItem(item) {
  const source = item === null || typeof item !== 'object' ? {} : item;
  const id = pickField(source, ['id']);
  const type = pickField(source, ['type', 'capture_type', 'captureType']);
  return Object.freeze({
    id: id === undefined ? null : id,
    step_id: toStepId(pickField(source, ['stepId', 'step_id'])),
    type: typeof type === 'string' ? type : null,
    item_key: toTextOrNull(pickField(source, ['itemKey', 'item_key'])),
    label: toTextOrNull(pickField(source, ['label'])),
    config: serializePayload(pickField(source, ['config', 'payload'])),
    required: toFlag(pickField(source, ['required'])),
    sort_order: toIntegerOrNull(pickField(source, ['sortOrder', 'sort_order'])),
  });
}

/**
 * `capture_item` 行 → 数据采集项（`config` 解析回对象），{@link serializeCaptureItem} 的逆。
 * 必填标记归一为 0/1（需求 12.3）。
 *
 * @param {object} row
 * @returns {Readonly<object>}
 * @throws {PayloadError} `config` 列不是合法 JSON
 */
export function parseCaptureItem(row) {
  const source = row === null || typeof row !== 'object' ? {} : row;
  const id = pickField(source, ['id']);
  const type = pickField(source, ['type', 'capture_type', 'captureType']);
  return Object.freeze({
    id: id === undefined ? null : id,
    stepId: toStepId(pickField(source, ['stepId', 'step_id'])),
    type: typeof type === 'string' ? type : null,
    itemKey: toTextOrNull(pickField(source, ['itemKey', 'item_key'])),
    label: toTextOrNull(pickField(source, ['label'])),
    config: parsePayload(pickField(source, ['config', 'payload'])),
    required: toFlag(pickField(source, ['required'])),
    sortOrder: toIntegerOrNull(pickField(source, ['sortOrder', 'sort_order'])),
  });
}
