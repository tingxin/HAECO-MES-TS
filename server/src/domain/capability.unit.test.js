import { describe, it, expect } from 'vitest';
import { currentCapabilityRevision, checkCapability, CAPABILITY_REJECTION } from './capability.js';
import { SEED_CAPABILITY_LIST } from '../db/seed.js';

const TODAY = '2024-06-01';

/** 与 seed 同形的一行 */
const row = (acType, gearType, skill, revision, from, to = null) => ({
  ac_type: acType,
  gear_type: gearType,
  skill,
  revision,
  effective_from: from,
  effective_to: to,
});

describe('currentCapabilityRevision —— 当前有效版本号（需求 39.4）', () => {
  it('空集合 / 非数组入参：无当前有效版本', () => {
    expect(currentCapabilityRevision([], TODAY)).toBeNull();
    expect(currentCapabilityRevision(null, TODAY)).toBeNull();
    expect(currentCapabilityRevision(undefined, TODAY)).toBeNull();
  });

  it('同期多条取 revision 最大者，且与数组顺序无关', () => {
    const rows = [
      row('320', 'MLG', 'GR', 2, '2020-01-01'),
      row('320', 'MLG', 'GR', 3, '2020-01-01'),
      row('320', 'MLG', 'GR', 1, '2020-01-01'),
    ];
    expect(currentCapabilityRevision(rows, TODAY)).toBe(3);
    expect(currentCapabilityRevision([...rows].reverse(), TODAY)).toBe(3);
  });

  it('已过期与尚未生效的记录不参与选取', () => {
    const rows = [
      row('320', 'MLG', 'GR', 9, '2010-01-01', '2019-12-31'), // 已过期
      row('320', 'MLG', 'GR', 8, '2999-01-01'), // 尚未生效
      row('320', 'MLG', 'GR', 2, '2020-01-01'), // 当前有效
    ];
    expect(currentCapabilityRevision(rows, TODAY)).toBe(2);
  });

  it('effective_to 为空视为长期有效；生效期边界日含当日', () => {
    expect(currentCapabilityRevision([row('320', 'MLG', 'GR', 4, '2020-01-01', null)], TODAY)).toBe(4);
    expect(currentCapabilityRevision([row('320', 'MLG', 'GR', 4, TODAY, TODAY)], TODAY)).toBe(4);
    expect(currentCapabilityRevision([row('320', 'MLG', 'GR', 4, '2020-01-01', '2024-05-31')], TODAY)).toBeNull();
    expect(currentCapabilityRevision([row('320', 'MLG', 'GR', 4, '2024-06-02', null)], TODAY)).toBeNull();
  });

  it('日期非法或生效期字段异常时不可判定，一律不参与选取', () => {
    const rows = [row('320', 'MLG', 'GR', 2, '2020-01-01')];
    expect(currentCapabilityRevision(rows, '2024/06/01')).toBeNull();
    expect(currentCapabilityRevision([row('320', 'MLG', 'GR', 2, null)], TODAY)).toBeNull();
    expect(currentCapabilityRevision([row('320', 'MLG', 'GR', 2, '2020-1-1')], TODAY)).toBeNull();
  });

  it('接受 Date 入参与 camelCase 记录写法', () => {
    const camel = [{ acType: '320', gearType: 'MLG', skill: 'GR', revision: 5, effectiveFrom: '2020-01-01', effectiveTo: null }];
    expect(currentCapabilityRevision(camel, new Date('2024-06-01T00:00:00Z'))).toBe(5);
  });
});

