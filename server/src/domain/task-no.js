/**
 * 工卡编号（Task No）批量生成 —— 纯领域函数，不触库。
 *
 * 需求 38.8：批量复制依可配置规则（前缀、后缀、起始序号、步长）自动生成不重复 Task No。
 * 需求 38.9：自动生成的编号与现存工卡重复时，自动跳至下一可用序号直至不重复。
 * 需求 38.10：批量完成后允许逐张调整，调整仍走查重——故本模块只负责"依规则算出一批不与
 *   `existing` 冲突的编号"，事后调整的查重由服务层用同一 `existing` 口径复校。
 *
 * 规则对象与 `task_no_sequence` 表（prefix / suffix / next_seq / step）同构，
 * DB 行可直接传入；`prefix`/`suffix` 在库中 NOT NULL DEFAULT ''，本模块亦以 '' 为缺省。
 *
 * 编号形如 `${prefix}${seq}${suffix}`，`seq` 以十进制无前导零渲染。
 * `existing` 中**不匹配本规则**的编号（前后缀不符、中段非纯数字、带前导零等非规范写法）
 * 不占用任何序号——否则批量生成会无谓跳号。
 */

/** 起始序号缺省值，与 `task_no_sequence.next_seq` 的 DDL 缺省一致。 */
const DEFAULT_NEXT_SEQ = 1;

/** 步长缺省值，与 `task_no_sequence.step` 的 DDL 缺省一致。 */
const DEFAULT_STEP = 1;

/** 正则字面量转义：前后缀为用户配置的任意文本，须按字面匹配。 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 前后缀归一：`null`/`undefined` 落 ''，非字符串一律拒绝（避免 `123` 静默变 '123'）。 */
function normalizeAffix(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new TypeError(`编号规则 ${name} 需为字符串或空，收到：${String(value)}`);
  }
  return value;
}

/**
 * 规则归一化：读 `next_seq`（兼容 camelCase 的 `nextSeq`）与 `step`，校验取值域。
 * @param {{prefix?: string, suffix?: string, next_seq?: number, nextSeq?: number, step?: number}} rule
 * @returns {{prefix: string, suffix: string, nextSeq: number, step: number}}
 */
function normalizeRule(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new TypeError(`编号规则需为对象，收到：${String(rule)}`);
  }

  const prefix = normalizeAffix(rule.prefix, 'prefix');
  const suffix = normalizeAffix(rule.suffix, 'suffix');

  const rawNextSeq = rule.next_seq ?? rule.nextSeq ?? DEFAULT_NEXT_SEQ;
  if (!Number.isSafeInteger(rawNextSeq) || rawNextSeq < 0) {
    throw new TypeError(`编号规则 next_seq 需为非负安全整数，收到：${String(rawNextSeq)}`);
  }

  const rawStep = rule.step ?? DEFAULT_STEP;
  if (!Number.isSafeInteger(rawStep) || rawStep < 1) {
    throw new TypeError(`编号规则 step 需为不小于 1 的安全整数，收到：${String(rawStep)}`);
  }

  return { prefix, suffix, nextSeq: rawNextSeq, step: rawStep };
}

/**
 * 按规则渲染序号为 Task No。
 * @param {object} rule 编号规则（同 `generateTaskNoBatch`）
 * @param {number} seq 序号（非负安全整数）
 * @returns {string}
 */
export function formatTaskNo(rule, seq) {
  const { prefix, suffix } = normalizeRule(rule);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError(`序号需为非负安全整数，收到：${String(seq)}`);
  }
  return `${prefix}${seq}${suffix}`;
}

/**
 * 从 Task No 反解序号；不由本规则生成的编号返回 `null`。
 *
 * 判定以"渲染可逆"为准：解析出的序号回渲后须与原串**逐字符相等**，
 * 故 `TC-007`（前导零）不视为占用 7 号——`TC-7` 才是本规则的 7 号。
 *
 * @param {object} rule 编号规则
 * @param {unknown} taskNo 待判定编号
 * @returns {number | null}
 */
export function parseTaskNoSeq(rule, taskNo) {
  if (typeof taskNo !== 'string') return null;
  const { prefix, suffix } = normalizeRule(rule);
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)${escapeRegExp(suffix)}$`);
  const matched = pattern.exec(taskNo);
  if (matched === null) return null;
  const seq = Number(matched[1]);
  if (!Number.isSafeInteger(seq)) return null;
  if (`${prefix}${seq}${suffix}` !== taskNo) return null;
  return seq;
}

/** 收集 `existing` 中归属本规则的序号；不匹配者直接丢弃（不占号）。 */
function collectOccupiedSequences(rule, existing) {
  const occupied = new Set();
  if (existing === undefined || existing === null) return occupied;
  if (typeof existing[Symbol.iterator] !== 'function' || typeof existing === 'string') {
    throw new TypeError('existing 需为可迭代的编号集合（数组或 Set）');
  }
  for (const taskNo of existing) {
    const seq = parseTaskNoSeq(rule, taskNo);
    if (seq !== null) occupied.add(seq);
  }
  return occupied;
}

/**
 * 批量生成 Task No（需求 38.8、38.9）。
 *
 * 从 `rule.next_seq` 起按 `rule.step` 递增取号，命中 `existing` 已占用的序号即跳至下一序号，
 * 直至凑够 `count` 个互不相同、且与 `existing` 全不重复的编号。
 *
 * @param {{prefix?: string, suffix?: string, next_seq?: number, step?: number}} rule
 *   编号规则，形状同 `task_no_sequence` 行；缺省 `prefix`/`suffix` 为 ''、`next_seq` 为 1、`step` 为 1。
 * @param {Iterable<string>} [existing] 已占用编号（库中现存全部 Task No）；调用方负责取全量。
 * @param {number} count 需生成的编号个数；`0` 返回空批次且不推进序号。
 * @returns {{taskNos: string[], sequences: number[], skippedSequences: number[], nextSeq: number}}
 *   - `taskNos`：生成的编号，顺序即序号升序，与 `sequences` 一一对应
 *   - `sequences`：各编号所用序号
 *   - `skippedSequences`：因被占用而跳过的序号（需求 38.9 的跳号轨迹）
 *   - `nextSeq`：下次取号的起始序号（末次所用序号 + step）；`count === 0` 时原样返回 `rule.next_seq`
 */
export function generateTaskNoBatch(rule, existing, count) {
  const { prefix, suffix, nextSeq, step } = normalizeRule(rule);

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`count 需为非负安全整数，收到：${String(count)}`);
  }

  const occupied = collectOccupiedSequences(rule, existing);

  const taskNos = [];
  const sequences = [];
  const skippedSequences = [];

  let seq = nextSeq;
  let lastUsedSeq = null;

  while (taskNos.length < count) {
    if (!Number.isSafeInteger(seq)) {
      throw new RangeError(`序号超出安全整数范围，无法继续取号：${String(seq)}`);
    }

    if (occupied.has(seq)) {
      skippedSequences.push(seq);
      // 每次跳号至少消耗一个已占用序号，跳号次数不可能超过占用总数——越界即实现有误。
      if (skippedSequences.length > occupied.size) {
        throw new Error('跳号次数超过已占用序号总数，编号生成逻辑异常');
      }
      seq += step;
      continue;
    }

    taskNos.push(`${prefix}${seq}${suffix}`);
    sequences.push(seq);
    lastUsedSeq = seq;
    seq += step;
  }

  return {
    taskNos,
    sequences,
    skippedSequences,
    nextSeq: lastUsedSeq === null ? nextSeq : lastUsedSeq + step,
  };
}
