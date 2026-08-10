/**
 * 工卡作废前置校验领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 10.3 的三项能力：
 * - `classifyVoidReferences(refs)`           三类引用识别与「在编 / 历史」工包引用区分（需求 42.1、42.3）
 * - `checkVoidPrecondition(card, refs, reason)` 作废前置校验：任一阻止性引用或原因为空即拒绝（需求 42.1、42.2、42.5）
 * - `isSelectableForNewPackage(card)`        作废（及已被取代）版本不可被新工包选用（需求 42.4）
 *
 * ## 判定边界（Property 24）
 *
 * 作废被接受**当且仅当**：不存在三类阻止性引用 **且** 作废原因非空。除此之外本函数不加任何前置：
 * 状态迁移合法性（如已作废版本不可再次作废）属 `card-rules.js` 的 `canTransition` 职责，
 * 服务层组合二者，本模块不重复判定，以免把两个正交约束混成一个不可解释的布尔。
 *
 * ## 三类阻止性引用（需求 42.1）
 *
 * | 类型 | 判定 | 出处 |
 * |------|------|------|
 * | (a) 执行中 JOB | `job.exec_status === 'InProgress'` | `job` 表 |
 * | (b) 已生成但尚未开始执行的 JOB | 已生成 JOB 且 `exec_status !== 'Completed'` 且非执行中（含 `Pending` 与**空值**） | `job` 表 |
 * | (c) 在编（尚未释放）工包已选入 | `GET /api/work-packages/in-progress-refs?cardId=` 契约端点 | WPL 模块 |
 *
 * `exec_status` 在 `schema.sql` 中可为 NULL。JOB 一经生成即为计划端持有的执行凭据，故
 * **未标记为 `Completed` 的 JOB 一律阻止作废**：`InProgress` 归 (a)，其余（`Pending` / 空值 /
 * 取值集外的脏数据）归 (b)——「已生成而未完成」即「计划端可能持有待执行 JOB」，这正是需求 42.2
 * 要避免的悬空场景。反之 `Completed` 的 JOB 是**已完结的历史执行记录**，不在 42.1 的枚举内，不阻止作废。
 *
 * ## 在编工包引用（阻止）与历史工包引用（不阻止）的区分 ⚠
 *
 * 这是本模块最容易做错的一处：两者都是「工包引用了这张工卡」，但语义相反。
 * - **在编（尚未释放）工包**：工包还在编排，选入的工卡尚未落成执行凭据。此时作废会让计划端
 *   持有一张已作废的工卡 → **阻止作废**（需求 42.1(c)）。
 * - **历史（已释放）工包**：引用已凝固为该工包的版本记录，作废当前工卡**不回溯改写**这份记录
 *   → **允许作废**，且历史工包中已引用的工卡版本记录保持不变（需求 42.3）。本模块为纯函数，
 *   不触碰任何历史记录；`historicalRefs` 仅原样回显供服务层与界面提示，落库路径不得据此更新工包。
 *
 * 判定采用「双侧一致才算历史」的保守规则（详见 {@link classifyVoidReferences}）：
 * 归入历史需分桶与行上释放标记不矛盾；**判不出来或两侧矛盾一律按在编处理（阻止作废）**——
 * 误拦一次作废可由业务方澄清后重试，漏拦则让计划端持有悬空引用，代价不对称。
 *
 * ## 与其它模块的关系
 *
 * - 原因必填与 `change-record.js` 的 `REASON_REQUIRED` 同义同码：作废通过后仍须经
 *   `buildChangeRecords(..., 'void', reason, ...)` 落 `void` 类型留痕（需求 42.5），
 *   两处对「空或纯空白」的判定必须一致，否则会出现「前置放行、留痕拒绝」的裂缝。
 * - `isSelectableForNewPackage` 只管**状态维度**（需求 42.4、Property 26）；Load Standard Package
 *   取卡另有 Stage 维度约束，见 `stage-constraint.js` 的 `selectableForStandardPackage`。
 *
 * 需求：42.1、42.2、42.3、42.4、42.5
 */

import { statusOf } from './card-rules.js';

