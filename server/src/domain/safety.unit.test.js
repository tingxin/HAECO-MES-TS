import { describe, it, expect } from 'vitest';
import {
  canEnterExecution,
  isCriticalStep,
  isCompleteAcknowledgement,
  SAFETY_REJECTION,
} from './safety.js';

/** `safety_acknowledgement` 同形行 */
const ack = (by, at = '2024-06-01T08:30:00Z', extra = {}) => ({
  id: 1,
  job_process_id: 10,
  acknowledged_by: by,
  acknowledged_at: at,
  ...extra,
});

/** `process_step` 同形行（编制域模板） */
const step = (isCritical) => ({
  id: 7,
  process_id: 'A',
  safety_warning: '断电后方可拆卸',
  is_critical: isCritical,
});

/** `job_step_snapshot` 同形行（执行域快照，content 为 JSON 文本） */
const snapshotRow = (isCritical, sourceStepIsCritical = null) => ({
  id: 3,
  job_process_id: 10,
  source_step_id: 7,
  source_card_revision: 1,
  content: JSON.stringify({ processId: 'A', safetyWarning: '断电后方可拆卸', isCritical }),
  snapshot_at: '2024-06-01T00:00:00Z',
  ...(sourceStepIsCritical === null ? {} : { is_critical: sourceStepIsCritical }),
});

describe('isCriticalStep —— 关键标记读取（需求 31.4，Property 34）', () => {
  it('读取 process_step 的 is_critical（0/1）', () => {
    expect(isCriticalStep(step(1))).toBe(true);
    expect(isCriticalStep(step(0))).toBe(false);
  });

  it('字段缺席视为未标记（schema 默认 0）；非对象入参不视为关键', () => {
    expect(isCriticalStep({ id: 7, process_id: 'A' })).toBe(false);
    expect(isCriticalStep(null)).toBe(false);
  });

  it('快照优先于编制域模板列：改模板不改变既有 JOB 的门禁行为', () => {
    // 快照标记关键、模板已被改回非关键 → 仍以快照为准
    expect(isCriticalStep(snapshotRow(true, 0))).toBe(true);
    // 快照未标记、模板事后被标记关键 → 仍以快照为准
    expect(isCriticalStep(snapshotRow(false, 1))).toBe(false);
  });

  it('content 为已解析对象亦可；content 非法 JSON 时退化为读取自身列', () => {
    expect(isCriticalStep({ job_process_id: 10, content: { isCritical: true } })).toBe(true);
    expect(isCriticalStep({ job_process_id: 10, content: '{不是 JSON', is_critical: 1 })).toBe(true);
    expect(isCriticalStep({ job_process_id: 10, content: '{不是 JSON', is_critical: 0 })).toBe(false);
  });

  it('无法识别的关键标记取值从严视为关键', () => {
    expect(isCriticalStep(step('critical'))).toBe(true);
    expect(isCriticalStep(step({}))).toBe(true);
  });
});

describe('isCompleteAcknowledgement —— 确认记录完整性（需求 31.7）', () => {
  it('确认人与确认时间齐备方为完整', () => {
    expect(isCompleteAcknowledgement(ack('E1001'))).toBe(true);
    expect(isCompleteAcknowledgement(ack('E1001', null))).toBe(false);
    expect(isCompleteAcknowledgement(ack(null))).toBe(false);
    expect(isCompleteAcknowledgement(ack('   ', '2024-06-01T08:30:00Z'))).toBe(false);
    expect(isCompleteAcknowledgement(ack('E1001', '   '))).toBe(false);
    expect(isCompleteAcknowledgement(null)).toBe(false);
  });

  it('兼容 camelCase 写法', () => {
    expect(isCompleteAcknowledgement({ acknowledgedBy: 'E1001', acknowledgedAt: '2024-06-01' })).toBe(true);
  });
});

describe('canEnterExecution —— 前置门禁（需求 31.5、31.6、31.7，Property 16）', () => {
  it('未标记关键的工序无确认前置，直接放行', () => {
    const r = canEnterExecution(snapshotRow(false), [], 'E1001');
    expect(r.ok).toBe(true);
    expect(r.rejection).toBeNull();
    expect(r.isCritical).toBe(false);
    expect(r.acknowledgement).toBeNull();
  });

  it('关键工序有本人完整确认记录时放行，并回带命中的记录', () => {
    const row = ack('E1001');
    const r = canEnterExecution(snapshotRow(true), [ack('E2002'), row], 'E1001');
    expect(r.ok).toBe(true);
    expect(r.isCritical).toBe(true);
    expect(r.acknowledgement).toBe(row);
  });

  it('关键工序无任何确认记录时阻止进入执行（需求 31.6）', () => {
    const r = canEnterExecution(snapshotRow(true), [], 'E1001');
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe(SAFETY_REJECTION.NOT_ACKNOWLEDGED);
    expect(r.message).toContain('关键工序');
  });

  it('他人的确认记录不解锁本人的执行', () => {
    const r = canEnterExecution(snapshotRow(true), [ack('E2002'), ack('E3003')], 'E1001');
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe(SAFETY_REJECTION.NOT_ACKNOWLEDGED);
  });

  it('缺确认人或缺确认时间的不完整记录不解锁（需求 31.7）', () => {
    expect(canEnterExecution(snapshotRow(true), [ack('E1001', null)], 'E1001').ok).toBe(false);
    expect(canEnterExecution(snapshotRow(true), [ack(null)], 'E1001').ok).toBe(false);
  });

  it('跨工序的确认记录不解锁本工序', () => {
    const other = ack('E1001', '2024-06-01T08:30:00Z', { job_process_id: 99 });
    const r = canEnterExecution(snapshotRow(true), [other], 'E1001');
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe(SAFETY_REJECTION.NOT_ACKNOWLEDGED);
  });

  it('未带 job_process_id 的确认记录视为调用方已按工序过滤', () => {
    const r = canEnterExecution(snapshotRow(true), [{ acknowledgedBy: 'E1001', acknowledgedAt: '2024-06-01' }], 'E1001');
    expect(r.ok).toBe(true);
  });

  it('工号数值与文本写法等价（staff_no TEXT / id INTEGER 两种口径）', () => {
    expect(canEnterExecution(snapshotRow(true), [ack(1001)], '1001').ok).toBe(true);
    expect(canEnterExecution(snapshotRow(true), [ack(' E1001 ')], 'E1001').ok).toBe(true);
  });

  it('失败即拒绝：工序不可判定、关键工序缺操作人员标识、acks 非数组', () => {
    expect(canEnterExecution(null, [ack('E1001')], 'E1001').rejection).toBe(SAFETY_REJECTION.INVALID_STEP);
    expect(canEnterExecution(snapshotRow(true), [ack('E1001')], '  ').rejection).toBe(SAFETY_REJECTION.INVALID_USER);
    expect(canEnterExecution(snapshotRow(true), null, 'E1001').rejection).toBe(SAFETY_REJECTION.NOT_ACKNOWLEDGED);
  });

  it('非关键工序不因操作人员标识缺失而被拦（门禁仅作用于被标记工序）', () => {
    expect(canEnterExecution(snapshotRow(false), null, null).ok).toBe(true);
  });

  it('返回值为冻结对象，调用方不可篡改判定结果', () => {
    const r = canEnterExecution(snapshotRow(true), [], 'E1001');
    expect(Object.isFrozen(r)).toBe(true);
  });
});
