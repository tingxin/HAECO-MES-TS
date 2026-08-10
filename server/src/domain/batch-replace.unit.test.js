import { describe, it, expect } from 'vitest';
import { batchReplace, BATCH_REPLACE_OUTCOME, BATCH_REPLACE_REJECTION } from './batch-replace.js';

const SPEC = { field: 'title', from: 'OLD', to: 'NEW' };
const REASON = '客户要求统一术语';
const OPERATOR = 'E1001';

function card(overrides) {
  return { id: 1, task_no: 'TS-01-0001', revision: 1, status: 'New', title: 'OLD', ...overrides };
}

describe('batchReplace —— 整批级闸门（需求 20.6、20.7）', () => {
  it.each([undefined, null, '', '   ', '\t\n', '\u3000'])('替换原因为 %p 时整批拒绝，零产出', (reason) => {
    const result = batchReplace([card()], SPEC, reason, OPERATOR);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(BATCH_REPLACE_REJECTION.REASON_REQUIRED);
    expect(result.items).toEqual([]);
    expect(result.updatedCards).toEqual([]);
    expect(result.changeRecords).toEqual([]);
  });

  it('操作人缺失时整批拒绝', () => {
    const result = batchReplace([card()], SPEC, REASON, '  ');
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(BATCH_REPLACE_REJECTION.OPERATOR_REQUIRED);
    expect(result.items).toEqual([]);
  });

  it('spec.field 非法时抛错', () => {
    expect(() => batchReplace([card()], { field: '' }, REASON, OPERATOR)).toThrow(TypeError);
    expect(() => batchReplace([card()], null, REASON, OPERATOR)).toThrow(TypeError);
  });
});

describe('batchReplace —— New-only 闸门（需求 20.3、20.4）', () => {
  it('非新增版本逐条拒绝并列明原因，不阻断其余工卡', () => {
    const cards = [
      card({ id: 1, status: 'UnderReview' }),
      card({ id: 2, status: 'Effective' }),
      card({ id: 3, status: 'Superseded' }),
      card({ id: 4, status: 'Void' }),
      card({ id: 5, status: 'New' }),
    ];
    const result = batchReplace(cards, SPEC, REASON, OPERATOR);

    expect(result.ok).toBe(true);
    expect(result.rejectedCount).toBe(4);
    expect(result.affectedCount).toBe(1);
    const rejected = result.items.filter((i) => i.outcome === BATCH_REPLACE_OUTCOME.REJECTED_NOT_EDITABLE);
    expect(rejected).toHaveLength(4);
    for (const item of rejected) {
      expect(item.rejectionMessage).toContain('仅新增(New)版本');
    }
    expect(result.items.find((i) => i.card.id === 5).outcome).toBe(BATCH_REPLACE_OUTCOME.REPLACED);
  });
});

describe('batchReplace —— 替换与未受影响（需求 20.1、20.2）', () => {
  it('字段当前值匹配 from：替换并产出恰好 1 条变更记录', () => {
    const result = batchReplace([card()], SPEC, REASON, OPERATOR, { timestamp: '2024-05-01T00:00:00.000Z' });
    expect(result.affectedCount).toBe(1);
    expect(result.changeRecords).toHaveLength(1);
    const record = result.changeRecords[0];
    expect(record.change_type).toBe('batch_replace');
    expect(record.field).toBe('title');
    expect(record.old_value).toBe('OLD');
    expect(record.new_value).toBe('NEW');
    expect(record.reason).toBe(REASON);
    expect(record.operator_id).toBe(OPERATOR);
    expect(result.updatedCards[0].title).toBe('NEW');
    // 源工卡不被写入
    expect(result.items[0].card.status).toBe('New');
  });

  it('字段当前值不匹配 from：未受影响，不产出记录', () => {
    const result = batchReplace([card({ title: 'SOMETHING_ELSE' })], SPEC, REASON, OPERATOR);
    expect(result.affectedCount).toBe(0);
    expect(result.unaffectedCount).toBe(1);
    expect(result.items[0].outcome).toBe(BATCH_REPLACE_OUTCOME.UNAFFECTED);
    expect(result.changeRecords).toEqual([]);
    expect(result.updatedCards).toEqual([]);
  });

  it('from === to（退化规格）：即使命中也不产出记录，归入未受影响', () => {
    const result = batchReplace([card()], { field: 'title', from: 'OLD', to: 'OLD' }, REASON, OPERATOR);
    expect(result.affectedCount).toBe(0);
    expect(result.unaffectedCount).toBe(1);
    expect(result.changeRecords).toEqual([]);
  });
});

describe('batchReplace —— 幂等性（需求 20.10，Property 13）', () => {
  it('同一规则第二次对已替换结果执行：受影响数为 0', () => {
    const first = batchReplace([card()], SPEC, REASON, OPERATOR);
    expect(first.affectedCount).toBe(1);

    const second = batchReplace(first.updatedCards, SPEC, REASON, OPERATOR);
    expect(second.affectedCount).toBe(0);
    expect(second.unaffectedCount).toBe(1);
    expect(second.changeRecords).toEqual([]);
  });
});

describe('batchReplace —— 返回值不可变（house convention）', () => {
  it('结果与条目均被冻结', () => {
    const result = batchReplace([card()], SPEC, REASON, OPERATOR);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
  });
});
