import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildChangeRecords, serializeChangeValue, CHANGE_TYPES, REJECTION } from './change-record.js';

// ─────────────────────────────────────────────────────────────────────────────
// 共享生成器（arbitraries）
// ─────────────────────────────────────────────────────────────────────────────

/** 字段名取自固定小集合，保证 before/after 之间大概率产生键重叠，覆盖「变化/不变」两类字段 */
const FIELD_NAMES = ['a', 'b', 'c', 'd', 'e'];
const fieldNameArb = fc.constantFrom(...FIELD_NAMES);

/**
 * 取值生成器：涵盖 number / string / boolean / null / undefined，
 * 刻意包含「落库形态可能相同但 JS 类型不同」的取值（如 1 与 '1'、null 与 undefined），
 * 用于验证 serializeChangeValue 落库形态相同即不判变更的规则。
 */
const valueArb = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.string({ maxLength: 8 }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
);

/** 随机键值字典（≤ FIELD_NAMES.length 个键），作为字段级可比对快照（非整体删除/新增） */
const objectArb = fc.dictionary(fieldNameArb, valueArb, { maxKeys: FIELD_NAMES.length });

const changeTypeArb = fc.constantFrom(...CHANGE_TYPES);

/** 非空白原因 / 操作人：trim 后非空即可（isBlank 以 trim().length === 0 判定） */
const nonBlankTextArb = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((s) => s.trim().length > 0);

/** 空白/纯空白原因：含制表、换行、半角空格与全角空格（U+3000），以及 null/undefined */
const blankReasonArb = fc.oneof(
  fc.constant(''),
  fc.constant(null),
  fc.constant(undefined),
  fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '\u3000'), { minLength: 0, maxLength: 10 })
    .map((chars) => chars.join('')),
);

/** 浅拷贝字典（值均为原语，浅拷贝即深拷贝），用于构造「内容相同但非同一引用」的 after */
function cloneDict(obj) {
  const out = {};
  for (const key of Object.keys(obj)) out[key] = obj[key];
  return out;
}

/** 依据 serializeChangeValue 计算 before/after 之间「实际发生变化」的字段集合（按字典序） */
function expectedChangedFields(before, after) {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...allKeys]
    .filter((key) => serializeChangeValue(before[key]) !== serializeChangeValue(after[key]))
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 10.7 → Property 35: 变更留痕完备性
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 35: 变更留痕完备性 —— For any 编制域内容变更（元数据保存、工序或参考文件删除、升版、批量替换、作废）与任意变更原因，buildChangeRecords 的产出满足：每个发生实际变化的字段恰好对应一条变更记录，且该记录的 old_value / new_value 分别等于变更前后的取值、change_type 等于本次操作类型、reason / operator_id / timestamp 均非空；未发生变化的字段不产生记录（before === after 时产出空集）。For any 为空或纯空白的变更原因，整个变更被拒绝且不产出任何记录。For any 变更操作序列，某工卡的变更记录查询结果恒等于该序列累积写入的全部记录——不丢失、不重复、不产生无对应操作的幻影记录。
describe('Property 35: 变更留痕完备性', () => {
  it('每个实际变化字段恰对应一条记录，old_value/new_value/reason/operator_id/timestamp 均正确非空', () => {
    fc.assert(
      fc.property(
        objectArb,
        objectArb,
        changeTypeArb,
        nonBlankTextArb,
        nonBlankTextArb,
        (before, after, changeType, reason, operatorId) => {
          const result = buildChangeRecords(before, after, changeType, reason, operatorId);

          expect(result.ok).toBe(true);

          const expectedFields = expectedChangedFields(before, after);
          const actualFields = result.records.map((r) => r.field).sort();
          expect(actualFields).toEqual(expectedFields);

          // 单次调用输出内无重复字段
          expect(new Set(actualFields).size).toBe(actualFields.length);

          for (const record of result.records) {
            expect(record.old_value).toBe(serializeChangeValue(before[record.field]));
            expect(record.new_value).toBe(serializeChangeValue(after[record.field]));
            expect(record.change_type).toBe(changeType);
            expect(record.reason).toBeTruthy();
            expect(record.operator_id).toBeTruthy();
            expect(record.timestamp).toBeTruthy();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('未变化字段不产生记录：before 与 after 内容相同（同引用或深拷贝）时产出空集', () => {
    fc.assert(
      fc.property(
        objectArb,
        changeTypeArb,
        nonBlankTextArb,
        nonBlankTextArb,
        (obj, changeType, reason, operatorId) => {
          const sameRefResult = buildChangeRecords(obj, obj, changeType, reason, operatorId);
          expect(sameRefResult.ok).toBe(true);
          expect(sameRefResult.records).toEqual([]);

          const clone = cloneDict(obj);
          const cloneResult = buildChangeRecords(obj, clone, changeType, reason, operatorId);
          expect(cloneResult.ok).toBe(true);
          expect(cloneResult.records).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('空或纯空白变更原因（含全角空格）整体拒绝，零产出', () => {
    fc.assert(
      fc.property(
        objectArb,
        objectArb,
        changeTypeArb,
        blankReasonArb,
        nonBlankTextArb,
        (before, after, changeType, reason, operatorId) => {
          const result = buildChangeRecords(before, after, changeType, reason, operatorId);
          expect(result.ok).toBe(false);
          expect(result.rejection).toBe(REJECTION.REASON_REQUIRED);
          expect(result.records).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('变更序列的累积记录集合不丢失、不重复、无幻影记录', () => {
    fc.assert(
      fc.property(
        // 4~6 个连续快照 ⇒ 3~5 次 buildChangeRecords 调用（每两个相邻快照为一次变更）
        fc.array(objectArb, { minLength: 4, maxLength: 6 }),
        changeTypeArb,
        nonBlankTextArb,
        nonBlankTextArb,
        (states, changeType, reason, operatorId) => {
          const seenStepFieldPairs = new Set();
          let totalActual = 0;
          let totalExpected = 0;

          for (let step = 1; step < states.length; step += 1) {
            const before = states[step - 1];
            const after = states[step];

            const result = buildChangeRecords(before, after, changeType, reason, operatorId, {
              timestamp: `2024-01-01T00:00:0${step}.000Z`,
            });
            expect(result.ok).toBe(true);

            const expectedFields = expectedChangedFields(before, after);
            const actualFields = result.records.map((r) => r.field).sort();

            // 不丢失、无幻影：本步产生的记录字段集合恰等于本步实际变化字段集合
            expect(actualFields).toEqual(expectedFields);

            // 不重复：本步输出内字段不重复
            expect(new Set(actualFields).size).toBe(actualFields.length);

            totalActual += result.records.length;
            totalExpected += expectedFields.length;

            // 跨步骤累积不重复：同一 (step, field) 组合只应出现一次
            for (const field of actualFields) {
              const key = `${step}:${field}`;
              expect(seenStepFieldPairs.has(key)).toBe(false);
              seenStepFieldPairs.add(key);
            }
          }

          // 累积记录总数与累积期望变化字段总数一致（不丢失、不重复）
          expect(totalActual).toBe(totalExpected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
