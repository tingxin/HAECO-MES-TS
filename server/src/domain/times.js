/**
 * 起止时间聚合与时序校验（纯函数）。
 *
 * 工卡级起止时间的唯一落位是 `job.start_time` / `job.finish_time`（需求 33.1、设计 Property 31），
 * 由本 JOB 全部 `job_process` 行聚合而来。本模块**只做聚合与判定，不触库、不写库**：
 * 服务层（任务 13.6）在报工开始/完成后调用 `computeCardTimes()`，把结果写回 `job` 行。
 *
 * 核心不对称（需求 33.5 vs 33.6，Property 18 的要点）：
 * - **开始时间**：只要**任意一道**工序已开始即存在，等于最早工序开始时间；
 * - **结束时间**：**当且仅当全部工序均已完成**时才存在，等于最晚工序结束时间；
 *   只要还有一道工序未完成，工卡结束时间**恒为空**（`null`），绝不取「已完成工序中的最晚值」。
 *
 * ## 时间比较方式（显式决策，非默认行为）
 *
 * 时间在 SQLite 中以 TEXT 存 ISO 8601 字符串。本模块**一律按解析后的时间点（epoch 毫秒）比较**，
 * 而非字典序比较。理由：字典序仅在「格式一致、零填充、时区偏移相同」时才与时间顺序一致，
 * 一旦混入不同偏移（`2024-01-01T08:00:00+08:00` 与 `2024-01-01T00:00:00Z` 为同一时刻，
 * 字典序却判为前者更大）或省略秒/毫秒，字典序即给出错误结论。起止时间是适航可追溯性证据，
 * 不接受这种隐式风险。
 *
 * 相应地：**输出恒为输入中的原始字符串**（不重新序列化），持久化文本保持逐字节不变；
 * 解析仅用于挑选「最早/最晚」与时序判定。无法解析的时间戳视为**输入缺陷**并抛错，
 * 而不是静默丢弃——丢弃会让聚合结果偏移到一个看似合理却错误的值。
 *
 * 需求：33.3–33.6, 33.8
 */

/** 读取字段，兼容仓储层 camelCase 与原始行 snake_case 两种形态。 */
function pick(row, camel, snake) {
  const value = row[camel] !== undefined ? row[camel] : row[snake];
  return value === undefined ? null : value;
}

/** 时间值是否「存在」：null / undefined / 空串 / 纯空白一律视为未记录。 */
function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * 解析为 epoch 毫秒。仅接受 ISO 8601 字符串或 Date 实例；不可解析即抛错。
 * @param {string|Date} value
 * @param {string} label 出错时用于定位的字段说明
 * @returns {number}
 */
function toEpoch(value, label) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError(`${label}: Invalid Date 实例`);
    return ms;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${label}: 时间须为 ISO 8601 字符串或 Date，实际为 ${typeof value}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`${label}: 无法解析为 ISO 8601 时间："${value}"`);
  }
  return ms;
}

/**
 * 时序校验（需求 33.8）：两值同时存在时，结束时间不得早于开始时间；相等视为合法。
 * 任一值缺失时无可比对象，返回 `true`（不构成违规）。
 *
 * @param {string|Date|null|undefined} start 开始时间
 * @param {string|Date|null|undefined} finish 结束时间
 * @returns {boolean} 结束时间不早于开始时间
 */
export function isChronological(start, finish) {
  if (!isPresent(start) || !isPresent(finish)) return true;
  return toEpoch(finish, 'finishTime') >= toEpoch(start, 'startTime');
}

/**
 * 由工序起止时间聚合出工卡（JOB）级起止时间。
 *
 * @param {Array<{startTime?: string|null, finishTime?: string|null, processId?: string}>} [processTimes]
 *        本 JOB 的全部工序时间记录。**必须是全集**：缺行会让「全部完成」判定失真。
 *        `null`/`undefined` 等同空数组（尚无工序 → 无起止时间）。
 * @returns {{
 *   startTime: string|null,
 *   finishTime: string|null,
 *   processCount: number,
 *   startedCount: number,
 *   finishedCount: number,
 *   allFinished: boolean,
 *   hasUnfinished: boolean,
 *   chronological: boolean,
 *   violations: Array<{index: number, processId: string|null, startTime: string, finishTime: string}>
 * }}
 *   - `startTime`：最早工序开始时间；无工序已开始时为 `null`（需求 33.5）
 *   - `finishTime`：**仅** `allFinished` 为真时存在，等于最晚工序结束时间；否则恒为 `null`（需求 33.6）
 *   - `allFinished`：工序数 > 0 **且**全部工序均有结束时间。空集合判为 `false`——
 *     零工序不构成「全部完成」，避免空 JOB 凭空得到结束时间。
 *     由此 `finishTime !== null` 与 `allFinished` 互为充要条件，Property 18 可直接断言。
 *   - `hasUnfinished`：存在未完成工序；为真时 `finishTime` 恒为 `null`
 *   - `chronological`：工卡级 `isChronological(startTime, finishTime)`
 *   - `violations`：工序级时序违规明细（该工序 finish 早于 start，需求 33.8）
 * @throws {TypeError} 入参非数组、元素非对象，或时间戳无法解析
 */
export function computeCardTimes(processTimes) {
  const rows = processTimes === null || processTimes === undefined ? [] : processTimes;
  if (!Array.isArray(rows)) {
    throw new TypeError('computeCardTimes: processTimes 须为数组');
  }

  let startTime = null;
  let startEpoch = Number.POSITIVE_INFINITY;
  let finishTime = null;
  let finishEpoch = Number.NEGATIVE_INFINITY;
  let startedCount = 0;
  let finishedCount = 0;
  const violations = [];

  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object') {
      throw new TypeError(`computeCardTimes: processTimes[${index}] 须为对象`);
    }
    const rawStart = pick(row, 'startTime', 'start_time');
    const rawFinish = pick(row, 'finishTime', 'finish_time');
    const processId = pick(row, 'processId', 'process_id');

    if (isPresent(rawStart)) {
      startedCount += 1;
      const epoch = toEpoch(rawStart, `processTimes[${index}].startTime`);
      if (epoch < startEpoch) {
        startEpoch = epoch;
        startTime = rawStart;
      }
    }

    if (isPresent(rawFinish)) {
      finishedCount += 1;
      const epoch = toEpoch(rawFinish, `processTimes[${index}].finishTime`);
      if (epoch > finishEpoch) {
        finishEpoch = epoch;
        finishTime = rawFinish;
      }
    }

    if (!isChronological(rawStart, rawFinish)) {
      violations.push({ index, processId, startTime: rawStart, finishTime: rawFinish });
    }
  });

  const processCount = rows.length;
  // 空集合不算「全部完成」：零工序不得凭空产出工卡结束时间。
  const allFinished = processCount > 0 && finishedCount === processCount;
  const hasUnfinished = processCount > 0 && finishedCount < processCount;

  // 需求 33.6 的硬闸门：只要有一道工序未完成，工卡结束时间就被清空——
  // 已完成工序的最晚结束时间在此**不得**泄漏为工卡结束时间。
  const cardFinishTime = allFinished ? finishTime : null;

  return {
    startTime,
    finishTime: cardFinishTime,
    processCount,
    startedCount,
    finishedCount,
    allFinished,
    hasUnfinished,
    chronological: isChronological(startTime, cardFinishTime),
    violations,
  };
}
