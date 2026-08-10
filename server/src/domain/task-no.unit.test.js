import { describe, it, expect } from 'vitest';
import { generateTaskNoBatch, formatTaskNo, parseTaskNoSeq } from './task-no.js';

describe('generateTaskNoBatch 基本生成（需求 38.8）', () => {
  it('按前缀/后缀/起始序号/步长连续取号', () => {
    const result = generateTaskNoBatch({ prefix: 'TC-2026-', suffix: '-A', next_seq: 5, step: 1 }, [], 3);
    expect(result.taskNos).toEqual(['TC-2026-5-A', 'TC-2026-6-A', 'TC-2026-7-A']);
    expect(result.sequences).toEqual([5, 6, 7]);
    expect(result.skippedSequences).toEqual([]);
    expect(result.nextSeq).toBe(8);
  });

  it('步长大于 1 时按步长递增', () => {
    const result = generateTaskNoBatch({ prefix: 'TC-', next_seq: 10, step: 5 }, [], 3);
    expect(result.taskNos).toEqual(['TC-10', 'TC-15', 'TC-20']);
    expect(result.nextSeq).toBe(25);
  });

  it('缺省规则字段落空前后缀、起始序号 1、步长 1', () => {
    const result = generateTaskNoBatch({}, [], 2);
    expect(result.taskNos).toEqual(['1', '2']);
    expect(result.nextSeq).toBe(3);
  });

  it('count 为 0 时返回空批次且不推进序号', () => {
    const result = generateTaskNoBatch({ prefix: 'TC-', next_seq: 7, step: 3 }, ['TC-7'], 0);
    expect(result.taskNos).toEqual([]);
    expect(result.sequences).toEqual([]);
    expect(result.nextSeq).toBe(7);
  });
});

describe('generateTaskNoBatch 跳号（需求 38.9）', () => {
  it('命中已占用序号时跳至下一可用序号', () => {
    const result = generateTaskNoBatch({ prefix: 'TC-', next_seq: 1, step: 1 }, ['TC-2'], 3);
    expect(result.taskNos).toEqual(['TC-1', 'TC-3', 'TC-4']);
    expect(result.skippedSequences).toEqual([2]);
    expect(result.nextSeq).toBe(5);
  });

  it('已占用为连续区段时跨过整段', () => {
    const existing = ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5'];
    const result = generateTaskNoBatch({ prefix: 'TC-', next_seq: 1, step: 1 }, existing, 2);
    expect(result.taskNos).toEqual(['TC-6', 'TC-7']);
    expect(result.skippedSequences).toEqual([1, 2, 3, 4, 5]);
  });

  it('生成结果与 existing 无交集，且批内互不重复', () => {
    const existing = new Set(['TC-3', 'TC-5', 'TC-9']);
    const { taskNos } = generateTaskNoBatch({ prefix: 'TC-', next_seq: 1, step: 2 }, existing, 4);
    expect(taskNos).toEqual(['TC-1', 'TC-7', 'TC-11', 'TC-13']);
    expect(new Set(taskNos).size).toBe(taskNos.length);
    for (const taskNo of taskNos) {
      expect(existing.has(taskNo)).toBe(false);
    }
  });

  it('步长跨过的占用序号不计入跳号轨迹', () => {
    const result = generateTaskNoBatch({ prefix: 'TC-', next_seq: 1, step: 10 }, ['TC-5', 'TC-11'], 2);
    expect(result.taskNos).toEqual(['TC-1', 'TC-21']);
    expect(result.skippedSequences).toEqual([11]);
  });
});

describe('generateTaskNoBatch 不匹配规则的既有编号不占号', () => {
  it('前后缀不符、中段非数字、前导零写法一律不占用序号', () => {
    const existing = ['XX-1', 'TC-abc', 'TC-001', 'TC-1-A', '', 'TC-'];
    const result = generateTaskNoBatch({ prefix: 'TC-', next_seq: 1, step: 1 }, existing, 3);
    expect(result.taskNos).toEqual(['TC-1', 'TC-2', 'TC-3']);
    expect(result.skippedSequences).toEqual([]);
  });

  it('空 existing 与省略 existing 等价', () => {
    const omitted = generateTaskNoBatch({ prefix: 'TC-' }, undefined, 2);
    const empty = generateTaskNoBatch({ prefix: 'TC-' }, [], 2);
    expect(omitted).toEqual(empty);
  });
});

describe('formatTaskNo / parseTaskNoSeq 可逆性', () => {
  it('渲染与反解互为逆运算', () => {
    const rule = { prefix: 'TC-', suffix: '-A' };
    expect(formatTaskNo(rule, 12)).toBe('TC-12-A');
    expect(parseTaskNoSeq(rule, 'TC-12-A')).toBe(12);
  });

  it('不属于本规则的编号反解为 null', () => {
    const rule = { prefix: 'TC-', suffix: '' };
    expect(parseTaskNoSeq(rule, 'TC-007')).toBeNull();
    expect(parseTaskNoSeq(rule, 'XX-7')).toBeNull();
    expect(parseTaskNoSeq(rule, 'TC-7x')).toBeNull();
    expect(parseTaskNoSeq(rule, 7)).toBeNull();
  });

  it('前后缀中的正则元字符按字面匹配', () => {
    const rule = { prefix: 'TC.(', suffix: ')+' };
    expect(formatTaskNo(rule, 3)).toBe('TC.(3)+');
    expect(parseTaskNoSeq(rule, 'TC.(3)+')).toBe(3);
    expect(parseTaskNoSeq(rule, 'TCX(3)+')).toBeNull();
    const result = generateTaskNoBatch(rule, ['TC.(1)+'], 2);
    expect(result.taskNos).toEqual(['TC.(2)+', 'TC.(3)+']);
  });
});

describe('入参校验', () => {
  it('规则与 count 的非法取值抛错', () => {
    expect(() => generateTaskNoBatch(null, [], 1)).toThrow(/编号规则需为对象/);
    expect(() => generateTaskNoBatch({ prefix: 123 }, [], 1)).toThrow(/prefix/);
    expect(() => generateTaskNoBatch({ next_seq: -1 }, [], 1)).toThrow(/next_seq/);
    expect(() => generateTaskNoBatch({ next_seq: 1.5 }, [], 1)).toThrow(/next_seq/);
    expect(() => generateTaskNoBatch({ step: 0 }, [], 1)).toThrow(/step/);
    expect(() => generateTaskNoBatch({}, [], -1)).toThrow(/count/);
    expect(() => generateTaskNoBatch({}, [], 2.5)).toThrow(/count/);
    expect(() => generateTaskNoBatch({}, 'TC-1', 1)).toThrow(/existing/);
  });
});
