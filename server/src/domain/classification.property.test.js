import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  confirmClassification,
  deriveCommercialClassification,
  DERIVATION_REASON,
  DERIVATION_STATUS,
  TIER_P1,
  TIER_P2,
  TIER_P3,
  TIER_P4,
  TIER_P5,
  TIER_P6,
} from './classification.js';
import { COMMERCIAL_CLASSIFICATION, DERIVATION_PRIORITY } from './enums.js';

const allTiers = DERIVATION_PRIORITY.map((tier_code, index) => ({
  tier_code,
  tier_order: index + 1,
  enabled: 1,
}));
const cardTypeMap = [
  { card_type: '02', commercial_classification: 'Routine' },
  { card_type: '04', commercial_classification: 'Routine' },
  { card_type: '08', commercial_classification: 'Routine' },
];
const allSources = Object.freeze({
  planDummyJob: { planRef: 'PLAN' },
  nrcOriginatingDoc: { docNo: 'NRC' },
  outsourceEntry: { listRef: 'OS', subtype: 'L sub' },
  partNature: { partNo: 'LLP' },
  packageDivision: { classification: 'Configuration(MOD)', packageRef: 'WP' },
});
const emptySources = Object.freeze({
  planDummyJob: false,
  nrcOriginatingDoc: null,
  outsourceEntry: null,
  partNature: false,
  packageDivision: null,
});
const classificationByTier = Object.freeze({
  [TIER_P1]: 'Dummy Job',
  [TIER_P2]: 'NRC',
  [TIER_P3]: 'Outsource',
  [TIER_P4]: 'LLP',
  [TIER_P5]: 'Configuration(MOD)',
  [TIER_P6]: 'Routine',
});
const tierPermutationArb = fc.shuffledSubarray(DERIVATION_PRIORITY, {
  minLength: DERIVATION_PRIORITY.length,
  maxLength: DERIVATION_PRIORITY.length,
});

// Feature: task-card-management, Property 23: 商务分类候选聚合、推荐与确认一致性
// Validates: Requirements 29.1–29.11, 34.1(h), 43.2–43.6

