/**
 * 释放时工序内容快照领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * ## 本模块存在的理由（不可弱化）
 *
 * `job_process.step_id` 直接引用**可变的**编制域模板行 `process_step`。若 JOB 的执行与呈现
 * 读模板当前内容，则后续对模板的任何修改都会**追溯性地改变历史 JOB 所呈现的作业内容**——
 * 违反需求 37.5（两域相互独立）、44.6（记录完整性）与 49.7，适航记录不可如此。
 * 因此释放时须对该次释放所含工序内容建立**不可变副本**（需求 49.5），JOB 只读该副本
 * （需求 49.6），`step_id` 仅作溯源（tasks.md 关键实现约束 4 / Property 34）。
 *
 * 由此推出两条硬性实现要求：
 *
 * 1. **真正的深拷贝**：快照不得与来源对象共享任何可变引用。来源 `steps` / `captureItems` /
 *    `components` / `sigReqs` 及其嵌套 `payload` / `config` / `visual_cue` 在建成快照**之后**
 *    被任意修改，已建成的快照内容必须逐字段不变（Property 34 断言此点）。
 *    实现手法：一切嵌套载荷经 `serializePayload` → `parsePayload` 往返，得到与来源无别名的
 *    新对象，并整体 `deepFreeze`——冻结让「误改快照」在开发期即暴露，而非静默污染。
 * 2. **确定性输出**：工序、采集项、组件、签署项均按稳定键排序，`serializePayload` 又保证
 *    对象键字典序落库，故同一内容的快照 JSON 恒唯一。Property 34 的逐字段比对因此可复现。
 *
 * ## `refDoc` 存 id 还是存解析后的文档？——存**解析后的内容**
 *
 * `process_step.ref_doc_id` 是指向 `reference_document` 的外键，而 `reference_document`
 * 同属编制域、同样可变（版本号 `doc_revision`、ATA 章节号都可被后续编辑）。若快照只存 id，
 * 则「后续编辑参考文件 → 历史 JOB 显示的参考文件版本随之变化」，与快照隔离的立意直接矛盾。
 * 故快照存**当时的文档内容**（`docType` / `refNo` / `docRevision` / `ataChapter`），并保留
 * `id` 仅作溯源。解析来源按序取：工序自带的 `refDoc` / `reference_document` 对象 →
 * `options.referenceDocuments` 按 `ref_doc_id` 查得 → 均无则退化为 `{id}` 占位并**不报错**
 * （工序允许不挂参考文件；调用方若给不出解析源，`refNo` 等为 `null` 是真实反映，不是静默失真）。
 *
 * ## 与既有模块的分工
 *
 * - 载荷序列化一律复用 `collections.js` 的 `serializePayload` / `parsePayload` /
 *   `parseCaptureItem` / `parseComponent`——快照内容与在线行走**同一条管道**，
 *   两处形态天然一致，不另造一套解析（否则 Property 12 与 Property 34 会各自为政）。
 * - 时间戳注入沿用 `change-record.js` 的 `options.timestamp` 房内约定：同一次释放的全部
 *   快照共享同一 `snapshotAt`（= 释放时间），缺省取当前时刻，便于测试完全控制输出。
 *
 * 需求：37.5、49.5、49.6、49.7
 */

import {
  parseCaptureItem,
  parseComponent,
  parsePayload,
  serializePayload,
} from './collections.js';

/** 快照 `content` 的字段顺序（design.md `job_step_snapshot.content` 定义，仅作契约声明与测试参照）。 */
export const SNAPSHOT_CONTENT_FIELDS = Object.freeze([
  'processId',
  'operation',
  'skill',
  'refDoc',
  'descriptionZh',
  'descriptionEn',
  'safetyWarning',
  'visualCue',
  'repairTips',
  'isCritical',
  'captureItems',
  'components',
  'signatureRequirements',
]);

/** 快照构建失败（缺少 `source_card_revision` 等 NOT NULL 前提）。服务层据此返回 500 / 400，不落库。 */
export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// =====================================================================
// 一、通用归一与深冻结
// =====================================================================