describe('checkCapability —— 能力范围校验（需求 39.1–39.3）', () => {
  const list = [
    row('320', 'MLG', 'GR', 1, '2010-01-01', '2019-12-31'), // 已过期
    row('320', 'MLG', 'GR', 2, '2020-01-01'),
    row('320', 'MLG', 'GR', 3, '2020-01-01'), // 同期更大版本
    row('747', 'NLG', 'IR', 1, '2020-01-01'),
    row('350', 'WLG', 'AS', 1, '2999-01-01'), // 尚未生效
  ];

  it('组合在当前有效版本内：通过并带出该作用域的版本号', () => {
    const result = checkCapability({ ac_type: '320', gear_type: 'MLG', skill: 'GR' }, list, TODAY);
    expect(result.ok).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.revision).toBe(3);
    expect(result.scope).toEqual({ acType: '320', gearType: 'MLG', skill: 'GR' });
    expect(result.onDate).toBe(TODAY);
  });

  it('版本作用域为三元组：仅有 rev 1 的组合同样通过，不被其它组合的更大版本裁剪（需求 39.4）', () => {
    const result = checkCapability({ acType: '747', gearType: 'NLG', skill: 'IR' }, list, TODAY);
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(1);
  });

  it('组合不在清单内：OUT_OF_SCOPE 且提示超出已批准范围（需求 39.3）', () => {
    const result = checkCapability({ ac_type: '737', gear_type: 'BLG', skill: 'NT' }, list, TODAY);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(CAPABILITY_REJECTION.OUT_OF_SCOPE);
    expect(result.revision).toBeNull();
    expect(result.message).toContain('超出已批准能力范围');
  });

  it('组合仅有已过期或尚未生效的记录：判为超出范围', () => {
    const expiredOnly = [row('737', 'BLG', 'NT', 1, '2010-01-01', '2019-12-31'), row('320', 'MLG', 'GR', 2, '2020-01-01')];
    expect(checkCapability({ ac_type: '737', gear_type: 'BLG', skill: 'NT' }, expiredOnly, TODAY).rejection).toBe(
      CAPABILITY_REJECTION.OUT_OF_SCOPE,
    );
    expect(checkCapability({ ac_type: '350', gear_type: 'WLG', skill: 'AS' }, list, TODAY).rejection).toBe(
      CAPABILITY_REJECTION.OUT_OF_SCOPE,
    );
  });

  it('清单为空 / 全部过期：NO_EFFECTIVE_REVISION，与超范围可区分（需求 39.1、39.4）', () => {
    const card = { ac_type: '320', gear_type: 'MLG', skill: 'GR' };
    expect(checkCapability(card, [], TODAY).rejection).toBe(CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION);
    expect(checkCapability(card, null, TODAY).rejection).toBe(CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION);

    const allExpired = [row('320', 'MLG', 'GR', 2, '2010-01-01', '2019-12-31')];
    const result = checkCapability(card, allExpired, TODAY);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION);
    expect(result.message).toContain('能力清单缺失或已过期');
  });

  it('三元组缺项或工卡非对象：判为超出范围（不匹配任何 NOT NULL 记录）', () => {
    expect(checkCapability({ ac_type: '320', gear_type: null, skill: 'GR' }, list, TODAY).rejection).toBe(
      CAPABILITY_REJECTION.OUT_OF_SCOPE,
    );
    expect(checkCapability(null, list, TODAY).rejection).toBe(CAPABILITY_REJECTION.OUT_OF_SCOPE);
  });

  it('校验日期格式非法：INVALID_ON_DATE，不放行', () => {
    const result = checkCapability({ ac_type: '320', gear_type: 'MLG', skill: 'GR' }, list, '01/06/2024');
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(CAPABILITY_REJECTION.INVALID_ON_DATE);
    expect(result.onDate).toBeNull();
  });

  it('返回值不可变（冻结），避免服务层误改判定结果', () => {
    const result = checkCapability({ ac_type: '320', gear_type: 'MLG', skill: 'GR' }, list, TODAY);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scope)).toBe(true);
  });

  it('对种子数据成立：320/MLG/GR 取 rev 3、747/NLG/IR 通过、350/WLG/AS 尚未生效', () => {
    const seeded = SEED_CAPABILITY_LIST.map((r) => ({ ...r }));
    expect(checkCapability({ ac_type: '320', gear_type: 'MLG', skill: 'GR' }, seeded, TODAY).revision).toBe(3);
    expect(checkCapability({ ac_type: '747', gear_type: 'NLG', skill: 'IR' }, seeded, TODAY).ok).toBe(true);
    expect(checkCapability({ ac_type: '737', gear_type: 'BLG', skill: 'NT' }, seeded, TODAY).ok).toBe(true);
    expect(checkCapability({ ac_type: '350', gear_type: 'WLG', skill: 'AS' }, seeded, TODAY).rejection).toBe(
      CAPABILITY_REJECTION.OUT_OF_SCOPE,
    );
  });
});
