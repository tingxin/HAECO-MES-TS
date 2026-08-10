/**
 * 执行过程单据（含 SWS）领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * SWS 即 `exec_doc_type === 'SW'` 的 `exec_document` 实例（需求 16.2、23.2）。
 *
 * ⚠ 本模块**只提供复制与读取辅助**，不实现 SWS 的编制表单/编制规则：需求 23.3 将
 * SWS 自身编制功能的归属（本模块 / LGS-TS-03-05 Supplementary Work Sheet 独立流程）
 * 列为待澄清项。归属确定前在此追加编制逻辑，将来极可能整块作废，故刻意留白。
 * 本模块之所以存在，是因为 SWS 复制此前无落位实体（`SW` 仅是 `exec_doc_type` 字典中的一个 code）。
 *
 * 复制语义与 `card-rules.js` 的 `copyCard(card, newTaskNo)` **严格同构**——Property 3 与
 * Property 20 对两类实体一并断言：除 `id` / 编号 / `status` / `revision` 外逐字段相等，
 * 且源对象保持不变。改动本模块的复制语义时，`copyCard` 须同步改动，否则两条属性必有一条失败。
 *
 * 需求：23.1、23.2、38.1–38.3
 */

/** 复制副本的初始状态（需求 38.3，与 `CARD_STATUS` 的 `New` 同值） */
export const EXEC_DOC_STATUS_NEW = 'New';

/** 复制副本的初始版本号（需求 38.3，与 `exec_document.revision` 的 DDL 默认值一致） */
export const INITIAL_REVISION = 1;

/** SWS 对应的执行过程单据类型码（需求 16.2、23.2） */
export const SWS_DOC_TYPE = 'SW';

/**
 * 复制时**不**从源单据克隆、而由复制规则重新赋值的列（需求 38.1–38.3）。
 * Property 3 的「除此之外逐字段相等」即以本集合为豁免清单。
 */
export const COPY_RESET_FIELDS = Object.freeze(['id', 'doc_no', 'status', 'revision']);

/**
 * 是否为 SWS 实例（需求 23.2）。接受单据对象或类型码字符串。
 * @param {unknown} doc
 * @returns {boolean}
 */
export function isSws(doc) {
  if (typeof doc === 'string') return doc === SWS_DOC_TYPE;
  if (doc === null || typeof doc !== 'object') return false;
  return (doc.exec_doc_type ?? doc.execDocType) === SWS_DOC_TYPE;
}

/**
 * 深克隆（JSON 形态取值 + `Date`）。
 *
 * 用于保证副本与源单据**不共享任何可变引用**：改副本不得影响源单据，反之亦然
 * （Property 3 的「源单据保持不变」在嵌套结构上的实际含义）。
 * 字符串是不可变值，原样返回即已隔离——`content` 以 JSON 字符串形态传入时无需解析，见
 * {@link cloneExecDocContent}。
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

/**
 * 克隆 `content`（需求 23.1：单据内容逐字段一致）。
 *
 * **显式约定 `content` 的两种入参形态，两者均不做形态转换**：
 * - **JSON 字符串**（仓储层直读 `exec_document.content` 的原始形态）：字符串不可变，
 *   原样返回即完成隔离，**不解析、不重新序列化**——重新序列化会改变键顺序与空白，
 *   使副本与源单据的 `content` 字面量不再逐字符相等，Property 3 随之失败。
 * - **已解析对象**（服务层已 `JSON.parse` 的形态）：深克隆，副本与源单据不共享子对象引用。
 *
 * 即：`typeof copy.content === typeof doc.content` 恒成立，复制不承担序列化职责。
 *
 * @param {unknown} content
 * @returns {unknown} 与入参同形态的克隆值
 */
export function cloneExecDocContent(content) {
  return deepClone(content);
}

/** 编号归一化：非空字符串原样（保留原貌），有限数字转字符串；其余为非法。 */
function normalizeDocNo(newDocNo) {
  if (typeof newDocNo === 'string') {
    return newDocNo.trim().length > 0 ? newDocNo : null;
  }
  if (typeof newDocNo === 'number' && Number.isFinite(newDocNo)) return String(newDocNo);
  if (typeof newDocNo === 'bigint') return newDocNo.toString();
  return null;
}

/**
 * 复制执行过程单据（含 SWS）——需求 23.1、23.2、38.1–38.3。
 *
 * 与 `copyCard(card, newTaskNo)` 同语义：
 * 1. `content` 与其余业务字段（`exec_doc_type` / `title` / `source_card_id` / `created_by` /
 *    `created_at` 及未来新增列）**逐字段克隆**，源单据未出现的列不凭空添加；
 * 2. `doc_no` 取传入的新编号（需求 38.1）；
 * 3. `status` 置 `'New'`、`revision` 置初始版本（需求 38.3）；
 * 4. `id` 置 `null`——副本尚未落库，主键由 `AUTOINCREMENT` 分配。保留该键（而非删除）
 *    使副本与源单据的**键集合完全一致**，Property 3 可直接做对称的逐字段比对；
 * 5. **源单据保持不变**：入参 `doc` 不被写入，嵌套结构亦不与副本共享引用。
 *
 * ⚠ **编号唯一性不由本函数校验**（本函数为纯函数，无库可查）。需求 38.2「编号重复则阻止复制
 * 并提示」由服务层在调用前以 `exec_document` 的 `UNIQUE(exec_doc_type, doc_no, revision)`
 * 维度查重实现；SQLite 的 `UNIQUE` 约束为最后防线。同理，若业务上希望副本记录复制者与复制
 * 时间，由服务层在本函数返回值上覆盖 `created_by` / `created_at`——本函数按需求 23.1 逐字段
 * 克隆，不擅自改写业务字段。
 *
 * @param {object} doc 源单据行（`exec_document` 的一行，`content` 可为 JSON 字符串或已解析对象）
 * @param {string|number} newDocNo 副本的新单据编号（须为调用方已确认不重复的值）
 * @returns {object} 副本对象（可直接交仓储层插入）
 * @throws {TypeError} `doc` 非对象，或 `newDocNo` 为空/非法
 */
export function copyExecDocument(doc, newDocNo) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TypeError('copyExecDocument：源单据须为 exec_document 行对象');
  }
  const docNo = normalizeDocNo(newDocNo);
  if (docNo === null) {
    throw new TypeError('copyExecDocument：须为副本指定不重复的新单据编号（需求 38.1）');
  }

  // ① 逐字段克隆源单据的全部自有列（含未来新增列，无需在此登记）
  const copy = {};
  for (const key of Object.keys(doc)) {
    copy[key] = key === 'content' ? cloneExecDocContent(doc[key]) : deepClone(doc[key]);
  }

  // ② 复制规则重置的四列（需求 38.1、38.3）
  copy.id = null;
  copy.doc_no = docNo;
  copy.status = EXEC_DOC_STATUS_NEW;
  copy.revision = INITIAL_REVISION;

  return copy;
}
