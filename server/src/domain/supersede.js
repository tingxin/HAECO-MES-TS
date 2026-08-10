/**
 * 版本取代与内容冻结领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 本文件承载两组规则：
 * - 任务 5.1：`isFrozen(card)` = `!isEditable(card)`，即「审核中」「生效」「已被取代」「作废」
 *   四态**均**冻结（非仅终态冻结）。
 * - 任务 6.1：`supersedeOnApprove(cards, approvedCard)`——批准生效时的版本取代方案，
 *   以**「先降级、后生效」的有序操作序列**产出，见下文「为什么返回操作序列」。
 *
 * 需求：4.7、34.3、38.7、44.1–44.3、44.4、44.5、44.7、49.1、49.2、49.8
 */

import { isEditable, isContentEditOperation, canTransition, statusOf } from './card-rules.js';

/**
 * 编制域内容冻结判定（需求 49.1、49.2）。
 *
 * 与 {@link isEditable} 严格互补：仅「新增(New)」不冻结，其余四态
 * （UnderReview / Effective / Superseded / Void）一律冻结。
 * 原设计仅覆盖 Superseded / Void，按需求 49.1 扩展为四态。
 *
 * ⚠ 冻结的对象是**编制域内容**。需求 49.8 列举的非内容变更操作
 * （查看/打印/导出/复制/升版/作废/发布）在生效态必须放行，见 {@link isFrozenFor}。
 *
 * @param {unknown} card 工卡对象或状态字符串
 * @returns {boolean}
 */
export function isFrozen(card) {
  return !isEditable(card);
}

/**
 * 针对具体操作的冻结判定（需求 49.4、49.8）。
 *
 * 非内容变更操作恒不被冻结；内容变更操作沿用 {@link isFrozen}。
 * 供服务层与前端只读化按操作粒度区分，避免闸门对需求 49.8 的操作误拦。
 *
 * @param {unknown} card 工卡对象或状态字符串
 * @param {unknown} operation 操作标识
 * @returns {boolean}
 */
export function isFrozenFor(card, operation) {
  if (!isContentEditOperation(operation)) return false;
  return isFrozen(card);
}
/* ==========================================================================
 * 任务 6.1：版本取代（需求 38.7、44.1–44.3、44.7；Property 25 的纯函数半侧）
 * ========================================================================== */

/**
 * ## 为什么返回「操作序列」而不是一组变更集
 *
 * `schema.sql` 上的 `UNIQUE(task_no) WHERE status='Effective'` 是 SQLite **部分唯一索引**，
 * 校验发生在**每条语句执行的瞬间**，而非事务提交时（`src/db/constraints.test.js` 的
 * 「Property 25 成因」已就此给出经验证据）。因此批准事务只有一个可行顺序：
 *
 * ```
 * ① 原生效版本 → Superseded          （此刻生效版本数 0）
 * ② 写 supersede_record              （生效版本数仍 0）
 * ③ 本版本     → Effective           （生效版本数 1）
 * ```
 *
 * 顺序颠倒（先 ③ 后 ①）会在**第一条 UPDATE 即撞索引**并整体回滚，结果是任何版本都无法生效。
 * 也就是说：**语句顺序是正确性要求，不是实现细节**。若本函数只返回「哪些版本要降级 / 哪个版本要生效」
 * 这样的无序变更集，顺序知识就落在服务层的手写代码里，一次无心的语句挪动即构成缺陷，
 * 而缺陷表现（批准始终失败）与成因（语句顺序）相隔甚远。
 *
 * 故本函数把顺序**编码进返回值本身**：
 * - `operations` 是**冻结的有序数组**，每个元素亦被冻结，调用方无法就地重排或改写；
 * - 每个操作携带 `seq`（自 1 连续递增）与 `effectiveCountAfter`（该语句执行后该 Task No 下
 *   应有的生效版本数），Property 25 的「每条语句后不变式」因此可被逐步断言；
 * - {@link assertSupersedeOperationOrder} 提供误用守卫，{@link runSupersedePlan} 让服务层
 *   **交出执行器**而非自行遍历——服务层拿不到重排的机会，也就无从排错。
 *
 * ## 与作废流程的界线（需求 44.3）
 *
 * 版本取代**不要求作废原因**，也**不计入作废流程**：产出的取代记录只有
 * `(task_no, superseded_revision, superseding_revision, superseded_at)` 四个字段，
 * 既无 `reason` 也不产生 `change_record`。作废前置与作废留痕在 `void-rules.js` 与
 * `change-record.js`，两条路径不得互相借用——把取代当作废会凭空要求业务方填报原因，
 * 把作废当取代会绕过需求 42.1 的三类引用校验。
 */

