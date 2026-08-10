/**
 * 关键工序安全警示前置门禁领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 9.2 的单一规则（Property 16）：
 * `canEnterExecution(step, acks, userId)` —— 工序可进入执行状态**当且仅当**
 * ① 该工序未被标记为关键维修/易误操作任务（需求 31.4），**或**
 * ② 该操作人员已存在对应的安全警示查看确认记录，且记录**同时含确认人与确认时间**（需求 31.5–31.7）。
 *
 * ## 门禁作用于执行期，关键标记取自快照（Property 34、需求 49.6）
 *
 * 门禁在**执行期**针对某一 `job_process` 求值，而 JOB 的执行与呈现一律读 `job_step_snapshot.content`，
 * `job_process.step_id` 仅作溯源、不作读取依赖。因此 `isCriticalStep` 的取值优先级为：
 *
 * 1. `step.content`（`job_step_snapshot.content`，JSON 文本或已解析对象）中的 `isCritical`
 * 2. `step` 自身的 `is_critical` / `isCritical` 列（`process_step` 行，或 `buildStepSnapshots` 产出的
 *    快照内容对象被直接传入的情形）
 *
 * 即：**快照在则以快照为准**，编制域模板列仅在无快照来源时作为退路。此优先级使「释放后改模板不改变
 * 既有 JOB 的门禁行为」成立；同时保留直接传入 `process_step` 行的用法，便于编制期预览与单元测试。
 *
 * ## 确认记录的归属与完整性
 *
 * - **须为该用户本人的确认**：他人的确认记录不解锁本人的执行（需求 31.6 的门禁对象是「操作人员」个体）。
 * - **须完整**：`acknowledged_by` 与 `acknowledged_at` 二者缺一即为不完整记录，不解锁
 *   （需求 31.7 明定记录含确认人与确认时间；`schema.sql` 中两列可空，故不完整行确实可能存在）。
 * - **须属于同一 JOB 工序**：`acks` 按签名语义为「该工序的确认记录集合」，通常由
 *   `safetyAckRepo` 按 `job_process_id` 查出。若确认行带 `job_process_id` 且工序侧亦可判定
 *   `job_process_id`，两者不一致的行**不计入**（跨工序的确认不解锁本工序）；未带该字段的行
 *   视为调用方已按工序过滤，直接参与匹配。
 *
 * ## 失败即拒绝（fail-closed）
 *
 * - `step` 非对象 → 无从判定关键标记 → 拒绝（`INVALID_STEP`）。
 * - 关键标记取值存在但无法识别为 0/1 → 从严视为**关键**（须确认方可进入）。
 * - 关键工序而 `userId` 缺失或空白 → 拒绝（`INVALID_USER`）：无法判定确认归属。
 *   非关键工序不涉及确认归属，`userId` 不参与判定（与 Property 16 的「当且仅当」表述一致）。
 *
 * 服务层据 `ok === false` 返回 **422**（见 design.md 错误处理表：「关键工序未确认安全警示 → 阻止该工序进入执行状态」）。
 *
 * 需求：31.4、31.5、31.6、31.7
 */

/** 门禁拒绝原因码（服务层据此给出可区分提示，一律映射 422） */
export const SAFETY_REJECTION = Object.freeze({
  /** 关键工序缺少该用户的完整查看确认记录（需求 31.6、31.7） */
  NOT_ACKNOWLEDGED: 'notAcknowledged',
  /** 工序入参不可判定（非对象），关键标记无从读取 */
  INVALID_STEP: 'invalidStep',
  /** 关键工序而操作人员标识缺失，确认归属无从判定 */
  INVALID_USER: 'invalidUser',
});

const REJECTION_MESSAGES = Object.freeze({
  [SAFETY_REJECTION.NOT_ACKNOWLEDGED]: '关键工序须先确认查看安全警示、视觉提示与维修技巧内容后方可进入执行',
  [SAFETY_REJECTION.INVALID_STEP]: '工序数据不可判定，无法校验安全警示门禁',
  [SAFETY_REJECTION.INVALID_USER]: '操作人员标识缺失，无法校验安全警示确认记录归属',
});

/**
 * 标识归一化：字符串去首尾空白，有限数值转字符串；取不到非空标识时返回 `null`。
 * （`app_user.staff_no` 为 TEXT，`app_user.id` / `job_process.id` 为 INTEGER，两类写法均可能出现。）
 * @param {unknown} value
 * @returns {string | null}
 */
