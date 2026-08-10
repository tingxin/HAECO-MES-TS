/**
 * 工卡基础规则领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 本文件当前承载任务 5.1 的三项规则：
 * - `canTransition(from, to)`  状态迁移合法性（依 `ALLOWED_TRANSITIONS` 五态，Superseded/Void 无出边）
 * - `isEditable(card)`         编制域内容可编辑态判定：仅 `status === 'New'`
 * - `canRelease(card)`         发布前置：`status === 'Effective'`
 *
 * 任务 5.2 追加（见本文件下半部分）：
 * - `nextRevision(card, manualRevision?)` / `reviseCard(card, manualRevision?)`
 * - `copyCard(card, newTaskNo)`
 * - `checkDuplicate(cards, taskNo, revision, excludeId)`
 * - `requiresBomFields(card)`
 *
 * 任务 5.3 追加（见本文件末尾）：
 * - `printProjection(card, template, jobContext?)`
 *
 * 需求：4.1–4.3、4.5–4.7、24.1、24.2、34.3、44.4、44.5、49.1、49.2、49.4、49.8
 *   （任务 5.2 追加部分另涉 3.3、3.4、6.8、7.1、7.5、8.1–8.3、10.4、10.5、38.1–38.6；
 *   任务 5.3 追加部分另涉 5.2、5.3、16.3、33.9、45.7）
 */

import { CARD_STATUS, ALLOWED_TRANSITIONS } from './enums.js';
import { IR_CARD_TYPE } from './bom.js';
import { aggregateSignatureRequirements } from './signature.js';
import { formatRevision } from './export-fields.js';
import { parsePayload, normalizeReferenceDocument } from './collections.js';

/** 唯一可编辑状态（需求 49.1） */
const STATUS_NEW = 'New';
/** 唯一可发布状态（需求 24.2） */
const STATUS_EFFECTIVE = 'Effective';

/**
 * 取工卡状态。接受工卡对象（`{ status }`，兼容 snake_case 的 `card_status`）
 * 或直接传入状态字符串；取不到合法状态时返回 `null`。
 * @param {unknown} card
 * @returns {string | null}
 */
export function statusOf(card) {
  if (typeof card === 'string') {
    return CARD_STATUS.includes(card) ? card : null;
  }
  if (card === null || typeof card !== 'object') return null;
  const raw = card.status ?? card.card_status ?? card.cardStatus;
  return typeof raw === 'string' && CARD_STATUS.includes(raw) ? raw : null;
}

/**
 * 状态迁移合法性（需求 4.5–4.7）。
 *
 * 为真当且仅当 `to ∈ ALLOWED_TRANSITIONS[from]`。`Superseded` 与 `Void` 为终态，
 * 出边集合为空，故由其迁出恒为假；`from` / `to` 不属于五态值域时亦为假
 * （未知状态不构成合法迁移，拒绝优于放行）。
 *
 * @param {unknown} from 迁移前状态
 * @param {unknown} to 迁移后状态
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  const outgoing = Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, from)
    ? ALLOWED_TRANSITIONS[from]
    : null;
  if (outgoing === null) return false;
  return outgoing.includes(to);
}

/**
 * 编制域内容可编辑态判定（需求 49.1、49.2）。
 *
 * 仅「新增(New)」可编辑；「审核中」「生效」「已被取代」「作废」四态一律冻结
 * （需求 34.3、44.4、44.5 为本判定在各自路径上的特例）。生效态内容变更须先升版（需求 49.3）。
 *
 * ⚠ 本判定仅约束**编制域内容变更**。需求 49.8 列举的非内容变更操作
 * （查看/打印/导出/复制/升版/作废/发布）不受其约束，见 {@link passesEditableGate}。
 *
 * @param {unknown} card 工卡对象或状态字符串
 * @returns {boolean}
 */
export function isEditable(card) {
  return statusOf(card) === STATUS_NEW;
}

/**
 * 发布至工包系统的前置条件（需求 24.1、24.2）：`status === 'Effective'`。
 * @param {unknown} card 工卡对象或状态字符串
 * @returns {boolean}
 */
export function canRelease(card) {
  return statusOf(card) === STATUS_EFFECTIVE;
}

/**
 * 编制域**内容变更**操作词表（需求 49.4）——受 `isEditable` 闸门约束的全部编辑入口。
 * 服务层新增编辑入口时须在此登记，否则 {@link passesEditableGate} 按未知操作从严处理。
 */
export const CONTENT_EDIT_OPERATIONS = Object.freeze([
  'cardSave',                 // 工卡保存（元数据）
  'stepCreate',               // 工序新增
  'stepUpdate',               // 工序修改
  'stepDelete',               // 工序删除
  'stepReorder',              // 工序排序
  'referenceDocAdd',          // 参考文件新增
  'referenceDocDelete',       // 参考文件删除
  'captureItemWrite',         // 数据采集项增删改
  'componentWrite',           // 插入组件增删改
  'signatureRequirementWrite',// 签署项配置增删
  'relationWrite',            // 工卡关联增删
  'batchReplace',             // 批量替换（需求 20.3 为本约束的特例）
]);

