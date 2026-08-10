import { describe, it, expect } from 'vitest';
import {
  buildChangeRecords,
  serializeChangeValue,
  CHANGE_TYPES,
  REJECTION,
} from './change-record.js';

const TS = '2024-05-01T03:00:00.000Z';
const OPTS = { timestamp: TS, cardId: 7, cardRevision: 2 };

describe('buildChangeRecords —— 字段级差异留痕（需求 19.1、19.3）', () => {
  it('每个实际变化的字段恰好产出一条记录，未变化字段不产生记录', () => {
    const before = { title: 'A', stage: 'MOD', isFai: false };
    const after = { title: 'B', stage: 'MOD', isFai: true };

    const result = buildChangeRecords(before, after, 'edit', '客户要求调整', 'E1001', OPTS);

    expect(result.ok).toBe(true);
    expect(result.records.map((r) => r.field)).toEqual(['isFai', 'title']);
    const title = result.records.find((r) => r.field === 'title');
    expect(title.old_value).toBe('A');
    expect(title.new_value).toBe('B');
    expect(title.change_type).toBe('edit');
    expect(title.reason).toBe('客户要求调整');
    expect(title.operator_id).toBe('E1001');
    expect(title.timestamp).toBe(TS);
    expect(title.card_id).toBe(7);
    expect(title.card_revision).toBe(2);
  });

  it('before 与 after 内容相同：产出空集（不产生幻影记录）', () => {
    const snapshot = { title: 'A', revision: 1, tags: ['x', 'y'] };
    const result = buildChangeRecords(snapshot, { ...snapshot }, 'edit', '无实质变更', 'E1001', OPTS);
    expect(result.ok).toBe(true);
    expect(result.records).toEqual([]);
  });

  it('落库形态相同不判为变更：1 与 "1"、undefined 与 null 均无记录', () => {
    const result = buildChangeRecords(
      { qty: 1, note: undefined },
      { qty: '1', note: null },
      'edit',
      '格式归一',
      'E1001',
      OPTS,
    );
    expect(result.records).toEqual([]);
  });

  it('嵌套对象仅键顺序不同不判为变更；内容变化才产出记录', () => {
    const same = buildChangeRecords(
      { meta: { a: 1, b: 2 } },
      { meta: { b: 2, a: 1 } },
      'edit',
      '键序无关',
      'E1001',
      OPTS,
    );
    expect(same.records).toEqual([]);

    const diff = buildChangeRecords(
      { meta: { a: 1 } },
      { meta: { a: 2 } },
      'edit',
      '内容变更',
      'E1001',
      OPTS,
    );
    expect(diff.records).toHaveLength(1);
    expect(diff.records[0].old_value).toBe('{"a":1}');
    expect(diff.records[0].new_value).toBe('{"a":2}');
  });

  it('新增字段与移除字段各产出一条记录，old_value / new_value 对应为 null', () => {
    const result = buildChangeRecords(
      { removed: 'x' },
      { added: 'y' },
      'edit',
      '字段增删',
      'E1001',
      OPTS,
    );
    expect(result.records).toHaveLength(2);
    expect(result.records.find((r) => r.field === 'removed')).toMatchObject({
      old_value: 'x',
      new_value: null,
    });
    expect(result.records.find((r) => r.field === 'added')).toMatchObject({
      old_value: null,
      new_value: 'y',
    });
  });
});

describe('buildChangeRecords —— 原因必填的整体拒绝（需求 19.2、20.7）', () => {
  it.each([undefined, null, '', '   ', '\t\n', '\u3000\u3000'])(
    '原因为 %p 时整体拒绝且零产出',
    (reason) => {
      const result = buildChangeRecords({ a: 1 }, { a: 2 }, 'edit', reason, 'E1001', OPTS);
      expect(result.ok).toBe(false);
      expect(result.rejection).toBe(REJECTION.REASON_REQUIRED);
      expect(result.records).toEqual([]);
    },
  );

  it('缺少操作人时整体拒绝（需求 19.3、7.4）', () => {
    const result = buildChangeRecords({ a: 1 }, { a: 2 }, 'edit', '有原因', '  ', OPTS);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(REJECTION.OPERATOR_REQUIRED);
    expect(result.records).toEqual([]);
  });

  it('变更类型非法时整体拒绝，不产出记录', () => {
    const result = buildChangeRecords({ a: 1 }, { a: 2 }, 'archive', '有原因', 'E1001', OPTS);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(REJECTION.INVALID_CHANGE_TYPE);
    expect(result.records).toEqual([]);
  });
});

describe('buildChangeRecords —— 五条路径共用单点（需求 20.8、42.5）', () => {
  it('五类 change_type 均可产出记录，且写入记录的 change_type 即本次操作类型', () => {
    for (const changeType of CHANGE_TYPES) {
      const result = buildChangeRecords(
        { status: 'New' },
        { status: 'Void' },
        changeType,
        '路径统一',
        'E1001',
        OPTS,
      );
      expect(result.ok).toBe(true);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].change_type).toBe(changeType);
    }
  });

  it('整体删除（after 缺失）产出恰好一条 field 为 null 的整体记录', () => {
    const step = { processId: 'P1', description: '拆卸' };
    const result = buildChangeRecords(step, null, 'delete', '工序取消', 'E1001', OPTS);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].field).toBeNull();
    expect(result.records[0].old_value).toBe('{"description":"拆卸","processId":"P1"}');
    expect(result.records[0].new_value).toBeNull();
  });

  it('两侧皆无快照：产出空集', () => {
    const result = buildChangeRecords(null, undefined, 'delete', '无变更', 'E1001', OPTS);
    expect(result.ok).toBe(true);
    expect(result.records).toEqual([]);
  });

  it('同一次变更的全部记录共享注入的时间戳', () => {
    const result = buildChangeRecords(
      { a: 1, b: 1 },
      { a: 2, b: 2 },
      'batch_replace',
      '批量替换',
      'E1001',
      { timestamp: new Date(TS) },
    );
    expect(result.records).toHaveLength(2);
    expect(new Set(result.records.map((r) => r.timestamp))).toEqual(new Set([TS]));
  });

  it('未注入时间戳时仍产出非空 ISO 时间戳', () => {
    const result = buildChangeRecords({ a: 1 }, { a: 2 }, 'revise', '升版', 'E1001');
    expect(result.records[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.records[0].card_id).toBeNull();
  });
});

describe('serializeChangeValue —— 落库形态唯一确定', () => {
  it.each([
    [null, null],
    [undefined, null],
    ['abc', 'abc'],
    [1, '1'],
    [0, '0'],
    [true, 'true'],
    [false, 'false'],
  ])('%p → %p', (input, expected) => {
    expect(serializeChangeValue(input)).toBe(expected);
  });

  it('Date 取 ISO 字符串，数组与对象取稳定 JSON', () => {
    expect(serializeChangeValue(new Date(TS))).toBe(TS);
    expect(serializeChangeValue([2, 1])).toBe('[2,1]');
    expect(serializeChangeValue({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
  });
});