function identity(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 取对象上第一个非 null/undefined 的字段值，兼容 snake_case 与 camelCase 两种写法。 */
function pickField(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * 解析 `job_step_snapshot.content`：JSON 文本或已解析对象；解析失败或非对象时返回 `null`
 * （随即退化为读取 `step` 自身列，而非直接放行）。
 * @param {unknown} step
 * @returns {object | null}
 */
function snapshotContentOf(step) {
  const raw = pickField(step, ['content', 'snapshotContent', 'snapshot_content']);
  if (raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 关键标记归一化：SQLite 存 0/1，亦接受布尔与 `'1'` / `'true'`。
 * **无法识别的取值一律视为关键**（从严，拒绝优于放行）。
 * @param {unknown} value 已确认存在（非 null/undefined）的取值
 * @returns {boolean}
 */
function toCriticalFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === '0' || text === 'false' || text === '') return false;
    return true; // '1' / 'true' / 其它不可识别取值 → 从严视为关键
  }
  return true;
}

/**
 * 工序是否被标记为关键维修 / 易误操作任务（需求 31.4）。
 *
 * 取值优先 `job_step_snapshot.content.isCritical`，无快照来源时退化为 `step` 自身的
 * `is_critical` / `isCritical` 列。两处均无该字段时视为**未标记**（`process_step.is_critical`
 * 为 `NOT NULL DEFAULT 0`，字段缺席即默认 0）。`step` 非对象时返回 `false`——该情形由
 * {@link canEnterExecution} 以 `INVALID_STEP` 单独拒绝，不在此处混淆语义。
 *
 * @param {unknown} step `job_step_snapshot` 行、快照内容对象或 `process_step` 行
 * @returns {boolean}
 */
export function isCriticalStep(step) {
  if (step === null || typeof step !== 'object') return false;

  const content = snapshotContentOf(step);
  if (content !== null) {
    const fromSnapshot = pickField(content, ['isCritical', 'is_critical']);
    if (fromSnapshot !== undefined) return toCriticalFlag(fromSnapshot);
  }

  const fromStep = pickField(step, ['is_critical', 'isCritical']);
  if (fromStep === undefined) return false;
  return toCriticalFlag(fromStep);
}

/**
 * 确认记录是否完整（需求 31.7）：`acknowledged_by` 与 `acknowledged_at` **同时**为非空值。
 * 缺任一项即为不完整记录，不足以解锁执行。
 * @param {unknown} ack `safety_acknowledgement` 行或等价对象
 * @returns {boolean}
 */
export function isCompleteAcknowledgement(ack) {
  if (ack === null || typeof ack !== 'object') return false;
  const by = identity(pickField(ack, ['acknowledged_by', 'acknowledgedBy']));
  const at = identity(pickField(ack, ['acknowledged_at', 'acknowledgedAt']));
  return by !== null && at !== null;
}

/** 工序侧可判定的 `job_process` 标识；取不到时为 `null`（此时不做跨工序过滤）。 */
function jobProcessIdOf(step) {
  return identity(pickField(step, ['job_process_id', 'jobProcessId', 'jobProcessID']));
}

/**
 * 在确认记录集合中查出「该用户 ∧ 完整 ∧ 属于本工序」的首条记录；无则返回 `null`。
 *
 * @param {unknown} acks 确认记录集合
 * @param {string} userId 已归一化的操作人员标识
 * @param {string | null} jobProcessId 工序侧可判定的 `job_process` 标识；`null` 表示不做归属过滤
 * @returns {object | null}
 */
function findAcknowledgement(acks, userId, jobProcessId) {
  if (!Array.isArray(acks)) return null;
  for (const ack of acks) {
    if (!isCompleteAcknowledgement(ack)) continue; // 不完整记录不解锁（需求 31.7）
    if (identity(pickField(ack, ['acknowledged_by', 'acknowledgedBy'])) !== userId) continue; // 须本人确认
    if (jobProcessId !== null) {
      const ackProcessId = identity(pickField(ack, ['job_process_id', 'jobProcessId', 'jobProcessID']));
      if (ackProcessId !== null && ackProcessId !== jobProcessId) continue; // 跨工序确认不解锁本工序
    }
    return ack;
  }
  return null;
}

function result(ok, rejection, isCritical, acknowledgement) {
  return Object.freeze({
    ok,
    rejection,
    message: rejection === null ? 'ok' : REJECTION_MESSAGES[rejection],
    isCritical,
    acknowledgement,
  });
}

/**
 * 关键工序安全警示前置门禁（需求 31.4–31.7，Property 16）。
 *
 * `ok === true` **当且仅当**：工序未标记关键，**或**该操作人员存在含确认人与确认时间的
 * 完整查看确认记录。他人的确认、不完整的确认、跨工序的确认一律不解锁。
 *
 * @param {object|null|undefined} step `job_step_snapshot` 行（含 `content`）、快照内容对象或 `process_step` 行
 * @param {ReadonlyArray<object>|null|undefined} acks 该工序的 `safety_acknowledgement` 记录集合
 * @param {string|number|null|undefined} acks[].acknowledged_by 确认人（需求 31.7）
 * @param {string|number|null|undefined} userId 操作人员标识（工号或用户 id），须与 `acknowledged_by` 同一口径
 * @returns {{ok: boolean, rejection: string|null, message: string, isCritical: boolean,
 *   acknowledgement: object|null}} `ok === true` 且工序为关键时，`acknowledgement` 为命中的确认记录
 */
export function canEnterExecution(step, acks, userId) {
  if (step === null || typeof step !== 'object') {
    // 关键标记不可判定 → 拒绝优于放行
    return result(false, SAFETY_REJECTION.INVALID_STEP, false, null);
  }

  const critical = isCriticalStep(step);
  if (!critical) {
    // 未标记关键：无查看确认前置，直接放行（需求 31.5 的门禁仅作用于被标记工序）
    return result(true, null, false, null);
  }

  const operator = identity(userId);
  if (operator === null) {
    return result(false, SAFETY_REJECTION.INVALID_USER, true, null);
  }

  const ack = findAcknowledgement(acks, operator, jobProcessIdOf(step));
  if (ack === null) {
    return result(false, SAFETY_REJECTION.NOT_ACKNOWLEDGED, true, null);
  }
  return result(true, null, true, ack);
}
