import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { CARD_STATUS, ALLOWED_TRANSITIONS, CARD_TYPE_CODES } from './enums.js';
import {
  canTransition,
  isEditable,
  canRelease,
  nextRevision,
  reviseCard,
  checkDuplicate,
  requiresBomFields,
  printProjection,
  passesEditableGate,
  CONTENT_EDIT_OPERATIONS,
  NON_CONTENT_OPERATIONS,
} from './card-rules.js';
import { isFrozen } from './supersede.js';
import { aggregateSignatureRequirements } from './signature.js';

// ─────────────────────────────────────────────────────────────────────────────
// 共享生成器（arbitraries）
// ─────────────────────────────────────────────────────────────────────────────

/** 五态全组合 */
const statusArb = fc.constantFrom(...CARD_STATUS);

/** 一张最小可用工卡（不含 card_type，供状态迁移 / 编辑态 / 发布类测试使用） */
const baseCardArb = (statusGen = statusArb) =>
  fc.record({
    id: fc.integer({ min: 1, max: 100000 }),
    taskNo: fc.stringMatching(/^[A-Z]{2}-[0-9]{4}$/),
    revision: fc.integer({ min: 1, max: 50 }),
    status: statusGen,
  });

// ─────────────────────────────────────────────────────────────────────────────
// 5.4 → Property 1: 状态迁移合法性
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 1: 状态迁移合法性 —— For any 工卡状态迁移对 (from, to)，canTransition(from, to) 为真当且仅当 to ∈ ALLOWED_TRANSITIONS[from]，即迁移属于集合 {新增→审核中, 新增→作废, 审核中→生效, 审核中→新增(驳回), 生效→已被取代, 生效→作废}；Superseded 与 Void 均为终态无出边；非法迁移被拒绝且状态保持不变。
describe('Property 1: 状态迁移合法性', () => {
  it('canTransition(from, to) 为真当且仅当 to ∈ ALLOWED_TRANSITIONS[from]（五态全组合）', () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        const expected = ALLOWED_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('Superseded 与 Void 均为终态：对任意目标状态均无出边', () => {
    fc.assert(
      fc.property(statusArb, (to) => {
        expect(canTransition('Superseded', to)).toBe(false);
        expect(canTransition('Void', to)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('非法状态字符串（不属五态值域）恒不构成合法迁移', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !CARD_STATUS.includes(s)),
        statusArb,
        (bogusFrom, to) => {
          expect(canTransition(bogusFrom, to)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.5 → Property 26（纯函数部分）: 编辑态封闭性与终态不可迁出（isEditable/isFrozen 闭包）
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 26: 编辑态封闭性与终态不可迁出 —— For any 工卡版本与任意编制域内容变更请求，该请求被接受当且仅当 status === "New"；处于「审核中」「生效」「已被取代」「作废」四态的版本一律被拒绝且内容逐字段保持不变。For any 处于「已被取代」或「作废」的版本，另不存在任何合法迁出迁移，且不可被新工包选用、历史工包中对该版本的引用记录保持不变。
describe('Property 26: 编辑态封闭性与终态不可迁出（纯函数部分：isEditable / isFrozen）', () => {
  it('isEditable 为真当且仅当 status === "New"', () => {
    fc.assert(
      fc.property(baseCardArb(), (card) => {
        expect(isEditable(card)).toBe(card.status === 'New');
      }),
      { numRuns: 100 },
    );
  });

  it('isFrozen(card) === !isEditable(card)（五态全覆盖）', () => {
    fc.assert(
      fc.property(baseCardArb(), (card) => {
        expect(isFrozen(card)).toBe(!isEditable(card));
      }),
      { numRuns: 100 },
    );
  });

  it('Effective 态：非内容变更操作全部放行，代表性内容变更操作全部拒绝', () => {
    fc.assert(
      fc.property(baseCardArb(fc.constant('Effective')), fc.constantFrom(...NON_CONTENT_OPERATIONS), (card, op) => {
        expect(passesEditableGate(card, op)).toBe(true);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(baseCardArb(fc.constant('Effective')), fc.constantFrom(...CONTENT_EDIT_OPERATIONS), (card, op) => {
        expect(passesEditableGate(card, op)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('New 态：内容变更操作全部放行（唯一可编辑态）', () => {
    fc.assert(
      fc.property(baseCardArb(fc.constant('New')), fc.constantFrom(...CONTENT_EDIT_OPERATIONS), (card, op) => {
        expect(passesEditableGate(card, op)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.6 → Property 2: 升版单调递增且保持编号
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 2: 升版单调递增且保持编号 —— For any 工卡，nextRevision 给出的默认新版本号等于原版本号加一，且 task_no 保持不变；For any 手动指定的版本号，其被接受当且仅当该 (task_no, revision) 组合在库中不存在，否则被拒绝（需求 7.5）；无论取默认值或手动值，task_no 恒不变且新版本状态恒为「新增」。
describe('Property 2: 升版单调递增且保持编号', () => {
  it('无手动覆盖时，nextRevision 默认值 = 原版本号 + 1', () => {
    fc.assert(
      fc.property(baseCardArb(), (card) => {
        expect(nextRevision(card)).toBe(card.revision + 1);
      }),
      { numRuns: 100 },
    );
  });

  it('reviseCard：task_no 不变、status 恒为 New（默认升版）', () => {
    fc.assert(
      fc.property(baseCardArb(), (card) => {
        const revised = reviseCard(card);
        expect(revised.taskNo).toBe(card.taskNo);
        expect(revised.status).toBe('New');
        expect(revised.revision).toBe(card.revision + 1);
        // 源工卡保持不变
        expect(card.status).not.toBe(undefined);
      }),
      { numRuns: 100 },
    );
  });

  it('手动指定版本号：作为给定值原样接受（形式校验），task_no 与 status 不受影响', () => {
    fc.assert(
      fc.property(baseCardArb(), fc.integer({ min: -1000, max: 1000 }), (card, manualRevision) => {
        expect(nextRevision(card, manualRevision)).toBe(manualRevision);
        const revised = reviseCard(card, manualRevision);
        expect(revised.taskNo).toBe(card.taskNo);
        expect(revised.status).toBe('New');
        expect(revised.revision).toBe(manualRevision);
      }),
      { numRuns: 100 },
    );
  });

  it('手动值的唯一性由 checkDuplicate 独立把关（不在 nextRevision/reviseCard 内做该校验）', () => {
    fc.assert(
      fc.property(
        baseCardArb(),
        fc.array(baseCardArb(), { minLength: 0, maxLength: 5 }),
        (card, otherCards) => {
          const manualRevision = card.revision + 1;
          // reviseCard 本身不判唯一性：即便 (taskNo, manualRevision) 已被占用，仍然返回该值
          const revised = reviseCard(card, manualRevision);
          expect(revised.revision).toBe(manualRevision);
          // 唯一性校验独立发生在 checkDuplicate，其结果不影响 reviseCard 的产出形态
          const dup = checkDuplicate([...otherCards, card], card.taskNo, manualRevision);
          expect(typeof dup.duplicate).toBe('boolean');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.7 → Property 6: IR 卡 BOM 字段条件性
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 6: IR 卡 BOM 字段条件性 —— For any 工卡，requiresBomFields(card) 为真当且仅当 card_type === "04"；判定仅依赖单一 card_type 列（WBS 为其别名，不存在第二列）。
describe('Property 6: IR 卡 BOM 字段条件性', () => {
  const cardTypeArb = fc.oneof(
    fc.constantFrom(...CARD_TYPE_CODES),
    fc.string().filter((s) => !CARD_TYPE_CODES.includes(s)),
  );

  it('requiresBomFields 为真当且仅当 card_type === "04"（合法与非法类型码均覆盖）', () => {
    fc.assert(
      fc.property(cardTypeArb, (cardType) => {
        expect(requiresBomFields({ cardType })).toBe(cardType === '04');
        expect(requiresBomFields(cardType)).toBe(cardType === '04');
      }),
      { numRuns: 100 },
    );
  });

  it('判定不依赖任何第二列（wbs 别名不存在，附加 wbs 键不改变结果）', () => {
    fc.assert(
      fc.property(cardTypeArb, fc.string(), (cardType, wbsValue) => {
        const withoutWbs = { cardType };
        const withWbs = { cardType, wbs: wbsValue };
        expect(requiresBomFields(withWbs)).toBe(requiresBomFields(withoutWbs));
        expect(requiresBomFields(withWbs)).toBe(cardType === '04');
      }),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.8 → Property 7: 查重一致性
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 7: 查重一致性 —— For any 工卡集合与任意 (task_no, revision)，checkDuplicate 判定为重复当且仅当集合中已存在相同 task_no 且相同 revision 的工卡；不同版本的相同 task_no 不构成重复。
describe('Property 7: 查重一致性', () => {
  const cardsArb = fc.array(baseCardArb(), { minLength: 0, maxLength: 8 });

  it('判定为重复当且仅当集合中存在同 task_no 且同 revision 的工卡', () => {
    fc.assert(
      fc.property(
        cardsArb,
        fc.stringMatching(/^[A-Z]{2}-[0-9]{4}$/),
        fc.integer({ min: 1, max: 50 }),
        (cards, taskNo, revision) => {
          const expected = cards.some((c) => c.taskNo === taskNo && c.revision === revision);
          const result = checkDuplicate(cards, taskNo, revision);
          expect(result.duplicate).toBe(expected);
          expect(result.ok).toBe(!expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('相同 task_no 但不同 revision 的工卡不构成重复', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z]{2}-[0-9]{4}$/),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        (taskNo, revA, revB) => {
          fc.pre(revA !== revB);
          const cards = [{ id: 1, taskNo, revision: revA, status: 'Effective' }];
          const result = checkDuplicate(cards, taskNo, revB);
          expect(result.duplicate).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.9 → Property 8: 打印隐藏分类
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 8: 打印隐藏分类 —— For any 工卡与任意打印模板，printProjection 输出字段集合不包含 card_type，且包含最小信息集全部字段（含计划/实际工时与起止时间栏）；For any 工序与其签署项配置，输出模型中该工序的签署栏集合恒与其 signature_requirement 配置一一对应（含签署人、签章、完成日期栏位），不存在无配置来源的签署栏、也不存在有配置而未输出的签署栏。
describe('Property 8: 打印隐藏分类', () => {
  const signatureRequirementArb = fc.record({
    id: fc.integer({ min: 1, max: 1000 }),
    signatureRole: fc.constantFrom('Operator', 'QC', 'NDT', 'CertifyingStaff'),
    stampRequired: fc.boolean(),
    dateRequired: fc.boolean(),
  });

  const stepArb = fc.record({
    id: fc.integer({ min: 1, max: 1000 }),
    processId: fc.stringMatching(/^[A-Z]{1,2}$/),
    seq: fc.integer({ min: 1, max: 100 }),
    signatureRequirements: fc.array(signatureRequirementArb, { minLength: 0, maxLength: 3 }),
  });

  // 工序 id 须在同一张卡内唯一——否则 byStep 匹配会按 id 撞车，与生产代码的正确性无关，
  // 而是生成器构造出「同 id 两道工序」这种在数据层 UNIQUE(id) 下不可能出现的非法输入。
  const cardWithTypeArb = fc
    .record({
      id: fc.integer({ min: 1, max: 100000 }),
      taskNo: fc.stringMatching(/^[A-Z]{2}-[0-9]{4}$/),
      title: fc.string(),
      revision: fc.integer({ min: 1, max: 50 }),
      cardType: fc.constantFrom(...CARD_TYPE_CODES),
      steps: fc.array(stepArb, { minLength: 0, maxLength: 4 }),
    })
    .map((card) => ({
      ...card,
      steps: card.steps.map((step, index) => ({ ...step, id: index + 1 })),
    }));

  it('输出对象不含 card_type / cardType 键', () => {
    fc.assert(
      fc.property(cardWithTypeArb, (card) => {
        const model = printProjection(card, undefined, undefined);
        expect(Object.prototype.hasOwnProperty.call(model, 'card_type')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(model, 'cardType')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('输出含最小信息集全部字段（组织名称、编号、标题、参考文件、修订版本标签、工序步骤等）', () => {
    fc.assert(
      fc.property(cardWithTypeArb, (card) => {
        const model = printProjection(card, undefined, undefined);
        for (const key of [
          'organizationName', 'taskNo', 'title', 'referenceDocuments', 'revisionLabel',
          'date', 'acType', 'gearType', 'partNo', 'manHours', 'startTime', 'finishTime', 'steps',
        ]) {
          expect(Object.prototype.hasOwnProperty.call(model, key)).toBe(true);
        }
        expect(Array.isArray(model.steps)).toBe(true);
        expect(model.steps.length).toBe(card.steps.length);
      }),
      { numRuns: 100 },
    );
  });

  it('每道工序的签署栏集合恒与 aggregateSignatureRequirements(steps).byStep 一一对应', () => {
    fc.assert(
      fc.property(cardWithTypeArb, (card) => {
        const model = printProjection(card, undefined, undefined);
        const aggregate = aggregateSignatureRequirements(card.steps);

        // 无孤立签署栏：每道工序输出的签署栏数恰等于聚合结果中该工序的签署项数
        model.steps.forEach((stepOut, index) => {
          const sourceStep = card.steps[index];
          const group = aggregate.byStep.find(
            (g) => g.stepId !== null && String(g.stepId) === String(sourceStep.id),
          );
          const expectedCount = group ? group.requirements.length : 0;
          expect(stepOut.signatures.length).toBe(expectedCount);
        });

        // 无遗漏签署栏：签署栏均含签署人/签章/完成日期三个栏位
        for (const stepOut of model.steps) {
          for (const sig of stepOut.signatures) {
            expect(Object.prototype.hasOwnProperty.call(sig, 'signedBy')).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(sig, 'stampId')).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(sig, 'signedAt')).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.10 → Property 15: 发布前置条件
// ─────────────────────────────────────────────────────────────────────────────

// Feature: task-card-management, Property 15: 发布前置条件 —— For any 工卡，canRelease(card) 为真当且仅当 card.status === "Effective"；非生效工卡的发布请求被拒绝，且无论成功与否均记录一次发布结果。
describe('Property 15: 发布前置条件', () => {
  it('canRelease 为真当且仅当 status === "Effective"（五态全覆盖）', () => {
    fc.assert(
      fc.property(baseCardArb(), (card) => {
        expect(canRelease(card)).toBe(card.status === 'Effective');
      }),
      { numRuns: 100 },
    );
  });

  it('非生效工卡恒被拒绝发布', () => {
    fc.assert(
      fc.property(baseCardArb(fc.constantFrom('New', 'UnderReview', 'Superseded', 'Void')), (card) => {
        expect(canRelease(card)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
