/**
 * 商务分类优先级链派生确定性属性测试（任务 8.5）。
 *
 * 覆盖 Property 23：结果 = 首个命中层级；P6 永不覆盖 P1–P5；同层多命中与类型 11
 * 产出候选集不自动裁决；每条结果记录命中层级与依据来源。
 *
 * 需求：29.1–29.7、43.3、43.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  deriveCommercialClassification,
  DERIVATION_STATUS,
  TIER_P1,
  TIER_P2,
  TIER_P3,
  TIER_P4,
  TIER_P5,
  TIER_P6,
} from './classification.js';
import { DERIVATION_PRIORITY } from './enums.js';

/** 未任何来源命中的基线 sources（P1–P5 全空） */
const emptySources = Object.freeze({
  planDummyJob: false,
  nrcOriginatingDoc: null,
  outsourceEntry: null,
  partNature: false,
  packageDivision: null,
});

/** 每个 P1–P5 层级对应的「单条命中」sources 片段与其产出分类 */
const TIER_HIT_SOURCE = Object.freeze({
  [TIER_P1]: { key: 'planDummyJob', value: { planRef: 'PLAN-1' }, classification: 'Dummy Job' },
  [TIER_P2]: { key: 'nrcOriginatingDoc', value: { docNo: 'NR-1' }, classification: 'NRC' },
  [TIER_P3]: { key: 'outsourceEntry', value: { listRef: 'OS-1' }, classification: 'Outsource' },
  [TIER_P4]: { key: 'partNature', value: { partNo: 'PN-1' }, classification: 'LLP' },
  [TIER_P5]: { key: 'packageDivision', value: { classification: 'Routine', packageRef: 'WP-1' }, classification: 'Routine' },
});

const P1_TO_P5 = [TIER_P1, TIER_P2, TIER_P3, TIER_P4, TIER_P5];

/** card_type_commercial_map 行集：01/11 双值，其余单值 */
const defaultMapRows = [
  { card_type: '01', commercial_classification: 'Gear Inspection' },
  { card_type: '01', commercial_classification: 'Routine' },
  ...['02', '03', '04', '05', '06', '07', '08', '09']
    .map((t) => ({ card_type: t, commercial_classification: 'Routine' })),
  { card_type: '10', commercial_classification: 'SB/AD/SL' },
  { card_type: '11', commercial_classification: 'Material Special Replacement' },
  { card_type: '11', commercial_classification: 'Configuration(MOD)' },
];

/** 由「随机启用子集 + 随机顺序」构造 tier_order 行集（P1–P6 全量，部分停用） */
const tierRowsArb = fc.shuffledSubarray(DERIVATION_PRIORITY, { minLength: 0 }).chain((enabledSet) => {
  // enabledSet 为已启用层级的一个乱序子集；剩余层级标记为停用，一并加入（顺序打乱）但不参与判定
  const disabledSet = DERIVATION_PRIORITY.filter((t) => !enabledSet.includes(t));
  return fc.constant({ enabledSet, disabledSet });
}).chain(({ enabledSet, disabledSet }) => fc
  .shuffledSubarray([...disabledSet], { minLength: disabledSet.length, maxLength: disabledSet.length })
  .map((shuffledDisabled) => {
    const rows = [];
    // 启用层级按 enabledSet 顺序赋予递增 tier_order（即判定顺序）
    enabledSet.forEach((tierCode, i) => {
      rows.push({ tier_code: tierCode, tier_order: i + 1, enabled: 1 });
    });
    // 停用层级 tier_order 任意（不影响结果），随机插入
    shuffledDisabled.forEach((tierCode, i) => {
      rows.push({ tier_code: tierCode, tier_order: 100 + i, enabled: 0 });
    });
    return { rows, tierOrder: enabledSet };
  }));

function cfgFrom(tierRows, mapRows = defaultMapRows) {
  return { tiers: tierRows, cardTypeMap: mapRows };
}