/** 取代操作类型词表——`operations[].op` 的封闭取值，服务层按此分派语句。 */
export const SUPERSEDE_OP = Object.freeze({
  /** ① 原生效版本 → `Superseded`（`task_card` UPDATE，需求 44.1） */
  DEMOTE_INCUMBENT: 'demoteIncumbent',
  /** ② 写取代关系（`supersede_record` INSERT，需求 44.2） */
  WRITE_SUPERSEDE_RECORD: 'writeSupersedeRecord',
  /** ③ 本版本 → `Effective`（`task_card` UPDATE，需求 44.1） */
  PROMOTE_APPROVED: 'promoteApproved',
});

/**
 * 唯一合法的操作阶段顺序：全部降级 → 全部取代记录 → 唯一一次生效。
 * {@link assertSupersedeOperationOrder} 以此为准绳。
 */
export const SUPERSEDE_OP_ORDER = Object.freeze([
  SUPERSEDE_OP.DEMOTE_INCUMBENT,
  SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD,
  SUPERSEDE_OP.PROMOTE_APPROVED,
]);

/** 拒绝原因词表。服务层据此分流：状态类 → 422，标识缺失类 → 400。 */
export const SUPERSEDE_REJECTION = Object.freeze({
  /** 未提供该 Task No 的版本列表——取不到版本列表即无法判定单一生效，不得据以放行 */
  CARDS_REQUIRED: 'CARDS_REQUIRED',
  /** 待生效版本缺 `task_no` */
  TASK_NO_REQUIRED: 'TASK_NO_REQUIRED',
  /** 待生效版本缺 `revision` 或不是正整数 */
  REVISION_REQUIRED: 'REVISION_REQUIRED',
  /** 当前状态不允许迁至 `Effective`（依 `canTransition`，仅 `UnderReview` 可批准生效） */
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
});

const SUPERSEDE_REJECTION_MESSAGES = Object.freeze({
  [SUPERSEDE_REJECTION.CARDS_REQUIRED]: '缺少该 Task No 的版本列表，无法判定单一生效版本',
  [SUPERSEDE_REJECTION.TASK_NO_REQUIRED]: '待生效版本缺少工卡编号（Task No）',
  [SUPERSEDE_REJECTION.REVISION_REQUIRED]: '待生效版本缺少合法的版本号（须为正整数）',
  [SUPERSEDE_REJECTION.ILLEGAL_TRANSITION]: '当前状态不可迁至「生效」，仅「审核中」版本可批准生效',
});

const STATUS_EFFECTIVE = 'Effective';
const STATUS_SUPERSEDED = 'Superseded';

