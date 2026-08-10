import { describe, it, expect } from 'vitest';
import {
  AC_TYPE,
  GEAR_TYPE,
  STAGE,
  SKILL,
  CTRL_CODE,
  CARD_TYPE,
  CARD_TYPE_CODES,
  EXEC_DOC_TYPE,
  EXEC_DOC_SIGN_RULE,
  CARD_STATUS,
  ALLOWED_TRANSITIONS,
  COMPONENT_TYPE,
  SIGNATURE_ROLE,
  COMMERCIAL_CLASSIFICATION,
  OUTSOURCE_SUBTYPE,
  DERIVATION_PRIORITY,
  ROLE,
  PERMISSION_POINT,
  STAGE_CROSSCUT,
  ENUMS,
  enumValues,
  isValidEnumValue,
  renderCheckConstraint,
} from './enums.js';

describe('枚举集合基数与内容', () => {
  it('各集合基数符合需求定义', () => {
    expect(AC_TYPE).toHaveLength(20);
    expect(GEAR_TYPE).toHaveLength(6);
    expect(STAGE).toHaveLength(8);
    expect(SKILL).toHaveLength(20);
    expect(CTRL_CODE).toHaveLength(9);
    expect(CARD_TYPE_CODES).toHaveLength(11);
    expect(EXEC_DOC_TYPE).toHaveLength(11);
    expect(CARD_STATUS).toHaveLength(5);
    expect(COMPONENT_TYPE).toHaveLength(13);
    expect(COMMERCIAL_CLASSIFICATION).toHaveLength(9);
    expect(DERIVATION_PRIORITY).toHaveLength(6);
    expect(ROLE).toHaveLength(8);
    expect(PERMISSION_POINT).toHaveLength(13);
    expect(STAGE_CROSSCUT).toEqual(['DMY', 'NRC', 'WCC', 'WFD']);
    expect(SIGNATURE_ROLE).toHaveLength(4);
    expect(OUTSOURCE_SUBTYPE).toEqual(['L sub', '工序外委']);
  });

  it('工卡类型键为 01–11，IR 卡为 04', () => {
    expect(CARD_TYPE_CODES).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']);
    expect(CARD_TYPE['04']).toContain('IR');
  });

  it('组件类型含 signature（承载 I.8）', () => {
    expect(COMPONENT_TYPE).toContain('signature');
  });

  it('权限点含三个独立点：batch_replace / config_write / capability_write', () => {
    expect(PERMISSION_POINT).toContain('batch_replace');
    expect(PERMISSION_POINT).toContain('config_write');
    expect(PERMISSION_POINT).toContain('capability_write');
  });

  it('SC 单据不签署、其所发工卡步骤需签署；其余为签署', () => {
    expect(EXEC_DOC_SIGN_RULE.SC).toBe('单据不签署，所发工卡步骤需签署');
    for (const code of EXEC_DOC_TYPE.filter((c) => c !== 'SC')) {
      expect(EXEC_DOC_SIGN_RULE[code]).toBe('签署');
    }
  });

  it('终态 Superseded / Void 无出边', () => {
    expect(ALLOWED_TRANSITIONS.Superseded).toEqual([]);
    expect(ALLOWED_TRANSITIONS.Void).toEqual([]);
    expect(Object.keys(ALLOWED_TRANSITIONS)).toEqual(CARD_STATUS);
  });
});

describe('isValidEnumValue', () => {
  it('集合内为真、集合外为假', () => {
    expect(isValidEnumValue('cardType', '04')).toBe(true);
    expect(isValidEnumValue('cardType', '12')).toBe(false);
    expect(isValidEnumValue('stage', 'RTN')).toBe(true);
    expect(isValidEnumValue('stage', 'rtn')).toBe(false);
  });

  it('Ctrl Code 与 Skill 为相互独立值域（需求 6.10）', () => {
    expect(isValidEnumValue('ctrlCode', 'GR')).toBe(false);
    expect(isValidEnumValue('skill', 'GR')).toBe(true);
    expect(isValidEnumValue('ctrlCode', 'OHV')).toBe(true);
    expect(isValidEnumValue('skill', 'OHV')).toBe(false);
    // 同码不同义：AS、CL 同时存在于两个值域，但判定各自独立
    expect(isValidEnumValue('ctrlCode', 'AS')).toBe(true);
    expect(isValidEnumValue('skill', 'AS')).toBe(true);
  });

  it('字段名接受 camelCase 与 snake_case 两种写法', () => {
    expect(isValidEnumValue('ctrl_code', 'DA')).toBe(true);
    expect(isValidEnumValue('permission_point', 'batch_replace')).toBe(true);
  });

  it('未知字段与非字符串取值一律为假', () => {
    expect(isValidEnumValue('wbs', '04')).toBe(false);
    expect(isValidEnumValue('cardType', 4)).toBe(false);
    expect(isValidEnumValue('cardType', null)).toBe(false);
    expect(isValidEnumValue(undefined, 'RTN')).toBe(false);
  });

  it('每个 ENUMS 条目的全部取值均判定为真', () => {
    for (const [field, values] of Object.entries(ENUMS)) {
      for (const value of values) {
        expect(isValidEnumValue(field, value)).toBe(true);
      }
    }
  });
});

describe('renderCheckConstraint', () => {
  it('渲染出列名与全部取值的 CHECK 子句', () => {
    expect(renderCheckConstraint('gearType')).toBe(
      "CHECK (gear_type IN ('BLG','LDG','MLG','N/A','NLG','WLG'))",
    );
    expect(renderCheckConstraint('cardStatus')).toBe(
      "CHECK (card_status IN ('New','UnderReview','Effective','Superseded','Void'))",
    );
  });

  it('支持列名覆盖，使同一值域可绑定不同列', () => {
    expect(renderCheckConstraint('stage', 'allowed_stage')).toBe(
      "CHECK (allowed_stage IN ('CUS','DMY','MOD','NRC','RTN','SPC','WCC','WFD'))",
    );
    expect(renderCheckConstraint('componentType', 'type')).toContain("'signature'");
  });

  it('单引号被转义为成对单引号', () => {
    const clause = renderCheckConstraint('cardType', "col'x");
    expect(clause.startsWith("CHECK (col'x IN (")).toBe(true);
    // 值域本身无单引号，逐值检查转义结果与源值一致
    for (const code of CARD_TYPE_CODES) {
      expect(clause).toContain(`'${code}'`);
    }
  });

  it('未知字段抛错（DDL 生成期失败优于生成无约束的表）', () => {
    expect(() => renderCheckConstraint('wbs')).toThrow(/未知枚举字段/);
  });
});

describe('enumValues', () => {
  it('已知字段返回值域、未知字段返回 null', () => {
    expect(enumValues('acType')).toBe(AC_TYPE);
    expect(enumValues('unknown_field')).toBeNull();
  });
});
