/**
 * 工卡关联领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载需求 21 的四件事，产出物与 `card_relation` 表逐列对应，服务层（任务 13.11）可直接落库：
 *
 * 1. **建立关联**（需求 21.1、21.3）：{@link buildRelation} 产出 `card_relation` 行，
 *    `exec_doc_type` 限于 11 类执行过程单据类型（需求 16.2），越界即抛错。
 * 2. **执行期自动关联**（需求 21.4）：执行过程产生 Process Card / Condition Report /
 *    Technique Sheet 等衍生单据时，`origin` 恒为 `'auto'`——**不需要人工关联动作**，
 *    调用方连 `origin` 实参都不必给，见 {@link defaultRelationOrigin}。
 * 3. **关键信息同步**（需求 21.5）：{@link syncRelationKeyInfo} 以来源当前值刷新
 *    `key_info_snapshot`（机型 / 件号 / 序列号 / 工卡编号）。
 * 4. **要求签署的单据类型集合**（需求 16.4、16.5、45.8、45.9）：{@link requiredSignDocTypes}
 *    是 `review.js` 的 `submitReviewChecklist` 校验项 (f) 的**唯一数据来源**。
 *
 * ── ⚠ 签署要求属性的运行时权威是 `exec_doc_type` 表，不是 `enums.js` 的常量 ──────
 * `EXEC_DOC_SIGN_RULE` 只是 `exec_doc_type.sign_rule` 的**种子默认值**（见 `enums.js` 头注）。
 * 故 {@link requiredSignDocTypes} 必须接受配置入参 `signRuleCfg`（即该表的行集合），仅在
 * 调用方完全不传时才回落至种子常量。业务方调整某类型的签署要求只需改表，无须改本模块。
 *
 * ── ⚠ 「签署」判定必须**精确相等**，不可用 `includes('签署')` ────────────────────
 * SC 的取值是 `'单据不签署，所发工卡步骤需签署'`（需求 16.5），**字面包含**「签署」二字。
 * 若以子串匹配判定，SC 会被误判为要求签署的单据，使需求 16.5「单据本身不签署」被反向执行，
 * 并让工卡在提交审核时被错误阻止（需求 45.9）。本模块一律用 `=== SIGN_RULE_REQUIRED`。
 *
 * ── 集合增删为何也在本模块 ───────────────────────────────────────
 * Property 33 断言「新增后可查得、删除后不再查得且其它关联不受影响、三元组不重复」。
 * 这三句需要一处可断言的纯函数落位，故本模块在三个关键函数之外提供
 * {@link addRelation} / {@link removeRelation} / {@link hasRelation} / {@link relationKey}，
 * 手法与 `collections.js` 的参考文件三件套一致（design.md 的函数表只列各模块*关键函数*）。
 * 三元组唯一性在 DB 侧由 `UNIQUE(card_id, exec_doc_type, related_doc_no)` 兜底，
 * 本模块的 {@link addRelation} 则在内存集合层面保证同键不重复入列。
 *
 * 需求：16.4、16.5、21.1–21.5、45.8、45.9
 */

import { EXEC_DOC_TYPE, EXEC_DOC_SIGN_RULE } from './enums.js';
import { serializePayload, parsePayload } from './collections.js';

/** 关联建立来源，与 `card_relation.origin` 的 CHECK 取值集一致（需求 21.1、21.4） */
export const RELATION_ORIGIN = Object.freeze({
  /** 编制期由 TS_Engineer 人工建立（需求 21.1） */
  MANUAL: 'manual',
  /** 执行期由服务层自动建立，无人工动作（需求 21.4） */
  AUTO: 'auto',
});

/** `origin` 的封闭取值集 */
export const RELATION_ORIGINS = Object.freeze([RELATION_ORIGIN.MANUAL, RELATION_ORIGIN.AUTO]);