/** 取对象上第一个存在（非 `null` / `undefined`）的字段。 */
function pick(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** 文本归一：缺失 → `null`；其余转字符串（不 trim，保留编制时的原貌）。 */
function toTextOrNull(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/** 整数归一：缺失或非有限数 → `null`。 */
function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/**
 * 0/1 归一（`is_critical` / `stamp_required` / `date_required` 等 INTEGER 列）。
 * 保持 0/1 而不转布尔，是为与 SQLite 列取值形态一致——快照读回后与在线行可直接比对。
 */
function toFlag(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === 'number') return value !== 0 ? 1 : 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true' ? 1 : 0;
  return fallback;
}

/** id 归一：数字或字符串原样保留（自增主键为 INTEGER，测试可传字符串）；缺失 → `null`。 */
function toIdOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return null;
}

/** 分组键：id 可能为数字或字符串，统一以字符串为键，避免 `1` 与 `'1'` 分成两组。 */
function groupKey(value) {
  const id = toIdOrNull(value);
  return id === null ? null : String(id);
}

/**
 * 深冻结：快照建成即不可变。递归冻结数组与普通对象成员。
 *
 * 冻结不是装饰——`job_step_snapshot` 只写不改（无更新入口），运行时任何对快照对象的写入
 * 都是缺陷；冻结令其在开发期就抛错（严格模式）或静默失败，而不是留到审计时才被发现。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/**
 * 载荷深拷贝：经 `serializePayload` → `parsePayload` 往返，产出与来源**无别名**的新值，
 * 且对象键已稳定为字典序。
 *
 * 入参为 JSON TEXT（DB 行）时 `parsePayload` 本就产出新对象；入参已是对象（服务层内存态）时
 * `parsePayload` 会**幂等返回同一引用**（见 collections.js），若不再序列化一次即会与来源共享
 * 引用——那正是 Property 34 要防的那一类缺陷，故此处必须多走一趟序列化。
 *
 * @throws {import('./collections.js').PayloadError} 载荷含非 JSON 原生取值或文本非法 JSON
 */
