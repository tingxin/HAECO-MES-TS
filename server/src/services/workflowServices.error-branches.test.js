import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import taskCardRepo from '../repositories/taskCardRepo.js';
import jobRepo from '../repositories/jobRepo.js';
import workPackageReleaseRepo from '../repositories/workPackageReleaseRepo.js';
import { getCard } from './taskCardService.js';
import { getPrintModel } from './printService.js';
import { exportCsv } from './exportService.js';
import { copyCard, reviseCard } from './versionService.js';
import { release } from './releaseService.js';
import { voidCard } from './voidService.js';
import { approve, submitForReview } from './reviewService.js';

let effectiveCardId;
let newCardId;

function captureServiceError(action) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    return error;
  }
  throw new Error('Expected action to throw ServiceError');
}

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();
  effectiveCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0001', 1).id;
  newCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0002', 1).id;
});

afterAll(() => closeDb());

const effectiveOperations = [
  ['view', () => getCard(effectiveCardId), (result) => expect(result.status).toBe('Effective')],
  ['print', () => getPrintModel(effectiveCardId), (result) => expect(result.model).toBeDefined()],
  ['export', () => exportCsv([effectiveCardId], 'key'), (result) => expect(result).toContain('TC-2026-0001')],
  ['copy', () => copyCard(effectiveCardId, 'TC-13-12-COPY', { operatorId: 'E10002' }), (result) => expect(result.status).toBe('New')],
  ['revise', () => reviseCard(effectiveCardId, 'Task 13.12 revision', { operatorId: 'E10002' }), (result) => expect(result.revision).toBe(2)],
  ['void', () => voidCard(effectiveCardId, 'Task 13.12 void', { operatorId: 'E10002' }), (result) => expect(result.status).toBe('Void')],
  ['release', () => release(effectiveCardId, { operatorId: 'E10002', pidNo: 'PID-2026-0001' }), (result) => expect(result.job.cardId).toBe(effectiveCardId)],
];


describe('Task 13.12 workflow gates and Effective-state operations', () => {
  it.each(effectiveOperations)('allows %s on an Effective card (Requirement 49.8)', (_name, action, assertResult) => {
    const result = action();
    assertResult(result);
  });

  it('blocks duplicate Task No + revision during submit-for-review', () => {
    taskCardRepo.update(effectiveCardId, { status: 'New' });
    const db = getDb();
    const originalPrepare = db.prepare.bind(db);

    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (!/SELECT \* FROM task_card WHERE task_no = \? ORDER BY revision ASC/.test(String(sql))) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'all' || typeof value !== 'function') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (...args) => {
            const rows = value.apply(target, args);
            return rows.length === 0 ? rows : [...rows, { ...rows[0], id: 999999 }];
          };
        },
      });
    };

    try {
      const error = captureServiceError(() =>
        submitForReview(effectiveCardId, { operatorId: 'E10001', changeReason: 'submit test' }),
      );
      expect(error.code).toBe(CODE.VALIDATION);
      expect(error.data.rejection).toBe('CHECKLIST_FAILED');
      expect(error.data.failedChecks).toEqual(expect.arrayContaining([
        expect.objectContaining({ check: 'a', rejection: 'DUPLICATE_TASK_NO' }),
      ]));
      expect(taskCardRepo.findById(effectiveCardId).status).toBe('New');
    } finally {
      db.prepare = originalPrepare;
    }
  });

  it('rejects an empty review comment', () => {
    taskCardRepo.update(effectiveCardId, { status: 'UnderReview' });
    const error = captureServiceError(() => approve(effectiveCardId, { operatorId: 'E20001' }, '  '));

    expect(error.code).toBe(CODE.VALIDATION);
    expect(error.data.rejection).toBe('COMMENT_REQUIRED');
  });

  it('rejects the card author acting as reviewer', () => {
    taskCardRepo.update(effectiveCardId, { status: 'UnderReview' });
    const error = captureServiceError(() =>
      approve(effectiveCardId, { operatorId: 'E10001' }, 'self-review must fail'),
    );

    expect(error.code).toBe(CODE.UNPROCESSABLE);
    expect(error.data.rejection).toBe('SAME_REVIEWER_AS_CREATOR');
  });


  it('blocks release for a non-Effective card and records the failed attempt', () => {
    const error = captureServiceError(() =>
      release(newCardId, { operatorId: 'E10001', packageRef: 'WP-13-12' }),
    );

    expect(error.code).toBe(CODE.UNPROCESSABLE);
    expect(error.data.status).toBe('New');
    expect(workPackageReleaseRepo.listByCardId(newCardId)).toEqual([
      expect.objectContaining({ cardId: newCardId, jobNo: null, result: 'failed' }),
    ]);
  });

  it('rejects an illegal UnderReview to Void transition', () => {
    taskCardRepo.update(newCardId, { status: 'UnderReview' });
    const error = captureServiceError(() =>
      voidCard(newCardId, 'illegal transition test', { operatorId: 'E10001' }),
    );

    expect(error.code).toBe(CODE.UNPROCESSABLE);
    expect(error.data).toMatchObject({ rejection: 'INVALID_TRANSITION', status: 'UnderReview' });
  });

  it.each([
    ['Pending enum value', 'Pending'],
    ['null status (project not-started semantic)', null],
  ])('blocks void for a %s JOB as JOB_NOT_STARTED', (_label, execStatus) => {
    jobRepo.create({
      jobNo: execStatus === null ? 'JOB-NULL-NOT-STARTED' : 'JOB-PENDING',
      cardId: effectiveCardId,
      cardRevision: 1,
      releasedAt: '2026-02-01T00:00:00.000Z',
      releasedBy: 'E10001',
      execStatus,
    });

    const error = captureServiceError(() =>
      voidCard(effectiveCardId, 'blocked by unstarted JOB', { operatorId: 'E10002' }),
    );
    expect(error.code).toBe(CODE.UNPROCESSABLE);
    expect(error.data.rejection).toBe('BLOCKING_REFERENCES');
    expect(error.data.blockingTypes).toContain('JOB_NOT_STARTED');
    expect(error.data.blockingRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'JOB_NOT_STARTED', execStatus }),
    ]));
  });

  it('rejects a blank change reason when revising an Effective card', () => {
    const error = captureServiceError(() =>
      reviseCard(effectiveCardId, '　 ', { operatorId: 'E10002' }),
    );

    expect(error.code).toBe(CODE.VALIDATION);
    expect(error.data.rejection).toBe('REASON_REQUIRED');
  });
});