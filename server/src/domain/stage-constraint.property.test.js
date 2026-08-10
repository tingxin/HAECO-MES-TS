import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { ALLOWED_TRANSITIONS, CARD_STATUS, CARD_TYPE_CODES, STAGE } from './enums.js';
import { canTransition } from './card-rules.js';
import {
  allowedStagesFor,
  crosscutStagesOf,
  defaultStageFor,
  selectableForStandardPackage,
  selectableStages,
  validateStageCardType,
} from './stage-constraint.js';

// ─────────────────────────────────────────────────────────────────────────────
// 共享生成器（arbitraries）
// ─────────────────────────────────────────────────────────────────────────────

/** 工卡类型全码域 */
const cardTypeArb = fc.constantFrom(...CARD_TYPE_CODES);

/** 单条约束行：`{ card_type, allowed_stage, is_auto_fill }`（camelCase 亦兼容，此处固定 snake_case） */
const constraintRowArb = fc.record({
  card_type: cardTypeArb,
  allowed_stage: fc.constantFrom(...STAGE),
  is_auto_fill: fc.boolean(),
});

/**
 * 随机 `cfg`：约束行的随机子集（含重复、跨类型）+ 横切取值的随机子集（`STAGE` 的任意子数组）。
 * `fc.subarray` 保持元素顺序且不重复，天然满足 `crosscut` 行的去重预期。
 */
const cfgArb = fc.record({
  constraints: fc.array(constraintRowArb, { maxLength: 24 }),
  crosscut: fc.subarray([...STAGE]),
});

/** 工卡状态全域（含非法字符串，用于验证 selectableForStandardPackage 对 WFD 的恒假性不依赖状态取值） */
const statusOrBogusArb = fc.oneof(
  fc.constantFrom(...CARD_STATUS),
  fc.string().filter((s) => !CARD_STATUS.includes(s)),
);

// ─────────────────────────────────────────────────────────────────────────────
// 8.6 → Property 28: Stage 与工卡类型约束一致性
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 28: Stage 与工卡类型约束一致性 —— For any 工卡，其 (Stage, 工卡类型) 组合可被保存或提交当且仅当该组合属于 stage_card_type_constraint 允许组合，或 Stage 属于横切取值集合 {DMY, NRC, WCC, WFD}。For any 工卡类型，defaultStageFor 给出的默认 Stage 恒属于该类型的允许组合，而 selectableStages 给出的可改选范围恒等于「该类型允许组合 ∪ 横切取值集合」——即横切取值对任意工卡类型均可达（此为需求 46.12 由「只读」修正为「默认值可改选」后的可达性保证；若 Stage 置只读，本子句不可满足，且需求 46.5 将退化为空条件）。工卡状态与 Stage、类型均独立不由二者派生；Stage=WFD 不使状态迁移为「作废」，但恒使 selectableForStandardPackage 返回假，从而排除于 Load Standard Package 取卡结果之外。
describe('Property 28: Stage 与工卡类型约束一致性', () => {
  it('selectableStages 对任意工卡类型恒包含全部横切取值（可达性保证，需求 46.12）', () => {
    fc.assert(
      fc.property(cardTypeArb, cfgArb, (cardType, cfg) => {
        const selectable = new Set(selectableStages(cardType, cfg));
        const crosscut = crosscutStagesOf(cfg);
        for (const stage of crosscut) {
          expect(selectable.has(stage)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('selectableStages 恒等于「该类型允许组合 ∪ 横切取值集合」', () => {
    fc.assert(
      fc.property(cardTypeArb, cfgArb, (cardType, cfg) => {
        const expected = new Set([...allowedStagesFor(cardType, cfg), ...crosscutStagesOf(cfg)]);
        expect(new Set(selectableStages(cardType, cfg))).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('defaultStageFor 恒属于该类型的允许组合，绝不返回仅存在于横切取值中的 Stage', () => {
    fc.assert(
      fc.property(cardTypeArb, cfgArb, (cardType, cfg) => {
        const value = defaultStageFor(cardType, cfg);
        if (value !== null) {
          expect(allowedStagesFor(cardType, cfg)).toContain(value);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('validateStageCardType(stage, cardType, cfg).ok 与 selectableStages 恒一致', () => {
    fc.assert(
      fc.property(cardTypeArb, cfgArb, fc.constantFrom(...STAGE), (cardType, cfg, stage) => {
        const selectable = selectableStages(cardType, cfg);
        const result = validateStageCardType(stage, cardType, cfg);
        expect(result.ok).toBe(selectable.includes(stage));
      }),
      { numRuns: 100 },
    );
  });

  it('Stage=WFD 恒使 selectableForStandardPackage 返回假，与工卡状态取值无关', () => {
    fc.assert(
      fc.property(statusOrBogusArb, (status) => {
        expect(selectableForStandardPackage({ stage: 'WFD', status })).toBe(false);
        expect(selectableForStandardPackage({ card_stage: 'WFD', card_status: status })).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('selectableForStandardPackage 为纯谓词：不修改入参工卡，亦不影响 canTransition 对该状态的判定（Stage 与状态维度独立，需求 46.7）', () => {
    fc.assert(
      fc.property(fc.constantFrom(...STAGE), fc.constantFrom(...CARD_STATUS), fc.constantFrom(...CARD_STATUS), (stage, status, to) => {
        const card = Object.freeze({ id: 1, taskNo: 'TC-0001', card_type: '01', stage, status });
        const snapshotBefore = JSON.stringify(card);

        // 连续调用两次，不应改变入参对象（冻结对象若被写入会抛异常，此处进一步以序列化比对兜底）
        selectableForStandardPackage(card);
        selectableForStandardPackage(card);
        expect(JSON.stringify(card)).toBe(snapshotBefore);

        // Stage 不派生状态迁移：canTransition 的判定结果只取决于 (from, to)，
        // 不受调用 selectableForStandardPackage 的影响，即使 stage === 'WFD'
        expect(canTransition(card.status, to)).toBe(ALLOWED_TRANSITIONS[card.status].includes(to));
      }),
      { numRuns: 100 },
    );
  });
});