/**
 * **非内容变更**操作词表（需求 49.8）——生效态必须放行，不得被编辑态闸门误拦。
 * 各操作自身的状态前置由其专属谓词负责（如发布见 {@link canRelease}、
 * 作废前置见 `void-rules.js`），本模块不在此重复判定。
 */
export const NON_CONTENT_OPERATIONS = Object.freeze([
  'view',     // 查看
  'print',    // 打印
  'export',   // 导出
  'copy',     // 复制
  'revise',   // 升版
  'void',     // 作废
  'release',  // 发布至工包
]);

/**
 * 操作是否属于编制域内容变更。
 *
 * 未登记的操作**视为内容变更**（返回 `true`）：适航记录不可被绕过修改，
 * 漏拦的代价高于误拦，故未知入口从严处理。
 *
 * @param {unknown} operation 操作标识
 * @returns {boolean}
 */
export function isContentEditOperation(operation) {
  if (typeof operation !== 'string') return true;
  return !NON_CONTENT_OPERATIONS.includes(operation);
}

/**
 * 编辑态统一闸门判定（需求 49.1、49.2、49.4、49.8）——服务层入口调用点。
 *
 * - 内容变更操作：当且仅当 `isEditable(card)` 为真时放行；
 * - 非内容变更操作（需求 49.8 列举七项）：不受编辑态约束，闸门恒放行，
 *   其状态前置交由各自专属谓词判定。
 *
 * @param {unknown} card 工卡对象或状态字符串
 * @param {unknown} operation 操作标识（见 {@link CONTENT_EDIT_OPERATIONS} / {@link NON_CONTENT_OPERATIONS}）
 * @returns {boolean}
 */
export function passesEditableGate(card, operation) {
  if (!isContentEditOperation(operation)) return true;
  return isEditable(card);
}
/* ══════════════════════════════════════════════════════════════════════════════
 * 任务 5.2：升版（`nextRevision` / `reviseCard`）、复制（`copyCard`）、
 *           查重（`checkDuplicate`）、IR 卡 BOM 字段条件（`requiresBomFields`）
 *
 * 需求：3.3、3.4、6.8、7.1、7.5、8.1–8.3、10.4、10.5、38.1–38.6
 *
 * ## 唯一性的三道防线（需求 38.6）
 * 1. 本模块 `checkDuplicate`：纯函数，判 `(task_no, revision)` 是否已被占用；
 * 2. 服务层：保存 / 提交（需求 10.4）与手动改版本号（需求 7.5）前调用 1，命中即 409；
 * 3. `task_card` 的 `UNIQUE (task_no, revision)`：最后防线，并发下兜底。
 * 三者口径必须一致——本模块刻意采用与 SQLite 默认 `BINARY` 比较相同的**逐字符相等**语义
 * （不 trim、不折叠大小写），否则会出现「领域放行、落库报错」或反之的裂缝。
 *
 * ## 与 `exec-doc.js` 的同构关系 ⚠
 * `copyCard` 与 `copyExecDocument` 的复制语义**严格同构**（Property 3 / Property 20 对两类实体
 * 一并断言）：除 `id` / 编号 / `status` / `revision` 外逐字段克隆、源对象保持不变、深克隆隔离。
 * 改动任一方的复制语义时，另一方须同步改动。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 复制副本的初始版本号（需求 38.3，与 `task_card.revision` 的 DDL 默认值一致） */
export const INITIAL_REVISION = 1;

/**
 * 复制时**不**从源工卡克隆、而由复制规则重新赋值的列（需求 38.1–38.3）。
 * 与 `exec-doc.js` 的 `COPY_RESET_FIELDS` 同形（编号列为 `task_no` 而非 `doc_no`）。
 * Property 3 的「除此之外逐字段相等」即以本集合为豁免清单。
 */
export const COPY_RESET_FIELDS = Object.freeze(['id', 'task_no', 'status', 'revision']);

/**
 * 升版时重新赋值的列（需求 38.4、38.5）。
 * **不含 `task_no`**：升版保持编号与原工卡一致且不允许修改（需求 38.4），这正是升版与复制的分水岭。
 */
export const REVISE_RESET_FIELDS = Object.freeze(['id', 'status', 'revision']);

/**
 * IR 卡（`card_type === '04'`）条件性 BOM 字段（需求 8.1、8.2）。
 * 列名与 `task_card` 一致；非 IR 卡不要求录入（需求 8.3），故这两列可为空。
 */
export const BOM_FIELDS = Object.freeze(['base_number', 'ipc_item_no']);

/** 查重拒绝原因码（需求 10.5、7.5 → 服务层映射 409） */
export const DUPLICATE_REJECTION = Object.freeze({
  /** `(task_no, revision)` 已被现存工卡占用 */
  DUPLICATE_TASK_NO: 'DUPLICATE_TASK_NO',
});

