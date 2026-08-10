import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { currentCapabilityRevision, checkCapability, CAPABILITY_REJECTION } from './capability.js';
import { AC_TYPE, GEAR_TYPE, SKILL } from './enums.js';

/**
 * 将「相对 onDate 的天数偏移」转为 `'YYYY-MM-DD'`（定宽零填充），与 capability.js 注释所述
 * 的字典序比较口径一致——仅用作测试侧夹具构造，不影响被测实现的日期比较逻辑。
 */
const EPOCH_UTC = Date.UTC(2020, 0, 1);
function dateStr(dayOffset) {
  return new Date(EPOCH_UTC + dayOffset * 86400000).toISOString().slice(0, 10);
}

/** 固定 (机型, 起落架类型, 专业) 三元组的作用域生成器 */
const scopeArb = fc.record({
  acType: fc.constantFrom(...AC_TYPE),
  gearType: fc.constantFrom(...GEAR_TYPE),
  skill: fc.constantFrom(...SKILL),
});

/**
 * 单条记录的「相对偏移」描述：四类生效期形态覆盖设计要求——
 * - expired：生效期已结束（`to < onDate`）
 * - future：尚未生效（`from > onDate`）
 * - open：生效期起始在 onDate 之前且 `effective_to` 为空（长期有效，覆盖当日）
 * - covering：`[from, to]` 明确覆盖 onDate
 */
const rowSpecArb = fc.record({
  kind: fc.constantFrom('expired', 'future', 'open', 'covering'),
  fromDelta: fc.integer({ min: 0, max: 200 }),
  toDelta: fc.integer({ min: 0, max: 200 }),
});

/** 依 onDate 偏移与 kind 计算某条记录的 (fromOffset, toOffset|null)，并给出该记录是否覆盖 onDate 的独立判定。 */
function buildOffsets(spec, onDateOffset) {
  switch (spec.kind) {
    case 'expired': {
      const to = onDateOffset - spec.toDelta - 1;
      const from = to - spec.fromDelta - 1;
      return { from, to, covers: false };
    }
    case 'future': {
      const from = onDateOffset + spec.fromDelta + 1;
      const to = from + spec.toDelta;
      return { from, to, covers: false };
    }
    case 'open': {
      const from = onDateOffset - spec.fromDelta;
      return { from, to: null, covers: true };
    }
    case 'covering':
    default: {
      const from = onDateOffset - spec.fromDelta;
      const to = onDateOffset + spec.toDelta;
      return { from, to, covers: true };
    }
  }
}

/** 跨生效期与多 revision 的能力清单生成器：固定作用域 + onDate + 1~8 条记录（revision = 下标+1）。 */
const scenarioArb = fc
  .record({
    scope: scopeArb,
    onDateOffset: fc.integer({ min: 300, max: 700 }),
    rowSpecs: fc.array(rowSpecArb, { minLength: 1, maxLength: 8 }),
    // 与 scope.acType 不同的机型，用于构造「作用域完全不匹配」的工卡（AC_TYPE 有 20 个取值，恒非空）
    otherAcTypeIndex: fc.integer({ min: 0, max: AC_TYPE.length - 2 }),
  })
  .map(({ scope, onDateOffset, rowSpecs, otherAcTypeIndex }) => {
    const onDate = dateStr(onDateOffset);
    const rows = rowSpecs.map((spec, index) => {
      const { from, to, covers } = buildOffsets(spec, onDateOffset);
      const revision = index + 1;
      return {
        row: {
          ac_type: scope.acType,
          gear_type: scope.gearType,
          skill: scope.skill,
          revision,
          effective_from: dateStr(from),
          effective_to: to === null ? null : dateStr(to),
        },
        revision,
        covers,
      };
    });

    // 独立计算期望的「当前有效版本」：覆盖 onDate 的记录中取 revision 最大者
    const coveringRevisions = rows.filter((r) => r.covers).map((r) => r.revision);
    const expectedRevision = coveringRevisions.length === 0 ? null : Math.max(...coveringRevisions);

    const otherAcType = AC_TYPE.filter((v) => v !== scope.acType)[otherAcTypeIndex % (AC_TYPE.length - 1)];

    return {
      scope,
      onDate,
      list: rows.map((r) => r.row),
      expectedRevision,
      otherAcType,
    };
  });

// Feature: task-card-management, Property 21: 能力清单范围校验 —— For any 工卡，其可提交审核当且仅当（机型, 起落架类型, 专业）组合存在于当前有效版本的能力清单中；超出范围的提交一律被拒绝。
describe('Property 21: 能力清单范围校验（跨生效期与多 revision）', () => {
  it('currentCapabilityRevision 与 checkCapability 均依「覆盖 onDate 的记录中 revision 最大者」判定，超出范围一律被拒绝', () => {
    fc.assert(
      fc.property(scenarioArb, ({ scope, onDate, list, expectedRevision, otherAcType }) => {
        // ① currentCapabilityRevision：与独立计算的期望值一致（跨生效期与多 revision）
        expect(currentCapabilityRevision(list, onDate)).toBe(expectedRevision);

        // ② 作用域匹配的工卡：当前有效版本存在时通过并带出该版本号；不存在时判为 NO_EFFECTIVE_REVISION
        const matchingCard = { ac_type: scope.acType, gear_type: scope.gearType, skill: scope.skill };
        const matchResult = checkCapability(matchingCard, list, onDate);

        if (expectedRevision !== null) {
          expect(matchResult.ok).toBe(true);
          expect(matchResult.rejection).toBeNull();
          expect(matchResult.revision).toBe(expectedRevision);

          // ③ 作用域不匹配的工卡（机型不同）：即使清单存在当前有效版本，仍判为 OUT_OF_SCOPE，
          //    且与「整张清单无当前有效版本」的 NO_EFFECTIVE_REVISION 可区分
          const mismatchCard = { ac_type: otherAcType, gear_type: scope.gearType, skill: scope.skill };
          const mismatchResult = checkCapability(mismatchCard, list, onDate);
          expect(mismatchResult.ok).toBe(false);
          expect(mismatchResult.rejection).toBe(CAPABILITY_REJECTION.OUT_OF_SCOPE);
          expect(mismatchResult.rejection).not.toBe(CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION);
        } else {
          expect(matchResult.ok).toBe(false);
          expect(matchResult.rejection).toBe(CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION);
          expect(matchResult.revision).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });
});
