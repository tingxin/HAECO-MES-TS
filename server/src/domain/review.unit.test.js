import { describe, it, expect } from 'vitest';
import {
  submitReviewChecklist,
  canApprove,
  acceptReviewAction,
  REVIEW_ACTIONS,
  REVIEW_ACTION_REJECTION,
} from './review.js';

/** 一张各校验项均能通过的“黄金”工卡 + ctx，供各测试增量破坏。 */
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
    steps: [
      {
        id: 10,
        process_id: 'A',
        signatureRequirements: [{ id: 100, signature_role: 'Operator' }],
      },
    ],
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

describe('submitReviewChecklist —— 提交审核校验清单 (a)-(g)（需求 34.1、34.2）', () => {
  it('黄金路径：全部 7 项通过', () => {
    const result = submitReviewChecklist(goldenCard(), goldenCtx());
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
  });

  it('(a) 查重：同版本号 Task No 已存在则未通过', () => {
    const card = goldenCard();
    const ctx = goldenCtx();
    ctx.cards = [{ id: 2, task_no: 'TN-0001', revision: 1 }];
    const result = submitReviewChecklist(card, ctx);
    expect(result.ok).toBe(false);
    expect(result.failedChecks.some((item) => item.check === 'a')).toBe(true);
  });

  it('(a) ctx.cards 未提供时 fail closed（视为未通过，而非静默跳过）', () => {
    const ctx = goldenCtx();
    delete ctx.cards;
    const result = submitReviewChecklist(goldenCard(), ctx);
    expect(result.ok).toBe(false);
    const item = result.failedChecks.find((entry) => entry.check === 'a');
    expect(item?.rejection).toBe('CTX_MISSING_CARDS');
  });

  it('(b) 枚举：非法 stage 取值未通过', () => {
    const card = { ...goldenCard(), stage: 'ZZZ' };
    const result = submitReviewChecklist(card, goldenCtx());
    expect(result.ok).toBe(false);
    expect(result.failedChecks.some((item) => item.check === 'b')).toBe(true);
  });

  it('(c) 必填：缺少参考文件与工序时未通过并列明缺失项', () => {
    const ctx = goldenCtx();
    ctx.referenceDocuments = [];
    ctx.steps = [];
    const result = submitReviewChecklist(goldenCard(), ctx);
    expect(result.ok).toBe(false);
    const item = result.failedChecks.find((entry) => entry.check === 'c');
    expect(item.detail).toEqual(
      expect.arrayContaining(['参考文件（至少 1 条）', '工序（至少 1 道）', '签署项（至少 1 项）']),
    );
  });

  it('(c) 必填：组织名称为空白时未通过', () => {
    const ctx = goldenCtx();
    ctx.orgName = '   ';
    const result = submitReviewChecklist(goldenCard(), ctx);
    expect(result.ok).toBe(false);
    const item = result.failedChecks.find((entry) => entry.check === 'c');
    expect(item.detail).toContain('组织名称');
  });

  it('(d) 能力清单：清单为空时未通过（NO_EFFECTIVE_REVISION）', () => {
    const ctx = goldenCtx();
    ctx.capabilityList = [];
    const result = submitReviewChecklist(goldenCard(), ctx);
    expect(result.ok).toBe(false);
    const item = result.failedChecks.find((entry) => entry.check === 'd');
    expect(item.rejection).toBe('NO_EFFECTIVE_REVISION');
  });

  it('(e) 变更原因：为空或纯空白时未通过', () => {
    const ctx = goldenCtx();
    ctx.changeReason = '   ';
    const result = submitReviewChecklist(goldenCard(), ctx);
    expect(result.ok).toBe(false);
    expect(result.failedChecks.some((item) => item.check === 'e' && item.rejection === 'REASON_REQUIRED')).toBe(true);
  });

  it('(f) 签署项配置：要求签署的关联单据存在但工卡零签署项配置时未通过', () => {
    const ctx = goldenCtx();
    ctx.relations = [{ card_id: 1, exec_doc_type: 'CR', related_doc_no: 'CR-1' }];
    ctx.steps = [{ id: 10, process_id: 'A' }]; // 有工序但无签署项配置
    const result = submitReviewChecklist(goldenCard(), ctx);
    expect(result.ok).toBe(false);
    const item = result.failedChecks.find((entry) => entry.check === 'f');
    expect(item.rejection).toBe('MISSING_SIGNATURE_CONFIG');
  });

  it('(f) 签署项配置：关联单据签署要求为 SC（子串含"签署"但非精确匹配）不误判为要求签署', () => {
    const ctx = goldenCtx();
    ctx.relations = [{ card_id: 1, exec_doc_type: 'SC', related_doc_no: 'SC-1' }];
    // 保留 goldenCtx 的签署项配置（(c) 必填项恒要求签署项≥1），仅验证 (f) 不因 SC 而误判未通过
    const result = submitReviewChecklist(goldenCard(), ctx);
    expect(result.ok).toBe(true);
  });

  it('(g) Stage×工卡类型组合：不允许的组合未通过', () => {
    const card = { ...goldenCard(), stage: 'CUS' }; // 类型 01 只允许 RTN
    const result = submitReviewChecklist(card, goldenCtx());
    expect(result.ok).toBe(false);
    expect(result.failedChecks.some((item) => item.check === 'g')).toBe(true);
  });

  it('多项同时未通过时全部列出（而非仅报首个）', () => {
    const card = { ...goldenCard(), stage: 'ZZZ' };
    const ctx = goldenCtx();
    ctx.changeReason = '';
    const result = submitReviewChecklist(card, ctx);
    expect(result.ok).toBe(false);
    const checks = result.failedChecks.map((item) => item.check);
    expect(checks).toContain('b');
    expect(checks).toContain('e');
  });
});