/**
 * 深克隆（JSON 形态取值 + `Date`）——与 `exec-doc.js` 内同名实现逐字一致（须保持同步）。
 *
 * 保证副本与源工卡**不共享任何可变引用**：改副本不得影响源工卡，反之亦然
 * （Property 3「源工卡保持不变」在嵌套结构上的实际含义）。字符串不可变，原样返回即已隔离，
 * 故以 JSON 字符串形态携带的内容字段不被解析、不被重新序列化（重新序列化会改变键顺序与空白，
 * 使副本与源工卡的字面量不再逐字符相等）。
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = deepClone(value[key]);
  }
  return out;
}

/** 取行上第一个**自有**键（无论取值是否为空），用于「写回源工卡实际使用的那个键名」。 */
function ownKeyOf(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return key;
  }
  return null;
}

/** 编号归一化：非空字符串原样（保留原貌，不 trim），有限数字 / bigint 转字符串；其余为非法。 */
function normalizeTaskNo(value) {
  if (typeof value === 'string') return value.trim().length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/**
 * 版本号归一化：整数原样；整数字面量字符串（JSON 往返中 INTEGER 可能退化为字符串）转整数。
 * 其余（小数、非数字文本、空值）返回 `null`，即「取不到可比较的版本号」。
 */
function normalizeRevision(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** 取工卡的 Task No（兼容 snake_case / camelCase）；取不到返回 `null`。 */
function taskNoOf(card) {
  if (typeof card === 'string' || typeof card === 'number') return normalizeTaskNo(card);
  if (card === null || typeof card !== 'object') return null;
  return normalizeTaskNo(card.task_no ?? card.taskNo);
}

/**
 * 取工卡的版本号（兼容 snake_case / camelCase）；取不到合法整数版本号时返回 `null`。
 * @param {unknown} card 工卡对象，或直接传入版本号
 * @returns {number | null}
 */
export function revisionOf(card) {
  if (typeof card === 'number' || typeof card === 'bigint' || typeof card === 'string') {
    return normalizeRevision(card);
  }
  if (card === null || typeof card !== 'object') return null;
  return normalizeRevision(card.revision ?? card.card_revision ?? card.cardRevision);
}

/**
 * 升版的版本号（需求 3.4、7.1、38.5，Property 2）。
 *
 * - 不传 `manualRevision`：返回**默认**版本号 = 原版本号 + 1（需求 7.1、38.5）；
 * - 传入 `manualRevision`：返回归一化后的手动值（需求 7.1 允许手动调整为其它版本号），
 *   本函数只做**形态**校验（须为安全整数），**不判唯一性**。
 *
 * ⚠ **无论取默认值还是手动值，调用方都必须再经 {@link checkDuplicate} 校验
 * `(task_no, revision)` 唯一性**（需求 7.5、38.6）：默认值同样可能与已存在的版本冲突
 * （例如 rev 1 生效、rev 2 已作为「新增」存在时，对 rev 1 升版得到的默认值 2 即已被占用）。
 * 服务层的标准流程：
 *
 * ```js
 * const revision = nextRevision(card, body.revision);        // 需求 7.1：默认 +1，允许手动覆盖
 * const dup = checkDuplicate(existingCards, taskNoOf(card), revision);
 * if (!dup.ok) return reject(409, dup.message);              // 需求 7.5、38.6
 * const newVersion = reviseCard(card, revision);             // 需求 38.4、38.5
 * ```
 *
 * 版本号下界不由本函数把关：`task_card.revision` 无 `CHECK` 约束，需求亦未定义「允许回退到更
 * 小版本号」与否（需求 7.1 只说「其它版本号」），故此处不擅自加下界，非整数才拒绝。
 *
 * @param {unknown} card 工卡对象（`{ revision }`，兼容 `card_revision` / `cardRevision`）或版本号
 * @param {unknown} [manualRevision] 手动指定的版本号；`undefined` / `null` 表示取默认值
 * @returns {number} 本次升版应采用的版本号
 * @throws {TypeError} 源工卡取不到合法整数版本号，或手动值非安全整数
 */
export function nextRevision(card, manualRevision) {
  if (manualRevision !== undefined && manualRevision !== null) {
    const manual = normalizeRevision(manualRevision);
    if (manual === null) {
      throw new TypeError(`nextRevision：手动指定的版本号须为整数，收到：${String(manualRevision)}`);
    }
    return manual;
  }
  const current = revisionOf(card);
  if (current === null) {
    throw new TypeError('nextRevision：源工卡取不到合法的整数版本号，无法计算默认新版本号');
  }
  return current + 1;
}

/**
 * 升版：由源工卡产出新版本对象（需求 3.4、38.4、38.5，Property 2 / Property 20）。
 *
 * 1. **`task_no` 保持与原工卡一致且不被改写**（需求 38.4）——这是与 {@link copyCard} 的唯一实质差别；
 * 2. `revision` 取 {@link nextRevision}（默认原版本 +1，可由 `manualRevision` 覆盖，需求 7.1）；
 * 3. `status` 置 `'New'`（需求 38.5）；新版本审核记录数天然为 0（不继承上一版本审核结果，
 *    见 Property 19）——审核记录为独立表，本函数不产出亦不复制；
 * 4. `id` 置 `null`：新版本尚未落库，主键由 `AUTOINCREMENT` 分配。保留该键（而非删除）使新版本
 *    与源工卡的**键集合完全一致**，属性测试可直接做对称的逐字段比对；
 * 5. 其余业务字段逐字段深克隆，**源工卡保持不变**。
 *
 * ⚠ 唯一性不由本函数校验（纯函数无库可查）：`(task_no, revision)` 查重见 {@link checkDuplicate}。
 * 原生效版本转「已被取代」由 `supersede.js` 在新版本**生效时**处理（需求 44.1），不在升版时发生。
 *
 * @param {object} card 源工卡行（`task_card` 的一行或等价对象）
 * @param {unknown} [manualRevision] 手动指定的新版本号；缺省取默认值（原版本 +1）
 * @returns {object} 新版本对象（可直接交仓储层插入）
 * @throws {TypeError} `card` 非对象，或版本号无法确定（见 {@link nextRevision}）
 */
export function reviseCard(card, manualRevision) {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    throw new TypeError('reviseCard：源工卡须为 task_card 行对象');
  }
  const revision = nextRevision(card, manualRevision);

  const revised = {};
  for (const key of Object.keys(card)) {
    revised[key] = deepClone(card[key]);
  }

  revised.id = null;
  revised.status = STATUS_NEW;
  // 写回源工卡实际使用的版本号键名，避免同时出现 revision 与 card_revision 两份取值
  revised[ownKeyOf(card, ['revision', 'card_revision', 'cardRevision']) ?? 'revision'] = revision;

  return revised;
}

/**
 * 复制：由源工卡产出内容一致的副本（需求 3.3、23.1、38.1–38.3，Property 3 / Property 20）。
 *
 * 1. 全部业务字段**逐字段深克隆**（需求 3.3「内容副本」），源工卡未出现的列不凭空添加；
 * 2. `task_no` 取传入的新编号（需求 38.1：副本须指定新的、不与现有工卡重复的编号）；
 * 3. `status` 置 `'New'`、`revision` 置初始版本（需求 38.3）；
 * 4. `id` 置 `null`（同 {@link reviseCard} 第 4 点）；
 * 5. **源工卡保持不变**：入参 `card` 不被写入，嵌套结构亦不与副本共享引用。
 *
 * ⚠ **编号唯一性不由本函数校验**（纯函数无库可查）。需求 38.2「编号重复则阻止复制并提示」由服务层
 * 在调用前经 {@link checkDuplicate}（副本版本号即 `INITIAL_REVISION`）判定，`UNIQUE (task_no,
 * revision)` 为最后防线；批量复制的编号自动生成与跳号见 `task-no.js` 的 `generateTaskNoBatch`
 * （需求 38.8–38.10）。同理，若业务上希望副本记录复制者与复制时间，由服务层在返回值上覆盖
 * `operator_id` / `last_update`——本函数按需求 3.3 逐字段克隆，不擅自改写业务字段。
 *
 * @param {object} card 源工卡行（`task_card` 的一行或等价对象）
 * @param {string|number} newTaskNo 副本的新工卡编号（须为调用方已确认不重复的值）
 * @returns {object} 副本对象（可直接交仓储层插入）
 * @throws {TypeError} `card` 非对象，或 `newTaskNo` 为空 / 非法
 */
export function copyCard(card, newTaskNo) {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    throw new TypeError('copyCard：源工卡须为 task_card 行对象');
  }
  const taskNo = normalizeTaskNo(newTaskNo);
  if (taskNo === null) {
    throw new TypeError('copyCard：须为副本指定不重复的新工卡编号（需求 38.1）');
  }

  const copy = {};
  for (const key of Object.keys(card)) {
    copy[key] = deepClone(card[key]);
  }

  copy.id = null;
  copy.status = STATUS_NEW;
  // 与 reviseCard 同理：写回源工卡实际使用的键名，保持副本与源工卡键集合一致
  copy[ownKeyOf(card, ['task_no', 'taskNo']) ?? 'task_no'] = taskNo;
  copy[ownKeyOf(card, ['revision', 'card_revision', 'cardRevision']) ?? 'revision'] = INITIAL_REVISION;

  return copy;
}

