import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { canArchivePaperless } from './signature.js';

// ─────────────────────────────────────────────────────────────────────────────
// 共享生成器（arbitraries）
// ─────────────────────────────────────────────────────────────────────────────

/** 固定工卡：本属性只关心签署完备性口径，工卡标识对匹配无影响（签署记录不带 card_id） */
const CARD = Object.freeze({ id: 1, task_no: 'TC-0001', revision: 1 });

/** 单个必需签署项的开关规格：`stampRequired` / `dateRequired` 各自独立随机 */
const requirementSpecArb = fc.record({
  stampRequired: fc.boolean(),
  dateRequired: fc.boolean(),
});

/**
 * 单条签署记录的构造规格：
 * - `matches`：是否指向本次判定所在的必需签署项（`signature_requirement_id` 命中）
 * - `hasSignedBy` / `hasStampId` / `hasSignedAt`：三个字段各自是否存在
 */
const signatureSpecArb = fc.record({
  matches: fc.boolean(),
  hasSignedBy: fc.boolean(),
  hasStampId: fc.boolean(),
  hasSignedAt: fc.boolean(),
});

/** 按索引构造一条 `signature_requirement` 同形行（`id` 全局唯一，避开身份键折叠） */
function buildRequirement(spec, index) {
  return {
    id: index + 1,
    signature_role: 'Operator',
    stamp_required: spec.stampRequired ? 1 : 0,
    date_required: spec.dateRequired ? 1 : 0,
  };
}

/** 按规格构造一条 `electronic_signature` 同形行；`matches` 为假时指向一个必不存在的负数 id */
function buildSignature(spec, requirementId, index) {
  return {
    id: index + 1,
    signature_requirement_id: spec.matches ? requirementId : -(index + 1),
    signed_by: spec.hasSignedBy ? 'E1001' : null,
    stamp_id: spec.hasStampId ? 'STAMP-01' : null,
    signed_at: spec.hasSignedAt ? '2024-06-01T08:30:00Z' : null,
  };
}

/** 单条签署记录对给定必需签署项规格是否完备（逐项开关口径，需求 32.3、45.4、45.5） */
function isSpecComplete(sigSpec, reqSpec) {
  if (!sigSpec.matches) return false;
  if (!sigSpec.hasSignedBy) return false;
  if (reqSpec.stampRequired && !sigSpec.hasStampId) return false;
  if (reqSpec.dateRequired && !sigSpec.hasSignedAt) return false;
  return true;
}

/** 一个「必需签署项 + 其候选签署记录规格集合」分组 */
const requirementGroupArb = fc.record({
  requirement: requirementSpecArb,
  signatures: fc.array(signatureSpecArb, { maxLength: 3 }),
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.6 → Property 17: 无纸化归档完备性
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 17: 无纸化归档完备性 —— For any 工卡，其可无纸化归档当且仅当全部必需签署项均已存在通过电子签章认证的签署记录（含签署人、签章标识与完成日期）。
describe('Property 17: 无纸化归档完备性', () => {
  it('ok 当且仅当每一项必需签署项均存在归属本项且完备（按逐项开关口径）的签署记录', () => {
    fc.assert(
      fc.property(fc.array(requirementGroupArb, { maxLength: 5 }), (groups) => {
        const requirements = groups.map((group, index) => buildRequirement(group.requirement, index));
        const signatures = groups.flatMap((group, index) =>
          group.signatures.map((sigSpec, sigIndex) =>
            buildSignature(sigSpec, requirements[index].id, index * 100 + sigIndex)));

        const expectedOkPerItem = groups.map((group) =>
          group.signatures.some((sigSpec) => isSpecComplete(sigSpec, group.requirement)));
        const expectedOk = expectedOkPerItem.every(Boolean);

        const result = canArchivePaperless(CARD, requirements, signatures);

        expect(result.ok).toBe(expectedOk);
        expect(result.total).toBe(requirements.length);
        expect(result.satisfiedCount).toBe(expectedOkPerItem.filter(Boolean).length);
        expect(result.vacuous).toBe(requirements.length === 0);
      }),
      { numRuns: 100 },
    );
  });

  it('必需签署项为空集时真空成立：ok 恒为真，与签署记录内容无关', () => {
    fc.assert(
      fc.property(fc.array(signatureSpecArb, { maxLength: 4 }), (sigSpecs) => {
        const signatures = sigSpecs.map((spec, index) => buildSignature(spec, 999, index));
        const result = canArchivePaperless(CARD, [], signatures);
        expect(result.ok).toBe(true);
        expect(result.vacuous).toBe(true);
        expect(result.total).toBe(0);
        expect(result.missing).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
