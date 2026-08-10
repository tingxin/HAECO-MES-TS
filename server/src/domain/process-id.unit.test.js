import { describe, it, expect } from 'vitest';
import {
  PROCESS_ID_PATTERN,
  generateProcessId,
  generateProcessIdSequence,
} from './process-id.js';

const card = { id: 1, taskNo: 'TC-0001', revision: 1 };

describe('generateProcessId — 大写字母序（D-02，需求 11.1）', () => {
  it('前 26 道工序为 A–Z', () => {
    expect(generateProcessId(card, 1)).toBe('A');
    expect(generateProcessId(card, 2)).toBe('B');
    expect(generateProcessId(card, 25)).toBe('Y');
    expect(generateProcessId(card, 26)).toBe('Z');
  });

  it('第 26/27 道的边界为 Z → AA（无零位，非普通二十六进制的 BA）', () => {
    expect(generateProcessId(card, 26)).toBe('Z');
    expect(generateProcessId(card, 27)).toBe('AA');
    expect(generateProcessId(card, 28)).toBe('AB');
  });

  it('两位与三位的进位边界与电子表格列号一致', () => {
    expect(generateProcessId(card, 52)).toBe('AZ');
    expect(generateProcessId(card, 53)).toBe('BA');
    expect(generateProcessId(card, 702)).toBe('ZZ');
    expect(generateProcessId(card, 703)).toBe('AAA');
  });

  it('编号仅由 seq 决定，与工卡内容无关（card 允许为空）', () => {
    expect(generateProcessId(null, 27)).toBe('AA');
    expect(generateProcessId(undefined, 27)).toBe('AA');
    expect(generateProcessId({ id: 999 }, 27)).toBe('AA');
  });

  it('输出恒匹配 PROCESS_ID_PATTERN', () => {
    for (const seq of [1, 26, 27, 100, 703]) {
      expect(generateProcessId(card, seq)).toMatch(PROCESS_ID_PATTERN);
    }
  });

  it('非法 seq（0、负数、小数、NaN、非数字）一律拒绝', () => {
    for (const seq of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
      expect(() => generateProcessId(card, seq)).toThrow(RangeError);
    }
  });
});

describe('generateProcessIdSequence', () => {
  it('生成的编号两两互不相同', () => {
    const ids = generateProcessIdSequence(card, 60);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids[0]).toBe('A');
    expect(ids[26]).toBe('AA');
  });

  it('道数为 0 时返回空数组，负数拒绝', () => {
    expect(generateProcessIdSequence(card, 0)).toEqual([]);
    expect(() => generateProcessIdSequence(card, -1)).toThrow(RangeError);
  });
});