/**
 * `(task_no, revision)` 查重（需求 10.4、10.5、38.6、7.5，Property 7）。
 *
 * 判为重复**当且仅当** `cards` 中存在**同 `task_no` 且同 `revision`** 的工卡：
 * **不同版本的相同 Task No 不构成重复**（需求 38.6 明确「提交查重仅针对相同版本号下的重复
 * Task No 进行拦截」）——同一 Task No 存在多版本是升版的正常形态，若按 Task No 单列判重，
 * 任何升版都会被自己的历史版本挡住。
 *
 * 比较语义与 SQLite `UNIQUE (task_no, revision)` 的默认 `BINARY` 比较一致：
 * Task No 逐字符相等（**不** trim、**不**折叠大小写），版本号按整数相等（容忍 JSON 往返中
 * INTEGER 退化为整数字面量字符串的情形）。取不到可比较的 Task No 或版本号时视为「无重复」
 * ——必填校验是提交清单的独立一项（需求 34.1(c)），不在此以「重复」的名义误报。
 *
 * `excludeId` 用于**排除自身**：重新校验某张已落库工卡（如需求 7.5 手动改版本号后复校）时
 * 传入其 `id`，避免它与自己冲突。比较按字符串等值（`id` 可能以路径参数字符串形态传入）。
 *
 * @param {Iterable<object>|null|undefined} cards 现存工卡集合（`task_card` 行或等价对象；
 *   调用方负责取全量——本函数不触库，漏取即漏判）
 * @param {unknown} taskNo 待判定的工卡编号
 * @param {unknown} revision 待判定的版本号
 * @param {unknown} [excludeId] 需排除的工卡 `id`（自身）；`null` / `undefined` 表示不排除
 * @returns {{ ok: boolean, duplicate: boolean, rejection: string|null, message: string,
 *             conflict: object|null, conflicts: ReadonlyArray<object>,
 *             taskNo: string|null, revision: number|null }}
 *   `ok === !duplicate`；`conflicts` 为全部冲突工卡（正常数据下至多一条，脏数据下可多条），
 *   `conflict` 取其首条，供界面高亮 Task No 使用。
 * @throws {TypeError} `cards` 非可迭代集合
 */
