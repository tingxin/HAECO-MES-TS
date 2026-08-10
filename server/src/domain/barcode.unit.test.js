import { describe, it, expect } from 'vitest';
import {
  BARCODE_SEPARATOR,
  BARCODE_SYMBOLOGY,
  generateBarcode,
  parseBarcode,
} from './barcode.js';
import { generateProcessId } from './process-id.js';

describe('generateBarcode — `{JOB No}-{Process ID}`（D-03，需求 15.1、15.2）', () => {
  it('按 JOB No 与 Process ID 拼接生成', () => {
    expect(generateBarcode('JOB-2026-0001', 'A')).toBe('JOB-2026-0001-A');
    expect(generateBarcode('J1', generateProcessId(null, 27))).toBe('J1-AA');
    expect(BARCODE_SEPARATOR).toBe('-');
    expect(BARCODE_SYMBOLOGY).toBe('Code128');
  });

  it('不同 JOB No 的同一工序产出不同条码（跨 JOB 不复用，需求 15.4）', () => {
    expect(generateBarcode('JOB-A', 'A')).not.toBe(generateBarcode('JOB-B', 'A'));
  });

  it('同一 JOB 的不同工序产出不同条码', () => {
    expect(generateBarcode('JOB-A', 'A')).not.toBe(generateBarcode('JOB-A', 'B'));
  });

  it('JOB No 含分隔符也不产生歧义（最后一个 `-` 为唯一切分点）', () => {
    expect(generateBarcode('J-A', 'B')).toBe('J-A-B');
    expect(generateBarcode('J', 'AB')).toBe('J-AB');
    expect(generateBarcode('J-A', 'B')).not.toBe(generateBarcode('J', 'AB'));
  });

  it('拒绝空白或非字符串 JOB No', () => {
    for (const jobNo of ['', '   ', null, undefined, 123, {}]) {
      expect(() => generateBarcode(jobNo, 'A')).toThrow(TypeError);
    }
  });

  it('拒绝非大写字母序的 Process ID（保护单射性）', () => {
    for (const processId of ['', 'a', 'A1', 'A-B', '1', null, undefined]) {
      expect(() => generateBarcode('JOB-1', processId)).toThrow(TypeError);
    }
  });
});

describe('parseBarcode — 逆映射（需求 15.4 可定位性）', () => {
  it('还原 JOB No 与 Process ID', () => {
    expect(parseBarcode('JOB-2026-0001-AA')).toEqual({
      jobNo: 'JOB-2026-0001',
      processId: 'AA',
    });
    expect(parseBarcode(generateBarcode('J-A', 'B'))).toEqual({ jobNo: 'J-A', processId: 'B' });
  });

  it('拒绝不符形态的内容', () => {
    for (const value of ['', 'JOB0001', '-A', 'JOB-1-a', 'JOB-1-', null] ) {
      expect(() => parseBarcode(value)).toThrow(TypeError);
    }
  });
});
