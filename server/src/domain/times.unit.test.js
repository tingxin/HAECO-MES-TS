import { describe, it, expect } from 'vitest';
import { computeCardTimes, isChronological } from './times.js';

describe('computeCardTimes —— 工卡级起止时间聚合（需求 33.5、33.6）', () => {
  it('空工序集合：无开始时间、无结束时间，且不判为全部完成', () => {
    const result = computeCardTimes([]);
    expect(result.startTime).toBeNull();
    expect(result.finishTime).toBeNull();
    expect(result.allFinished).toBe(false);
    expect(result.hasUnfinished).toBe(false);
    expect(result.processCount).toBe(0);
  });

  it('null / undefined 入参等同空集合', () => {
    expect(computeCardTimes(null).finishTime).toBeNull();
    expect(computeCardTimes(undefined).processCount).toBe(0);
  });

  it('单道工序已完成：起止时间即该工序自身的起止时间', () => {
    const result = computeCardTimes([
      { processId: 'A', startTime: '2024-03-01T08:00:00Z', finishTime: '2024-03-01T12:00:00Z' },
    ]);
    expect(result.startTime).toBe('2024-03-01T08:00:00Z');
    expect(result.finishTime).toBe('2024-03-01T12:00:00Z');
    expect(result.allFinished).toBe(true);
    expect(result.chronological).toBe(true);
  });

  it('全部工序完成：开始取最早、结束取最晚（与数组顺序无关）', () => {
    const result = computeCardTimes([
      { processId: 'B', startTime: '2024-03-02T09:00:00Z', finishTime: '2024-03-05T18:00:00Z' },
      { processId: 'A', startTime: '2024-03-01T07:30:00Z', finishTime: '2024-03-01T16:00:00Z' },
      { processId: 'C', startTime: '2024-03-03T10:00:00Z', finishTime: '2024-03-04T11:00:00Z' },
    ]);
    expect(result.startTime).toBe('2024-03-01T07:30:00Z');
    expect(result.finishTime).toBe('2024-03-05T18:00:00Z');
    expect(result.allFinished).toBe(true);
    expect(result.hasUnfinished).toBe(false);
  });

  it('存在未完成工序：开始时间存在，结束时间恒为空（需求 33.6）', () => {
    const result = computeCardTimes([
      { processId: 'A', startTime: '2024-03-01T08:00:00Z', finishTime: '2024-03-01T12:00:00Z' },
      { processId: 'B', startTime: '2024-03-01T13:00:00Z', finishTime: null },
    ]);
    expect(result.startTime).toBe('2024-03-01T08:00:00Z');
    expect(result.finishTime).toBeNull();
    expect(result.hasUnfinished).toBe(true);
    expect(result.allFinished).toBe(false);
    // 已完成工序的最晚结束时间不得泄漏为工卡结束时间
    expect(result.finishedCount).toBe(1);
  });

  it('部分工序已开始但无一完成：有开始时间、无结束时间', () => {
    const result = computeCardTimes([
      { processId: 'A', startTime: '2024-03-01T08:00:00Z' },
      { processId: 'B' },
    ]);
    expect(result.startTime).toBe('2024-03-01T08:00:00Z');
    expect(result.finishTime).toBeNull();
    expect(result.startedCount).toBe(1);
    expect(result.finishedCount).toBe(0);
  });

  it('空白字符串视为未记录', () => {
    const result = computeCardTimes([{ startTime: '   ', finishTime: '' }]);
    expect(result.startTime).toBeNull();
    expect(result.finishTime).toBeNull();
    expect(result.startedCount).toBe(0);
    expect(result.allFinished).toBe(false);
  });

  it('工序 finish 早于 start：计入 violations 且不影响聚合口径', () => {
    const result = computeCardTimes([
      { processId: 'A', startTime: '2024-03-02T08:00:00Z', finishTime: '2024-03-01T08:00:00Z' },
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ index: 0, processId: 'A' });
    expect(result.allFinished).toBe(true);
    expect(result.chronological).toBe(false);
  });

  it('按时间点而非字典序比较：不同时区偏移的同一时刻可正确排序', () => {
    // 2024-03-01T08:00:00+08:00 === 2024-03-01T00:00:00Z，早于 2024-03-01T02:00:00Z
    const result = computeCardTimes([
      { processId: 'A', startTime: '2024-03-01T08:00:00+08:00', finishTime: '2024-03-01T03:00:00Z' },
      { processId: 'B', startTime: '2024-03-01T02:00:00Z', finishTime: '2024-03-01T12:00:00+08:00' },
    ]);
    // 原始字符串原样返回，不重新序列化
    expect(result.startTime).toBe('2024-03-01T08:00:00+08:00');
    expect(result.finishTime).toBe('2024-03-01T12:00:00+08:00'); // = 04:00Z，晚于 03:00Z
    expect(result.violations).toHaveLength(0);
  });

  it('无法解析的时间戳抛错，而非静默丢弃', () => {
    expect(() => computeCardTimes([{ startTime: 'not-a-time' }])).toThrow(TypeError);
    expect(() => computeCardTimes('nope')).toThrow(TypeError);
  });
});

describe('isChronological —— 时序校验（需求 33.8）', () => {
  it('两值同时存在时结束不早于开始为真，相等亦为真', () => {
    expect(isChronological('2024-03-01T08:00:00Z', '2024-03-01T09:00:00Z')).toBe(true);
    expect(isChronological('2024-03-01T08:00:00Z', '2024-03-01T08:00:00Z')).toBe(true);
    expect(isChronological('2024-03-01T09:00:00Z', '2024-03-01T08:00:00Z')).toBe(false);
  });

  it('任一值缺失时无可比对象，返回真', () => {
    expect(isChronological(null, '2024-03-01T09:00:00Z')).toBe(true);
    expect(isChronological('2024-03-01T09:00:00Z', null)).toBe(true);
    expect(isChronological(null, null)).toBe(true);
    expect(isChronological('  ', '2024-03-01T09:00:00Z')).toBe(true);
  });
});
