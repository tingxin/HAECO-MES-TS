/**
 * 商务分类优先级链派生单元测试（任务 8.1）。
 * 覆盖：配置驱动顺序与停用层级、首个命中、P6 不覆盖 P1–P5、同层多命中与类型 01/11 双值候选集、
 * 命中层级与依据来源记录、人工确认与越界取值拒绝。
 *
 * 需求：29.1–29.8、43.2–43.5
 */

import { describe, it, expect } from 'vitest';
import {
  deriveCommercialClassification,
  confirmClassification,
  normalizePriorityTiers,
  normalizeCardTypeMap,
  isValidCommercialClassification,
  DERIVATION_STATUS,
  DERIVATION_REASON,
  TIER_P1,
  TIER_P3,
  TIER_P5,
  TIER_P6,
} from './classification.js';
import { DERIVATION_PRIORITY } from './enums.js';

/** 模拟 `derivation_priority_config` 表行集（种子默认顺序） */
const defaultTiers = DERIVATION_PRIORITY.map((tierCode, i) => ({
  tier_code: tierCode, tier_order: i + 1, enabled: 1,
}));

/** 模拟 `card_type_commercial_map` 表行集（需求 43.2 全量条目） */
const defaultMap = [
  { card_type: '01', commercial_classification: 'Gear Inspection' },
  { card_type: '01', commercial_classification: 'Routine' },
  ...['02', '03', '04', '05', '06', '07', '08', '09']
    .map((t) => ({ card_type: t, commercial_classification: 'Routine' })),
  { card_type: '10', commercial_classification: 'SB/AD/SL' },
  { card_type: '11', commercial_classification: 'Material Special Replacement' },
  { card_type: '11', commercial_classification: 'Configuration(MOD)' },
];

const cfg = { tiers: defaultTiers, cardTypeMap: defaultMap };
const noSources = {
  planDummyJob: false,
  nrcOriginatingDoc: null,
  outsourceEntry: null,
  partNature: false,
  packageDivision: null,
};

describe('normalizePriorityTiers（需求 29.8：顺序取自配置表）', () => {
  it('按 tier_order 排序并跳过 enabled=0 的层级', () => {
    const tiers = normalizePriorityTiers([
      { tier_code: TIER_P5, tier_order: 2, enabled: 1 },
      { tier_code: TIER_P1, tier_order: 9, enabled: 0 },
      { tier_code: TIER_P3, tier_order: 1, enabled: 1 },
    ]);
    expect(tiers.map((t) => t.tierCode)).toEqual([TIER_P3, TIER_P5]);
  });

  it('剔除未知层级代码与重复条目', () => {
    const tiers = normalizePriorityTiers([
      { tier_code: 'P9_Unknown', tier_order: 1, enabled: 1 },
      { tier_code: TIER_P1, tier_order: 3, enabled: 1 },
      { tier_code: TIER_P1, tier_order: 5, enabled: 1 },
    ]);
    expect(tiers).toEqual([{ tierCode: TIER_P1, tierOrder: 3 }]);
  });
});

describe('deriveCommercialClassification 首个命中（需求 29.2）', () => {
  it('P1 命中即为 Dummy Job，且携带命中层级与依据来源', () => {
    const result = deriveCommercialClassification(
      { id: 'c1', card_type: '10' },
      { ...noSources, planDummyJob: { planRef: 'PLAN-001' }, nrcOriginatingDoc: { docNo: 'NR-1' } },
      cfg,
    );
    expect(result.status).toBe(DERIVATION_STATUS.DERIVED);
    expect(result.classification).toBe('Dummy Job');
    expect(result.hitTier).toBe(TIER_P1);
    expect(result.sourceRef).toBe('PLAN-001');
  });

  it('P3 命中给出 Outsource 与二级细分（需求 29.3）', () => {
    const result = deriveCommercialClassification(
      { card_type: '02' },
      { ...noSources, outsourceEntry: { listRef: 'OS-7', subtype: 'L sub' }, partNature: true },
      cfg,
    );
    expect(result.classification).toBe('Outsource');
    expect(result.outsourceSubtype).toBe('L sub');
    expect(result.hitTier).toBe(TIER_P3);
  });

  it('配置表顺序变化即改判定结果，不改代码（需求 29.8）', () => {
    const sources = { ...noSources, planDummyJob: true, partNature: true };
    const reordered = {
      tiers: [
        { tier_code: 'P4_PartNature', tier_order: 1, enabled: 1 },
        { tier_code: TIER_P1, tier_order: 2, enabled: 1 },
      ],
      cardTypeMap: defaultMap,
    };
    expect(deriveCommercialClassification({ card_type: '02' }, sources, cfg).classification)
      .toBe('Dummy Job');
    expect(deriveCommercialClassification({ card_type: '02' }, sources, reordered).classification)
      .toBe('LLP');
  });

  it('优先级链配置缺失时不回退常量，报 PRIORITY_CONFIG_MISSING', () => {
    const result = deriveCommercialClassification({ card_type: '02' }, noSources, undefined);
    expect(result.status).toBe(DERIVATION_STATUS.UNDETERMINED);
    expect(result.reasonCode).toBe(DERIVATION_REASON.PRIORITY_CONFIG_MISSING);
  });
});

