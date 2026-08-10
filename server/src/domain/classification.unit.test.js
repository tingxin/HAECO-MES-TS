import { describe, expect, it } from 'vitest';
import {
  confirmClassification,
  deriveCommercialClassification,
  isValidCommercialClassification,
  isValidOutsourceSubtype,
  normalizeCardTypeMap,
  normalizePriorityTiers,
  DERIVATION_REASON,
  DERIVATION_STATUS,
  TIER_P1,
  TIER_P2,
  TIER_P3,
  TIER_P4,
  TIER_P5,
  TIER_P6,
} from './classification.js';
import { DERIVATION_PRIORITY } from './enums.js';

const tiers = DERIVATION_PRIORITY.map((tier_code, index) => ({
  tier_code,
  tier_order: index + 1,
  enabled: 1,
}));
const map = [
  { card_type: '01', commercial_classification: 'Gear Inspection' },
  { card_type: '01', commercial_classification: 'Routine' },
  ...['02', '03', '04', '05', '06', '07', '08', '09']
    .map((card_type) => ({ card_type, commercial_classification: 'Routine' })),
  { card_type: '10', commercial_classification: 'SB/AD/SL' },
  { card_type: '11', commercial_classification: 'Material Special Replacement' },
  { card_type: '11', commercial_classification: 'Configuration(MOD)' },
];
const cfg = { tiers, cardTypeMap: map };
const empty = {
  planDummyJob: false,
  nrcOriginatingDoc: null,
  outsourceEntry: null,
  partNature: false,
  packageDivision: null,
};
const names = (result) => result.candidates.map((item) => item.classification);

describe('商务分类运行时配置', () => {
  it('按 tier_order 排序、跳过停用/未知层级并去除重复层级', () => {
    expect(normalizePriorityTiers([
      { tier_code: TIER_P5, tier_order: 2, enabled: 1 },
      { tier_code: TIER_P1, tier_order: 9, enabled: 0 },
      { tier_code: TIER_P3, tier_order: 1, enabled: 1 },
      { tier_code: TIER_P3, tier_order: 8, enabled: 1 },
      { tier_code: 'P9_Unknown', tier_order: 0, enabled: 1 },
    ])).toEqual([
      { tierCode: TIER_P3, tierOrder: 1 },
      { tierCode: TIER_P5, tierOrder: 2 },
    ]);
  });

  it('类型映射保持配置顺序、按值去重并剔除非法分类', () => {
    const normalized = normalizeCardTypeMap([
      { card_type: '01', commercial_classification: 'Gear Inspection' },
      { card_type: '01', commercial_classification: 'Routine' },
      { card_type: '01', commercial_classification: 'Routine' },
      { card_type: '01', commercial_classification: 'Nonsense' },
    ]);
    expect(normalized['01']).toEqual(['Gear Inspection', 'Routine']);
  });

  it('优先级配置缺失时 fail closed，不回退编译期常量', () => {
    const result = deriveCommercialClassification({ card_type: '02' }, empty, undefined);
    expect(result).toMatchObject({
      status: DERIVATION_STATUS.UNDETERMINED,
      reasonCode: DERIVATION_REASON.PRIORITY_CONFIG_MISSING,
      candidates: [],
    });
  });
});

