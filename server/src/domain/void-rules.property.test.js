import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  checkVoidPrecondition,
  classifyVoidReferences,
  isSelectableForNewPackage,
  VOID_REJECTION,
  HISTORICAL_REFERENCE_TYPE,
} from './void-rules.js';
import { CARD_STATUS } from './enums.js';

const CARD = Object.freeze({ id: 7, task_no: 'TS-01-0001', revision: 2, status: 'Effective' });

/** 非空非纯空白的作废原因生成器：固定非空白前缀，保证任意后缀拼接后仍非 blank。 */
const validReasonArb = fc.string({ minLength: 0, maxLength: 20 }).map((s) => `作废原因-${s}`);

/** 空白 / 缺失作废原因生成器（需求 42.5）。 */
const blankReasonArb = fc.constantFrom(undefined, null, '', '   ', '\t\n', '\u3000', '  \u3000 ');

/** JOB 引用：`exec_status` 覆盖执行中 / 待执行 / 已完结 / 空值 / 脏数据五种取值。 */
const jobRefArb = fc.record({
  job_no: fc.string({ minLength: 1, maxLength: 6 }),
  exec_status: fc.option(fc.constantFrom('InProgress', 'Pending', 'Completed', 'garbage'), { nil: undefined }),
  pid: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: undefined }),
});

/** 在编（尚未释放）工包引用：恒阻止作废，与 `released` 标记无关。 */
const inProgressPackageRefArb = fc.record({
  package_no: fc.string({ minLength: 1, maxLength: 6 }),
  pid: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: undefined }),
});

/**
 * 历史工包引用：`released` 三态覆盖——`true`（明确已释放，不阻止）、`false`（矛盾信号，从严阻止）、
 * 缺失（无标记，按「无 / 已释放」默认判为历史，不阻止）。
 */
const historicalPackageRefArb = fc.record({
  package_no: fc.string({ minLength: 1, maxLength: 6 }),
  card_revision: fc.integer({ min: 1, max: 9 }),
  released: fc.option(fc.boolean(), { nil: undefined }),
});

/** 三类来源随机组合的完整 `refs`（数量 0~4 条，覆盖「无引用」到「多引用叠加」）。 */
const refsArb = fc.record({
  jobs: fc.array(jobRefArb, { minLength: 0, maxLength: 4 }),
  inProgressPackages: fc.array(inProgressPackageRefArb, { minLength: 0, maxLength: 4 }),
  historicalPackages: fc.array(historicalPackageRefArb, { minLength: 0, maxLength: 4 }),
});

// Feature: task-card-management, Property 24: For any 工卡，作废被接受当且仅当不存在三类引用（执行中 JOB、已生成未开始 JOB、在编工包已选入）且作废原因非空；作废后不可被新工包选用，历史工包中已引用的版本记录保持不变。
describe('Property 24: 作废前置校验', () => {
  it('通过当且仅当不存在三类阻止性引用（任意组合），给定有效原因', () => {
    fc.assert(
      fc.property(refsArb, validReasonArb, (refs, reason) => {
        const classified = classifyVoidReferences(refs);
        const result = checkVoidPrecondition(CARD, refs, reason);

        expect(result.ok).toBe(!classified.hasBlocking);
        expect(result.ok).toBe(classified.hasBlocking === false);
        if (!classified.hasBlocking) {
          expect(result.rejection).toBeNull();
        } else {
          expect(result.rejection).toBe(VOID_REJECTION.BLOCKING_REFERENCES);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('作废原因为空或纯空白且无阻止性引用：拒绝且拒因为 REASON_REQUIRED', () => {
    fc.assert(
      fc.property(blankReasonArb, (reason) => {
        // 无任何引用来源，确保 hasBlocking 恒为 false，只考察原因维度
        const result = checkVoidPrecondition(CARD, { jobs: [], inProgressPackages: [], historicalPackages: [] }, reason);

        expect(result.ok).toBe(false);
        expect(result.rejection).toBe(VOID_REJECTION.REASON_REQUIRED);
        expect(result.reasonMissing).toBe(true);
        expect(result.blockingRefs).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('明确已释放的历史工包引用不阻止作废，仅回显于 historicalRefs 且不改写入参记录', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            package_no: fc.string({ minLength: 1, maxLength: 6 }),
            card_revision: fc.integer({ min: 1, max: 9 }),
          }).map((row) => ({ ...row, released: true })),
          { minLength: 1, maxLength: 4 },
        ),
        validReasonArb,
        (historicalPackages, reason) => {
          // 其余来源保持干净（无阻止性引用），只考察历史工包引用本身
          const refs = { jobs: [], inProgressPackages: [], historicalPackages };
          const snapshot = JSON.stringify(refs);

          const result = checkVoidPrecondition(CARD, refs, reason);

          // 存在即历史引用，与阻止性引用互斥，且不影响整体放行
          expect(result.ok).toBe(true);
          expect(result.blockingRefs).toEqual([]);
          expect(result.historicalRefs).toHaveLength(historicalPackages.length);
          for (const ref of result.historicalRefs) {
            expect(ref.type).toBe(HISTORICAL_REFERENCE_TYPE);
          }
          const revisionsInResult = result.historicalRefs.map((r) => r.cardRevision).sort();
          const revisionsInInput = historicalPackages.map((r) => r.card_revision).sort();
          expect(revisionsInResult).toEqual(revisionsInInput);

          // 纯函数：入参引用记录原样不变（历史工包版本记录不被回溯改写）
          expect(JSON.stringify(refs)).toBe(snapshot);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isSelectableForNewPackage：Void / Superseded 恒不可选用，其余状态恒可选用', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CARD_STATUS), (status) => {
        const selectable = isSelectableForNewPackage({ status });
        const expected = status !== 'Void' && status !== 'Superseded';
        expect(selectable).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