/** 取行上第一个存在的字段，兼容 camelCase / snake_case 两种写法。 */
function pickField(row, keys) {
  if (row === null || typeof row !== 'object') return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** 归一化 Task No：非空字符串原样；数字转字符串；其余（含空白串）为 `null`。 */
function taskNoOf(row) {
  const value = pickField(row, ['task_no', 'taskNo']);
  if (typeof value === 'string') return value.trim().length === 0 ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/**
 * 归一化版本号为 INTEGER（`task_card.revision` 为 INTEGER 列）。
 * 接受整数与整数字面量字符串；小数、非数、非正数一律返回 `null`。
 */
function revisionOf(row) {
  const value = pickField(row, ['revision', 'card_revision', 'cardRevision']);
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'bigint') return value > 0n ? Number(value) : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    const parsed = Number.parseInt(text, 10);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

/** 归一化注入的时间戳（与 `change-record.js` 的同名内部实现同义）。 */
function normalizeSupersededAt(timestamp) {
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

function rejectSupersede(rejection) {
  return Object.freeze({
    ok: false,
    rejection,
    message: SUPERSEDE_REJECTION_MESSAGES[rejection],
    taskNo: null,
    supersedingRevision: null,
    supersededRevisions: Object.freeze([]),
    operations: Object.freeze([]),
    supersedeRecords: Object.freeze([]),
    invariantViolatedBefore: false,
  });
}

/**
 * 同一 Task No 下的原生效版本（需求 44.1）。
 *
 * 仅取 `task_no` 相同、`status === 'Effective'`、且 `revision !== 待生效版本` 的行，
 * 按 `revision` 升序返回——**排除自身**：若版本列表中本版本已标记生效（列表取数早于状态变更
 * 的时序错位），也不得把自己降级为已被取代。
 *
 * 部分唯一索引保证正常数据下最多一行；此处仍按集合处理，是为了让「数据已越界」的脏库
 * 也能被本函数收敛回 ≤ 1 个生效版本（结果中以 `invariantViolatedBefore` 标记）。
 */
function findIncumbents(cards, taskNo, supersedingRevision) {
  return cards
    .filter((card) => card !== null && typeof card === 'object')
    .filter((card) => taskNoOf(card) === taskNo)
    .filter((card) => statusOf(card) === STATUS_EFFECTIVE)
    .map((card) => ({ card, revision: revisionOf(card) }))
    .filter(({ revision }) => revision !== null && revision !== supersedingRevision)
    .sort((a, b) => a.revision - b.revision);
}

/**
 * 版本取代方案（需求 38.7、44.1–44.3、44.7；Property 25 的纯函数半侧）。
 *
 * 产出**有序**操作序列，服务层须在**同一事务内按序执行**（推荐经 {@link runSupersedePlan}）：
 * 先把该 Task No 下原生效版本降级为 `Superseded` 并写取代记录，最后才把本版本置为 `Effective`。
 * 顺序颠倒会撞部分唯一索引，见模块内「为什么返回操作序列」。
 *
 * 首个版本批准（无原生效版本）时 `operations` 只含一条 `promoteApproved`，`supersedeRecords` 为空
 * ——无取代关系可记录，不产生空记录行。
 *
 * 不抛异常；`ok === false` 时 `operations` 恒为空数组，忽略 `ok` 的调用方也不会执行到任何语句。
 *
 * @param {unknown} cards 该 Task No 下的全部版本行（`{task_no, revision, status}`，兼容 camelCase）。
 *   须为数组；非数组视为「取不到版本列表」而整体拒绝
 * @param {unknown} approvedCard 本次被批准的版本（`{task_no, revision, status}`）
 * @param {{timestamp?: Date|string|number}} [options] `timestamp` 可注入，全部取代记录共享该取代时间
 * @returns {{ok: boolean, rejection: string|null, message: string, taskNo: string|null,
 *            supersedingRevision: number|null, supersededRevisions: readonly number[],
 *            operations: ReadonlyArray<object>, supersedeRecords: ReadonlyArray<object>,
 *            invariantViolatedBefore: boolean}}
 */
export function supersedeOnApprove(cards, approvedCard, options = {}) {
  // ① 版本列表必须给出：判不出「有没有原生效版本」就不能生成生效语句
  if (!Array.isArray(cards)) return rejectSupersede(SUPERSEDE_REJECTION.CARDS_REQUIRED);

  // ② 标识齐备：取代记录以 task_no 为键（非 card_id），编号与版本号缺一不可
  const taskNo = taskNoOf(approvedCard);
  if (taskNo === null) return rejectSupersede(SUPERSEDE_REJECTION.TASK_NO_REQUIRED);
  const supersedingRevision = revisionOf(approvedCard);
  if (supersedingRevision === null) return rejectSupersede(SUPERSEDE_REJECTION.REVISION_REQUIRED);

  // ③ 状态前置：仅「审核中」可批准生效（`ALLOWED_TRANSITIONS`），已生效版本不再重复生效
  if (!canTransition(statusOf(approvedCard), STATUS_EFFECTIVE)) {
    return rejectSupersede(SUPERSEDE_REJECTION.ILLEGAL_TRANSITION);
  }

  const supersededAt = normalizeSupersededAt(options.timestamp);
  const incumbents = findIncumbents(cards, taskNo, supersedingRevision);

  const operations = [];
  const records = [];
  let seq = 0;
  const push = (operation) => {
    seq += 1;
    operations.push(Object.freeze({ seq, ...operation }));
  };

  // 阶段一：逐个降级原生效版本。`effectiveCountAfter` 记的是该语句执行后应剩的生效版本数，
  // 正常数据下单条降级后即为 0——Property 25 可据此逐语句断言不变式
  incumbents.forEach(({ revision }, index) => {
    push({
      op: SUPERSEDE_OP.DEMOTE_INCUMBENT,
      table: 'task_card',
      action: 'update',
      where: Object.freeze({ task_no: taskNo, revision }),
      set: Object.freeze({ status: STATUS_SUPERSEDED }),
      row: null,
      effectiveCountAfter: incumbents.length - index - 1,
      description: `降级原生效版本 ${taskNo} rev.${revision} → ${STATUS_SUPERSEDED}`,
    });
  });

  // 阶段二：写取代关系（被取代版本号 / 取代版本号 / 取代时间，需求 44.2）。
  // 记录只有四个字段：不含作废原因，也不产生 change_record（需求 44.3）
  incumbents.forEach(({ revision }) => {
    const row = Object.freeze({
      task_no: taskNo,
      superseded_revision: revision,
      superseding_revision: supersedingRevision,
      superseded_at: supersededAt,
    });
    records.push(row);
    push({
      op: SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD,
      table: 'supersede_record',
      action: 'insert',
      where: null,
      set: null,
      row,
      effectiveCountAfter: 0,
      description: `记录取代关系 ${taskNo}：rev.${revision} 被 rev.${supersedingRevision} 取代`,
    });
  });

  // 阶段三：置本版本为生效——**必须最后执行**，此前生效版本数已为 0，索引方可放行
  push({
    op: SUPERSEDE_OP.PROMOTE_APPROVED,
    table: 'task_card',
    action: 'update',
    where: Object.freeze({ task_no: taskNo, revision: supersedingRevision }),
    set: Object.freeze({ status: STATUS_EFFECTIVE }),
    row: null,
    effectiveCountAfter: 1,
    description: `置本版本生效 ${taskNo} rev.${supersedingRevision} → ${STATUS_EFFECTIVE}`,
  });

  return Object.freeze({
    ok: true,
    rejection: null,
    message: 'ok',
    taskNo,
    supersedingRevision,
    supersededRevisions: Object.freeze(incumbents.map(({ revision }) => revision)),
    operations: Object.freeze(operations),
    supersedeRecords: Object.freeze(records),
    // 入参已越界（同一 Task No 下多于一个生效版本）：本方案仍将其全部降级并收敛回 ≤ 1
    invariantViolatedBefore: incumbents.length > 1,
  });
}

/** {@link assertSupersedeOperationOrder} 抛出的错误码。 */
export const SUPERSEDE_ORDER_VIOLATION = 'SUPERSEDE_ORDER_VIOLATION';

/**
 * 误用守卫：校验操作序列未被重排、截断或混入。
 *
 * 断言 `seq` 自 1 连续递增、`op` 取值封闭、阶段顺序符合 {@link SUPERSEDE_OP_ORDER}
 * （降级 → 取代记录 → 生效）、且 `promoteApproved` 恰好一条并位于末位。
 * 违反即抛错——顺序错误的后果（批准永久失败）远比一次显式抛错难排查，故此处宁快失败。
 *
 * @param {unknown} operations {@link supersedeOnApprove} 产出的 `operations`
 * @throws {Error & {code: string}} 序列非法时抛出，`code === 'SUPERSEDE_ORDER_VIOLATION'`
 * @returns {ReadonlyArray<object>} 原序列（便于链式使用）
 */
export function assertSupersedeOperationOrder(operations) {
  const fail = (detail) => {
    const error = new Error(`版本取代操作序列非法：${detail}`);
    error.code = SUPERSEDE_ORDER_VIOLATION;
    throw error;
  };

  if (!Array.isArray(operations)) fail('operations 须为数组');
  if (operations.length === 0) fail('operations 为空，无可执行语句');

  let phase = 0;
  let promoteCount = 0;
  operations.forEach((operation, index) => {
    if (operation === null || typeof operation !== 'object') fail(`第 ${index + 1} 项不是操作对象`);
    if (operation.seq !== index + 1) fail(`第 ${index + 1} 项 seq=${operation.seq}，序号不连续（疑被重排）`);
    const stage = SUPERSEDE_OP_ORDER.indexOf(operation.op);
    if (stage < 0) fail(`第 ${index + 1} 项 op=${String(operation.op)} 不属封闭取值`);
    if (stage < phase) {
      fail(
        `第 ${index + 1} 项 ${operation.op} 出现在 ${SUPERSEDE_OP_ORDER[phase]} 之后，` +
          '违反「先降级、后生效」顺序（颠倒将撞部分唯一索引并整体回滚）',
      );
    }
    phase = stage;
    if (operation.op === SUPERSEDE_OP.PROMOTE_APPROVED) promoteCount += 1;
  });

  if (promoteCount !== 1) fail(`promoteApproved 应恰好 1 条，实为 ${promoteCount} 条`);
  if (operations[operations.length - 1].op !== SUPERSEDE_OP.PROMOTE_APPROVED) {
    fail('promoteApproved 须为最后一条语句');
  }
  return operations;
}

/**
 * 按序执行取代方案——服务层的推荐入口（须在 `better-sqlite3` 事务内调用）。
 *
 * 服务层**交出执行器**而不自行遍历 `operations`：顺序由本函数保证，调用方拿不到重排的机会。
 * 本函数自身无 I/O，全部副作用由传入的 `applyOperation` 承担。
 *
 * `plan.ok === false` 时不执行任何操作，原样返回该方案的拒绝信息。
 *
 * @param {{ok: boolean, operations: ReadonlyArray<object>}} plan {@link supersedeOnApprove} 的返回值
 * @param {(operation: object, index: number) => unknown} applyOperation 单条操作的执行器
 * @returns {{ok: boolean, rejection: string|null, applied: readonly unknown[]}}
 * @throws {Error & {code: string}} 序列被重排时抛 {@link SUPERSEDE_ORDER_VIOLATION}
 */
export function runSupersedePlan(plan, applyOperation) {
  if (plan === null || typeof plan !== 'object') {
    const error = new Error('版本取代操作序列非法：plan 须为 supersedeOnApprove 的返回值');
    error.code = SUPERSEDE_ORDER_VIOLATION;
    throw error;
  }
  if (plan.ok !== true) {
    return Object.freeze({
      ok: false,
      rejection: plan.rejection ?? null,
      applied: Object.freeze([]),
    });
  }
  if (typeof applyOperation !== 'function') {
    const error = new Error('版本取代操作序列非法：applyOperation 须为函数');
    error.code = SUPERSEDE_ORDER_VIOLATION;
    throw error;
  }

  assertSupersedeOperationOrder(plan.operations);
  const applied = plan.operations.map((operation, index) => applyOperation(operation, index));
  return Object.freeze({ ok: true, rejection: null, applied: Object.freeze(applied) });
}