describe('Property 23: 商务分类候选聚合、推荐与确认一致性', () => {
  it('运行时层级任意重排时，全部启用命中均按首次出现顺序聚合且首候选为推荐', () => {
    fc.assert(fc.property(tierPermutationArb, (order) => {
      const tiers = order.map((tier_code, index) => ({ tier_code, tier_order: index + 1, enabled: 1 }));
      const result = deriveCommercialClassification(
        { card_type: '08' },
        allSources,
        { tiers, cardTypeMap },
      );
      const expected = order.map((tier) => classificationByTier[tier]);
      expect(result.candidates.map((candidate) => candidate.classification)).toEqual(expected);
      expect(result.evaluatedTiers.map((tier) => tier.tierCode)).toEqual(order);
      expect(result.recommendedClassification).toBe(expected[0]);
      expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
      expect(deriveCommercialClassification(
        { card_type: '08' }, allSources, { tiers, cardTypeMap },
      )).toEqual(result);
    }), { numRuns: 100 });
  });

  it('任意启停组合只评估启用层级；零/一/多候选分别对应 undetermined/derived/pending', () => {
    fc.assert(fc.property(
      tierPermutationArb,
      fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
      (order, enabledFlags) => {
        const tiers = order.map((tier_code, index) => ({
          tier_code,
          tier_order: index + 1,
          enabled: enabledFlags[index] ? 1 : 0,
        }));
        const enabled = order.filter((_, index) => enabledFlags[index]);
        const result = deriveCommercialClassification(
          { card_type: '08' }, allSources, { tiers, cardTypeMap },
        );
        const expected = enabled.map((tier) => classificationByTier[tier]);
        expect(result.candidates.map((candidate) => candidate.classification)).toEqual(expected);
        expect(result.evaluatedTiers.map((tier) => tier.tierCode)).toEqual(enabled);
        if (expected.length === 0) {
          expect(result.status).toBe(DERIVATION_STATUS.UNDETERMINED);
          expect(result.reasonCode).toBe(DERIVATION_REASON.PRIORITY_CONFIG_MISSING);
          expect(result.recommendedClassification).toBeNull();
        } else if (expected.length === 1) {
          expect(result.status).toBe(DERIVATION_STATUS.DERIVED);
          expect(result.classification).toBe(expected[0]);
          expect(result.recommendedClassification).toBe(expected[0]);
        } else {
          expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
          expect(result.classification).toBeNull();
          expect(result.recommendedClassification).toBe(expected[0]);
        }
      },
    ), { numRuns: 100 });
  });

  it('同分类的重复事实与 P6 映射聚合为唯一候选，sources 完整、去重且顺序稳定', () => {
    const refArb = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: 1,
      maxLength: 5,
    });
    fc.assert(fc.property(refArb, (refs) => {
      const packageDivision = refs.flatMap((packageRef) => [
        { classification: 'Routine', packageRef },
        { classification: 'Routine', packageRef },
      ]);
      const result = deriveCommercialClassification(
        { card_type: '08' },
        { ...emptySources, packageDivision },
        {
          tiers: [
            { tier_code: TIER_P5, tier_order: 1, enabled: 1 },
            { tier_code: TIER_P6, tier_order: 2, enabled: 1 },
          ],
          cardTypeMap,
        },
      );
      expect(result.status).toBe(DERIVATION_STATUS.DERIVED);
      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0];
      expect(candidate.classification).toBe('Routine');
      expect(candidate.hitTier).toBe(TIER_P5);
      expect(candidate.sources.map((source) => source.sourceRef)).toEqual([
        ...refs,
        'card_type:08',
      ]);
      expect(new Set(candidate.sources.map((source) => JSON.stringify(source))).size)
        .toBe(candidate.sources.length);
    }), { numRuns: 100 });
  });

  it('类型 11 对任意来源和配置恒为固定双候选、无推荐且不评估 P1-P5', () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.boolean(),
      tierPermutationArb,
      (dummy, outsource, order) => {
        const result = deriveCommercialClassification(
          { card_type: '11' },
          {
            ...emptySources,
            planDummyJob: dummy,
            outsourceEntry: outsource ? { subtype: 'L sub' } : null,
          },
          {
            tiers: order.map((tier_code, index) => ({
              tier_code,
              tier_order: index + 1,
              enabled: index % 2,
            })),
            cardTypeMap,
          },
        );
        expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
        expect(result.candidates.map((candidate) => candidate.classification)).toEqual([
          'Material Special Replacement',
          'Configuration(MOD)',
        ]);
        expect(result.recommendedClassification).toBeNull();
        expect(result.evaluatedTiers).toEqual([
          { tierCode: TIER_P6, tierOrder: null, hitCount: 2 },
        ]);
      },
    ), { numRuns: 100 });
  });

  it('确认只接受当前候选；Outsource 必须选择候选允许的 subtype 并绑定对应证据', () => {
    fc.assert(fc.property(
      fc.constantFrom('L sub', '工序外委'),
      fc.string({ minLength: 1, maxLength: 12 }),
      (subtype, ref) => {
        const pending = deriveCommercialClassification(
          { card_type: '08' },
          { ...emptySources, outsourceEntry: { listRef: ref, subtype } },
          { tiers: allTiers, cardTypeMap },
        );
        const accepted = confirmClassification(
          pending,
          { classification: 'Outsource', outsourceSubtype: subtype },
          { confirmedBy: 'E10001', confirmedAt: '2026-08-10T00:00:00.000Z' },
        );
        expect(accepted.accepted).toBe(true);
        expect(accepted.result).toMatchObject({
          status: DERIVATION_STATUS.CONFIRMED,
          classification: 'Outsource',
          outsourceSubtype: subtype,
          sourceRef: ref,
          isManualConfirmed: true,
        });

        const otherSubtype = subtype === 'L sub' ? '工序外委' : 'L sub';
        expect(confirmClassification(
          pending,
          { classification: 'Outsource', outsourceSubtype: otherSubtype },
        ).reasonCode).toBe(DERIVATION_REASON.OUTSOURCE_SUBTYPE_MISMATCH);
        expect(confirmClassification(pending, 'SB/AD/SL').reasonCode)
          .toBe(DERIVATION_REASON.CLASSIFICATION_NOT_CANDIDATE);
      },
    ), { numRuns: 100 });
  });

  it('pending 派生不修改输入工卡上的既有权威分类', () => {
    fc.assert(fc.property(
      fc.constantFrom(...COMMERCIAL_CLASSIFICATION),
      (authority) => {
        const card = {
          card_type: '02',
          commercial_classification: authority,
          outsource_subtype: authority === 'Outsource' ? 'L sub' : null,
        };
        const before = structuredClone(card);
        const result = deriveCommercialClassification(
          card,
          { ...emptySources, planDummyJob: true },
          { tiers: allTiers, cardTypeMap },
        );
        expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
        expect(card).toEqual(before);
        expect(card.commercial_classification).toBe(authority);
      },
    ), { numRuns: 100 });
  });
});
