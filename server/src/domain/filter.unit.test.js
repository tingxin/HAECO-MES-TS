import { describe, it, expect } from 'vitest';
import {
  matchesFilters,
  filterCards,
  normalizeFilters,
  activeFilterFields,
  FILTER_FIELD_NAMES,
} from './filter.js';

/** 与仓储层出参同形的工卡（camelCase） */
const card = (over = {}) => ({
  id: 1,
  taskNo: 'TC-320-001',
  revision: 1,
  title: 'MLG Shock Strut Inspection',
  acType: '320',
  gearType: 'MLG',
  stage: 'RTN',
  status: 'New',
  cardType: '01',
  ...over,
});

describe('normalizeFilters —— 空条件剔除（需求 1.3）', () => {
  it('非对象入参与全空条件均无生效条件', () => {
    expect(normalizeFilters(null)).toEqual([]);
    expect(normalizeFilters(undefined)).toEqual([]);
    expect(normalizeFilters('320')).toEqual([]);
    expect(normalizeFilters({})).toEqual([]);
    expect(normalizeFilters({ acType: '', taskNo: '   ', title: null, status: undefined, stage: [] })).toEqual([]);
  });

  it('仅非空条件进入生效集合，键名支持 snake_case', () => {
    expect(activeFilterFields({ ac_type: '320', title: '', card_type: '04' })).toEqual(['acType', 'cardType']);
  });

  it('七个筛选维度与 design.md §1.1 查询参数一致', () => {
    expect(FILTER_FIELD_NAMES).toEqual(['acType', 'taskNo', 'gearType', 'title', 'status', 'stage', 'cardType']);
  });
});

describe('matchesFilters —— AND 语义（需求 1.2、1.3）', () => {
  it('空条件全通过，且不读取工卡字段', () => {
    expect(matchesFilters(card(), {})).toBe(true);
    expect(matchesFilters({}, { acType: '  ' })).toBe(true);
    expect(matchesFilters(null, null)).toBe(true);
  });

  it('多条件须同时成立，任一不满足即不命中', () => {
    const c = card();
    expect(matchesFilters(c, { acType: '320', gearType: 'MLG', status: 'New' })).toBe(true);
    expect(matchesFilters(c, { acType: '320', gearType: 'NLG' })).toBe(false);
  });

  it('工卡缺该字段时任何非空条件均不成立', () => {
    expect(matchesFilters({ taskNo: 'TC-1' }, { acType: '320' })).toBe(false);
  });

  it('选择类维度精确匹配，输入类维度子串且大小写不敏感（需求 1.1）', () => {
    const c = card();
    expect(matchesFilters(c, { taskNo: '320' })).toBe(true);
    expect(matchesFilters(c, { title: 'shock strut' })).toBe(true);
    expect(matchesFilters(c, { acType: '32' })).toBe(false); // 精确：不做前缀匹配
  });

  it('筛选值首尾空白不改变结果', () => {
    expect(matchesFilters(card(), { acType: ' 320 ', title: ' Shock ' })).toBe(true);
  });

  it('状态、Stage、工卡类型为一等筛选条件（需求 1.5、4.4、46.6、2.1）', () => {
    expect(matchesFilters(card({ status: 'Effective' }), { status: 'Effective' })).toBe(true);
    expect(matchesFilters(card({ status: 'New' }), { status: 'Effective' })).toBe(false);
    expect(matchesFilters(card({ stage: 'WFD' }), { stage: 'WFD' })).toBe(true);
    expect(matchesFilters(card({ cardType: '04' }), { cardType: '04' })).toBe(true);
  });

  it('同一维度多候选取值为 OR，维度之间仍为 AND', () => {
    const c = card({ status: 'UnderReview' });
    expect(matchesFilters(c, { status: ['New', 'UnderReview'] })).toBe(true);
    expect(matchesFilters(c, { status: ['New', 'UnderReview'], acType: '330' })).toBe(false);
  });

  it('snake_case 工卡（仓储原始行）同样可判定', () => {
    const row = { task_no: 'TC-330-009', ac_type: '330', gear_type: 'NLG', card_type: '10', status: 'Effective' };
    expect(matchesFilters(row, { acType: '330', cardType: '10', taskNo: '009' })).toBe(true);
  });
});

describe('filterCards —— 集合筛选（需求 1.2、1.4）', () => {
  const cards = [
    card({ id: 1, acType: '320', status: 'New' }),
    card({ id: 2, acType: '330', status: 'Effective', title: 'NLG Wheel Change' }),
    card({ id: 3, acType: '320', status: 'Effective' }),
  ];

  it('空条件结果等于全集且保持顺序', () => {
    expect(filterCards(cards, {}).map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('AND 组合按全部条件收窄', () => {
    expect(filterCards(cards, { acType: '320', status: 'Effective' }).map((c) => c.id)).toEqual([3]);
  });

  it('无匹配返回空集（需求 1.4）', () => {
    expect(filterCards(cards, { acType: '777' })).toEqual([]);
  });

  it('非数组入参视为空集', () => {
    expect(filterCards(null, {})).toEqual([]);
  });
});