/**
 * 执行期衍生单据类型（需求 21.4 明列：Process Card、Condition Report、Technique Sheet「等」）。
 *
 * 这三类单据是执行过程的产物，其与来源 Task Card 的关联**由系统自动建立**，故
 * {@link defaultRelationOrigin} 对它们默认给出 `'auto'`。
 * 「等」字留下的口子由 `job_id` 补齐：任何携带 JOB 归属的单据都产生于执行期，同样默认 `'auto'`。
 *
 * ⚠ 这只是**默认值推断**：需求 21.3 允许工卡与全部 11 类单据建立关联，编制期人工关联一张
 * PC 完全合法——此时调用方显式传 `'manual'` 即可覆盖，显式实参恒优先。
 */
export const EXEC_PERIOD_DERIVED_DOC_TYPES = Object.freeze(['PC', 'CR', 'TS']);

/** 要求签署的签署要求属性取值（需求 16.4）。SC 的取值不等于此值，见模块头注。 */
export const SIGN_RULE_REQUIRED = '签署';

/**
 * 关键信息快照（`key_info_snapshot`）的四个字段（需求 21.5）。
 * 键为快照内的 camelCase 字段名，值为其在来源行上的候选列名（按优先级排列）。
 *
 * ⚠ 件号与序列号**不在 `task_card` 上**：它们是 `job` 的 `part_no` / `part_sn`
 * （Process Card 四字段，需求 27.1）与进厂起落架件号/序列号 `inbound_gear_pn` / `inbound_sn`
 * （需求 26.1）。故候选列名同时覆盖工卡、JOB 与服务层拼装的 camelCase 视图三种来源形态。
 */
export const KEY_INFO_FIELDS = Object.freeze({
  acType: Object.freeze(['acType', 'ac_type']),
  partNo: Object.freeze(['partNo', 'part_no', 'partNumber', 'part_number', 'inboundGearPn', 'inbound_gear_pn']),
  serialNo: Object.freeze(['serialNo', 'serial_no', 'partSn', 'part_sn', 'inboundSn', 'inbound_sn', 'sn']),
  taskNo: Object.freeze(['taskNo', 'task_no']),
});

/** 快照字段的固定顺序（序列化后键序稳定，便于比对与去重） */
const KEY_INFO_NAMES = Object.freeze(Object.keys(KEY_INFO_FIELDS));

/** `key_info_snapshot` 列在关联行上的两种键名形态（DB 行 / 服务层视图） */
const SNAPSHOT_KEYS = Object.freeze(['key_info_snapshot', 'keyInfoSnapshot']);