/** JOB 已完结的执行状态——唯一不阻止作废的 `job.exec_status` 取值（需求 42.1 未列举完结 JOB） */
const JOB_STATUS_COMPLETED = 'Completed';
/** JOB 执行中（需求 42.1(a)） */
const JOB_STATUS_IN_PROGRESS = 'InProgress';

/** 不可被新工包选用的终态（需求 42.4、44.5，Property 26） */
const NOT_SELECTABLE_STATUS = Object.freeze(['Void', 'Superseded']);

/**
 * 阻止性引用类型词表（需求 42.2 要求向用户提示**具体的引用类型**）。
 * 与 {@link VOID_REFERENCE_LABELS} 一一对应。
 */
export const VOID_REFERENCE_TYPES = Object.freeze({
  /** (a) 处于执行中的关联 JOB */
  JOB_IN_PROGRESS: 'JOB_IN_PROGRESS',
  /** (b) 已生成但尚未开始执行的关联 JOB（含 `Pending` 与状态空值） */
  JOB_NOT_STARTED: 'JOB_NOT_STARTED',
  /** (c) 在编（尚未释放）工包中已选入该工卡 */
  IN_PROGRESS_PACKAGE: 'IN_PROGRESS_PACKAGE',
});

/** 非阻止性引用类型：历史（已释放）工包引用（需求 42.3） */
export const HISTORICAL_REFERENCE_TYPE = 'HISTORICAL_PACKAGE';

/** 引用类型中文标签——服务层与界面直接取用，保证提示文案单点维护。 */
export const VOID_REFERENCE_LABELS = Object.freeze({
  [VOID_REFERENCE_TYPES.JOB_IN_PROGRESS]: '执行中 JOB',
  [VOID_REFERENCE_TYPES.JOB_NOT_STARTED]: '已生成未开始执行的 JOB',
  [VOID_REFERENCE_TYPES.IN_PROGRESS_PACKAGE]: '在编（尚未释放）工包已选入',
  [HISTORICAL_REFERENCE_TYPE]: '历史（已释放）工包引用',
});

/** 拒绝原因词表。`REASON_REQUIRED` 与 `change-record.js` 的同名码同义（须保持一致）。 */
export const VOID_REJECTION = Object.freeze({
  /** 存在需求 42.1 所列任一引用 → 服务层映射 422 */
  BLOCKING_REFERENCES: 'BLOCKING_REFERENCES',
  /** 作废原因为空或纯空白（需求 42.5） → 服务层映射 400 */
  REASON_REQUIRED: 'REASON_REQUIRED',
});

/**
 * 空白判定——与 `change-record.js` 的同名内部判定逐字一致（含全角空格 U+3000）。
 * 两处必须同义：作废前置放行的原因，必须能被留痕构造接受。
 */
function isBlank(value) {
  if (typeof value === 'string') {
    return value.trim().length === 0 || /^[\s\u3000]*$/.test(value);
  }
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'bigint') return false;
  return true;
}

