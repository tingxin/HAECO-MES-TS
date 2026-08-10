import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import * as taskCardRepo from '../repositories/taskCardRepo.js';
import * as classificationResultRepo from '../repositories/classificationResultRepo.js';
import { submitForReview } from './reviewService.js';

beforeEach(() => { resetDb(':memory:'); migrate(); seed(); });
afterAll(() => closeDb());

function rejectionOf(cardId) {
  try { submitForReview(cardId, { operatorId: 'E10001', changeReason: 'gate' }); }
  catch (error) { return error; }
  return null;
}

function appendResult(cardId, overrides = {}) {
  return classificationResultRepo.create({
    cardId,
    status: 'requires_confirmation',
    classification: null,
    candidatesJson: [{ classification: 'LLP' }, { classification: 'Routine' }],
    recommendedClassification: 'LLP',
    evaluatedTiersJson: [],
    isManualConfirmed: false,
    ...overrides,
  });
}

function cardUnderTest() {
  return taskCardRepo.findByTaskNoAndRevision('TC-2026-0002', 1);
}

function expectClassificationGate(error) {
  expect(error?.data?.failedChecks.find((item) => item.check === 'h')).toMatchObject({
    rejection: 'COMMERCIAL_CLASSIFICATION_CONFIRMATION_REQUIRED',
  });
}

describe('reviewService 商务分类持久状态门禁', () => {
  it('缺少持久化分类结果时 fail closed 并保持 New', () => {
    const card = cardUnderTest();
    const error = rejectionOf(card.id);
    expect(error?.data?.failedChecks.find((item) => item.check === 'h')).toMatchObject({
      rejection: 'CLASSIFICATION_RESULT_MISSING',
    });
    expect(taskCardRepo.findById(card.id).status).toBe('New');
  });

  it.each(['requires_confirmation', 'undetermined'])(
    '从最新持久化状态阻止 %s 提交审核',
    (status) => {
      const card = cardUnderTest();
      appendResult(card.id, { status });
      expectClassificationGate(rejectionOf(card.id));
      expect(getDb().prepare('SELECT status FROM task_card WHERE id = ?').get(card.id).status).toBe('New');
    },
  );

  it('唯一 derived 结果通过 (h) 门禁', () => {
    const card = cardUnderTest();
    appendResult(card.id, {
      status: 'derived', classification: 'Routine',
      candidatesJson: [{ classification: 'Routine' }], recommendedClassification: 'Routine',
    });
    const error = rejectionOf(card.id);
    expect(error?.data?.failedChecks?.some((item) => item.check === 'h') ?? false).toBe(false);
  });

  it('人工 confirmed 结果通过 (h) 门禁', () => {
    const card = cardUnderTest();
    appendResult(card.id, {
      status: 'confirmed', classification: 'LLP', isManualConfirmed: true,
    });
    const error = rejectionOf(card.id);
    expect(error?.data?.failedChecks?.some((item) => item.check === 'h') ?? false).toBe(false);
  });
});