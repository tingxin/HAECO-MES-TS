import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aggregateSignatureRequirements } from './signature.js';
import { submitReviewChecklist } from './review.js';
import { EXEC_DOC_TYPE, EXEC_DOC_SIGN_RULE } from './enums.js';

/**
 * Property 27 测试任务 9.5 的三段建构：
 *
 * 1. 必需签署项恒等于全工序配置并集——工序按嵌套形态 ①（`signatureRequirements` 挂在工序上）
 *    生成，每道工序 0–3 个签署项配置，全局唯一 `id`，断言聚合结果的 `id` 集合与全部配置
 *    `id` 集合完全相等（不多不少、不重不漏）。
 * 2. 不存在无来源项——构造 `step_id` 不命中任一给定工序的扁平签署项行，断言其落入
 *    `orphans` 而不进入 `requirements`（同时验证命中工序的扁平行正常计入，作对照）。
 * 3. 端到端约束——关联单据的 `sign_rule === '签署'`，而工卡下全部工序签署项聚合为空时，
 *    经 `review.js` 的 `submitReviewChecklist` 校验项 (f) 必判未通过，直接调用组合后的
 *    校验函数验证，而非独立重新推导 (f) 的判定逻辑。
 *
 * 需求：45.1、45.3、45.6、45.8、45.9、32.4
 */

/** 关联单据签署要求属性精确等于「签署」的类型集合（需求 16.4，排除 SC 的子串陷阱） */
const REQUIRED_SIGN_DOC_TYPES = EXEC_DOC_TYPE.filter((code) => EXEC_DOC_SIGN_RULE[code] === '签署');

// ---------------------------------------------------------------------------
// Build 1：必需签署项恒等于全工序配置并集
// ---------------------------------------------------------------------------

/** 每道工序的签署项配置个数（0–3），至少 1 道工序，至多 5 道 */
const stepConfigCountsArb = fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 5 });

/** 按每道工序的配置个数，生成嵌套形态 ① 的工序数组，全局唯一签署项配置 id 从 1 递增 */
function buildStepsWithNestedConfigs(counts) {
  let nextConfigId = 1;
  const expectedIds = new Set();
  const steps = counts.map((n, stepIndex) => {
    const stepId = stepIndex + 1;
    const configs = [];
    for (let i = 0; i < n; i += 1) {
      configs.push({ id: nextConfigId, signature_role: 'Operator', step_id: stepId });
      expectedIds.add(nextConfigId);
      nextConfigId += 1;
    }
    return { id: stepId, process_id: String(stepIndex), signatureRequirements: configs };
  });
  return { steps, expectedIds, totalConfigs: nextConfigId - 1 };
}

// ---------------------------------------------------------------------------
// Build 2：不存在无来源项（orphans）
// ---------------------------------------------------------------------------

/** 一组互不相同的工序 id（1..1000 内），至少 1 个，至多 5 个 */
const stepIdsArb = fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 5 });
/** 保证落在工序 id 值域之外的孤立 `step_id`（负数，与工序 id 全为正数天然不相交） */
const orphanStepIdArb = fc.integer({ min: -1000, max: -1 });

// ---------------------------------------------------------------------------
// Build 3：端到端——要求签署的单据未配置签署项时工卡不可提交审核
// ---------------------------------------------------------------------------

/** 一张各校验项均能通过的"黄金"工卡 + ctx（与 review.property.test.js 的黄金路径一致） */
function goldenCard() {
  return {
    id: 1,
    task_no: 'TN-0001',
    revision: 1,
    title: 'Test Card',
    date: '2024-06-01',
    ac_type: '320',
    gear_type: 'MLG',
    stage: 'RTN',
    skill: 'GR',
    ctrl_code: 'AS',
    card_type: '01',
    status: 'New',
    created_by: 'E001',
  };
}

