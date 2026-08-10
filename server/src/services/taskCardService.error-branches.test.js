import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import taskCardRepo from '../repositories/taskCardRepo.js';
import accessDenialLogRepo from '../repositories/accessDenialLogRepo.js';
import { updateCard } from './taskCardService.js';
import { store } from './attachmentService.js';
import { getCurrentCapability } from './capabilityService.js';
import { copy as copyExecDocument, list as listExecDocuments } from './execDocumentService.js';
import { createStageConstraint } from './configService.js';

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
  newCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0002', 1).id;
});

afterAll(() => closeDb());

describe('Task 13.12 authoring and validation error branches', () => {
  it.each([
    ['New', true],
    ['UnderReview', false],
    ['Effective', false],
    ['Superseded', false],
    ['Void', false],
  ])('%s status applies the content-edit gate', (status, allowed) => {
    taskCardRepo.update(newCardId, { status });

    if (allowed) {
      const updated = updateCard(newCardId, { title: 'Allowed New-state edit' }, { operatorId: 'E10001' }, 'test edit');
      expect(updated.title).toBe('Allowed New-state edit');
      return;
    }

    const error = captureServiceError(() =>
      updateCard(newCardId, { title: `Blocked ${status} edit` }, { operatorId: 'E10001' }, 'test edit'),
    );
    expect(error.code).toBe(CODE.UNPROCESSABLE);
    expect(error.data).toMatchObject({ status, operation: 'cardSave' });
    expect(taskCardRepo.findById(newCardId).title).not.toBe(`Blocked ${status} edit`);
  });


  it('rejects a blank change reason before persisting a New-state edit', () => {
    const before = taskCardRepo.findById(newCardId);
    const error = captureServiceError(() =>
      updateCard(newCardId, { title: 'Must not persist' }, { operatorId: 'E10001' }, '  '),
    );

    expect(error.code).toBe(CODE.VALIDATION);
    expect(error.data.rejection).toBe('REASON_REQUIRED');
    expect(taskCardRepo.findById(newCardId).title).toBe(before.title);
  });

  it('rejects unsupported attachment MIME before filesystem persistence', () => {
    const error = captureServiceError(() =>
      store(Buffer.from('small'), { originalName: 'payload.exe', mimeType: 'application/x-msdownload' }),
    );

    expect(error.code).toBe(CODE.VALIDATION);
    expect(error.data.mimeType).toBe('application/x-msdownload');
  });

  it('rejects an image larger than the 10 MiB category limit', () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    const error = captureServiceError(() =>
      store(oversized, { originalName: 'large.png', mimeType: 'image/png' }),
    );

    expect(error.code).toBe(CODE.VALIDATION);
    expect(error.data).toMatchObject({
      mimeType: 'image/png',
      byteSize: oversized.length,
      maxBytes: 10 * 1024 * 1024,
    });
  });

  it('rejects a capability scope with no revision effective on the requested date', () => {
    const error = captureServiceError(() =>
      getCurrentCapability('350', 'WLG', 'AS', { onDate: '2026-01-01' }),
    );

    expect(error.code).toBe(CODE.UNPROCESSABLE);
    expect(error.data).toMatchObject({
      rejection: 'NO_EFFECTIVE_REVISION',
      acType: '350',
      gearType: 'WLG',
      skill: 'AS',
      onDate: '2026-01-01',
    });
  });

  it('returns ServiceError 409 when an SWS copy reuses an existing number', () => {
    const source = listExecDocuments({ execDocType: 'SW', page: 1, pageSize: 10 }).list[0];
    const error = captureServiceError(() =>
      copyExecDocument({ id: source.id, newDocNo: source.docNo }, { operatorId: 'E10001' }),
    );

    expect(error.code).toBe(CODE.CONFLICT);
    expect(error.data.rejection).toBe('DUPLICATE_DOC_NO');
  });


  it('returns 403 and audits a config_write denial', () => {
    const actor = {
      staffNo: 'E10001',
      role: 'TS_Engineer',
      method: 'POST',
      path: '/api/config/stage-constraints',
      now: '2026-02-01T00:00:00.000Z',
    };
    const error = captureServiceError(() =>
      createStageConstraint(actor, { cardType: '01', allowedStage: 'RTN' }),
    );

    expect(error.code).toBe(CODE.FORBIDDEN);
    expect(error.data.rejection).toBe('forbiddenConfigWrite');
    expect(accessDenialLogRepo.listByUserId('E10001')).toEqual([
      expect.objectContaining({
        staffNo: 'E10001',
        role: 'TS_Engineer',
        permissionPoint: 'config_write',
        method: 'POST',
        path: '/api/config/stage-constraints',
        deniedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);
  });
});