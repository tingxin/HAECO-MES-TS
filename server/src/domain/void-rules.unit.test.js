import { describe, it, expect } from 'vitest';
import {
  checkVoidPrecondition,
  classifyVoidReferences,
  isSelectableForNewPackage,
  VOID_REFERENCE_TYPES,
  VOID_REJECTION,
  HISTORICAL_REFERENCE_TYPE,
} from './void-rules.js';

const CARD = { id: 7, task_no: 'TS-01-0001', revision: 2, status: 'Effective' };
const REASON = '工艺已由新版本替代';

describe('checkVoidPrecondition —— 三类阻止性引用（需求 42.1、42.2）', () => {
  it('无引用且原因非空：通过', () => {
    const result = checkVoidPrecondition(CARD, { jobs: [], inProgressPackages: [] }, REASON);
    expect(result.ok).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.blockingRefs).toEqual([]);
  });

  it('执行中 JOB：拒绝，提示引用类型与位置', () => {
    const result = checkVoidPrecondition(
      CARD,
      { jobs: [{ job_no: 'JOB-001', exec_status: 'InProgress', pid: 'P-9' }] },
      REASON,
    );
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(VOID_REJECTION.BLOCKING_REFERENCES);
    expect(result.blockingTypes).toEqual([VOID_REFERENCE_TYPES.JOB_IN_PROGRESS]);
    expect(result.blockingRefs[0].location).toBe('JOB JOB-001 / PID P-9');
    expect(result.message).toContain('执行中 JOB');
    expect(result.message).toContain('JOB-001');
  });

  it('已生成未开始 JOB（Pending 与状态空值）：均拒绝并归入第二类', () => {
    const result = checkVoidPrecondition(
      CARD,
      { jobs: [{ job_no: 'JOB-002', exec_status: 'Pending' }, { job_no: 'JOB-003' }] },
      REASON,
    );
    expect(result.ok).toBe(false);
    expect(result.blockingTypes).toEqual([VOID_REFERENCE_TYPES.JOB_NOT_STARTED]);
    expect(result.blockingRefs).toHaveLength(2);
  });

  it('已完结 JOB（Completed）不阻止作废', () => {
    const result = checkVoidPrecondition(
      CARD,
      { jobs: [{ job_no: 'JOB-004', exec_status: 'Completed' }] },
      REASON,
    );
    expect(result.ok).toBe(true);
    expect(result.blockingRefs).toEqual([]);
  });

  it('在编工包已选入：拒绝', () => {
    const result = checkVoidPrecondition(
      CARD,
      { inProgressPackages: [{ package_no: 'WP-77', pid: 'P-9' }] },
      REASON,
    );
    expect(result.ok).toBe(false);
    expect(result.blockingTypes).toEqual([VOID_REFERENCE_TYPES.IN_PROGRESS_PACKAGE]);
    expect(result.blockingRefs[0].location).toBe('工包 WP-77 / PID P-9');
  });
});

describe('历史工包引用不阻止作废（需求 42.3）', () => {
  it('历史工包引用仅回显、不阻止，且入参对象不被改写', () => {
    const refs = {
      historicalPackages: [{ package_no: 'WP-01', card_revision: 1 }],
      jobs: [{ job_no: 'JOB-005', exec_status: 'Completed' }],
    };
    const snapshot = JSON.stringify(refs);

    const result = checkVoidPrecondition(CARD, refs, REASON);

    expect(result.ok).toBe(true);
    expect(result.historicalRefs).toHaveLength(1);
    expect(result.historicalRefs[0].type).toBe(HISTORICAL_REFERENCE_TYPE);
    expect(result.historicalRefs[0].cardRevision).toBe(1);
    expect(JSON.stringify(refs)).toBe(snapshot); // 历史版本记录保持不变
  });

  it('未分桶工包引用：明确已释放才算历史，未释放或无标记一律阻止', () => {
    const released = classifyVoidReferences({ workPackages: [{ package_no: 'WP-02', released: true }] });
    expect(released.hasBlocking).toBe(false);
    expect(released.historicalRefs).toHaveLength(1);

    const unmarked = classifyVoidReferences({ workPackages: [{ package_no: 'WP-03' }] });
    expect(unmarked.hasBlocking).toBe(true);
    expect(unmarked.blockingTypes).toEqual([VOID_REFERENCE_TYPES.IN_PROGRESS_PACKAGE]);
  });

  it('历史桶内标记为未释放（矛盾信号）按在编从严处理', () => {
    const result = classifyVoidReferences({
      historicalPackages: [{ package_no: 'WP-04', status: 'Draft' }],
    });
    expect(result.hasBlocking).toBe(true);
    expect(result.historicalRefs).toEqual([]);
  });
});

describe('作废原因必填（需求 42.5）', () => {
  it.each([undefined, null, '', '   ', '\t\n', '\u3000'])('原因为 %p 时拒绝', (reason) => {
    const result = checkVoidPrecondition(CARD, {}, reason);
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(VOID_REJECTION.REASON_REQUIRED);
    expect(result.reasonMissing).toBe(true);
  });

  it('引用与原因同时不合规：引用优先报出，两项信号均可读', () => {
    const result = checkVoidPrecondition(CARD, { jobs: [{ job_no: 'JOB-006' }] }, '  ');
    expect(result.rejection).toBe(VOID_REJECTION.BLOCKING_REFERENCES);
    expect(result.rejections).toEqual([
      VOID_REJECTION.BLOCKING_REFERENCES,
      VOID_REJECTION.REASON_REQUIRED,
    ]);
    expect(result.reasonMissing).toBe(true);
  });
});

describe('isSelectableForNewPackage —— 作废后不可被新工包选用（需求 42.4）', () => {
  it('Void / Superseded 恒不可选用，其余状态可选用', () => {
    expect(isSelectableForNewPackage({ status: 'Void' })).toBe(false);
    expect(isSelectableForNewPackage('Superseded')).toBe(false);
    expect(isSelectableForNewPackage({ status: 'Effective' })).toBe(true);
    expect(isSelectableForNewPackage({ status: 'New' })).toBe(true);
    expect(isSelectableForNewPackage({ status: '不存在的状态' })).toBe(false);
  });
});

describe('返回值不可变（house convention）', () => {
  it('结果与引用条目均被冻结', () => {
    const result = checkVoidPrecondition(CARD, { jobs: [{ job_no: 'JOB-007' }] }, REASON);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.blockingRefs)).toBe(true);
    expect(Object.isFrozen(result.blockingRefs[0])).toBe(true);
  });
});
