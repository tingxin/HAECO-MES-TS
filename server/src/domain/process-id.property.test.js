import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PROCESS_ID_PATTERN,
  generateProcessId,
  generateProcessIdSequence,
} from './process-id.js';

// Feature: task-card-management, Property 10: 同一工卡下生成的多个工序，其 process_id 两两互不相同且符合固定生成规则（A–Z 后接 AA、AB…）。
describe('Property 10: 工序编号唯一（generateProcessIdSequence）', () => {
  it('对任意工序道数 N，生成的 process_id 两两互不相同、均匹配 PROCESS_ID_PATTERN，且遵循双射二十六进制边界规则', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.option(fc.constantFrom(null, { id: 1, taskNo: 'TC-0001', revision: 1 }, {}), {
          nil: undefined,
        }),
        (n, card) => {
          const ids = generateProcessIdSequence(card, n);

          // 长度与两两互不相同（Set 去重后长度不变）
          expect(ids).toHaveLength(n);
          expect(new Set(ids).size).toBe(n);

          // 每个生成的编号均匹配大写字母序模式
          for (const id of ids) {
            expect(id).toMatch(PROCESS_ID_PATTERN);
          }

          // 与 generateProcessId 直接调用交叉校验，逐项一致
          for (let seq = 1; seq <= n; seq += 1) {
            expect(ids[seq - 1]).toBe(generateProcessId(card, seq));
          }

          // 双射二十六进制边界抽查：seq 26 → 'Z'，seq 27 → 'AA'（仅当范围覆盖时）
          if (n >= 26) {
            expect(ids[25]).toBe('Z');
            expect(generateProcessId(card, 26)).toBe('Z');
          }
          if (n >= 27) {
            expect(ids[26]).toBe('AA');
            expect(generateProcessId(card, 27)).toBe('AA');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