// Feature: task-card-management, Property 23: 商务分类派生优先级确定性 —— For any 工卡与其分类来源输入，派生结果等于优先级链 DERIVATION_PRIORITY 中首个命中层级给出的分类，落在预定义取值集合内且对相同输入具有确定性；类型映射（P6）永不覆盖 P1–P5 的命中结果；同层多命中或类型 11 双值时不自动裁决而产出候选集要求人工确认；每条结果均记录命中层级与依据来源，人工确认时标记确认人与时间。
describe('Property 23: 商务分类派生优先级确定性', () => {
  it('(1) hitTier 恒等于 tier_order 中首个启用且有匹配来源的层级', () => {
    fc.assert(
      fc.property(
        tierRowsArb,
        fc.subarray(P1_TO_P5, { minLength: 1, maxLength: P1_TO_P5.length }),
        (tierInfo, hitTierCodes) => {
          // 按 P1_TO_P5 顺序构造 sources：hitTierCodes 中的层级命中，其余不命中
          const sources = { ...emptySources };
          for (const tierCode of hitTierCodes) {
            const spec = TIER_HIT_SOURCE[tierCode];
            sources[spec.key] = spec.value;
          }
          const card = { card_type: '02' }; // 单值映射类型，P6 命中不构成多值候选，便于本断言聚焦 P1–P5 优先级
          const cfg = cfgFrom(tierInfo.rows);
          const result = deriveCommercialClassification(card, sources, cfg);

          // 期望的首个命中层级：按 tierOrder（启用层级顺序）遍历，找到第一个「命中」的层级。
          // card_type='02' 在 defaultMapRows 中恒映射到单值 ['Routine']，故 P6 一旦轮到必命中。
          const hitSet = new Set(hitTierCodes);
          let expectedTier = null;
          for (const tierCode of tierInfo.tierOrder) {
            if (tierCode === TIER_P6 || hitSet.has(tierCode)) { expectedTier = tierCode; break; }
          }

          if (expectedTier === null) {
            expect(result.status).toBe(DERIVATION_STATUS.UNDETERMINED);
            expect(result.hitTier).toBeNull();
          } else {
            expect(result.hitTier).toBe(expectedTier);
            expect([DERIVATION_STATUS.DERIVED, DERIVATION_STATUS.REQUIRES_CONFIRMATION])
              .toContain(result.status);
          }

          // 确定性：相同输入两次调用结果逐字段相等
          const repeat = deriveCommercialClassification(card, sources, cfg);
          expect(repeat).toEqual(result);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('(2) P6 永不覆盖 P1–P5 命中：即便 P1–P5 命中且 P6 同样有映射，结果恒来自命中的 P1–P5 层级', () => {
    fc.assert(
      fc.property(
        tierRowsArb,
        fc.subarray(P1_TO_P5, { minLength: 1, maxLength: P1_TO_P5.length }),
        fc.constantFrom('01', '02', '10', '11'), // 覆盖单值与双值 P6 映射类型
        (tierInfo, hitTierCodes, cardType) => {
          const sources = { ...emptySources };
          for (const tierCode of hitTierCodes) {
            const spec = TIER_HIT_SOURCE[tierCode];
            sources[spec.key] = spec.value;
          }
          const card = { card_type: cardType };
          const cfg = cfgFrom(tierInfo.rows);
          const result = deriveCommercialClassification(card, sources, cfg);

          // 若 P1–P5 中任一命中层级在 tierOrder 中排在 P6 之前（或 P6 未启用/未参与），
          // 则 P6 绝不会成为结果的 hitTier。
          const p6Index = tierInfo.tierOrder.indexOf(TIER_P6);
          const earliestHitIndex = Math.min(
            ...hitTierCodes.map((t) => tierInfo.tierOrder.indexOf(t)).filter((i) => i >= 0),
          );
          const p1To5HitsBeforeP6 = p6Index === -1 || earliestHitIndex < p6Index;

          if (p1To5HitsBeforeP6 && Number.isFinite(earliestHitIndex)) {
            expect(result.hitTier).not.toBe(TIER_P6);
            expect(P1_TO_P5).toContain(result.hitTier);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('(3) 同层多命中（P5 两条及以上互异分类）恒产出 REQUIRES_CONFIRMATION，classification 为 null，candidates 长度 ≥ 2', () => {
    const distinctPackageDivisionArb = fc.uniqueArray(
      fc.constantFrom('Routine', 'Material Special Replacement', 'Configuration(MOD)'),
      { minLength: 2, maxLength: 3 },
    );
    fc.assert(
      fc.property(
        tierRowsArb,
        distinctPackageDivisionArb,
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 2, maxLength: 3 }),
        (tierInfo, classifications, refs) => {
          fc.pre(tierInfo.tierOrder.includes(TIER_P5));
          const sources = {
            ...emptySources,
            packageDivision: classifications.map((c, i) => ({
              classification: c,
              packageRef: `${refs[i % refs.length]}-${i}`,
            })),
          };
          const card = { card_type: '02' };
          const cfg = cfgFrom(tierInfo.rows);
          const result = deriveCommercialClassification(card, sources, cfg);

          // P5 之前（tierOrder 更靠前）没有其它层级命中，故 P5 为首个命中层级。
          // sources 中仅 P5 有条目，P1–P4 恒未命中；但 P6（card_type='02'→单值 'Routine'）
          // 一旦排在 P5 之前，也会先行命中，故要求 P5 排在 P6 之前（或 P6 未启用）。
          const p5Index = tierInfo.tierOrder.indexOf(TIER_P5);
          const p6Index = tierInfo.tierOrder.indexOf(TIER_P6);
          fc.pre(p6Index === -1 || p5Index < p6Index);

          expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
          expect(result.classification).toBeNull();
          expect(result.hitTier).toBe(TIER_P5);
          expect(result.candidates.length).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('(4) 工卡类型 01 或 11 搭配 2 条映射时，P1–P5 全未命中的情况下恒产出 REQUIRES_CONFIRMATION 候选集', () => {
    fc.assert(
      fc.property(
        tierRowsArb,
        fc.constantFrom('01', '11'),
        (tierInfo, cardType) => {
          const card = { card_type: cardType };
          const cfg = cfgFrom(tierInfo.rows); // sources 全空 → P1–P5 均未命中
          const result = deriveCommercialClassification(card, emptySources, cfg);

          if (!tierInfo.tierOrder.includes(TIER_P6)) {
            // P6 未启用：无法兜底，理应 UNDETERMINED
            expect(result.status).toBe(DERIVATION_STATUS.UNDETERMINED);
            return;
          }

          expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
          expect(result.classification).toBeNull();
          expect(result.hitTier).toBe(TIER_P6);
          expect(result.candidates.length).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('(5) 无论 derived 结果还是候选集中的每一项，均携带非空 hitTier 与非空 sourceRef', () => {
    const anyHitCombinationArb = fc.record({
      tierInfo: tierRowsArb,
      hitTierCodes: fc.subarray(P1_TO_P5, { minLength: 0, maxLength: P1_TO_P5.length }),
      cardType: fc.constantFrom('01', '02', '03', '10', '11'),
      multiP5: fc.boolean(),
    });

    fc.assert(
      fc.property(anyHitCombinationArb, ({ tierInfo, hitTierCodes, cardType, multiP5 }) => {
        const sources = { ...emptySources };
        for (const tierCode of hitTierCodes) {
          const spec = TIER_HIT_SOURCE[tierCode];
          sources[spec.key] = spec.value;
        }
        if (multiP5) {
          sources.packageDivision = [
            { classification: 'Routine', packageRef: 'WP-A' },
            { classification: 'Configuration(MOD)', packageRef: 'WP-B' },
          ];
        }
        const card = { card_type: cardType };
        const cfg = cfgFrom(tierInfo.rows);
        const result = deriveCommercialClassification(card, sources, cfg);

        if (result.status === DERIVATION_STATUS.DERIVED) {
          expect(result.hitTier).not.toBeNull();
          expect(result.sourceRef).toBeDefined();
          expect(result.sourceRef).not.toBeNull();
        }
        if (result.status === DERIVATION_STATUS.REQUIRES_CONFIRMATION) {
          expect(result.hitTier).not.toBeNull();
          expect(result.candidates.length).toBeGreaterThanOrEqual(1);
          for (const candidate of result.candidates) {
            expect(candidate.hitTier).not.toBeNull();
            expect(candidate.hitTier).toBeDefined();
            expect(candidate.sourceRef).toBeDefined();
            expect(candidate.sourceRef).not.toBeNull();
          }
        }
        if (result.status === DERIVATION_STATUS.UNDETERMINED) {
          expect(result.hitTier).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });
});
