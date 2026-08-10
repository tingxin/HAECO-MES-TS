/**
 * 工序编号（Process ID）生成模块 —— 纯函数，无 I/O。
 *
 * 规则（《临时设计说明》D-02，需求 11.1）：**大写字母序**，A–Z；超过 26 道工序后为
 * AA、AB…，即**电子表格列号式的双射二十六进制**（bijective base-26），与 Excel 列标题
 * A…Z、AA…AZ、BA… 完全一致。边界：
 *
 * | seq | 1 | 26 | 27 | 28 | 52 | 53 | 702 | 703 |
 * |-----|---|----|----|----|----|----|-----|-----|
 * | id  | A | Z  | AA | AB | AZ | BA | ZZ  | AAA |
 *
 * 注意这**不是**普通二十六进制：不存在「零位字符」，故 26→`Z` 而 27→`AA`（非 `BA`），
 * 且任意 seq 都映射到唯一编号（双射），这是 Property 10「同一工卡下工序编号两两互不
 * 相同」的成立依据 —— 编号仅由 seq 决定，seq 互异即编号互异。
 *
 * `card` 参数只表达**编号的作用域**（工序编号在单张工卡内唯一，见 `UNIQUE(card_id,
 * process_id)`），不参与计算，因此本函数不校验其内容、也不依赖其任何字段。
 *
 * 需求：11.1
 */

/** 工序编号的合法形态：一个或多个大写字母 */
export const PROCESS_ID_PATTERN = /^[A-Z]+$/;

/** 字母表基数 */
const RADIX = 26;

/** 'A' 的码位 */
const CODE_A = 'A'.charCodeAt(0);

/**
 * 生成工序编号。
 *
 * @param {object|null|undefined} card 所属工卡（仅表达作用域，不参与计算，允许为空）
 * @param {number} seq 工序在工卡内的序号，从 **1** 开始（1 → `A`）
 * @returns {string} 大写字母序编号，如 `A`、`Z`、`AA`、`AB`
 * @throws {RangeError} `seq` 非整数、小于 1 或非安全整数时抛出 —— 序号是「第几道工序」，
 *   0、负数、小数与 `NaN` 在业务上无定义，静默回退会产出重复或空编号，故显式拒绝。
 */
export function generateProcessId(card, seq) {
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError(`工序序号须为不小于 1 的整数，实际收到：${String(seq)}`);
  }

  let letters = '';
  let remaining = seq;
  while (remaining > 0) {
    // 先减 1 使余数落在 0–25，实现「无零位」的双射映射
    const index = (remaining - 1) % RADIX;
    letters = String.fromCharCode(CODE_A + index) + letters;
    remaining = Math.floor((remaining - 1) / RADIX);
  }
  return letters;
}

/**
 * 生成一张工卡下前 `count` 道工序的编号序列（`generateProcessId` 的批量形式）。
 *
 * @param {object|null|undefined} card 所属工卡（同上，仅表达作用域）
 * @param {number} count 工序道数
 * @returns {string[]} 长度为 `count` 的编号数组，元素两两互不相同
 * @throws {RangeError} `count` 非整数或小于 0 时抛出
 */
export function generateProcessIdSequence(card, count) {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`工序道数须为不小于 0 的整数，实际收到：${String(count)}`);
  }
  const ids = [];
  for (let seq = 1; seq <= count; seq += 1) {
    ids.push(generateProcessId(card, seq));
  }
  return ids;
}