describe('商务分类全候选聚合', () => {
  it('评估全部启用 P1-P6，并按运行时层级顺序排列候选与推荐', () => {
    const result = deriveCommercialClassification({ card_type: '08' }, {
      planDummyJob: { planRef: 'PLAN-1' },
      nrcOriginatingDoc: { docNo: 'NR-1' },
      outsourceEntry: { listRef: 'OS-1', subtype: 'L sub' },
      partNature: { partNo: 'LLP-1' },
      packageDivision: { classification: 'Configuration(MOD)', packageRef: 'WP-1' },
    }, cfg);

    expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
    expect(names(result)).toEqual([
      'Dummy Job', 'NRC', 'Outsource', 'LLP', 'Configuration(MOD)', 'Routine',
    ]);
    expect(result.recommendedClassification).toBe('Dummy Job');
    expect(result.evaluatedTiers.map((tier) => tier.tierCode)).toEqual(DERIVATION_PRIORITY);
  });

  it('配置重排改变候选顺序和推荐，但不丢弃后续候选', () => {
    const reordered = {
      tiers: [
        { tier_code: TIER_P4, tier_order: 1, enabled: 1 },
        { tier_code: TIER_P1, tier_order: 2, enabled: 1 },
        { tier_code: TIER_P6, tier_order: 3, enabled: 1 },
      ],
      cardTypeMap: map,
    };
    const result = deriveCommercialClassification(
      { card_type: '04' },
      { ...empty, planDummyJob: true, partNature: true },
      reordered,
    );
    expect(names(result)).toEqual(['LLP', 'Dummy Job', 'Routine']);
    expect(result.recommendedClassification).toBe('LLP');
  });

  it('08 外包事实与启用的 P6 Routine 并存，按顺序推荐 Outsource', () => {
    const result = deriveCommercialClassification(
      { card_type: '08' },
      { ...empty, outsourceEntry: { listRef: 'OS-08', subtype: 'L sub' } },
      cfg,
    );
    expect(result).toMatchObject({
      status: DERIVATION_STATUS.REQUIRES_CONFIRMATION,
      recommendedClassification: 'Outsource',
      classification: null,
    });
    expect(names(result)).toEqual(['Outsource', 'Routine']);
  });

  it('P6 显式停用时不参与候选聚合', () => {
    const disabledP6 = {
      tiers: tiers.map((tier) => ({ ...tier, enabled: tier.tier_code === TIER_P6 ? 0 : 1 })),
      cardTypeMap: map,
    };
    const result = deriveCommercialClassification(
      { card_type: '08' },
      { ...empty, outsourceEntry: { listRef: 'OS-08', subtype: 'L sub' } },
      disabledP6,
    );
    expect(result).toMatchObject({
      status: DERIVATION_STATUS.DERIVED,
      classification: 'Outsource',
      outsourceSubtype: 'L sub',
    });
    expect(result.evaluatedTiers.some((tier) => tier.tierCode === TIER_P6)).toBe(false);
  });

  it('04 的 IR 只是卡类型；LLP 事实与 P6 Routine 共同展示', () => {
    const result = deriveCommercialClassification(
      { card_type: '04' },
      { ...empty, partNature: { partNo: 'P-04' } },
      cfg,
    );
    expect(names(result)).toEqual(['LLP', 'Routine']);
    expect(result.recommendedClassification).toBe('LLP');
  });

  it('相同分类跨层/同层重复命中只保留一个候选并聚合去重证据', () => {
    const result = deriveCommercialClassification(
      { card_type: '08' },
      {
        ...empty,
        packageDivision: [
          { classification: 'Routine', packageRef: 'A' },
          { classification: 'Routine', packageRef: 'A' },
          { classification: 'Routine', packageRef: 'B' },
        ],
      },
      cfg,
    );
    expect(result.status).toBe(DERIVATION_STATUS.DERIVED);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sources).toEqual([
      { hitTier: TIER_P5, sourceRef: 'A', outsourceSubtype: null },
      { hitTier: TIER_P5, sourceRef: 'B', outsourceSubtype: null },
      { hitTier: TIER_P6, sourceRef: 'card_type:08', outsourceSubtype: null },
    ]);
  });

  it('没有命中候选时返回 undetermined', () => {
    const onlyFacts = { tiers: tiers.filter((tier) => tier.tier_code !== TIER_P6), cardTypeMap: map };
    const result = deriveCommercialClassification({ card_type: '02' }, empty, onlyFacts);
    expect(result).toMatchObject({
      status: DERIVATION_STATUS.UNDETERMINED,
      reasonCode: DERIVATION_REASON.NO_TIER_HIT,
      recommendedClassification: null,
    });
  });

  it('11 忽略 P1-P5 和配置，固定双候选、无推荐且始终待确认', () => {
    const result = deriveCommercialClassification(
      { card_type: '11' },
      { ...empty, planDummyJob: true, outsourceEntry: { subtype: 'L sub' } },
      { tiers: [], cardTypeMap: [] },
    );
    expect(result.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
    expect(names(result)).toEqual(['Material Special Replacement', 'Configuration(MOD)']);
    expect(result.recommendedClassification).toBeNull();
    expect(result.evaluatedTiers).toEqual([{ tierCode: TIER_P6, tierOrder: null, hitCount: 2 }]);
  });
});

