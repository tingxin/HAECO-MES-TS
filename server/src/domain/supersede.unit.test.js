/**
 * 单元测试：`supersede.js` 的版本取代规则（任务 6.1）。
 *
 * 覆盖需求 38.7、44.1–44.3、44.7：
 * - 操作序列恒为「先降级 → 写取代记录 → 后生效」，`promoteApproved` 恒在末位（Property 25 成因）
 * - 取代记录含被取代版本号 / 取代版本号 / 取代时间，且**不含**作废原因（需求 44.3）
 * - 首版批准无原生效版本时不产出空取代记录
 * - 每条语句执行后生效版本数恒 ≤ 1（`effectiveCountAfter`）
 *
 * `isFrozen` / `isFrozenFor`（任务 5.1）的断言在 `card-rules.unit.test.js`，此处不重复。
 */

import { describe, it, expect } from 'vitest';
import {
  supersedeOnApprove,
  assertSupersedeOperationOrder,
  runSupersedePlan,
  SUPERSEDE_OP,
  SUPERSEDE_OP_ORDER,
  SUPERSEDE_REJECTION,
  SUPERSEDE_ORDER_VIOLATION,
} from './supersede.js';

const TASK_NO = 'TC-APPROVE-001';
const AT = '2026-01-01T00:00:00.000Z';

const row = (revision, status, taskNo = TASK_NO) => ({
  id: revision,
  task_no: taskNo,
  revision,
  status,
});

const opsOf = (plan) => plan.operations.map((operation) => operation.op);