function clonePayload(value) {
  const parsed = parsePayload(value);
  if (parsed === null || typeof parsed !== 'object') return parsed;
  return parsePayload(serializePayload(parsed));
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

/** 稳定比较：`null` 排在末位，其余按 (数值 | 文本) 升序。 */
function compareNullable(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** 按多个取值函数依次比较，构成稳定全序。 */
function compareBy(a, b, selectors) {
  for (const select of selectors) {
    const result = compareNullable(select(a), select(b));
    if (result !== 0) return result;
  }
  return 0;
}

// =====================================================================
// 二、子集合归一（采集项 / 组件 / 签署项 / 参考文件）
// =====================================================================

/**
 * 参考文件快照：存**当时的文档内容**（见文件头「存 id 还是存内容」）。
 * @param {unknown} doc
 * @returns {object|null}
 */
function snapshotReferenceDocument(doc) {
  if (doc === null || doc === undefined) return null;
  if (typeof doc !== 'object') {
    // 仅给到 ref_doc_id 标量：留 id 溯源，其余为 null（真实反映「解析源未提供」）
    return { id: toIdOrNull(doc), docType: null, refNo: null, docRevision: null, ataChapter: null };
  }
  return {
    id: toIdOrNull(pick(doc, ['id', 'refDocId', 'ref_doc_id'])),
    docType: toTextOrNull(pick(doc, ['docType', 'doc_type'])),
    refNo: toTextOrNull(pick(doc, ['refNo', 'ref_no'])),
    docRevision: toTextOrNull(pick(doc, ['docRevision', 'doc_revision', 'revision'])),
    ataChapter: toTextOrNull(pick(doc, ['ataChapter', 'ata_chapter'])),
  };
}

/** 采集项快照（复用 `parseCaptureItem`，`config` 另做深拷贝以断开别名）。 */
function snapshotCaptureItem(item) {
  const parsed = parseCaptureItem(item);
  return {
    id: parsed.id,
    type: parsed.type,
    itemKey: parsed.itemKey,
    label: parsed.label,
    config: clonePayload(parsed.config),
    required: parsed.required,
    sortOrder: parsed.sortOrder,
  };
}

/** 插入组件快照（复用 `parseComponent`，`payload` 另做深拷贝以断开别名）。 */
function snapshotComponent(component) {
  const parsed = parseComponent(component);
  return {
    id: parsed.id,
    type: parsed.type,
    payload: clonePayload(parsed.payload),
    sortOrder: parsed.sortOrder,
  };
}

/**
 * 签署项快照（`signature_requirement` 四个业务列）。
 * `dateRequired` 缺省为 1，与 `schema.sql` 的 `DEFAULT 1` 一致（需求 45）。
 */
function snapshotSignatureRequirement(requirement) {
  const source = requirement === null || typeof requirement !== 'object' ? {} : requirement;
  return {
    id: toIdOrNull(pick(source, ['id'])),
    signatureRole: toTextOrNull(pick(source, ['signatureRole', 'signature_role'])),
    stampRequired: toFlag(pick(source, ['stampRequired', 'stamp_required']), 0),
    dateRequired: toFlag(pick(source, ['dateRequired', 'date_required']), 1),
    sortOrder: toIntegerOrNull(pick(source, ['sortOrder', 'sort_order'])),
  };
}

/**
 * 按 `step_id` 归组。**归不到任何工序的条目一律丢弃**——它们属于别的工序或别的工卡，
 * 混入本次快照即等于把无关内容写进适航记录。
 */
function groupByStepId(list) {
  const groups = new Map();
  if (!Array.isArray(list)) return groups;
  for (const entry of list) {
    const key = groupKey(pick(entry, ['stepId', 'step_id']));
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

// =====================================================================
// 三、快照构建（主入口）
// =====================================================================

/**
 * 构建一次释放的全部工序内容快照（需求 49.5–49.7、37.5）。
 *
 * 产出的每个元素与 `job_step_snapshot` 行一一对应（除自增 `id` 与释放时才得知的
 * `job_process_id`，由发布服务在同一事务内回填）：
 * `{ sourceStepId, sourceCardRevision, snapshotAt, content }`，
 * `content` 形状见 {@link SNAPSHOT_CONTENT_FIELDS}。
 *
 * 输出**深度冻结**且与入参无共享引用：建成之后修改 `steps` / `captureItems` / `components` /
 * `sigReqs`（含其嵌套载荷）皆不影响已建成的快照（Property 34）。
 *
 * 输出顺序确定：工序按 `seq` → `processId` → `id` 升序；采集项与组件按 `sortOrder` →
 * (`itemKey` | `type`) → `id` 升序；签署项按 `sortOrder` → `signatureRole` → `id` 升序。
 *
 * @param {ReadonlyArray<object>|null|undefined} steps 本次释放所含工序模板行（`process_step`）
 * @param {ReadonlyArray<object>|null|undefined} captureItems 采集项行，按 `step_id` 归属工序
 * @param {ReadonlyArray<object>|null|undefined} components 插入组件行，按 `step_id` 归属工序
 * @param {ReadonlyArray<object>|null|undefined} sigReqs 签署项行，按 `step_id` 归属工序
 * @param {{sourceCardRevision?: number|string, card?: {revision?: number},
 *          timestamp?: Date|string|number,
 *          referenceDocuments?: ReadonlyArray<object>|Map<*, object>}} [options]
 *   `sourceCardRevision`（或 `card.revision`）为**必需**——列为 NOT NULL，缺失即抛
 *   {@link SnapshotError}，不容许写入无版本来源的快照；
 *   `timestamp` 为释放时间，同一次释放的全部快照共享；
 *   `referenceDocuments` 供 `ref_doc_id` → 文档内容解析（数组或以 id 为键的 Map）。
 * @returns {ReadonlyArray<Readonly<object>>} 深冻结的快照数组
 * @throws {SnapshotError} 缺少 `sourceCardRevision`
 * @throws {import('./collections.js').PayloadError} 某个载荷含非 JSON 原生取值或非法 JSON 文本
 */
export function buildStepSnapshots(steps, captureItems, components, sigReqs, options = {}) {
  const snapshotAt = normalizeTimestamp(options.timestamp);
  const refDocIndex = buildRefDocIndex(options.referenceDocuments);

  const stepRows = (Array.isArray(steps) ? [...steps] : []).filter(
    (step) => step !== null && typeof step === 'object',
  );
  stepRows.sort((a, b) =>
    compareBy(a, b, [
      (row) => toIntegerOrNull(pick(row, ['seq'])),
      (row) => toTextOrNull(pick(row, ['processId', 'process_id'])),
      (row) => toIdOrNull(pick(row, ['id'])),
    ]),
  );

  const captureGroups = groupByStepId(captureItems);
  const componentGroups = groupByStepId(components);
  const sigReqGroups = groupByStepId(sigReqs);

  const snapshots = stepRows.map((step) => {
    const stepId = toIdOrNull(pick(step, ['id', 'stepId', 'step_id']));
    const key = stepId === null ? null : String(stepId);

    const stepCaptureItems = (key === null ? [] : captureGroups.get(key) ?? [])
      .map(snapshotCaptureItem)
      .sort((a, b) => compareBy(a, b, [(x) => x.sortOrder, (x) => x.itemKey, (x) => x.id]));

    const stepComponents = (key === null ? [] : componentGroups.get(key) ?? [])
      .map(snapshotComponent)
      .sort((a, b) => compareBy(a, b, [(x) => x.sortOrder, (x) => x.type, (x) => x.id]));

    const stepSignatureRequirements = (key === null ? [] : sigReqGroups.get(key) ?? [])
      .map(snapshotSignatureRequirement)
      .sort((a, b) => compareBy(a, b, [(x) => x.sortOrder, (x) => x.signatureRole, (x) => x.id]));

    const content = {
      processId: toTextOrNull(pick(step, ['processId', 'process_id'])),
      operation: toTextOrNull(pick(step, ['operation'])),
      skill: toTextOrNull(pick(step, ['skill'])),
      refDoc: resolveRefDoc(step, refDocIndex),
      descriptionZh: toTextOrNull(pick(step, ['descriptionZh', 'description_zh'])),
      descriptionEn: toTextOrNull(pick(step, ['descriptionEn', 'description_en'])),
      safetyWarning: toTextOrNull(pick(step, ['safetyWarning', 'safety_warning'])),
      visualCue: clonePayload(pick(step, ['visualCue', 'visual_cue'])),
      repairTips: toTextOrNull(pick(step, ['repairTips', 'repair_tips'])),
      isCritical: toFlag(pick(step, ['isCritical', 'is_critical']), 0),
      captureItems: stepCaptureItems,
      components: stepComponents,
      signatureRequirements: stepSignatureRequirements,
    };

    return {
      sourceStepId: stepId,
      sourceCardRevision: resolveSourceCardRevision(step, options),
      snapshotAt,
      content,
    };
  });

  return deepFreeze(snapshots);
}

/** 参考文件解析索引：数组 → 以 id 为键的 Map；已是 Map 时按 id 归一化键。 */
function buildRefDocIndex(referenceDocuments) {
  const index = new Map();
  if (!referenceDocuments) return index;
  const entries =
    referenceDocuments instanceof Map
      ? [...referenceDocuments.values()]
      : Array.isArray(referenceDocuments)
        ? referenceDocuments
        : [];
  for (const doc of entries) {
    const key = groupKey(pick(doc, ['id']));
    if (key !== null) index.set(key, doc);
  }
  return index;
}

/**
 * 解析工序的参考文件快照，按序取：工序自带对象 → 索引按 `ref_doc_id` 查得 → `{id}` 占位。
 * 工序未挂参考文件时为 `null`（合法，`ref_doc_id` 可空）。
 */
function resolveRefDoc(step, refDocIndex) {
  const embedded = pick(step, ['refDoc', 'ref_doc', 'referenceDocument', 'reference_document']);
  if (embedded !== undefined && typeof embedded === 'object') {
    return snapshotReferenceDocument(embedded);
  }
  const refDocId = pick(step, ['refDocId', 'ref_doc_id']);
  if (refDocId === undefined) return embedded === undefined ? null : snapshotReferenceDocument(embedded);
  const resolved = refDocIndex.get(groupKey(refDocId));
  return snapshotReferenceDocument(resolved ?? refDocId);
}

/**
 * 解析快照的来源工卡版本号（`source_card_revision`，NOT NULL）。
 * 取值序：`options.sourceCardRevision` → `options.card.revision` → 工序行携带的 `cardRevision`。
 */
function resolveSourceCardRevision(step, options) {
  const candidate =
    options.sourceCardRevision ??
    (options.card === null || typeof options.card !== 'object'
      ? undefined
      : options.card.revision) ??
    pick(step, ['cardRevision', 'card_revision', 'sourceCardRevision', 'source_card_revision']);
  const revision = toIntegerOrNull(candidate);
  if (revision === null) {
    throw new SnapshotError(
      'source_card_revision 为必填（NOT NULL）：请在 options.sourceCardRevision 或 options.card.revision 中给出释放时的工卡版本号',
    );
  }
  return revision;
}

// =====================================================================
// 四、content 列往返（与在线行共用同一序列化管道）
// =====================================================================

/**
 * 快照 `content` → JSON TEXT（`job_step_snapshot.content` 列，NOT NULL）。
 *
 * 复用 `collections.js` 的稳定键序序列化，故同一内容的落库文本恒唯一，Property 34 的
 * 逐字段比对可退化为文本比对。
 *
 * @param {object} content {@link buildStepSnapshots} 产出的 `content`
 * @returns {string} JSON 文本
 * @throws {import('./collections.js').PayloadError} content 含非 JSON 原生取值
 */
export function serializeSnapshotContent(content) {
  const text = serializePayload(content ?? {});
  return text === null ? '{}' : text;
}

/**
 * JSON TEXT → 快照 `content`（{@link serializeSnapshotContent} 的逆），产出**深冻结**对象。
 * 已是对象时亦返回深冻结副本，便于服务层无差别使用。
 *
 * @param {unknown} text
 * @returns {Readonly<object>}
 * @throws {import('./collections.js').PayloadError} 文本不是合法 JSON
 */
export function parseSnapshotContent(text) {
  const parsed = clonePayload(text);
  return deepFreeze(parsed === null ? {} : parsed);
}

/**
 * 快照对象 → `job_step_snapshot` 行（`content` 序列化为 JSON TEXT）。
 *
 * `jobProcessId` 由发布服务在写入 `job_process` 后回填——快照与 JOB 工序实例一对一
 * （`UNIQUE(job_process_id)`），故此列必须由调用方给出。
 *
 * @param {object} snapshot {@link buildStepSnapshots} 的单个元素
 * @param {number|string} jobProcessId 对应的 `job_process.id`
 * @returns {Readonly<{job_process_id: number|string, source_step_id: number|string|null,
 *                     source_card_revision: number, content: string, snapshot_at: string}>}
 */
export function serializeStepSnapshot(snapshot, jobProcessId) {
  const source = snapshot === null || typeof snapshot !== 'object' ? {} : snapshot;
  return Object.freeze({
    job_process_id: toIdOrNull(jobProcessId),
    source_step_id: toIdOrNull(source.sourceStepId ?? source.source_step_id),
    source_card_revision: resolveSourceCardRevision(null, {
      sourceCardRevision: source.sourceCardRevision ?? source.source_card_revision,
    }),
    content: serializeSnapshotContent(source.content),
    snapshot_at: toTextOrNull(source.snapshotAt ?? source.snapshot_at),
  });
}