export function checkDuplicate(cards, taskNo, revision, excludeId) {
  const rows = cards === null || cards === undefined ? [] : cards;
  if (typeof rows[Symbol.iterator] !== 'function' || typeof rows === 'string') {
    throw new TypeError('checkDuplicate：cards 须为可迭代的工卡集合（数组或 Set）');
  }

  const candidateTaskNo = normalizeTaskNo(taskNo);
  const candidateRevision = normalizeRevision(revision);
  const excluded = excludeId === null || excludeId === undefined ? null : String(excludeId);

  const conflicts = [];
  if (candidateTaskNo !== null && candidateRevision !== null) {
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      if (excluded !== null && row.id !== null && row.id !== undefined && String(row.id) === excluded) {
        continue;
      }
      if (taskNoOf(row) !== candidateTaskNo) continue;
      if (revisionOf(row) !== candidateRevision) continue; // 不同版本不构成重复（需求 38.6）
      conflicts.push(row);
    }
  }

  const duplicate = conflicts.length > 0;
  return Object.freeze({
    ok: !duplicate,
    duplicate,
    rejection: duplicate ? DUPLICATE_REJECTION.DUPLICATE_TASK_NO : null,
    message: duplicate
      ? `工卡编号 ${candidateTaskNo} 的版本 ${candidateRevision} 已存在，不可重复`
      : 'ok',
    conflict: duplicate ? conflicts[0] : null,
    conflicts: Object.freeze(conflicts),
    taskNo: candidateTaskNo,
    revision: candidateRevision,
  });
}

/**
 * 是否要求录入 BOM 字段（需求 8.1–8.3、6.8，Property 6）。
 *
 * 为真**当且仅当** `card_type === '04'`（IR 卡），即需求 8.1、8.2 的 Base Number 与 IPC 项号
 * 为该类型的条件必填项；其它类型不要求录入（需求 8.3）。
 *
 * ⚠ 判定**仅依赖单一 `card_type` 列**：需求 6.8 明确 WBS 与工卡类型是同一字段的两种称法，
 * 系统内只有 `task_card.card_type` 一列（前端 WBS 下拉即绑定该列），**不存在 `wbs` 列**。
 * 若日后误加第二列，两列取值必然出现分歧，IR 卡判定即不再唯一——故此处不读任何 `wbs` 别名。
 *
 * 类型码取**逐字符相等**（不 trim、不作数字转换）：`card_type` 的 `CHECK` 约束以字面量取值集
 * 判定，`' 04'`、`4` 都不是合法取值，不应被识别为 IR 卡。
 *
 * @param {unknown} card 工卡对象（`{ card_type }`，兼容 `cardType`）或直接传入类型码
 * @returns {boolean}
 */
