import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { CARD_STATUS } from './enums.js';
import { batchReplace, BATCH_REPLACE_OUTCOME, BATCH_REPLACE_REJECTION } from './batch-replace.js';
import { serializeChangeValue } from './change-record.js';

// ─────────────────────────────────────────────────────────────────────────────
// 10.8 → Property 13（纯函数部分）: 批量替换正确、幂等且受管控
//
// design.md 原文（Property 13）：
// *For any* 工卡集合与替换规则 `(field, from, to)`（`from ≠ to`）：替换仅作用于状态为
// 「新增」的版本，任何非「新增」版本一律被拒绝且内容不变；替换原因为空时整批被拒绝；
// 执行成功后每张被修改工卡各新增恰好 1 条变更记录；对同一规则连续执行第二次时受影响
// 数量为 0（幂等）；任一失败则整批回滚（无部分生效）。
//
// **被测层次**：混合——态限制、原因必填、幂等与逐卡留痕条数可在 `batchReplace` 纯函数
// 上断言（本文件覆盖）；「任一失败则整批回滚（无部分生效）」须以内存 SQLite + 批量替换
// 服务为被测对象，属事务/持久化属性，见任务 14.2，不在本任务范围。
//
// **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.6, 20.7, 20.8, 49.4**
// ─────────────────────────────────────────────────────────────────────────────

/** 待替换字段名——固定为 payload，避免与工卡识别字段（id/task_no/revision/status）混淆。 */
const FIELD = 'payload';

/** 字段候选取值的小字母表：足够小以保证生成的批次中存在命中 from 的 New 卡，也存在未命中的卡。 */
const VALUE_ALPHABET = ['OLD', 'OTHER', 'NEW', 'X', 'Y'];

/** 五态全覆盖的最小工卡：`payload` 为待替换字段。 */
const cardArb = fc.record({
  id: fc.integer({ min: 1, max: 100000 }),
  task_no: fc.stringMatching(/^[A-Z]{2}-[0-9]{4}$/),
  revision: fc.integer({ min: 1, max: 50 }),
  status: fc.constantFrom(...CARD_STATUS),
  payload: fc.constantFrom(...VALUE_ALPHABET),
});

const cardsArb = fc.array(cardArb, { minLength: 1, maxLength: 12 });

/** `(from, to)` 对，`from ≠ to`（design.md 前提条件）。 */
const fromToArb = fc
  .tuple(fc.constantFrom(...VALUE_ALPHABET), fc.constantFrom(...VALUE_ALPHABET))
  .filter(([from, to]) => from !== to)
  .map(([from, to]) => ({ from, to }));

/** 非空非纯空白的替换原因（需求 20.6、20.7 的合法输入侧）。 */
const reasonArb = fc.constantFrom('客户要求统一术语', 'AD 修订', 'Reason X', '统一表述');

/** 非空操作人工号。 */
const operatorArb = fc.constantFrom('E1001', 'E2002', 'U9', 'OP-7');

/** 空/纯空白的替换原因（需求 20.6、20.7 的非法输入侧）。 */
const blankReasonArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(''),
  fc
    .array(fc.constantFrom(' ', '\t', '\n', '\u3000'), { minLength: 1, maxLength: 8 })
    .map((chars) => chars.join('')),
);

describe('Property 13（纯函数部分）: 批量替换正确、幂等且受管控', () => {
  it('态限制：非 New 版本恒被拒绝并列明原因；New 且命中 from 的版本恒被替换并产出 1 条记录', () => {
    fc.assert(
      fc.property(cardsArb, fromToArb, reasonArb, operatorArb, (cards, { from, to }, reason, operatorId) => {
        const spec = { field: FIELD, from, to };
        const result = batchReplace(cards, spec, reason, operatorId);

        expect(result.ok).toBe(true);
        expect(result.items).toHaveLength(cards.length);

        result.items.forEach((item, index) => {
          const original = cards[index];

          if (original.status !== 'New') {
            // 任何非新增版本逐条拒绝，内容（原始 card 对象）不变，且给出非空拒绝原因
            expect(item.outcome).toBe(BATCH_REPLACE_OUTCOME.REJECTED_NOT_EDITABLE);
            expect(item.rejectionMessage).not.toBeNull();
            expect(typeof item.rejectionMessage).toBe('string');
            expect(item.rejectionMessage.length).toBeGreaterThan(0);
            expect(item.changeRecord).toBeNull();
            expect(original.payload).toBe(cards[index].payload); // 源对象未被就地修改
          } else if (original.payload === from) {
            // New 且命中 from：恰好替换，产出恰好 1 条记录
            expect(item.outcome).toBe(BATCH_REPLACE_OUTCOME.REPLACED);
            expect(item.changeRecord).not.toBeNull();
          }
        });
      }),
      { numRuns: 100 },
    );
  });

  it('原因为空或纯空白：整批拒绝，ok=false，items 为空数组', () => {
    fc.assert(
      fc.property(cardsArb, fromToArb, blankReasonArb, operatorArb, (cards, { from, to }, reason, operatorId) => {
        const spec = { field: FIELD, from, to };
        const result = batchReplace(cards, spec, reason, operatorId);

        expect(result.ok).toBe(false);
        expect(result.rejection).toBe(BATCH_REPLACE_REJECTION.REASON_REQUIRED);
        expect(result.items).toEqual([]);
        expect(result.updatedCards).toEqual([]);
        expect(result.changeRecords).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('逐卡留痕：每个 REPLACED 条目恰有 1 条 change_type=batch_replace 的变更记录，字段与前后值一致', () => {
    fc.assert(
      fc.property(cardsArb, fromToArb, reasonArb, operatorArb, (cards, { from, to }, reason, operatorId) => {
        const spec = { field: FIELD, from, to };
        const result = batchReplace(cards, spec, reason, operatorId);

        const replacedItems = result.items.filter((item) => item.outcome === BATCH_REPLACE_OUTCOME.REPLACED);

        // 全局变更记录集合数量恰等于 REPLACED 条目数（每张被修改工卡恰好 1 条记录）
        expect(result.changeRecords).toHaveLength(replacedItems.length);
        expect(result.affectedCount).toBe(replacedItems.length);

        for (const item of replacedItems) {
          expect(item.changeRecord).not.toBeNull();
          expect(item.changeRecord.change_type).toBe('batch_replace');
          expect(item.changeRecord.field).toBe(FIELD);
          expect(item.changeRecord.old_value).toBe(serializeChangeValue(item.before));
          expect(item.changeRecord.new_value).toBe(serializeChangeValue(item.after));
          expect(item.before).toBe(from);
          expect(item.after).toBe(to);
          expect(result.changeRecords).toContain(item.changeRecord);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('幂等性：对首次执行产出的 updatedCards 再次执行同一规则，受影响数恒为 0', () => {
    fc.assert(
      fc.property(cardsArb, fromToArb, reasonArb, operatorArb, (cards, { from, to }, reason, operatorId) => {
        const spec = { field: FIELD, from, to };

        const first = batchReplace(cards, spec, reason, operatorId);
        expect(first.ok).toBe(true);

        const second = batchReplace(first.updatedCards, spec, reason, operatorId);
        expect(second.ok).toBe(true);
        expect(second.affectedCount).toBe(0);
        expect(second.changeRecords).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
