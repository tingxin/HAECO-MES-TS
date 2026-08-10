import { describe, it, expect } from 'vitest';
import { CARD_TYPE_CODES, STAGE_CROSSCUT } from './enums.js';
import { buildStageConstraintRows } from '../db/seed.js';
import {
  allowedStagesFor,
  crosscutStagesOf,
  defaultStageFor,
  normalizeStageConstraintConfig,
  selectableForStandardPackage,
  selectableStages,
  STAGE_REJECTION,
  validateStageCardType,
} from './stage-constraint.js';

/** 种子配置：01–09→RTN(auto)、10→SPC(auto)、11→CUS/MOD(非 auto)，横切取值 DMY/NRC/WCC/WFD */
const seedCfg = () => ({
  constraints: buildStageConstraintRows(),
  crosscut: STAGE_CROSSCUT.map((stage) => ({ stage })),
});

const ROUTINE_TYPES = ['01', '02', '03', '04', '05', '06', '07', '08', '09'];

describe('normalizeStageConstraintConfig（需求 46.9、46.14）', () => {
  it('兼容 snake_case 行、camelCase 行与直接传入数组', () => {
    const snake = normalizeStageConstraintConfig({
      stage_card_type_constraint: [{ card_type: '10', allowed_stage: 'SPC', is_auto_fill: 1 }],
      stage_crosscut: [{ stage: 'WFD' }],
    });
    expect(snake.allowedByCardType['10']).toEqual(['SPC']);
    expect(snake.autoFillByCardType['10']).toEqual(['SPC']);
    expect(snake.crosscutStages).toEqual(['WFD']);

    const camel = normalizeStageConstraintConfig({
      constraints: [{ cardType: '10', allowedStage: 'SPC', isAutoFill: true }],
      crosscutStages: ['WFD'],
    });
    expect(camel).toEqual(snake);

    // 裸数组：横切取值来源未给出，取种子默认值
    const bare = normalizeStageConstraintConfig([{ card_type: '11', allowed_stage: 'CUS', is_auto_fill: 0 }]);
    expect(bare.allowedByCardType['11']).toEqual(['CUS']);
    expect(bare.autoFillByCardType['11']).toEqual([]);
    expect(bare.crosscutStages).toEqual([...STAGE_CROSSCUT]);
  });

  it('横切取值以配置为运行时权威：给出空数组即视为清空，未给出才兜底种子值', () => {
    expect(crosscutStagesOf({ constraints: [], crosscut: [] })).toEqual([]);
    expect(crosscutStagesOf({ constraints: [], crosscut: ['MOD'] })).toEqual(['MOD']);
    expect(crosscutStagesOf(null)).toEqual([...STAGE_CROSSCUT]);
  });

  it('静默忽略非法行（未知类型、未知 Stage、非对象）并去重', () => {
    const cfg = normalizeStageConstraintConfig({
      constraints: [
        { card_type: '99', allowed_stage: 'RTN' },
        { card_type: '01', allowed_stage: 'ZZZ' },
        null,
        'RTN',
        { card_type: '01', allowed_stage: 'RTN', is_auto_fill: 1 },
        { card_type: '01', allowed_stage: 'RTN', is_auto_fill: 1 },
      ],
      crosscut: ['WFD', 'WFD', 'nope', 42],
    });
    expect(cfg.allowedByCardType['01']).toEqual(['RTN']);
    expect(cfg.crosscutStages).toEqual(['WFD']);
    // 键集合覆盖全部类型；`'10'`/`'11'` 属整数索引键会被引擎前置，故比较集合而非顺序
    expect(new Set(Object.keys(cfg.allowedByCardType))).toEqual(new Set(CARD_TYPE_CODES));
  });
});

