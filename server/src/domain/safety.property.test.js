import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { canEnterExecution } from './safety.js';

// ─────────────────────────────────────────────────────────────────────────────
// 共享生成器（arbitraries）
// ─────────────────────────────────────────────────────────────────────────────

/** 操作人员标识：非空字母数字串（避开 identity() 的空白折叠边界，边界口径已由单元测试覆盖） */
const userIdArb = fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''));

/**
 * 单条确认记录的构造规格：
 * - `hasBy` / `matches`：是否存在 `acknowledged_by`，以及其取值是否等于本次判定的 `userId`
 * - `hasAt`：是否存在 `acknowledged_at`
 * 完整且归属本人的记录 ⇔ `hasBy && matches && hasAt`。
 */
const ackSpecArb = fc.record({
  hasBy: fc.boolean(),
  matches: fc.boolean(),
  hasAt: fc.boolean(),
});

/** 按规格构造一条 `safety_acknowledgement` 同形行 */
function buildAck(spec, userId, otherUserId) {
  return {
    id: 1,
    acknowledged_by: spec.hasBy ? (spec.matches ? userId : otherUserId) : null,
    acknowledged_at: spec.hasAt ? '2024-06-01T08:30:00Z' : null,
  };
}

/** 该规格集合中是否存在「完整且归属本人」的记录 */
function hasCompleteOwnAck(specs) {
  return specs.some((spec) => spec.hasBy && spec.matches && spec.hasAt);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.7 → Property 16: 关键工序安全警示前置门禁
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 16: 关键工序安全警示前置门禁 —— For any JOB 工序与任意操作人员，该工序可进入执行状态当且仅当：该工序未被标记为关键维修/易误操作任务，或该操作人员已存在对应的安全警示查看确认记录（含确认人与确认时间）。
describe('Property 16: 关键工序安全警示前置门禁', () => {
  it('关键工序：ok 当且仅当存在归属本人且完整（含确认人与确认时间）的确认记录', () => {
    fc.assert(
      fc.property(
        userIdArb,
        userIdArb,
        fc.array(ackSpecArb, { maxLength: 6 }),
        (userId, otherUserIdRaw, ackSpecs) => {
          // 保证 otherUserId 与 userId 不同，避免「不匹配」规格意外命中本人
          const otherUserId = otherUserIdRaw === userId ? `${otherUserIdRaw}X` : otherUserIdRaw;
          const acks = ackSpecs.map((spec) => buildAck(spec, userId, otherUserId));
          const expected = hasCompleteOwnAck(ackSpecs);

          const step = { id: 7, process_id: 'A', is_critical: true };
          const result = canEnterExecution(step, acks, userId);
          expect(result.ok).toBe(expected);
          expect(result.isCritical).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('非关键工序：无论确认记录与操作人员标识如何，恒放行', () => {
    fc.assert(
      fc.property(
        fc.oneof(userIdArb, fc.constant(null), fc.constant(undefined), fc.constant('')),
        fc.array(
          fc.oneof(
            ackSpecArb.map((spec) => buildAck(spec, 'U1', 'U2')),
            fc.constant(null),
            fc.constant({}),
          ),
          { maxLength: 6 },
        ),
        (userId, acks) => {
          const step = { id: 7, process_id: 'A', is_critical: false };
          const result = canEnterExecution(step, acks, userId);
          expect(result.ok).toBe(true);
          expect(result.rejection).toBeNull();
          expect(result.isCritical).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