/** 取对象上第一个存在（非 `undefined`）的键值；全不存在返回 `undefined`。 */
function pickDefined(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

/** 取对象上第一个有值（非 `null` / `undefined`）的键值；全无返回 `undefined`。 */
function pickValued(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * 文本归一：去首尾空白后为空（含 `null` / 纯空白 / 非文本取值）一律 `null`；
 * 有限数字与 bigint 转字符串——编号类字段在 JSON 往返中可能退化为数字。
 */
function text(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/** 主键归一：有限整数原样，其余走文本归一（尚未落库或测试传字符串 id 时仍可用）。 */
function identity(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return text(value);
}

/** 时间戳归一：`Date` / ISO 字符串 / 毫秒数均可；缺省取当前时刻（与 `change-record.js` 一致）。 */
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

/** 是否为可读字段的普通对象（数组不算——数组无业务字段可读）。 */
function isRow(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// =====================================================================
// 一、关键信息快照（需求 21.5）
// =====================================================================

/**
 * 从若干来源行中提取关键信息（需求 21.5：机型、件号、序列号、工卡编号）。
 *
 * 逐字段按 `sources` 的**给定顺序**取第一个有值者：靠前的来源优先。典型调用为
 * `extractKeyInfo(options.keyInfo, card, doc)`——显式传入的关键信息优先于工卡，
 * 工卡又优先于单据/JOB 行。各来源的键名兼容 camelCase 与 snake_case，见 {@link KEY_INFO_FIELDS}。
 *
 * @param {...unknown} sources 来源行（工卡 / JOB / 单据 / 已拼装的关键信息对象），非对象项忽略
 * @returns {Readonly<{acType: string|null, partNo: string|null, serialNo: string|null, taskNo: string|null}>}
 *   四个字段恒存在，缺值为 `null`（保留全部键使快照可逐字段比对）
 */
export function extractKeyInfo(...sources) {
  const rows = sources.filter(isRow);
  const info = {};
  for (const name of KEY_INFO_NAMES) {
    const aliases = KEY_INFO_FIELDS[name];
    let value = null;
    for (const row of rows) {
      const candidate = text(pickValued(row, aliases));
      if (candidate !== null) {
        value = candidate;
        break;
      }
    }
    info[name] = value;
  }
  return Object.freeze(info);
}

/**
 * 关键信息 → `key_info_snapshot` 列取值（JSON TEXT）。
 *
 * 复用 `collections.js` 的稳定序列化：键按字典序排列，故同一关键信息的落库文本唯一，
 * 「快照是否与来源当前值一致」可直接以字符串比较判定（Property 33）。
 *
 * @param {unknown} keyInfo 关键信息对象或任意来源行（内部走 {@link extractKeyInfo} 归一）
 * @returns {string} JSON 文本（四个键恒在，缺值为 `null`）
 */
export function serializeKeyInfo(keyInfo) {
  return serializePayload(extractKeyInfo(keyInfo));
}

/**
 * 读取关联记录的关键信息快照（{@link serializeKeyInfo} 的逆）。
 *
 * 兼容三种承载形态：JSON 文本（DB 直读）、已解析对象（服务层）、空列（NULL / 空串）。
 * 空列返回四个字段皆 `null` 的对象，而非 `null`——调用方无需分支即可逐字段比对。
 *
 * @param {unknown} relation 关联行（读 `key_info_snapshot` / `keyInfoSnapshot`），亦可直接传快照取值
 * @returns {Readonly<{acType: string|null, partNo: string|null, serialNo: string|null, taskNo: string|null}>}
 */
export function readKeyInfoSnapshot(relation) {
  const raw = isRow(relation) && pickDefined(relation, SNAPSHOT_KEYS) !== undefined
    ? pickDefined(relation, SNAPSHOT_KEYS)
    : relation;
  const parsed = parsePayload(raw === undefined ? null : raw);
  return extractKeyInfo(parsed);
}

/**
 * 关键信息变更同步至关联记录（需求 21.5）。
 *
 * 返回**新的**关联行，入参 `relation` 不被修改（服务层依赖「校验失败即无副作用」）：
 * 除 `key_info_snapshot` 外逐字段原样保留，快照键名沿用原行的写法
 * （`key_info_snapshot` / `keyInfoSnapshot`，两者皆无时按 DB 列名写 `key_info_snapshot`）。
 *
 * **合并语义**（而非整体覆盖）：`keyInfo` 中**出现**的字段覆盖快照对应字段（显式 `null`
 * 即清空），**未出现**的字段保留快照原值。理由：需求 21.5 的触发点是「某项关键信息发生变更」，
 * 调用方常只带来变更的那一项；整体覆盖会把未提及的三项误清为 `null`。
 * 传入完整的来源当前值时，合并结果即等于来源当前值——Property 33 的「快照恒与来源当前值一致」
 * 因此成立。
 *
 * @param {object} relation 关联行（`card_relation` 行或等价对象）
 * @param {object} keyInfo 变更后的关键信息，或任意携带关键信息的来源行（工卡 / JOB）
 * @returns {Readonly<object>} 刷新了快照的新关联行（冻结）
 * @throws {TypeError} `relation` 或 `keyInfo` 非对象
 */
export function syncRelationKeyInfo(relation, keyInfo) {
  if (!isRow(relation)) {
    throw new TypeError('syncRelationKeyInfo：relation 须为 card_relation 行对象');
  }
  if (!isRow(keyInfo)) {
    throw new TypeError('syncRelationKeyInfo：keyInfo 须为关键信息对象或携带关键信息的来源行');
  }

  const previous = readKeyInfoSnapshot(relation);
  const merged = {};
  for (const name of KEY_INFO_NAMES) {
    // 「出现」= 该字段的任一别名键在 keyInfo 上存在且不为 undefined（显式 null 视为清空）
    const provided = pickDefined(keyInfo, KEY_INFO_FIELDS[name]);
    merged[name] = provided === undefined ? previous[name] : text(provided);
  }

  const snapshotKey = SNAPSHOT_KEYS.find((key) => relation[key] !== undefined) ?? SNAPSHOT_KEYS[0];
  return Object.freeze({ ...relation, [snapshotKey]: serializePayload(merged) });
}

// =====================================================================
// 二、建立关联（需求 21.1、21.3、21.4）
// =====================================================================

/**
 * 单据是否为执行期衍生单据（需求 21.4）：类型属 {@link EXEC_PERIOD_DERIVED_DOC_TYPES}，
 * 或携带 JOB 归属（`job_id`）——后者涵盖需求 21.4 的「等」字未穷举的类型。
 *
 * @param {unknown} doc 单据行（或单据类型码字符串）
 * @returns {boolean}
 */
export function isExecPeriodDerivedDoc(doc) {
  if (typeof doc === 'string') return EXEC_PERIOD_DERIVED_DOC_TYPES.includes(doc.trim());
  if (!isRow(doc)) return false;
  const docType = text(pickValued(doc, ['execDocType', 'exec_doc_type', 'docType', 'doc_type', 'type']));
  if (docType !== null && EXEC_PERIOD_DERIVED_DOC_TYPES.includes(docType)) return true;
  return identity(pickValued(doc, ['jobId', 'job_id'])) !== null;
}

/**
 * 关联来源的默认取值（需求 21.4）：执行期衍生单据 → `'auto'`，其余 → `'manual'`。
 *
 * 这是「**无需人工关联动作**」的落实方式：服务层在执行期产生 PC / CR / TS 时直接
 * `buildRelation(card, doc)`，不传 `origin` 即得 `'auto'`，无处需要人工介入。
 *
 * @param {unknown} doc 单据行或单据类型码
 * @returns {'manual'|'auto'}
 */
export function defaultRelationOrigin(doc) {
  return isExecPeriodDerivedDoc(doc) ? RELATION_ORIGIN.AUTO : RELATION_ORIGIN.MANUAL;
}

/** 归一化 `origin`：大小写与首尾空白容错；缺省（`null`/`undefined`）返回 `undefined` 交默认推断。 */
function normalizeOrigin(origin) {
  if (origin === null || origin === undefined) return undefined;
  const value = typeof origin === 'string' ? origin.trim().toLowerCase() : null;
  return RELATION_ORIGINS.includes(value) ? value : null;
}

/**
 * 建立工卡关联记录（需求 21.1、21.3、21.4）。
 *
 * 产出行与 `card_relation` 表列一一对应（除自增 `id`）：
 * `{ card_id, exec_doc_type, related_doc_no, job_id, origin, key_info_snapshot, created_by, created_at }`，
 * 仓储层可直接落库，无需二次拼装。
 *
 * - `exec_doc_type` 取自单据，须属 11 类执行过程单据类型（需求 16.2、21.3），否则抛错——
 *   `card_relation.exec_doc_type` 有 `CHECK` 约束，越界值本就无法落库，提前抛错定位更准。
 * - `origin` 显式实参优先；缺省时按 {@link defaultRelationOrigin} 推断（需求 21.4）。
 * - `job_id` 取 `options.jobId`，缺省回落至单据自带的 `job_id`；编制期人工关联通常为 `null`。
 *   **本函数不强制** `manual ⇒ job_id === null`：需求未禁止在 JOB 上下文中人工补建关联。
 * - `key_info_snapshot` 由 `options.keyInfo` → 工卡 → 单据逐字段取值（需求 21.5 的初始快照），
 *   后续来源变更走 {@link syncRelationKeyInfo}。
 *
 * ⚠ **三元组唯一性不在此校验**（本函数为纯函数，无库可查）：需求 21.1 的「同一
 * `(card, exec_doc_type, related_doc_no)` 不重复」由 {@link addRelation} 在内存集合层面保证，
 * DB 侧 `UNIQUE(card_id, exec_doc_type, related_doc_no)` 为最后防线。
 *
 * @param {object|number|string} card 工卡行（读 `id`）；亦可直接传工卡主键
 * @param {object} doc 关联单据（读 `exec_doc_type`/`execDocType` 与
 *   `doc_no`/`docNo`/`related_doc_no`/`relatedDocNo`，可选 `job_id`）
 * @param {'manual'|'auto'} [origin] 关联来源；缺省按单据推断（需求 21.4）
 * @param {{keyInfo?: object, jobId?: number|string|null, createdBy?: string,
 *   createdAt?: Date|string|number}} [options]
 * @returns {Readonly<{card_id: number|string, exec_doc_type: string, related_doc_no: string,
 *   job_id: number|string|null, origin: 'manual'|'auto', key_info_snapshot: string,
 *   created_by: string|null, created_at: string}>} 冻结的 `card_relation` 行
 * @throws {TypeError} 工卡主键缺失、单据非对象、单据类型越界或缺失、单据编号为空、`origin` 非法
 */
export function buildRelation(card, doc, origin, options = {}) {
  const cardId = identity(isRow(card) ? pickValued(card, ['id', 'cardId', 'card_id']) : card);
  if (cardId === null) {
    throw new TypeError('buildRelation：取不到工卡主键（card_relation.card_id 为 NOT NULL）');
  }
  if (!isRow(doc)) {
    throw new TypeError('buildRelation：doc 须为关联单据对象（含单据类型与单据编号）');
  }

  const docType = text(pickValued(doc, ['execDocType', 'exec_doc_type', 'docType', 'doc_type', 'type']));
  if (docType === null || !EXEC_DOC_TYPE.includes(docType)) {
    throw new TypeError(
      `buildRelation：单据类型 ${String(docType)} 不属 11 类执行过程单据类型（需求 16.2、21.3）`,
    );
  }

  const docNo = text(pickValued(doc, ['relatedDocNo', 'related_doc_no', 'docNo', 'doc_no']));
  if (docNo === null) {
    throw new TypeError('buildRelation：关联单据编号不可为空（card_relation.related_doc_no 为 NOT NULL）');
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (normalizedOrigin === null) {
    throw new TypeError(
      `buildRelation：origin 须为 ${RELATION_ORIGINS.join(' / ')}，收到 ${String(origin)}`,
    );
  }

  const jobId = identity(
    options.jobId !== undefined ? options.jobId : pickValued(doc, ['jobId', 'job_id']),
  );

  return Object.freeze({
    card_id: cardId,
    exec_doc_type: docType,
    related_doc_no: docNo,
    job_id: jobId,
    // 需求 21.4：执行期衍生单据无人工动作，缺省即 'auto'
    origin: normalizedOrigin ?? defaultRelationOrigin(doc),
    // 需求 21.5：初始快照按 keyInfo → 工卡 → 单据的优先级取值
    key_info_snapshot: serializePayload(extractKeyInfo(options.keyInfo, card, doc)),
    created_by: text(options.createdBy),
    created_at: normalizeTimestamp(options.createdAt),
  });
}

// =====================================================================
// 三、关联集合增删查（需求 21.1、21.2，Property 33）
// =====================================================================

/**
 * 关联记录的身份键 = `(card_id, exec_doc_type, related_doc_no)` 三元组，
 * 与 `card_relation` 的 `UNIQUE` 约束**同维度**（需求 21.1）。
 *
 * 刻意**不以 `id` 为身份**：三元组才是业务唯一性，未落库的关联没有 `id`，
 * 而「同一工卡不得重复关联同一单据」在落库前就应成立。
 *
 * @param {unknown} relation 关联行（camelCase / snake_case 皆可）
 * @returns {string}
 */
export function relationKey(relation) {
  const source = isRow(relation) ? relation : {};
  const cardId = identity(pickValued(source, ['cardId', 'card_id']));
  const docType = text(pickValued(source, ['execDocType', 'exec_doc_type']));
  const docNo = text(pickValued(source, ['relatedDocNo', 'related_doc_no', 'docNo', 'doc_no']));
  return `${String(cardId)}|${String(docType)}|${String(docNo)}`;
}

/**
 * 关联集合中是否已存在该关联（需求 21.2：从一张 Task Card 查看其关联单据）。
 * @param {unknown} relations 关联集合；非数组视为空集
 * @param {unknown} target 关联行或其身份键
 * @returns {boolean}
 */
export function hasRelation(relations, target) {
  if (!Array.isArray(relations)) return false;
  const key = typeof target === 'string' ? target : relationKey(target);
  return relations.some((item) => relationKey(item) === key);
}

/**
 * 新增关联（需求 21.1）：返回追加于末尾的新集合，**入参集合不变**。
 *
 * 三元组已存在时**不重复入列**（需求 21.1、Property 33「三元组不重复」），并以
 * `added: false` 告知调用方——服务层据此返回「该单据已关联」而非撞 `UNIQUE` 抛 500。
 * 已存在时保留**原有**记录（不以新记录覆盖）：原记录承载着最初的建立人/时间与 `origin`，
 * 重复的建立动作不应改写这些审计信息。关键信息变更请走 {@link syncRelationKeyInfo}。
 *
 * @param {readonly object[]|null|undefined} relations 原集合
 * @param {object} relation 待新增关联（通常来自 {@link buildRelation}）
 * @returns {Readonly<{relations: readonly object[], added: boolean}>}
 */
export function addRelation(relations, relation) {
  const base = Array.isArray(relations) ? relations : [];
  if (hasRelation(base, relation)) {
    return Object.freeze({ relations: Object.freeze([...base]), added: false });
  }
  return Object.freeze({ relations: Object.freeze([...base, relation]), added: true });
}

/**
 * 删除关联：返回移除后的新集合，**其余关联原值原序保留**（Property 33「其它关联不受影响」）。
 *
 * 同三元组的条目全部移除；`removed` 给出实际移除条数，服务层可据此判断「待删关联不存在」。
 *
 * @param {readonly object[]|null|undefined} relations 原集合
 * @param {unknown} target 关联行或其身份键
 * @returns {Readonly<{relations: readonly object[], removed: number}>}
 */
export function removeRelation(relations, target) {
  const base = Array.isArray(relations) ? relations : [];
  const key = typeof target === 'string' ? target : relationKey(target);
  const kept = base.filter((item) => relationKey(item) !== key);
  return Object.freeze({
    relations: Object.freeze(kept),
    removed: base.length - kept.length,
  });
}

/**
 * 某张工卡的关联集合（需求 21.2）：按 `card_id` 过滤，保持原顺序。
 * @param {readonly object[]|null|undefined} relations
 * @param {object|number|string} card 工卡行或工卡主键
 * @returns {readonly object[]}
 */
export function relationsOfCard(relations, card) {
  if (!Array.isArray(relations)) return Object.freeze([]);
  const cardId = identity(isRow(card) ? pickValued(card, ['id', 'cardId', 'card_id']) : card);
  if (cardId === null) return Object.freeze([]);
  const key = String(cardId);
  return Object.freeze(
    relations.filter((item) => {
      const itemCardId = identity(pickValued(isRow(item) ? item : {}, ['cardId', 'card_id']));
      return itemCardId !== null && String(itemCardId) === key;
    }),
  );
}

// =====================================================================
// 四、要求签署的单据类型集合（需求 16.4、16.5、45.8、45.9）
// =====================================================================

/**
 * 把 `signRuleCfg` 归一为 `类型码 → sign_rule` 的查表函数。
 *
 * 接受四种形态，皆为运行时真实会遇到的：
 * - `exec_doc_type` 表行数组：`[{ code, sign_rule }]`（`GET` 配置的直读形态，**权威**）；
 * - 普通对象映射：`{ CR: '签署', … }`（`EXEC_DOC_SIGN_RULE` 的形态）；
 * - `Map`；
 * - `null` / `undefined`：回落至 `EXEC_DOC_SIGN_RULE` **种子默认值**（见模块头注的权威说明）。
 *
 * 未在配置中登记的类型 → `undefined`，即**不视为**要求签署：需求 45.8 的判定以 sign_rule 为
 * 依据，无配置即无依据，宁可不阻止提交，也不凭空要求签署项。
 */
function signRuleLookup(signRuleCfg) {
  if (signRuleCfg === null || signRuleCfg === undefined) {
    return (code) => EXEC_DOC_SIGN_RULE[code];
  }
  if (signRuleCfg instanceof Map) {
    return (code) => signRuleCfg.get(code);
  }
  if (Array.isArray(signRuleCfg)) {
    const map = new Map();
    for (const row of signRuleCfg) {
      if (!isRow(row)) continue;
      const code = text(pickValued(row, ['code', 'execDocType', 'exec_doc_type']));
      if (code === null) continue;
      const rule = pickValued(row, ['signRule', 'sign_rule']);
      map.set(code, typeof rule === 'string' ? rule.trim() : rule);
    }
    return (code) => map.get(code);
  }
  if (isRow(signRuleCfg)) {
    return (code) => {
      const rule = signRuleCfg[code];
      return typeof rule === 'string' ? rule.trim() : rule;
    };
  }
  throw new TypeError('requiredSignDocTypes：signRuleCfg 须为 exec_doc_type 行数组、映射对象或 Map');
}

/**
 * 关联单据中**要求签署**的类型集合（需求 16.4、45.8、45.9）——
 * `review.js` 的 `submitReviewChecklist` 校验项 (f) 的数据来源。
 *
 * 判定 = 该类型在 `exec_doc_type` 配置中的 `sign_rule` **精确等于**「签署」。
 * 故 SC 恒不入选（需求 16.5：单据本身不签署，其所发工卡步骤需签署），
 * 见模块头注「不可用子串匹配」。
 *
 * 返回值按 `EXEC_DOC_TYPE` 的**规范顺序**去重排列（不随关联入参顺序抖动），
 * 便于逐项比对与提示信息拼装；集合语义下顺序无关，确定性只为可复现。
 *
 * @param {readonly object[]|null|undefined} relations 关联集合（`card_relation` 行，
 *   已由调用方筛至目标工卡；亦可直接传类型码字符串数组）
 * @param {ReadonlyArray<object>|Record<string,string>|Map<string,string>|null} [signRuleCfg]
 *   `exec_doc_type` 表行集合或等价映射；缺省回落至种子常量 `EXEC_DOC_SIGN_RULE`
 * @returns {readonly string[]} 冻结的类型码数组（去重，规范顺序）
 * @throws {TypeError} `signRuleCfg` 形态非法
 */
export function requiredSignDocTypes(relations, signRuleCfg) {
  const lookup = signRuleLookup(signRuleCfg);
  const rows = Array.isArray(relations) ? relations : [];

  const present = new Set();
  for (const item of rows) {
    const code = typeof item === 'string'
      ? text(item)
      : text(pickValued(isRow(item) ? item : {}, ['execDocType', 'exec_doc_type']));
    if (code === null) continue;
    present.add(code);
  }

  const required = EXEC_DOC_TYPE.filter(
    (code) => present.has(code) && lookup(code) === SIGN_RULE_REQUIRED,
  );
  return Object.freeze(required);
}