describe('商务分类人工确认', () => {
  it('Outsource 多 subtype 保留完整候选，并按所选 subtype 绑定对应证据', () => {
    const pending = deriveCommercialClassification(
      { card_type: '08' },
      {
        ...empty,
        outsourceEntry: [
          { listRef: 'OS-L', subtype: 'L sub' },
          { listRef: 'OS-P', subtype: '工序外委' },
        ],
      },
      cfg,
    );
    const outsource = pending.candidates.find((item) => item.classification === 'Outsource');
    expect(outsource.outsourceSubtypes).toEqual(['L sub', '工序外委']);

    const outcome = confirmClassification(
      pending,
      { classification: 'Outsource', outsourceSubtype: '工序外委' },
      { confirmedBy: 'E10001', confirmedAt: '2026-08-10T10:00:00.000Z' },
    );
    expect(outcome.accepted).toBe(true);
    expect(outcome.result).toMatchObject({
      status: DERIVATION_STATUS.CONFIRMED,
      classification: 'Outsource',
      outsourceSubtype: '工序外委',
      sourceRef: 'OS-P',
      isManualConfirmed: true,
      confirmedBy: 'E10001',
      confirmedAt: '2026-08-10T10:00:00.000Z',
    });
  });

  it('类型 11 可人工二选一并保留候选证据', () => {
    const pending = deriveCommercialClassification({ card_type: '11' }, empty, cfg);
    const outcome = confirmClassification(
      pending,
      'Configuration(MOD)',
      { confirmedBy: 'E10001', confirmedAt: '2026-08-10T11:00:00.000Z' },
    );
    expect(outcome.accepted).toBe(true);
    expect(outcome.result).toMatchObject({
      classification: 'Configuration(MOD)',
      hitTier: TIER_P6,
      sourceRef: 'card_type:11',
      isCandidateChoice: true,
    });
  });

  it('拒绝枚举外、枚举内非候选及不匹配 Outsource subtype', () => {
    const pending = deriveCommercialClassification(
      { card_type: '08' },
      { ...empty, outsourceEntry: { subtype: 'L sub' } },
      cfg,
    );
    expect(confirmClassification(pending, 'Whatever').reasonCode)
      .toBe(DERIVATION_REASON.CLASSIFICATION_NOT_ALLOWED);
    expect(confirmClassification(pending, 'NRC').reasonCode)
      .toBe(DERIVATION_REASON.CLASSIFICATION_NOT_CANDIDATE);
    expect(confirmClassification(
      pending,
      { classification: 'Outsource', outsourceSubtype: '工序外委' },
    ).reasonCode).toBe(DERIVATION_REASON.OUTSOURCE_SUBTYPE_MISMATCH);
  });

  it('分类与 Outsource subtype 值域保持封闭', () => {
    expect(isValidCommercialClassification('Routine')).toBe(true);
    expect(isValidCommercialClassification('IR')).toBe(false);
    expect(isValidOutsourceSubtype('L sub')).toBe(true);
    expect(isValidOutsourceSubtype('Other')).toBe(false);
  });
});
