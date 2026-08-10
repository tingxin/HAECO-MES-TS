import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import taskCardRepo from '../repositories/taskCardRepo.js';
import processStepRepo from '../repositories/processStepRepo.js';
import tpcRepo from '../repositories/tpcRepo.js';
import ppcRepo from '../repositories/ppcRepo.js';
import lotListBaseRepo from '../repositories/lotListBaseRepo.js';
import jobStepSnapshotRepo from '../repositories/jobStepSnapshotRepo.js';
import { parseSnapshotContent } from '../domain/snapshot.js';
import { getCard, updateProcessStep } from './taskCardService.js';
import { release } from './releaseService.js';
import { refreshBomBase } from './bomService.js';

let effectiveCardId;
let newCardId;
let irLotCardId;

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();
  effectiveCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0001', 1).id;
  newCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0002', 1).id;
  irLotCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0003', 1).id;
});

afterAll(() => closeDb());

describe('Task 13.12 integration carry-through examples', () => {
  it('looks up and backfills all four TPC document fields', () => {
    const tpc = tpcRepo.findByRefNo('32-11-51')[0];
    const fourFields = {
      documentType: tpc.docType,
      refNo: tpc.refNo,
      documentRevision: tpc.docRevision,
      documentDesc: tpc.docDesc,
    };

    taskCardRepo.update(newCardId, fourFields);
    expect(getCard(newCardId)).toMatchObject({
      documentType: 'CMM',
      refNo: '32-11-51',
      documentRevision: 'Rev 12',
      documentDesc: 'Main Landing Gear CMM',
    });
  });

  it('carries PPC work category/hours while TS edits cannot overwrite the read-only values', () => {
    const step = processStepRepo.findByCardAndProcessId(newCardId, 'A');
    const ppc = ppcRepo.findByCardAndStep(newCardId, 'A');
    processStepRepo.update(step.id, {
      workCategory: ppc.workCategory,
      estimatedManHours: ppc.estimatedManHours,
    });

    const updated = updateProcessStep(
      step.id,
      {
        descriptionEn: 'Editable authoring text',
        workCategory: 'MANUAL OVERRIDE',
        estimatedManHours: 999,
      },
      { operatorId: 'E10001' },
      'verify PPC fields are read-only',
    );

    expect(updated).toMatchObject({
      descriptionEn: 'Editable authoring text',
      workCategory: 'Inspection',
      estimatedManHours: 1.5,
    });
  });


  it('releases PPC target date, Process Card fields, and per-step operations into execution storage', () => {
    for (const step of processStepRepo.listByCardId(effectiveCardId)) {
      processStepRepo.update(step.id, { operation: `STALE-${step.processId}` });
    }

    const result = release(effectiveCardId, {
      operatorId: 'E10002',
      pidNo: 'PID-2026-0001',
      packageRef: 'WP-INTEGRATION-001',
    });

    expect(result.integrationDataMissing).toBe(false);
    expect(result.job).toMatchObject({
      jobTargetDate: '2026-09-30',
      partNo: 'P/N-32-11-51-001',
      partSn: 'SN-0001',
      partDesc: 'MLG SHOCK STRUT',
      operationType: 'OVERHAUL',
    });

    const operations = Object.fromEntries(
      jobStepSnapshotRepo.listByJobId(result.job.id).map((snapshot) => {
        const content = parseSnapshotContent(snapshot.content);
        return [content.processId, content.operation];
      }),
    );
    expect(operations).toEqual({
      A: 'RECEIVING INSPECTION',
      B: 'DIMENSION CHECK',
    });
  });

  it('keeps unavailable integration values null without blocking release', () => {
    const cardId = Number(taskCardRepo.create({
      taskNo: 'TC-13-12-NO-INTEGRATION',
      revision: 1,
      title: 'Missing integration contract example',
      cardType: '01',
      status: 'Effective',
      createdBy: 'E10001',
    }));
    processStepRepo.create({
      cardId,
      processId: 'A',
      seq: 1,
      skill: 'GR',
      operation: null,
      descriptionEn: 'Release must continue',
    });

    const result = release(cardId, { operatorId: 'E10002', pidNo: 'PID-NOT-FOUND' });

    expect(result.integrationDataMissing).toBe(true);
    expect(result.message).toContain('集成数据缺失');
    expect(result.job).toMatchObject({
      jobTargetDate: null,
      partNo: null,
      partSn: null,
      partDesc: null,
      operationType: null,
    });
    const [snapshot] = jobStepSnapshotRepo.listByJobId(result.job.id);
    expect(parseSnapshotContent(snapshot.content).operation).toBeNull();
  });


  it('reads the complete Lot List Base collection and carries it through BOM refresh', () => {
    const bases = lotListBaseRepo.listBasesByLotListRef('LT-2026-001');
    expect(bases).toEqual([
      { baseNumber: 'BASE-320-MLG-101', lotNumber: 'LOT-2026-0001' },
      { baseNumber: 'BASE-320-MLG-102', lotNumber: 'LOT-2026-0001' },
      { baseNumber: 'BASE-320-MLG-103', lotNumber: 'LOT-2026-0001' },
    ]);

    expect(refreshBomBase(irLotCardId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseNumber: 'BASE-320-MLG-101', source: 'lot_list' }),
      expect.objectContaining({ baseNumber: 'BASE-320-MLG-102', source: 'lot_list' }),
      expect.objectContaining({ baseNumber: 'BASE-320-MLG-103', source: 'lot_list' }),
    ]));
  });
});