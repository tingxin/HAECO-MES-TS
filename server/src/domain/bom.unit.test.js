import { describe, it, expect } from 'vitest';
import { aggregateBomBase, BOM_BASE_SOURCE } from './bom.js';

/** 类型 04 IR 卡（直接维护 Base，需求 8.1、48.4(a)） */
const irCard = {
  id: 1,
  task_no: 'TC-2026-0001',
  title: 'MLG 目视检查',
  card_type: '04',
  base_number: 'BASE-320-MLG-101',
};

/** 类型 05 IR Lot 卡（经 Lot List 带出 Base，需求 48.1、48.4(b)） */
const lotCard = { id: 2, task_no: 'TC-2026-0002', title: 'MLG Lot 检查', card_type: '05' };

/** 已由 `GET /api/lot-lists/:lotListRef/bases` 补齐 Base 值的关联行 */
const lotLink = {
  card_id: 2,
  lot_number: 'LOT-2026-0001',
  lot_list_ref: 'LT-2026-001',
  bases: [
    { baseNumber: 'BASE-320-MLG-201', lotNumber: 'LOT-2026-0001' },
    { baseNumber: 'BASE-320-MLG-202', lotNumber: 'LOT-2026-0001' },
  ],
};

describe('aggregateBomBase —— 两来源并集（需求 48.4）', () => {
  it('空入参产出空输出', () => {
    expect(aggregateBomBase([], [])).toEqual([]);
    expect(aggregateBomBase(null, undefined)).toEqual([]);
  });

  it('输出 = 04 直接维护的 Base ∪ 05 经 Lot List 带出的 Base', () => {
    const rows = aggregateBomBase([irCard, lotCard], [lotLink]);
    expect(rows.map((r) => r.baseNumber)).toEqual([
      'BASE-320-MLG-101',
      'BASE-320-MLG-201',
      'BASE-320-MLG-202',
    ]);
    expect(rows.map((r) => r.source)).toEqual(['ir_card', 'lot_list', 'lot_list']);
  });

  it('每行携带 Task Card No 与 Task Title（需求 48.5）', () => {
    const rows = aggregateBomBase([irCard, lotCard], [lotLink]);
    expect(rows[0]).toMatchObject({ taskNo: 'TC-2026-0001', taskTitle: 'MLG 目视检查', cardId: 1 });
    expect(rows[1]).toMatchObject({ taskNo: 'TC-2026-0002', taskTitle: 'MLG Lot 检查', cardId: 2 });
  });

  it('Lot List 来源携带 Lot Number 与 Lot List 引用，IR 卡来源两者恒为空（需求 48.6）', () => {
    const rows = aggregateBomBase([irCard, lotCard], [lotLink]);
    expect(rows[0].lotNumber).toBeNull();
    expect(rows[0].lotListRef).toBeNull();
    expect(rows[1].lotNumber).toBe('LOT-2026-0001');
    expect(rows[1].lotListRef).toBe('LT-2026-001');
  });

  it('同一 05 卡关联多个 Lot List 时逐个带出，各自标识自身 Lot Number（需求 48.1、48.2）', () => {
    const rows = aggregateBomBase([lotCard], [
      lotLink,
      { card_id: 2, lot_number: 'LOT-2026-0002', lot_list_ref: 'LT-2026-002', bases: ['BASE-777-NLG-201'] },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({
      baseNumber: 'BASE-777-NLG-201',
      lotNumber: 'LOT-2026-0002',
      source: BOM_BASE_SOURCE.LOT_LIST,
    });
  });

  it('Base 明细为字符串数组时，Lot Number 回落至关联行', () => {
    const rows = aggregateBomBase([lotCard], [{ ...lotLink, bases: ['BASE-A', ' BASE-B '] }]);
    expect(rows.map((r) => [r.baseNumber, r.lotNumber])).toEqual([
      ['BASE-A', 'LOT-2026-0001'],
      ['BASE-B', 'LOT-2026-0001'],
    ]);
  });

  it('camelCase 与 snake_case 入参等价', () => {
    const camel = aggregateBomBase(
      [{ id: 2, taskNo: 'TC-2026-0002', taskTitle: 'MLG Lot 检查', cardType: '05' }],
      [{ cardId: 2, lotNumber: 'LOT-2026-0001', lotListRef: 'LT-2026-001', base_numbers: [{ base_number: 'BASE-X' }] }],
    );
    const snake = aggregateBomBase(
      [lotCard],
      [{ card_id: 2, lot_number: 'LOT-2026-0001', lot_list_ref: 'LT-2026-001', bases: ['BASE-X'] }],
    );
    expect(camel).toEqual(snake);
  });
});

describe('aggregateBomBase —— 不去重（《临时设计说明》A6 待澄清项 3）', () => {
  it('同一 Base 由 04 与 05 两来源产出时保留两行，各自标识 source', () => {
    const rows = aggregateBomBase(
      [{ ...irCard, base_number: 'BASE-SHARED' }, lotCard],
      [{ ...lotLink, bases: ['BASE-SHARED'] }],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.baseNumber)).toEqual(['BASE-SHARED', 'BASE-SHARED']);
    expect(rows.map((r) => r.source)).toEqual([BOM_BASE_SOURCE.IR_CARD, BOM_BASE_SOURCE.LOT_LIST]);
  });

  it('同一 Base 由两个 Lot List 带出时同样保留两行', () => {
    const rows = aggregateBomBase([lotCard], [
      { card_id: 2, lot_number: 'LOT-1', lot_list_ref: 'LT-1', bases: ['BASE-DUP'] },
      { card_id: 2, lot_number: 'LOT-2', lot_list_ref: 'LT-2', bases: ['BASE-DUP'] },
    ]);
    expect(rows.map((r) => r.lotNumber)).toEqual(['LOT-1', 'LOT-2']);
  });
});

describe('aggregateBomBase —— Lot List Base 集合变更后同步更新（需求 48.8）', () => {
  it('同一工卡配以变更后的关联即得变更后输出（纯投影、无缓存）', () => {
    const before = aggregateBomBase([lotCard], [lotLink]);
    const after = aggregateBomBase([lotCard], [
      { ...lotLink, bases: ['BASE-320-MLG-201', 'BASE-320-MLG-303'] },
    ]);
    expect(before.map((r) => r.baseNumber)).toEqual(['BASE-320-MLG-201', 'BASE-320-MLG-202']);
    expect(after.map((r) => r.baseNumber)).toEqual(['BASE-320-MLG-201', 'BASE-320-MLG-303']);
    // 重复调用同一入参恒得同一结果
    expect(aggregateBomBase([lotCard], [lotLink])).toEqual(before);
  });

  it('Base 集合清空后该卡不再贡献输出行', () => {
    expect(aggregateBomBase([lotCard], [{ ...lotLink, bases: [] }])).toEqual([]);
    expect(aggregateBomBase([lotCard], [{ card_id: 2, lot_number: 'LOT-1' }])).toEqual([]);
  });
});

describe('aggregateBomBase —— 被忽略的入参情形', () => {
  it('非 04/05 类型工卡不贡献输出行，即便带有 base_number', () => {
    const rows = aggregateBomBase([{ id: 3, task_no: 'TC-3', card_type: '06', base_number: 'BASE-Z' }], []);
    expect(rows).toEqual([]);
  });

  it('04 卡 Base 为空或纯空白时不贡献输出行', () => {
    expect(aggregateBomBase([{ ...irCard, base_number: null }], [])).toEqual([]);
    expect(aggregateBomBase([{ ...irCard, base_number: '   ' }], [])).toEqual([]);
  });

  it('关联行的 card_id 不在 cards 中、或挂在非 05 卡上时被跳过', () => {
    expect(aggregateBomBase([], [lotLink])).toEqual([]);
    expect(aggregateBomBase([{ ...irCard, id: 2 }], [lotLink]).map((r) => r.source)).toEqual(['ir_card']);
  });

  it('空 Base 明细项被跳过，其余明细照常输出', () => {
    const rows = aggregateBomBase([lotCard], [{ ...lotLink, bases: ['', '  ', 'BASE-OK', { baseNumber: null }] }]);
    expect(rows.map((r) => r.baseNumber)).toEqual(['BASE-OK']);
  });
});

describe('aggregateBomBase —— 入参缺陷抛错', () => {
  it('入参非数组、元素非对象、bases 非数组一律抛 TypeError', () => {
    expect(() => aggregateBomBase('x', [])).toThrow(TypeError);
    expect(() => aggregateBomBase([], 'x')).toThrow(TypeError);
    expect(() => aggregateBomBase([null], [])).toThrow(TypeError);
    expect(() => aggregateBomBase([], [42])).toThrow(TypeError);
    expect(() => aggregateBomBase([lotCard], [{ card_id: 2, lot_number: 'L', bases: 'BASE-A' }])).toThrow(TypeError);
  });

  it('Lot List 来源取不到任何 Lot Number 时抛错（需求 48.2、48.6 无法满足）', () => {
    expect(() => aggregateBomBase([lotCard], [{ card_id: 2, bases: ['BASE-A'] }])).toThrow(/Lot Number/);
  });
});

describe('aggregateBomBase —— 返回值不可变', () => {
  it('输出数组与行对象均被冻结', () => {
    const rows = aggregateBomBase([irCard], []);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });

  it('不改写入参', () => {
    const cards = [structuredClone(irCard), structuredClone(lotCard)];
    const links = [structuredClone(lotLink)];
    aggregateBomBase(cards, links);
    expect(cards).toEqual([irCard, lotCard]);
    expect(links).toEqual([lotLink]);
  });
});