/** 取行上第一个存在的字段，兼容 camelCase / snake_case 两种写法。 */
function pickField(row, keys) {
  if (row === null || typeof row !== 'object') return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** 取 `refs` 上第一个存在的数组来源；未给出该来源时返回空数组。 */
function pickRows(refs, keys) {
  const raw = pickField(refs, keys);
  return Array.isArray(raw) ? raw : [];
}

/** 归一化为可读文本；取不到时返回 `null`。 */
function asLabel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim().length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/**
 * `exec_status` 归一化：容忍大小写与 `in_progress` / `in-progress` 等写法差异。
 * 取值集外或缺失一律返回 `null`（由调用方按「已生成未完成」从严归类）。
 */
function normalizeExecStatus(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (key === 'inprogress') return JOB_STATUS_IN_PROGRESS;
  if (key === 'completed') return JOB_STATUS_COMPLETED;
  if (key === 'pending') return 'Pending';
  return null;
}

/**
 * 工包引用行的**释放标记**三态判定：
 * `true` 已释放（历史）、`false` 未释放（在编）、`null` 行上未给出标记。
 *
 * 接受 `released` / `is_released`（布尔、0/1、`'1'` / `'true'`）与工包状态字面量
 * （`Released` / `Historical` / `Closed` / `Completed` → 已释放；
 *  `Draft` / `New` / `Editing` / `InProgress` / `Unreleased` / `Pending` → 未释放）。
 */
function releasedFlagOf(row) {
  const flag = pickField(row, ['released', 'isReleased', 'is_released']);
  if (flag !== undefined) {
    if (typeof flag === 'boolean') return flag;
    if (typeof flag === 'number') return flag !== 0;
    if (typeof flag === 'string') {
      const key = flag.trim().toLowerCase();
      if (key === '1' || key === 'true' || key === 'y' || key === 'yes') return true;
      if (key === '0' || key === 'false' || key === 'n' || key === 'no') return false;
    }
  }
  const status = pickField(row, ['packageStatus', 'package_status', 'status', 'state']);
  if (typeof status === 'string') {
    const key = status.trim().toLowerCase().replace(/[\s_-]/g, '');
    if (['released', 'historical', 'history', 'closed', 'completed', 'archived'].includes(key)) return true;
    if (['draft', 'new', 'editing', 'inprogress', 'unreleased', 'pending', 'open', 'wip'].includes(key)) return false;
  }
  const releasedAt = pickField(row, ['releasedAt', 'released_at', 'releaseTime', 'release_time', 'releaseDate']);
  if (releasedAt !== undefined) return true;
  return null;
}

/** JOB 引用行 → 结构化引用条目（`location` 供需求 42.2 的「引用位置」提示）。 */
function toJobReference(row, index) {
  const status = normalizeExecStatus(pickField(row, ['exec_status', 'execStatus', 'status']));
  const type =
    status === JOB_STATUS_IN_PROGRESS
      ? VOID_REFERENCE_TYPES.JOB_IN_PROGRESS
      : VOID_REFERENCE_TYPES.JOB_NOT_STARTED;
  const jobNo = asLabel(pickField(row, ['job_no', 'jobNo', 'no', 'id']));
  const pid = asLabel(pickField(row, ['pid', 'PID', 'pid_no', 'pidNo']));
  const location = [jobNo === null ? `JOB[${index}]` : `JOB ${jobNo}`, pid === null ? null : `PID ${pid}`]
    .filter((part) => part !== null)
    .join(' / ');
  return Object.freeze({
    type,
    typeLabel: VOID_REFERENCE_LABELS[type],
    location,
    jobNo,
    packageNo: null,
    pid,
    execStatus: status,
    blocking: true,
  });
}

/** 工包引用行 → 结构化引用条目。`blocking` 由在编 / 历史判定给出。 */
function toPackageReference(row, index, blocking) {
  const type = blocking ? VOID_REFERENCE_TYPES.IN_PROGRESS_PACKAGE : HISTORICAL_REFERENCE_TYPE;
  const packageNo = asLabel(
    pickField(row, ['package_no', 'packageNo', 'work_package_no', 'workPackageNo', 'wpNo', 'no', 'id']),
  );
  const pid = asLabel(pickField(row, ['pid', 'PID', 'pid_no', 'pidNo']));
  const cardRevision = pickField(row, ['card_revision', 'cardRevision', 'revision']);
  const location = [
    packageNo === null ? `工包[${index}]` : `工包 ${packageNo}`,
    pid === null ? null : `PID ${pid}`,
  ]
    .filter((part) => part !== null)
    .join(' / ');
  return Object.freeze({
    type,
    typeLabel: VOID_REFERENCE_LABELS[type],
    location,
    jobNo: null,
    packageNo,
    pid,
    cardRevision: cardRevision === undefined ? null : cardRevision,
    blocking,
  });
}

/**
 * 三类阻止性引用识别 + 历史工包引用分离（需求 42.1、42.3）。
 *
 * ## 接受的 `refs` 形态
 *
 * ```
 * {
 *   jobs:                [{ job_no, exec_status, pid }],   // 别名：relatedJobs / jobRefs
 *   inProgressPackages:  [{ package_no, pid }],            // 别名：inProgressRefs / inProgressPackageRefs
 *   historicalPackages:  [{ package_no, pid, card_revision }], // 别名：historicalRefs / releasedPackages
 *   workPackages:        [{ package_no, released }],       // 未分桶来源：别名 packages / packageRefs
 * }
 * ```
 *
 * 直接传入数组时按 `jobs` 解释（最常见的单来源调用）；`null` / `undefined` / 非对象视为无引用。
 * `refs` 假定已由服务层按 `cardId` 取数（前两类查 `job.exec_status`，第三类查
 * `GET /api/work-packages/in-progress-refs`），本模块不再按卡过滤。
 *
 * ## 在编 / 历史的保守判定
 *
 * | 分桶 | 行上释放标记 | 判定 |
 * |------|--------------|------|
 * | `historicalPackages` | 无 / 已释放 | 历史（不阻止） |
 * | `historicalPackages` | 未释放（矛盾） | 在编（**阻止**） |
 * | `inProgressPackages` | 无 / 未释放 | 在编（阻止） |
 * | `inProgressPackages` | 已释放（矛盾） | 在编（**阻止**，分桶优先） |
 * | `workPackages`（未分桶） | 已释放 | 历史（不阻止） |
 * | `workPackages`（未分桶） | 未释放 / 无标记 | 在编（**阻止**） |
 *
 * 即：**只有被明确判定为已释放且无矛盾信号的工包引用才算历史引用**，其余一律阻止。
 *
 * @param {unknown} refs 见上
 * @returns {{ blockingRefs: ReadonlyArray<object>, historicalRefs: ReadonlyArray<object>,
 *             hasBlocking: boolean, blockingTypes: readonly string[] }}
 */
export function classifyVoidReferences(refs) {
  const source = Array.isArray(refs) ? { jobs: refs } : refs;
  const blocking = [];
  const historical = [];

  // 前两类：JOB 引用。未标记为 Completed 的 JOB 一律阻止（InProgress 归 (a)，其余归 (b)）
  pickRows(source, ['jobs', 'relatedJobs', 'jobRefs', 'job', 'jobReferences']).forEach((row, index) => {
    if (row === null || typeof row !== 'object') return;
    const status = normalizeExecStatus(pickField(row, ['exec_status', 'execStatus', 'status']));
    if (status === JOB_STATUS_COMPLETED) return; // 已完结的历史执行记录，不在需求 42.1 枚举内
    blocking.push(toJobReference(row, index));
  });

  // 第三类：在编工包引用。分桶为权威；行上标记矛盾时按在编从严处理
  pickRows(source, ['inProgressPackages', 'inProgressRefs', 'inProgressPackageRefs', 'inProgressWorkPackages'])
    .forEach((row, index) => {
      if (row === null || typeof row !== 'object') return;
      blocking.push(toPackageReference(row, index, true));
    });

  // 历史工包引用：允许作废，且其版本记录保持不变（需求 42.3）；仅当无「未释放」矛盾信号时才归此桶
  pickRows(source, ['historicalPackages', 'historicalRefs', 'historicalPackageRefs', 'releasedPackages'])
    .forEach((row, index) => {
      if (row === null || typeof row !== 'object') return;
      if (releasedFlagOf(row) === false) {
        blocking.push(toPackageReference(row, index, true));
        return;
      }
      historical.push(toPackageReference(row, index, false));
    });

  // 未分桶来源：须自行携带「已释放」标记才判为历史，判不出来一律阻止
  pickRows(source, ['workPackages', 'packages', 'packageRefs', 'workPackageRefs']).forEach((row, index) => {
    if (row === null || typeof row !== 'object') return;
    if (releasedFlagOf(row) === true) {
      historical.push(toPackageReference(row, index, false));
      return;
    }
    blocking.push(toPackageReference(row, index, true));
  });

  const blockingTypes = [];
  for (const ref of blocking) {
    if (!blockingTypes.includes(ref.type)) blockingTypes.push(ref.type);
  }

  return Object.freeze({
    blockingRefs: Object.freeze(blocking),
    historicalRefs: Object.freeze(historical),
    hasBlocking: blocking.length > 0,
    blockingTypes: Object.freeze(blockingTypes),
  });
}

/** 拼装需求 42.2 要求的提示文案：逐条给出「引用类型 + 引用位置」。 */
function describeBlocking(blockingRefs) {
  const detail = blockingRefs
    .map((ref) => `${ref.typeLabel}（${ref.location}）`)
    .join('；');
  return `存在阻止作废的引用，无法作废：${detail}`;
}

/**
 * 作废前置校验（需求 42.1、42.2、42.5，Property 24）。
 *
 * 通过**当且仅当**：不存在三类阻止性引用 **且** `reason` 非空非纯空白。
 * 不抛异常；服务层据 `rejection` 分流：`BLOCKING_REFERENCES` → 422，`REASON_REQUIRED` → 400。
 *
 * 拒绝时 `rejection` 取**引用优先**：引用是硬约束（补什么原因都不可作废），原因缺失可当场补齐，
 * 故先报引用。两项信号在返回值中恒可分别读取（`blockingRefs` / `reasonMissing` / `rejections`），
 * 调用方无需依赖该优先级。
 *
 * 历史工包引用不进入 `blockingRefs`，仅原样回显于 `historicalRefs`（需求 42.3）：
 * 本函数为纯函数，既不改写也不要求调用方改写历史工包中已引用的工卡版本记录。
 *
 * @param {unknown} card 工卡对象（`{ id, task_no, revision, status }`，兼容 camelCase）；仅用于回显定位信息，
 *   **状态前置不在此判定**（见模块头「判定边界」）
 * @param {unknown} refs 引用聚合，见 {@link classifyVoidReferences}
 * @param {unknown} reason 作废原因（需求 42.5：为空或纯空白时拒绝，且须留存至变更记录）
 * @returns {{ ok: boolean, rejection: string|null, rejections: readonly string[], message: string,
 *             blockingRefs: ReadonlyArray<object>, blockingTypes: readonly string[],
 *             historicalRefs: ReadonlyArray<object>, reasonMissing: boolean,
 *             card: {id: unknown, taskNo: string|null, revision: unknown} }}
 */
export function checkVoidPrecondition(card, refs, reason) {
  const { blockingRefs, historicalRefs, hasBlocking, blockingTypes } = classifyVoidReferences(refs);
  const reasonMissing = isBlank(reason);

  const rejections = [];
  if (hasBlocking) rejections.push(VOID_REJECTION.BLOCKING_REFERENCES);
  if (reasonMissing) rejections.push(VOID_REJECTION.REASON_REQUIRED);

  const identity = Object.freeze({
    id: pickField(card, ['id', 'cardId', 'card_id']) ?? null,
    taskNo: asLabel(pickField(card, ['task_no', 'taskNo'])),
    revision: pickField(card, ['revision', 'card_revision', 'cardRevision']) ?? null,
  });

  const ok = rejections.length === 0;
  const rejection = ok ? null : rejections[0];
  const message = ok
    ? 'ok'
    : rejection === VOID_REJECTION.BLOCKING_REFERENCES
      ? describeBlocking(blockingRefs)
      : '作废原因为必填项，不得为空或纯空白';

  return Object.freeze({
    ok,
    rejection,
    rejections: Object.freeze(rejections),
    message,
    blockingRefs,
    blockingTypes,
    historicalRefs,
    reasonMissing,
    card: identity,
  });
}

/**
 * 作废后不可被新工包选用（需求 42.4；「已被取代」同理，见需求 44.5 与 Property 26）。
 *
 * 仅判**状态维度**：`Void` / `Superseded` 恒为假，其余状态为真。
 * Load Standard Package 取卡另需 `Stage=RTN` 且 `status=Effective`，
 * 见 `stage-constraint.js` 的 `selectableForStandardPackage`（本函数不重复其 Stage 判定）。
 *
 * 状态取不到（未知取值）时返回 `false`：无法确认可选用即不放行。
 *
 * @param {unknown} card 工卡对象或状态字符串
 * @returns {boolean}
 */
export function isSelectableForNewPackage(card) {
  const status = statusOf(card);
  if (status === null) return false;
  return !NOT_SELECTABLE_STATUS.includes(status);
}