describe('canApprove —— 一编一审（需求 22.3）', () => {
  it('审核人与编制人不同时为真', () => {
    expect(canApprove({ created_by: 'E001' }, 'M002')).toBe(true);
  });

  it('审核人与编制人相同时为假', () => {
    expect(canApprove({ created_by: 'E001' }, 'E001')).toBe(false);
  });

  it('审核人身份为空白时为假（无法确认不是编制人）', () => {
    expect(canApprove({ created_by: 'E001' }, '   ')).toBe(false);
    expect(canApprove({ created_by: 'E001' }, null)).toBe(false);
  });

  it('不校验审卡权限本身，只判编审是否同一人', () => {
    // 无权限概念参与，仅工号比较
    expect(canApprove({ created_by: null }, 'M002')).toBe(true);
  });
});

describe('acceptReviewAction —— 审核动作接受条件（需求 34.4-34.7、34.10、34.11）', () => {
  it('态为审核中且意见非空时接受', () => {
    const result = acceptReviewAction({ status: 'UnderReview' }, 'approve', '符合要求');
    expect(result.ok).toBe(true);
    expect(result.action).toBe('approve');
  });

  it('非审核中态时拒绝', () => {
    const result = acceptReviewAction({ status: 'New' }, 'approve', '符合要求');
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(REVIEW_ACTION_REJECTION.NOT_UNDER_REVIEW);
  });

  it('审核意见为空或纯空白时拒绝', () => {
    const result = acceptReviewAction({ status: 'UnderReview' }, 'reject', '   ');
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(REVIEW_ACTION_REJECTION.COMMENT_REQUIRED);
  });

  it('非法审核动作时拒绝', () => {
    const result = acceptReviewAction({ status: 'UnderReview' }, 'delete', '理由');
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(REVIEW_ACTION_REJECTION.INVALID_ACTION);
  });

  it('REVIEW_ACTIONS 恰为 approve/reject 两值', () => {
    expect(REVIEW_ACTIONS).toEqual(['approve', 'reject']);
  });
});
