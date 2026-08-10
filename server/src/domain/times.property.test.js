import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeCardTimes, isChronological } from './times.js';

// 基准时刻 + 分钟偏移，构造真实的 ISO 8601 时间戳；偏移取值范围足够大，
// 使得同一属性运行内各行的开始/结束偏移碰撞概率可忽略，从而可在测试中
// 独立、确定地推算出「期望的最早开始 / 最晚结束 / 是否全部完成」，再与
// computeCardTimes 的输出比对。
const BASE_MS = Date.parse('2024-01-01T00:00:00Z');
const toIso = (offsetMinutes) => new Date(BASE_MS + offsetMinutes * 60000).toISOString();
const OFFSET_MAX = 5_000_000; // 约 9.5 年跨度，足够稀疏

// 单道工序的生成基元：是否已开始、是否已完成，各自独立取一个偏移量。
// 「已开始未完成」「已完成」「未开始」均由 hasStart/hasFinish 的组合覆盖。
const processRowArb = fc.record({
  processId: fc.string({ minLength: 1, maxLength: 8 }),
  hasStart: fc.boolean(),
  hasFinish: fc.boolean(),
  startOffset: fc.integer({ min: 0, max: OFFSET_MAX }),
  finishOffset: fc.integer({ min: 0, max: OFFSET_MAX }),
});

function toRecord(row) {
  return {
    processId: row.processId,
    startTime: row.hasStart ? toIso(row.startOffset) : null,
    finishTime: row.hasFinish ? toIso(row.finishOffset) : null,
  };
}

/** 依据生成器自身的偏移量，独立算出期望的聚合结果（不复用被测实现）。 */
function expectedAggregate(rows) {
  const started = rows.filter((r) => r.hasStart);
  const finished = rows.filter((r) => r.hasFinish);
  const processCount = rows.length;
  const allFinished = processCount > 0 && finished.length === processCount;
  const hasUnfinished = processCount > 0 && finished.length < processCount;

  const expectedStartTime =
    started.length === 0 ? null : toIso(Math.min(...started.map((r) => r.startOffset)));
  const expectedFinishTime = allFinished
    ? toIso(Math.max(...finished.map((r) => r.finishOffset)))
    : null;

  return {
    expectedStartTime,
    expectedFinishTime,
    allFinished,
    hasUnfinished,
    processCount,
    startedCount: started.length,
    finishedCount: finished.length,
  };
}

// Feature: task-card-management, Property 18: For any JOB 或其工序，若同时存在开始时间与结束时间，则结束时间不早于开始时间；JOB 的工卡开始时间存在当且仅当至少一道工序已开始，且等于其最早工序开始时间；JOB 的工卡结束时间存在当且仅当全部工序均已完成，且等于其最晚工序结束时间——存在未完成工序时该值恒为空（需求 33.6）。
describe('Property 18: 起止时间时序一致性（computeCardTimes 聚合语义）', () => {
  it('任意工序集合：开始/结束/全部完成判定与独立算出的期望值一致（需求 33.5、33.6）', () => {
    fc.assert(
      fc.property(fc.array(processRowArb, { minLength: 0, maxLength: 20 }), (rows) => {
        const records = rows.map(toRecord);
        const expected = expectedAggregate(rows);
        const result = computeCardTimes(records);

        expect(result.startTime).toBe(expected.expectedStartTime);
        expect(result.allFinished).toBe(expected.allFinished);
        expect(result.hasUnfinished).toBe(expected.hasUnfinished);
        expect(result.processCount).toBe(expected.processCount);
        expect(result.startedCount).toBe(expected.startedCount);
        expect(result.finishedCount).toBe(expected.finishedCount);
        expect(result.finishTime).toBe(expected.expectedFinishTime);

        // 核心不对称：只要存在未完成工序，工卡结束时间恒为空——
        // 绝不会泄漏为「已完成工序中的最晚值」。
        if (result.hasUnfinished) {
          expect(result.finishTime).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('存在未完成工序时工卡结束时间恒为空：至少 1 道已完成 + 至少 1 道未完成的强制场景（需求 33.6 核心断言）', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            processId: fc.string({ minLength: 1, maxLength: 8 }),
            startOffset: fc.integer({ min: 0, max: OFFSET_MAX }),
            finishOffset: fc.integer({ min: 0, max: OFFSET_MAX }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.array(
          fc.record({
            processId: fc.string({ minLength: 1, maxLength: 8 }),
            hasStart: fc.boolean(), // 未完成工序可能已开始，也可能尚未开始
            startOffset: fc.integer({ min: 0, max: OFFSET_MAX }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (finishedRows, unfinishedRows) => {
          const finishedRecords = finishedRows.map((r) => ({
            processId: r.processId,
            startTime: toIso(r.startOffset),
            finishTime: toIso(r.finishOffset),
          }));
          const unfinishedRecords = unfinishedRows.map((r) => ({
            processId: r.processId,
            startTime: r.hasStart ? toIso(r.startOffset) : null,
            finishTime: null,
          }));

          const result = computeCardTimes([...finishedRecords, ...unfinishedRecords]);

          // 至少存在一道未完成工序 → hasUnfinished 必为真 → finishTime 必为空。
          expect(result.hasUnfinished).toBe(true);
          expect(result.allFinished).toBe(false);
          expect(result.finishTime).toBeNull();
          // 即便已完成工序中存在很晚的结束时间，也不得泄漏为工卡结束时间。
          expect(result.finishedCount).toBe(finishedRows.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('工卡级 chronological 字段与 isChronological(startTime, finishTime) 恒一致（需求 33.8）', () => {
    fc.assert(
      fc.property(fc.array(processRowArb, { minLength: 0, maxLength: 20 }), (rows) => {
        const records = rows.map(toRecord);
        const result = computeCardTimes(records);
        expect(result.chronological).toBe(isChronological(result.startTime, result.finishTime));
      }),
      { numRuns: 100 },
    );
  });
});