describe('supersedeOnApprove —— 操作序列（需求 44.1、44.2、38.7、44.7）', () => {
  it('存在原生效版本时按「降级 → 取代记录 → 生效」三步产出', () => {
    const cards = [row(1, 'Effective'), row(2, 'UnderReview')];
    const plan = supersedeOnApprove(cards, row(2, 'UnderReview'), { timestamp: AT });

    expect(plan.ok).toBe(true);
    expect(opsOf(plan)).toEqual([
      SUPERSEDE_OP.DEMOTE_INCUMBENT,
      SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD,
      SUPERSEDE_OP.PROMOTE_APPROVED,
    ]);
    expect(plan.operations.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(plan.supersededRevisions).toEqual([1]);
    expect(plan.supersedingRevision).toBe(2);
    expect(plan.taskNo).toBe(TASK_NO);
    expect(plan.invariantViolatedBefore).toBe(false);
  });

  it('降级与生效语句携带可直接落库的 where / set', () => {
    const plan = supersedeOnApprove([row(3, 'Effective')], row(4, 'UnderReview'), { timestamp: AT });
    const [demote, , promote] = plan.operations;

    expect(demote).toMatchObject({
      table: 'task_card',
      action: 'update',
      where: { task_no: TASK_NO, revision: 3 },
      set: { status: 'Superseded' },
    });
    expect(promote).toMatchObject({
      table: 'task_card',
      action: 'update',
      where: { task_no: TASK_NO, revision: 4 },
      set: { status: 'Effective' },
    });
  });

  it('每条语句执行后的生效版本数恒 ≤ 1，且末条恰为 1（Property 25 不变式）', () => {
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'), { timestamp: AT });
    const counts = plan.operations.map((o) => o.effectiveCountAfter);

    expect(counts).toEqual([0, 0, 1]);
    expect(counts.every((n) => n <= 1)).toBe(true);
  });

  it('首个版本批准（无原生效版本）只产出 promote，不产出空取代记录', () => {
    const plan = supersedeOnApprove([row(1, 'UnderReview')], row(1, 'UnderReview'), {
      timestamp: AT,
    });

    expect(plan.ok).toBe(true);
    expect(opsOf(plan)).toEqual([SUPERSEDE_OP.PROMOTE_APPROVED]);
    expect(plan.supersedeRecords).toEqual([]);
    expect(plan.supersededRevisions).toEqual([]);
  });

  it('只取同一 Task No 的生效版本，其它编号与非生效版本一律不降级', () => {
    const cards = [
      row(1, 'Superseded'),
      row(2, 'Void'),
      row(3, 'New'),
      row(4, 'Effective'),
      row(5, 'UnderReview'),
      row(9, 'Effective', 'TC-OTHER-002'),
    ];
    const plan = supersedeOnApprove(cards, row(5, 'UnderReview'), { timestamp: AT });

    expect(plan.supersededRevisions).toEqual([4]);
    expect(plan.supersedeRecords).toHaveLength(1);
  });

  it('版本列表中本版本已被标记生效时不降级自身（时序错位容错）', () => {
    const plan = supersedeOnApprove([row(2, 'Effective')], row(2, 'UnderReview'), {
      timestamp: AT,
    });

    expect(plan.supersededRevisions).toEqual([]);
    expect(opsOf(plan)).toEqual([SUPERSEDE_OP.PROMOTE_APPROVED]);
  });

  it('脏数据存在多个生效版本时全部降级并标记入参越界，收敛回单一生效', () => {
    const cards = [row(1, 'Effective'), row(2, 'Effective'), row(3, 'UnderReview')];
    const plan = supersedeOnApprove(cards, row(3, 'UnderReview'), { timestamp: AT });

    expect(plan.supersededRevisions).toEqual([1, 2]);
    expect(plan.invariantViolatedBefore).toBe(true);
    expect(opsOf(plan)).toEqual([
      SUPERSEDE_OP.DEMOTE_INCUMBENT,
      SUPERSEDE_OP.DEMOTE_INCUMBENT,
      SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD,
      SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD,
      SUPERSEDE_OP.PROMOTE_APPROVED,
    ]);
    expect(plan.operations.map((o) => o.effectiveCountAfter)).toEqual([1, 0, 0, 0, 1]);
  });

  it('兼容 camelCase 与字符串版本号入参', () => {
    const plan = supersedeOnApprove(
      [{ taskNo: TASK_NO, revision: '1', status: 'Effective' }],
      { taskNo: TASK_NO, revision: '2', status: 'UnderReview' },
      { timestamp: AT },
    );

    expect(plan.ok).toBe(true);
    expect(plan.supersededRevisions).toEqual([1]);
    expect(plan.supersedingRevision).toBe(2);
  });
});

describe('supersedeOnApprove —— 取代记录（需求 44.2、44.3）', () => {
  it('记录含被取代版本号、取代版本号与取代时间，且不含作废原因', () => {
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'), {
      timestamp: AT,
    });
    const [record] = plan.supersedeRecords;

    expect(record).toEqual({
      task_no: TASK_NO,
      superseded_revision: 1,
      superseding_revision: 2,
      superseded_at: AT,
    });
    expect(Object.keys(record).sort()).toEqual([
      'superseded_at',
      'superseded_revision',
      'superseding_revision',
      'task_no',
    ]);
    expect(record).not.toHaveProperty('reason');
  });

  it('未传取代原因也不影响判定：取代不走作废流程（需求 44.3）', () => {
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'));

    expect(plan.ok).toBe(true);
    expect(plan.rejection).toBeNull();
    // 不产生 change_record 之类的留痕入参，方案里只有 task_card 与 supersede_record 两张表
    expect([...new Set(plan.operations.map((o) => o.table))].sort()).toEqual([
      'supersede_record',
      'task_card',
    ]);
  });

  it('时间戳可注入且全部记录共享同一取代时间；Date 与毫秒数归一为 ISO', () => {
    const cards = [row(1, 'Effective'), row(2, 'Effective')];
    const byDate = supersedeOnApprove(cards, row(3, 'UnderReview'), { timestamp: new Date(AT) });
    const byMillis = supersedeOnApprove(cards, row(3, 'UnderReview'), {
      timestamp: Date.parse(AT),
    });

    expect(byDate.supersedeRecords.map((r) => r.superseded_at)).toEqual([AT, AT]);
    expect(byMillis.supersedeRecords.map((r) => r.superseded_at)).toEqual([AT, AT]);
  });

  it('缺省时间戳取当前时刻的 ISO 文本', () => {
    const before = Date.now();
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'));
    const at = Date.parse(plan.supersedeRecords[0].superseded_at);

    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('supersedeOnApprove —— 拒绝分支', () => {
  it('版本列表缺失（非数组）整体拒绝，且不产出任何操作', () => {
    for (const cards of [undefined, null, {}, 'x']) {
      const plan = supersedeOnApprove(cards, row(2, 'UnderReview'));
      expect(plan.ok).toBe(false);
      expect(plan.rejection).toBe(SUPERSEDE_REJECTION.CARDS_REQUIRED);
      expect(plan.operations).toEqual([]);
      expect(plan.supersedeRecords).toEqual([]);
    }
  });

  it('缺 Task No / 非法版本号分别拒绝', () => {
    expect(supersedeOnApprove([], { revision: 2, status: 'UnderReview' }).rejection).toBe(
      SUPERSEDE_REJECTION.TASK_NO_REQUIRED,
    );
    expect(supersedeOnApprove([], { task_no: '   ', revision: 2, status: 'UnderReview' }).rejection).toBe(
      SUPERSEDE_REJECTION.TASK_NO_REQUIRED,
    );
    for (const revision of [undefined, 0, -1, 1.5, 'v2', '']) {
      const plan = supersedeOnApprove([], { task_no: TASK_NO, revision, status: 'UnderReview' });
      expect(plan.rejection).toBe(SUPERSEDE_REJECTION.REVISION_REQUIRED);
    }
  });

  it('仅「审核中」可批准生效，其余状态拒绝且不产出操作', () => {
    for (const status of ['New', 'Effective', 'Superseded', 'Void', 'unknown']) {
      const plan = supersedeOnApprove([row(1, 'Effective')], row(2, status));
      expect(plan.ok).toBe(false);
      expect(plan.rejection).toBe(SUPERSEDE_REJECTION.ILLEGAL_TRANSITION);
      expect(plan.operations).toEqual([]);
    }
    expect(supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview')).ok).toBe(true);
  });
});

describe('返回值不可变——调用方无法重排或改写操作序列', () => {
  const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'), { timestamp: AT });

  it('方案、操作数组与每条操作均被冻结', () => {
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.operations)).toBe(true);
    plan.operations.forEach((operation) => {
      expect(Object.isFrozen(operation)).toBe(true);
      if (operation.where !== null) expect(Object.isFrozen(operation.where)).toBe(true);
      if (operation.set !== null) expect(Object.isFrozen(operation.set)).toBe(true);
    });
    expect(Object.isFrozen(plan.supersedeRecords)).toBe(true);
    expect(Object.isFrozen(plan.supersedeRecords[0])).toBe(true);
  });

  it('就地重排（reverse / sort / 赋值）一律不生效', () => {
    expect(() => plan.operations.reverse()).toThrow();
    expect(opsOf(plan)).toEqual([
      SUPERSEDE_OP.DEMOTE_INCUMBENT,
      SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD,
      SUPERSEDE_OP.PROMOTE_APPROVED,
    ]);
  });
});

describe('assertSupersedeOperationOrder —— 误用守卫', () => {
  const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'), { timestamp: AT });

  it('合法序列通过并原样返回', () => {
    expect(assertSupersedeOperationOrder(plan.operations)).toBe(plan.operations);
  });

  it('顺序颠倒（先生效、后降级）被拒', () => {
    const reordered = [...plan.operations].reverse().map((operation, index) => ({
      ...operation,
      seq: index + 1,
    }));

    expect(() => assertSupersedeOperationOrder(reordered)).toThrow(/顺序|序列/);
    try {
      assertSupersedeOperationOrder(reordered);
    } catch (error) {
      expect(error.code).toBe(SUPERSEDE_ORDER_VIOLATION);
    }
  });

  it('序号不连续、空序列、非数组、op 取值越界与缺少 promote 均被拒', () => {
    expect(() =>
      assertSupersedeOperationOrder(plan.operations.map((o) => ({ ...o, seq: o.seq + 1 }))),
    ).toThrow(/seq/);
    expect(() => assertSupersedeOperationOrder([])).toThrow(/空/);
    expect(() => assertSupersedeOperationOrder(null)).toThrow(/数组/);
    expect(() =>
      assertSupersedeOperationOrder([{ seq: 1, op: 'dropTable' }]),
    ).toThrow(/封闭取值/);
    expect(() => assertSupersedeOperationOrder([plan.operations[0]])).toThrow(/promoteApproved/);
  });

  it('阶段顺序词表即为唯一合法顺序', () => {
    expect(SUPERSEDE_OP_ORDER).toEqual([
      SUPERSEDE_OP.DEMOTE_INCUMBENT,
      SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD,
      SUPERSEDE_OP.PROMOTE_APPROVED,
    ]);
  });
});

describe('runSupersedePlan —— 服务层交出执行器', () => {
  it('按序回调每条操作并收集结果', () => {
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'), {
      timestamp: AT,
    });
    const seen = [];
    const result = runSupersedePlan(plan, (operation, index) => {
      seen.push(`${index}:${operation.op}`);
      return operation.seq;
    });

    expect(seen).toEqual([
      `0:${SUPERSEDE_OP.DEMOTE_INCUMBENT}`,
      `1:${SUPERSEDE_OP.WRITE_SUPERSEDE_RECORD}`,
      `2:${SUPERSEDE_OP.PROMOTE_APPROVED}`,
    ]);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([1, 2, 3]);
  });

  it('被拒方案不执行任何操作', () => {
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'New'));
    let calls = 0;
    const result = runSupersedePlan(plan, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(SUPERSEDE_REJECTION.ILLEGAL_TRANSITION);
  });

  it('执行器缺失或 plan 非法时抛出可识别错误', () => {
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'));
    expect(() => runSupersedePlan(plan, null)).toThrow(/applyOperation/);
    expect(() => runSupersedePlan(null, () => {})).toThrow(/plan/);
  });

  it('执行器抛错时原样冒泡，供服务层回滚整个事务（需求 44.8）', () => {
    const plan = supersedeOnApprove([row(1, 'Effective')], row(2, 'UnderReview'));
    expect(() =>
      runSupersedePlan(plan, (operation) => {
        if (operation.op === SUPERSEDE_OP.PROMOTE_APPROVED) throw new Error('SQLITE_CONSTRAINT');
      }),
    ).toThrow('SQLITE_CONSTRAINT');
  });
});