describe('validateStageCardType（需求 46.10、46.11、46.13）', () => {
  it('放行约束表允许组合', () => {
    const cfg = seedCfg();
    for (const cardType of ROUTINE_TYPES) {
      expect(validateStageCardType('RTN', cardType, cfg).ok).toBe(true);
    }
    expect(validateStageCardType('SPC', '10', cfg).ok).toBe(true);
    expect(validateStageCardType('CUS', '11', cfg).ok).toBe(true);
    expect(validateStageCardType('MOD', '11', cfg).ok).toBe(true);
  });

  it('放行横切取值与任意工卡类型的共存，并标记 viaCrosscut', () => {
    const cfg = seedCfg();
    for (const cardType of CARD_TYPE_CODES) {
      for (const stage of STAGE_CROSSCUT) {
        const result = validateStageCardType(stage, cardType, cfg);
        expect(result.ok).toBe(true);
        expect(result.viaCrosscut).toBe(true);
      }
    }
  });

  it('阻止非允许组合并提示可取范围', () => {
    const cfg = seedCfg();
    const result = validateStageCardType('SPC', '01', cfg);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(STAGE_REJECTION.COMBINATION_NOT_ALLOWED);
    expect(result.selectableStages).toEqual(['RTN', ...STAGE_CROSSCUT]);
    expect(result.message).toContain('RTN');

    expect(validateStageCardType('CUS', '10', cfg).ok).toBe(false);
    expect(validateStageCardType('RTN', '11', cfg).ok).toBe(false);
  });

  it('未知 Stage / 未知工卡类型一律拒绝', () => {
    const cfg = seedCfg();
    expect(validateStageCardType('ZZZ', '01', cfg).rejection).toBe(STAGE_REJECTION.UNKNOWN_STAGE);
    expect(validateStageCardType(undefined, '01', cfg).rejection).toBe(STAGE_REJECTION.UNKNOWN_STAGE);
    expect(validateStageCardType('RTN', '12', cfg).rejection).toBe(STAGE_REJECTION.UNKNOWN_CARD_TYPE);
    expect(validateStageCardType('RTN', null, cfg).rejection).toBe(STAGE_REJECTION.UNKNOWN_CARD_TYPE);
  });

  it('改配置即改校验结果，不改代码（需求 46.14）', () => {
    const cfg = { constraints: [{ card_type: '01', allowed_stage: 'SPC', is_auto_fill: 1 }], crosscut: [] };
    expect(validateStageCardType('SPC', '01', cfg).ok).toBe(true);
    expect(validateStageCardType('RTN', '01', cfg).ok).toBe(false);
    expect(validateStageCardType('WFD', '01', cfg).ok).toBe(false); // 横切取值被清空
  });
});

describe('defaultStageFor（需求 46.12：默认值，不置只读）', () => {
  it('单一允许 Stage 的类型给出默认值', () => {
    const cfg = seedCfg();
    for (const cardType of ROUTINE_TYPES) {
      expect(defaultStageFor(cardType, cfg)).toBe('RTN');
    }
    expect(defaultStageFor('10', cfg)).toBe('SPC');
  });

  it('多个允许 Stage 并存（类型 11 的 CUS/MOD）无默认值，须人工选择', () => {
    expect(defaultStageFor('11', seedCfg())).toBeNull();
  });

  it('默认值恒属于该类型的允许组合，绝不取仅存在于横切取值中的 Stage', () => {
    const cfg = seedCfg();
    for (const cardType of CARD_TYPE_CODES) {
      const value = defaultStageFor(cardType, cfg);
      if (value !== null) expect(allowedStagesFor(cardType, cfg)).toContain(value);
    }
  });

  it('无配置行或未知类型时为 null', () => {
    expect(defaultStageFor('01', { constraints: [], crosscut: [] })).toBeNull();
    expect(defaultStageFor('99', seedCfg())).toBeNull();
    expect(defaultStageFor(undefined, seedCfg())).toBeNull();
  });
});

describe('selectableStages（需求 46.12、46.13：横切取值对任意类型可达）', () => {
  it('恒等于该类型允许组合 ∪ 横切取值，且与校验放行集合一致', () => {
    const cfg = seedCfg();
    for (const cardType of CARD_TYPE_CODES) {
      const expected = new Set([...allowedStagesFor(cardType, cfg), ...STAGE_CROSSCUT]);
      expect(new Set(selectableStages(cardType, cfg))).toEqual(expected);
      for (const stage of selectableStages(cardType, cfg)) {
        expect(validateStageCardType(stage, cardType, cfg).ok).toBe(true);
      }
    }
  });

  it('WFD 对全部工卡类型可达——否则需求 46.5 的排除逻辑失效', () => {
    const cfg = seedCfg();
    for (const cardType of CARD_TYPE_CODES) {
      expect(selectableStages(cardType, cfg)).toContain('WFD');
    }
  });
});

describe('selectableForStandardPackage（需求 46.3、46.5、46.7 契约谓词）', () => {
  const card = (stage, status) => ({ id: 1, taskNo: 'TC-0001', card_type: '01', stage, status });

  it('仅 Stage=RTN 且状态为 Effective 时为真', () => {
    expect(selectableForStandardPackage(card('RTN', 'Effective'))).toBe(true);
    expect(selectableForStandardPackage(card('RTN', 'New'))).toBe(false);
    expect(selectableForStandardPackage(card('RTN', 'UnderReview'))).toBe(false);
    expect(selectableForStandardPackage(card('RTN', 'Superseded'))).toBe(false);
    expect(selectableForStandardPackage(card('RTN', 'Void'))).toBe(false);
    expect(selectableForStandardPackage(card('SPC', 'Effective'))).toBe(false);
    expect(selectableForStandardPackage(card('CUS', 'Effective'))).toBe(false);
  });

  it('Stage=WFD 恒为假，即使状态仍为 Effective', () => {
    expect(selectableForStandardPackage(card('WFD', 'Effective'))).toBe(false);
    expect(selectableForStandardPackage({ stage: 'WFD', card_status: 'Effective' })).toBe(false);
  });

  it('缺失或非法入参一律为假', () => {
    expect(selectableForStandardPackage(null)).toBe(false);
    expect(selectableForStandardPackage({})).toBe(false);
    expect(selectableForStandardPackage(card('ZZZ', 'Effective'))).toBe(false);
  });
});