describe('P6 兜底（需求 29.2 P6、43.3、43.4）', () => {
  it('P1–P5 未命中时依类型映射派生，02–09→Routine、10→SB/AD/SL', () => {
    for (const cardType of ['02', '05', '09']) {
      const r = deriveCommercialClassification({ card_type: cardType }, noSources, cfg);
      expect(r.classification).toBe('Routine');
      expect(r.hitTier).toBe(TIER_P6);
      expect(r.sourceRef).toBe(`card_type:${cardType}`);
    }
    expect(deriveCommercialClassification({ card_type: '10' }, noSources, cfg).classification)
      .toBe('SB/AD/SL');
  });

  it('P6 永不覆盖 P1–P5 的命中结果', () => {
    const result = deriveCommercialClassification(
      { card_type: '10' },
      { ...noSources, packageDivision: { classification: 'Configuration(MOD)' } },
      cfg,
    );
    expect(result.hitTier).toBe(TIER_P5);
    expect(result.classification).toBe('Configuration(MOD)');
  });

  it('类型 01、11 双值映射产出候选集且不自动裁决', () => {
    for (const [cardType, expected] of [
      ['01', ['Gear Inspection', 'Routine']],
      ['11', ['Material Special Replacement', 'Configuration(MOD)']],
    ]) {
      const r = deriveCommercialClassification({ card_type: cardType }, noSources, cfg);
      expect(r.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
      expect(r.classification).toBeNull();
      expect(r.requiresManualConfirmation).toBe(true);
      expect(r.reasonCode).toBe(DERIVATION_REASON.CARD_TYPE_MULTI_MAP);
      expect(r.candidates.map((c) => c.classification)).toEqual(expected);
      expect(r.candidates.every((c) => c.hitTier === TIER_P6 && c.sourceRef !== null)).toBe(true);
    }
  });

  it('类型未映射时无命中', () => {
    const r = deriveCommercialClassification({ card_type: '01' }, noSources, { tiers: defaultTiers });
    expect(r.status).toBe(DERIVATION_STATUS.UNDETERMINED);
    expect(r.reasonCode).toBe(DERIVATION_REASON.NO_TIER_HIT);
  });
});

describe('同层多命中不自动裁决（需求 29.4）', () => {
  it('P5 两条划分同时命中时产出候选集', () => {
    const r = deriveCommercialClassification(
      { card_type: '02' },
      {
        ...noSources,
        packageDivision: [
          { classification: 'Routine', packageRef: 'WP-1' },
          { classification: 'Material Special Replacement', packageRef: 'WP-2' },
        ],
      },
      cfg,
    );
    expect(r.status).toBe(DERIVATION_STATUS.REQUIRES_CONFIRMATION);
    expect(r.classification).toBeNull();
    expect(r.reasonCode).toBe(DERIVATION_REASON.MULTI_HIT_IN_TIER);
    expect(r.hitTier).toBe(TIER_P5);
    expect(r.candidates.map((c) => c.sourceRef)).toEqual(['WP-1', 'WP-2']);
  });

  it('同层同值重复依据不构成多命中', () => {
    const r = deriveCommercialClassification(
      { card_type: '02' },
      { ...noSources, packageDivision: [{ classification: 'Routine' }, { classification: 'Routine' }] },
      cfg,
    );
    expect(r.status).toBe(DERIVATION_STATUS.DERIVED);
    expect(r.classification).toBe('Routine');
  });
});

describe('人工确认与取值封闭性（需求 29.6、29.7）', () => {
  const pending = deriveCommercialClassification({ card_type: '11' }, noSources, cfg);

  it('确认候选值后标记人工确认并记录确认人与时间', () => {
    const { accepted, result } = confirmClassification(
      pending, 'Configuration(MOD)', { confirmedBy: 'u-ts-1', confirmedAt: '2025-01-02T03:04:05Z' },
    );
    expect(accepted).toBe(true);
    expect(result.status).toBe(DERIVATION_STATUS.CONFIRMED);
    expect(result.classification).toBe('Configuration(MOD)');
    expect(result.isManualConfirmed).toBe(true);
    expect(result.isCandidateChoice).toBe(true);
    expect(result.hitTier).toBe(TIER_P6);
    expect(result.confirmedBy).toBe('u-ts-1');
    expect(result.confirmedAt).toBe('2025-01-02T03:04:05Z');
  });

  it('拒绝取值集合以外的人工指定值', () => {
    const rejected = confirmClassification(pending, 'Whatever', { confirmedBy: 'u1' });
    expect(rejected.accepted).toBe(false);
    expect(rejected.reasonCode).toBe(DERIVATION_REASON.CLASSIFICATION_NOT_ALLOWED);
    expect(rejected.result).toBeNull();
    expect(isValidCommercialClassification('Whatever')).toBe(false);
  });
});

describe('normalizeCardTypeMap', () => {
  it('聚合同类型多值并剔除越界分类', () => {
    const map = normalizeCardTypeMap([
      { card_type: '01', commercial_classification: 'Gear Inspection' },
      { card_type: '01', commercial_classification: 'Routine' },
      { card_type: '01', commercial_classification: 'Nonsense' },
    ]);
    expect(map['01']).toEqual(['Gear Inspection', 'Routine']);
  });
});

describe('确定性（Property 23 的示例锚点）', () => {
  it('相同输入两次调用结果逐字段相等', () => {
    const card = { card_type: '01' };
    const sources = { ...noSources, outsourceEntry: [{ subtype: 'L sub' }, { subtype: '工序外委' }] };
    expect(deriveCommercialClassification(card, sources, cfg))
      .toEqual(deriveCommercialClassification(card, sources, cfg));
  });
});