export function requiresBomFields(card) {
  if (typeof card === 'string') return card === IR_CARD_TYPE;
  if (card === null || typeof card !== 'object') return false;
  return (card.card_type ?? card.cardType) === IR_CARD_TYPE;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 任务 5.3：打印投影（`printProjection`）
 *
 * 需求：5.2、5.3、16.3、33.9、45.7，Property 8
 *
 * ## 职责边界
 *
 * 本函数**只做字段投影**，不渲染 HTML（渲染由前端消费 `template_body` 完成，见
 * `print-template.js` 模块头注）。输出即 `GET /api/task-cards/:id/print` 三元组
 * `{ templateId, templateBody, model }` 中的 `model`（design.md）。
 *
 * ## 剔除工卡分类（需求 5.2、40.5）
 *
 * 输出对象**不含** `card_type` / `cardType` 键——不是置空，而是从不写入该键，
 * 任何模板都无字段可渲染出工卡类型（保证点在投影侧，而非模板选用侧）。
 *
 * ## 最小信息集字段（需求 5.3）与来源
 *
 * | 最小信息集项 | 输出字段 | 来源 |
 * |---|---|---|
 * | 组织名称 | `organizationName` | `card.organizationName` / `card.organization_name`（服务层从 `system_parameter` 读取后合并到入参），`template.organizationName` 兜底 |
 * | 工卡编号 | `taskNo` | `card.task_no` / `card.taskNo` |
 * | 标题 | `title` | `card.title` |
 * | 参考文件与版本 | `referenceDocuments[]`（`docType`/`refNo`/`docRevision`/`ataChapter`） | `card.referenceDocuments` / `card.reference_documents`（`reference_document` 行集合），经 `collections.js` 的 `normalizeReferenceDocument` 归一 |
 * | 修订版本与日期 | `revisionLabel`（两位补零文本）、`date` | `card.revision`（经 {@link formatRevision}）、`card.date` |
 * | 适用机型/件号 | `acType`、`partNo` | `card.ac_type`；`partNo` 为 Process Card 只读带出字段（需求 27.1–27.3 同一处置：编制态不呈现，故编制态投影为 `null`），仅执行态由 `jobContext.partNo` 带出 |
 * | 工序步骤与记录栏 | `steps[]`（描述 + 工时/起止时间记录栏，见下） | `card.steps` |
 * | 签署栏 | `steps[].signatures[]` | 见下「逐工序签署栏」 |
 * | 特殊工具/耗材 | `steps[].tools[]` / `steps[].consumables[]` | 工序插入组件（`inserted_component`）中 `type='tool'` / `'consumable'` 的载荷 |
 * | 工时与起止时间栏 | 卡级 `manHours` / `startTime` / `finishTime`，工序级 `steps[].manHours` / `startTime` / `finishTime`（需求 33.9：卡级另含计划/实际工时） | 见下「编制态 / 执行态投影」 |
 * | 维修草图 | `steps[].sketches[]` | 工序插入组件中 `type='image'` 的载荷（需求 13.2） |
 *
 * ## 逐工序签署栏（需求 45.7，Property 8）
 *
 * 每道工序的签署栏集合**恒与其 `signature_requirement` 配置一一对应**：本函数不自行重新聚合，
 * 而是直接复用 `signature.js` 的 `aggregateSignatureRequirements(card.steps)`
 * 取其 `byStep` 分组（需求 45.6 的唯一来源），故天然满足「不产出无配置来源的签署栏、
 * 也不遗漏已配置的签署栏」——凡该聚合判定为孤立（`orphans`）的配置行本函数同样不呈现。
 * 每个签署栏含签署人 / 签章 / 完成日期三个栏位（需求 45.7 字面要求），
 * 值是否带出见下「编制态 / 执行态投影」。
 *
 * ## 编制态 / 执行态投影（`jobContext` 缺省 / 传入）
 *
 * - **缺省 `jobContext`**（编制态）：工时的**实际值**、起止时间、签署栏的签署记录三类栏位
 *   输出为空白待填（`null`）——栏位本身（结构）仍然存在，只是没有取值，这正是「纸质卡应如此」
 *   的字面含义（design.md）。工序**预计工时**（`process_step.estimated_man_hours`，PPC 写入、
 *   TS 只读带出列）不受此影响，恒按 `card.steps[].estimatedManHours` 原样输出（该列编制期即存在）。
 * - **传入 `jobContext`**（执行态）：带出该 JOB 的实际工时（`jobContext.processes[]` 按工序匹配、
 *   卡级为其汇总）、起止时间（工序级按匹配的 `jobContext.processes[]` 项、卡级取
 *   `jobContext.startTime`/`finishTime`）与签署记录（`jobContext.signatures[]` 按
 *   `signatureRequirementId` 匹配至对应签署栏）。
 *
 * `jobContext` 形状（各字段均可 camelCase 或 snake_case）：
 * ```
 * {
 *   startTime, finishTime,                 // 卡级起止时间（job.start_time / finish_time）
 *   partNo,                                // Process Card PART No（job.part_no）
 *   processes: [{ stepId|processId, actualManHours, startTime, finishTime }],  // job_process 行
 *   signatures: [{ signatureRequirementId, signedBy, stampId, signedAt }],      // electronic_signature 行
 * }
 * ```
 *
 * @param {object} card 工卡行，含嵌套 `referenceDocuments`（或 `reference_documents`）与
 *   `steps`（或 `process_steps`；元素可嵌套 `components`/`insertedComponents` 与
 *   `signatureRequirements`/`signature_requirement`，形态同 {@link aggregateSignatureRequirements}）
 * @param {unknown} [template] 打印模板选用结果（`selectPrintTemplate` 的返回值）或等价对象；
 *   本函数不读取其 `templateBody`，仅在 `card` 缺少组织名称时以其 `organizationName` 兜底
 * @param {unknown} [jobContext] 执行态上下文；缺省即编制态投影
 * @returns {Readonly<object>} 冻结的打印模型（`model`），不含 `card_type` / `cardType`
 * @throws {TypeError} `card` 非对象
 */
export function printProjection(card, template, jobContext) {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    throw new TypeError('printProjection：工卡须为 task_card 行对象');
  }

  const pickAny = (source, keys) => {
    if (source === null || typeof source !== 'object') return undefined;
    for (const key of keys) {
      const value = source[key];
      if (value !== null && value !== undefined) return value;
    }
    return undefined;
  };
  const toStringOrNull = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    return String(value);
  };
  const toFiniteNumberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const toBooleanFlag = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return !['0', 'false', 'no', ''].includes(value.trim().toLowerCase());
    return Boolean(value);
  };
  const identityOf = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const text = value.trim();
      return text === '' ? null : text;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'bigint') return value.toString();
    return null;
  };
  const stepIdentityOf = (step) => ({
    id: identityOf(pickAny(step, ['id'])),
    processId: identityOf(pickAny(step, ['processId', 'process_id'])),
  });
  const groupByStepId = (list) => {
    const map = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (item === null || typeof item !== 'object') continue;
      const key = identityOf(pickAny(item, ['stepId', 'step_id']));
      if (key === null) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  };
  const matchesStep = (entry, identity) => {
    const entryStepId = identityOf(pickAny(entry, ['stepId', 'step_id']));
    if (entryStepId !== null && identity.id !== null && entryStepId === identity.id) return true;
    const entryProcessId = identityOf(pickAny(entry, ['processId', 'process_id']));
    if (entryProcessId !== null && identity.processId !== null && entryProcessId === identity.processId) return true;
    return false;
  };

  // ── 参考文件与版本 ──────────────────────────────────────────────
  const referenceDocuments = pickAny(card, ['referenceDocuments', 'reference_documents']) ?? [];
  const referenceDocumentsOut = Object.freeze(
    (Array.isArray(referenceDocuments) ? referenceDocuments : [])
      .map((doc) => normalizeReferenceDocument(doc)),
  );

  // ── 组织名称：card 优先，template 兜底 ──────────────────────────
  const organizationName = toStringOrNull(
    pickAny(card, ['organizationName', 'organization_name'])
    ?? pickAny(template, ['organizationName', 'organization_name']),
  );

  // ── 工序集合与逐工序签署栏（需求 45.6、45.7，复用唯一聚合来源） ──
  const stepsSource = pickAny(card, ['steps', 'process_steps', 'processSteps']);
  const steps = Array.isArray(stepsSource) ? stepsSource : [];
  const signatureAggregate = aggregateSignatureRequirements(steps);
  const signaturesByStepKey = new Map(
    signatureAggregate.byStep
      .filter((group) => group.stepId !== null)
      .map((group) => [String(group.stepId), group.requirements]),
  );

  // ── 执行态上下文：工序实例（工时/起止时间）与签署记录 ───────────
  const jobProcesses = Array.isArray(pickAny(jobContext, ['processes', 'job_processes']))
    ? pickAny(jobContext, ['processes', 'job_processes'])
    : [];
  const jobSignatures = Array.isArray(pickAny(jobContext, ['signatures']))
    ? pickAny(jobContext, ['signatures'])
    : [];
  const jobSignatureByRequirementId = new Map();
  for (const sig of jobSignatures) {
    const reqId = identityOf(pickAny(sig, ['signatureRequirementId', 'signature_requirement_id']));
    if (reqId === null) continue;
    if (!jobSignatureByRequirementId.has(reqId)) jobSignatureByRequirementId.set(reqId, sig);
  }

  // ── 工序插入组件分组（工具/耗材/维修草图的来源；支持嵌套或按 step_id 归属的扁平集合） ──
  const flatComponentsByStep = groupByStepId(
    pickAny(card, ['components', 'insertedComponents', 'inserted_components']),
  );

  const projectComponent = (component) => {
    const payload = parsePayload(pickAny(component, ['payload']));
    const base = payload !== null && typeof payload === 'object' ? payload : {};
    return Object.freeze({
      id: pickAny(component, ['id']) ?? null,
      sortOrder: toFiniteNumberOrNull(pickAny(component, ['sortOrder', 'sort_order'])),
      ...base,
    });
  };

  const projectStep = (step) => {
    const identity = stepIdentityOf(step);
    const stepKey = identity.id ?? identity.processId;

    const componentsNested = pickAny(step, ['components', 'insertedComponents', 'inserted_components']);
    const components = Array.isArray(componentsNested)
      ? componentsNested
      : (identity.id !== null ? flatComponentsByStep.get(identity.id) : undefined) ?? [];

    const tools = [];
    const consumables = [];
    const sketches = [];
    for (const component of components) {
      const type = pickAny(component, ['type', 'component_type', 'componentType']);
      if (type === 'tool') tools.push(projectComponent(component));
      else if (type === 'consumable') consumables.push(projectComponent(component));
      else if (type === 'image') sketches.push(projectComponent(component));
    }

    const matchedProcess = jobProcesses.find((process) => matchesStep(process, identity)) ?? null;

    const signatureRequirements = stepKey !== null ? (signaturesByStepKey.get(String(stepKey)) ?? []) : [];
    const signatures = signatureRequirements.map((requirement) => {
      const record = jobSignatureByRequirementId.get(requirement.id !== null ? identityOf(requirement.id) : null);
      return Object.freeze({
        signatureRole: requirement.signatureRole,
        stampRequired: requirement.stampRequired,
        dateRequired: requirement.dateRequired,
        signedBy: record ? toStringOrNull(pickAny(record, ['signedBy', 'signed_by'])) : null,
        stampId: record ? toStringOrNull(pickAny(record, ['stampId', 'stamp_id'])) : null,
        signedAt: record ? toStringOrNull(pickAny(record, ['signedAt', 'signed_at'])) : null,
      });
    });

    return Object.freeze({
      processId: toStringOrNull(pickAny(step, ['processId', 'process_id'])),
      seq: toFiniteNumberOrNull(pickAny(step, ['seq'])),
      skill: toStringOrNull(pickAny(step, ['skill'])),
      descriptionZh: toStringOrNull(pickAny(step, ['descriptionZh', 'description_zh'])),
      descriptionEn: toStringOrNull(pickAny(step, ['descriptionEn', 'description_en'])),
      safetyWarning: toStringOrNull(pickAny(step, ['safetyWarning', 'safety_warning'])),
      repairTips: toStringOrNull(pickAny(step, ['repairTips', 'repair_tips'])),
      isCritical: toBooleanFlag(pickAny(step, ['isCritical', 'is_critical']) ?? false),
      tools: Object.freeze(tools),
      consumables: Object.freeze(consumables),
      sketches: Object.freeze(sketches),
      manHours: Object.freeze({
        estimated: toFiniteNumberOrNull(pickAny(step, ['estimatedManHours', 'estimated_man_hours'])),
        actual: matchedProcess
          ? toFiniteNumberOrNull(pickAny(matchedProcess, ['actualManHours', 'actual_man_hours']))
          : null,
      }),
      startTime: matchedProcess ? toStringOrNull(pickAny(matchedProcess, ['startTime', 'start_time'])) : null,
      finishTime: matchedProcess ? toStringOrNull(pickAny(matchedProcess, ['finishTime', 'finish_time'])) : null,
      signatures: Object.freeze(signatures),
    });
  };

  const stepsOut = Object.freeze(steps.map((step) => projectStep(step)));

  // ── 卡级工时与起止时间栏（需求 33.9：计划/实际工时 + 起止时间） ──
  const plannedManHours = steps.reduce((sum, step) => {
    const value = toFiniteNumberOrNull(pickAny(step, ['estimatedManHours', 'estimated_man_hours']));
    return value === null ? sum : (sum ?? 0) + value;
  }, null);
  const actualManHours = jobContext === null || jobContext === undefined
    ? null
    : jobProcesses.reduce((sum, process) => {
      const value = toFiniteNumberOrNull(pickAny(process, ['actualManHours', 'actual_man_hours']));
      return value === null ? sum : (sum ?? 0) + value;
    }, null);

  // ── 适用机型/件号：机型编制态即有，件号（Process Card 带出）仅执行态呈现（需求 27.1–27.3 同一处置） ──
  const partNo = jobContext === null || jobContext === undefined
    ? null
    : toStringOrNull(pickAny(jobContext, ['partNo', 'part_no']));

  return Object.freeze({
    organizationName,
    taskNo: toStringOrNull(pickAny(card, ['taskNo', 'task_no'])),
    title: toStringOrNull(pickAny(card, ['title'])),
    revisionLabel: formatRevision(pickAny(card, ['revision', 'card_revision', 'cardRevision'])),
    date: toStringOrNull(pickAny(card, ['date'])),
    acType: toStringOrNull(pickAny(card, ['acType', 'ac_type'])),
    gearType: toStringOrNull(pickAny(card, ['gearType', 'gear_type'])),
    partNo,
    referenceDocuments: referenceDocumentsOut,
    manHours: Object.freeze({ estimated: plannedManHours, actual: actualManHours }),
    startTime: jobContext === null || jobContext === undefined
      ? null
      : toStringOrNull(pickAny(jobContext, ['startTime', 'start_time'])),
    finishTime: jobContext === null || jobContext === undefined
      ? null
      : toStringOrNull(pickAny(jobContext, ['finishTime', 'finish_time'])),
    steps: stepsOut,
  });
}
