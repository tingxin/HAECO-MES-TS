import { describe, it, expect } from 'vitest';
import { CARD_STATUS } from './enums.js';
import {
  canTransition,
  isEditable,
  canRelease,
  isContentEditOperation,
  passesEditableGate,
  NON_CONTENT_OPERATIONS,
} from './card-rules.js';
import { isFrozen, isFrozenFor } from './supersede.js';

const card = (status) => ({ id: 1, taskNo: 'TC-0001', revision: 1, status });

describe('canTransition（需求 4.5–4.7）', () => {
  it('放行六条允许迁移', () => {
    expect(canTransition('New', 'UnderReview')).toBe(true);
    expect(canTransition('New', 'Void')).toBe(true);
    expect(canTransition('UnderReview', 'Effective')).toBe(true);
    expect(canTransition('UnderReview', 'New')).toBe(true);
    expect(canTransition('Effective', 'Superseded')).toBe(true);
    expect(canTransition('Effective', 'Void')).toBe(true);
  });

  it('终态 Superseded / Void 无出边', () => {
    for (const to of CARD_STATUS) {
      expect(canTransition('Superseded', to)).toBe(false);
      expect(canTransition('Void', to)).toBe(false);
    }
  });

  it('拒绝跨态跳跃、自迁移与未知状态', () => {
    expect(canTransition('New', 'Effective')).toBe(false);
    expect(canTransition('New', 'Superseded')).toBe(false);
    expect(canTransition('UnderReview', 'Void')).toBe(false);
    expect(canTransition('New', 'New')).toBe(false);
    expect(canTransition('Draft', 'New')).toBe(false);
    expect(canTransition('New', 'draft')).toBe(false);
    expect(canTransition(undefined, 'New')).toBe(false);
  });
});

describe('isEditable / isFrozen（需求 49.1、49.2、34.3、44.4、44.5）', () => {
  it('仅新增态可编辑，其余四态冻结', () => {
    expect(isEditable(card('New'))).toBe(true);
    for (const status of ['UnderReview', 'Effective', 'Superseded', 'Void']) {
      expect(isEditable(card(status))).toBe(false);
      expect(isFrozen(card(status))).toBe(true);
    }
    expect(isFrozen(card('New'))).toBe(false);
  });

  it('缺失或非法状态不可编辑', () => {
    expect(isEditable({})).toBe(false);
    expect(isEditable(card('new'))).toBe(false);
    expect(isEditable(null)).toBe(false);
    expect(isFrozen(null)).toBe(true);
  });

  it('接受状态字符串作为入参', () => {
    expect(isEditable('New')).toBe(true);
    expect(isEditable('Effective')).toBe(false);
  });
});

describe('canRelease（需求 24.1、24.2）', () => {
  it('仅生效态可发布', () => {
    expect(canRelease(card('Effective'))).toBe(true);
    for (const status of ['New', 'UnderReview', 'Superseded', 'Void']) {
      expect(canRelease(card(status))).toBe(false);
    }
    expect(canRelease(null)).toBe(false);
  });
});

describe('编辑态闸门不误拦非内容变更操作（需求 49.4、49.8）', () => {
  it('生效态在查看/打印/导出/复制/升版/作废/发布上放行', () => {
    const effective = card('Effective');
    expect(NON_CONTENT_OPERATIONS).toEqual([
      'view', 'print', 'export', 'copy', 'revise', 'void', 'release',
    ]);
    for (const op of NON_CONTENT_OPERATIONS) {
      expect(isContentEditOperation(op)).toBe(false);
      expect(passesEditableGate(effective, op)).toBe(true);
      expect(isFrozenFor(effective, op)).toBe(false);
    }
  });

  it('生效态在内容变更操作上一律被拦', () => {
    const effective = card('Effective');
    for (const op of ['cardSave', 'stepUpdate', 'referenceDocDelete', 'batchReplace']) {
      expect(passesEditableGate(effective, op)).toBe(false);
      expect(isFrozenFor(effective, op)).toBe(true);
    }
    expect(passesEditableGate(card('New'), 'cardSave')).toBe(true);
  });

  it('未登记操作从严处理，按内容变更走闸门', () => {
    expect(isContentEditOperation('someNewEditEntry')).toBe(true);
    expect(passesEditableGate(card('Effective'), 'someNewEditEntry')).toBe(false);
    expect(passesEditableGate(card('New'), 'someNewEditEntry')).toBe(true);
  });
});