function goldenCtx() {
  return {
    cards: [],
    orgName: 'HAECO',
    referenceDocuments: [{ id: 1, doc_type: 'DWG', ref_no: 'REF-1' }],
    // 工卡下全部工序零签署项配置——(f) 的触发条件（同时会使 (c) 的"签署项≥1 项"分支
    // 一并未通过，这是 review.js 现有实现的固有耦合，不影响本测试对 (f) 的核心断言）
    steps: [{ id: 10, process_id: 'A' }],
    capabilityList: [
      { ac_type: '320', gear_type: 'MLG', skill: 'GR', revision: 1, effective_from: '2020-01-01', effective_to: null },
    ],
    onDate: '2024-06-01',
    changeReason: '首次编制',
    relations: [],
    signRuleCfg: undefined,
    stageConstraintCfg: {
      constraints: [{ card_type: '01', allowed_stage: 'RTN', is_auto_fill: 1 }],
    },
  };
}

const requiredDocTypeArb = fc.constantFrom(...REQUIRED_SIGN_DOC_TYPES);
const docNoArb = fc.integer({ min: 1, max: 1000000 }).map((n) => `D-${n}`);

// Feature: task-card-management, Property 27: 必需签署项来源完备性 —— For any 工卡，需求 32.4 判定的「必需签署项」集合恒等于其全部工序 signature_requirement 配置的并集；不存在无来源的必需签署项；任一签署要求属性为「签署」的单据若未配置签署项，则该工卡不可提交审核。
describe('Property 27: 必需签署项来源完备性', () => {
  it('必需签署项恒等于全工序配置并集（不多不少、不重不漏）', () => {
    fc.assert(
      fc.property(stepConfigCountsArb, (counts) => {
        const { steps, expectedIds, totalConfigs } = buildStepsWithNestedConfigs(counts);
        const aggregate = aggregateSignatureRequirements(steps);

        expect(aggregate.count).toBe(totalConfigs);
        expect(aggregate.orphans.length).toBe(0);
        expect(aggregate.duplicates).toBe(0);

        const actualIds = new Set(aggregate.requirements.map((item) => item.id));
        expect(actualIds).toEqual(expectedIds);
        // 集合大小相等 + 元素集合相等 ⇒ 无重复、无多余、无遗漏
        expect(aggregate.requirements.length).toBe(expectedIds.size);
      }),
      { numRuns: 100 },
    );
  });

  it('不存在无来源项：step_id 未命中任一给定工序的扁平签署项行落入 orphans 而不进入 requirements', () => {
    fc.assert(
      fc.property(stepIdsArb, orphanStepIdArb, (stepIds, orphanStepId) => {
        const steps = stepIds.map((id) => ({ id }));
        const legitStepId = stepIds[0];

        const requirements = [
          // 命中已知工序的扁平行——应正常计入 requirements，作为对照
          { id: 5001, step_id: legitStepId, signature_role: 'QC' },
          // 未命中任何已知工序的扁平行——应落入 orphans，不进入 requirements
          { id: 5002, step_id: orphanStepId, signature_role: 'QC' },
        ];

        const aggregate = aggregateSignatureRequirements({ steps, requirements });

        expect(aggregate.orphans.length).toBe(1);
        expect(aggregate.orphans[0].id).toBe(5002);
        expect(aggregate.orphans[0].stepId).toBe(orphanStepId);

        const requirementIds = aggregate.requirements.map((item) => item.id);
        expect(requirementIds).toContain(5001);
        expect(requirementIds).not.toContain(5002);
        expect(aggregate.count).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it('签署要求为「签署」的单据未配置签署项时，工卡不可提交审核（经 submitReviewChecklist 校验项 (f)）', () => {
    fc.assert(
      fc.property(requiredDocTypeArb, docNoArb, (docType, docNo) => {
        const card = goldenCard();
        const ctx = goldenCtx();
        ctx.relations = [{ card_id: card.id, exec_doc_type: docType, related_doc_no: docNo }];

        const result = submitReviewChecklist(card, ctx);

        expect(result.ok).toBe(false);
        const checks = result.failedChecks.map((item) => item.check);
        expect(checks).toContain('f');
      }),
      { numRuns: 100 },
    );
  });
});
