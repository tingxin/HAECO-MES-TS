import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { CODE } from '../lib/response.js';
import processStepRepo from '../repositories/processStepRepo.js';
import captureItemRepo from '../repositories/captureItemRepo.js';
import componentRepo from '../repositories/componentRepo.js';
import signatureRequirementRepo from '../repositories/signatureRequirementRepo.js';
import { getJobStepContent } from './executionService.js';
import { getPrintModel } from './printService.js';
import { release } from './releaseService.js';
import { approve, submitForReview } from './reviewService.js';
import {
  addCaptureItem,
  addComponent,
  addProcessStep,
  addReferenceDocument,
  addSignatureRequirement,
  createCard,
  removeProcessStep,
  updateCaptureItem,
  updateComponent,
  updateProcessStep,
  updateSignatureRequirement,
} from './taskCardService.js';
import { reviseCard } from './versionService.js';

const AUTHOR = Object.freeze({ operatorId: 'E10001' });
const REVIEWER = Object.freeze({ operatorId: 'E20001' });

const tokenArb = fc
  .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
    minLength: 1,
    maxLength: 10,
  })
  .map((characters) => characters.join(''));

const mutationArb = fc.record({
  taskToken: tokenArb,
  mutationToken: tokenArb,
  deleteFirstStep: fc.boolean(),
  captureType: fc.constantFrom('measurement', 'text', 'range', 'dataGroup'),
  captureRequired: fc.boolean(),
  componentType: fc.constantFrom('tool', 'consumable', 'image'),
  signatureRole: fc.constantFrom('Operator', 'QC', 'NDT', 'CertifyingStaff'),
  stampRequired: fc.boolean(),
  dateRequired: fc.boolean(),
  numericValue: fc.integer({ min: -1000, max: 1000 }),
});

function rebuildSeededDatabase() {
  resetDb(':memory:');
  migrate();
  seed();
  return getDb();
}

function clone(value) {
  return structuredClone(value);
}

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

function selectSnapshotRows(db, jobId) {
  return db
    .prepare(
      `SELECT jss.*
         FROM job_step_snapshot jss
         JOIN job_process jp ON jp.id = jss.job_process_id
        WHERE jp.job_id = ?
        ORDER BY jp.process_id, jss.id`,
    )
    .all(jobId);
}

function observeReadSql(db) {
  const originalPrepare = db.prepare.bind(db);
  const sql = [];
  db.prepare = (statement) => {
    sql.push(String(statement));
    return originalPrepare(statement);
  };
  return sql;
}

function buildEffectiveSource(taskToken) {
  const source = createCard(
    {
      taskNo: `P34-${taskToken}`,
      title: `Property 34 source ${taskToken}`,
      acType: '320',
      gearType: 'MLG',
      stage: 'RTN',
      skill: 'GR',
      ctrlCode: 'IS',
      cardType: '01',
    },
    AUTHOR,
  );

  addReferenceDocument(
    source.id,
    { docType: 'CMM', refNo: `P34-REF-${taskToken}`, docRevision: '1', ataChapter: '32' },
    AUTHOR,
  );

  const stepA = addProcessStep(
    source.id,
    {
      seq: 1,
      skill: 'GR',
      descriptionZh: `原始工序 A ${taskToken}`,
      descriptionEn: `Original step A ${taskToken}`,
      safetyWarning: `Warning A ${taskToken}`,
      repairTips: `Tip A ${taskToken}`,
      isCritical: true,
    },
    AUTHOR,
  );
  const stepB = addProcessStep(
    source.id,
    {
      seq: 2,
      skill: 'QC',
      descriptionZh: `原始工序 B ${taskToken}`,
      descriptionEn: `Original step B ${taskToken}`,
      isCritical: false,
    },
    AUTHOR,
  );

  for (const [index, step] of [stepA, stepB].entries()) {
    addCaptureItem(
      step.id,
      {
        type: 'measurement',
        itemKey: `original-${index + 1}`,
        label: `Original capture ${index + 1}`,
        config: { unit: 'mm', minimum: index },
        required: true,
        sortOrder: 1,
      },
      AUTHOR,
    );
    addComponent(
      step.id,
      {
        type: 'tool',
        payload: { code: `TOOL-${index + 1}`, description: `Original tool ${index + 1}` },
        sortOrder: 1,
      },
      AUTHOR,
    );
    addSignatureRequirement(
      step.id,
      {
        signatureRole: index === 0 ? 'Operator' : 'QC',
        stampRequired: index === 1,
        dateRequired: true,
        sortOrder: 1,
      },
      AUTHOR,
    );
  }

  const underReview = submitForReview(source.id, {
    ...AUTHOR,
    changeReason: `Property 34 initial approval ${taskToken}`,
  });
  expect(underReview.status).toBe('UnderReview');
  const effective = approve(source.id, REVIEWER, `Property 34 approved ${taskToken}`);
  expect(effective.status).toBe('Effective');
  return { effective, sourceSteps: [stepA, stepB] };
}

function mutateRevision(revised, input) {
  const clonedSteps = processStepRepo.listByCardId(revised.id);
  expect(clonedSteps).toHaveLength(2);

  const deleteIndex = input.deleteFirstStep ? 0 : 1;
  const retainIndex = deleteIndex === 0 ? 1 : 0;
  const deletedStep = clonedSteps[deleteIndex];
  const retainedStep = clonedSteps[retainIndex];
  const reason = `Property 34 mutation ${input.mutationToken}`;

  updateProcessStep(
    retainedStep.id,
    {
      descriptionZh: `已升版修改 ${input.mutationToken}`,
      descriptionEn: `Revised content ${input.mutationToken}`,
      safetyWarning: `Revised warning ${input.numericValue}`,
      repairTips: `Revised tip ${input.mutationToken}`,
      isCritical: !Boolean(retainedStep.isCritical),
    },
    AUTHOR,
    reason,
  );

  const [capture] = captureItemRepo.listByStepId(retainedStep.id);
  const [component] = componentRepo.listByStepId(retainedStep.id);
  const [signature] = signatureRequirementRepo.listByStepId(retainedStep.id);
  expect(capture).toBeDefined();
  expect(component).toBeDefined();
  expect(signature).toBeDefined();

  updateCaptureItem(
    capture.id,
    {
      type: input.captureType,
      itemKey: `revised-${input.mutationToken}`,
      label: `Revised capture ${input.mutationToken}`,
      config: { generated: input.numericValue, token: input.mutationToken },
      required: input.captureRequired,
      sortOrder: 17,
    },
    AUTHOR,
    reason,
  );
  updateComponent(
    component.id,
    {
      type: input.componentType,
      payload: { generated: input.numericValue, token: input.mutationToken },
      sortOrder: 19,
    },
    AUTHOR,
    reason,
  );
  updateSignatureRequirement(
    signature.id,
    {
      signatureRole: input.signatureRole,
      stampRequired: input.stampRequired,
      dateRequired: input.dateRequired,
      sortOrder: 23,
    },
    AUTHOR,
    reason,
  );

  const addedStep = addProcessStep(
    revised.id,
    {
      seq: 3,
      skill: 'TS',
      descriptionZh: `新增工序 ${input.mutationToken}`,
      descriptionEn: `Added step ${input.mutationToken}`,
      isCritical: input.stampRequired,
    },
    AUTHOR,
  );
  addCaptureItem(
    addedStep.id,
    {
      type: input.captureType,
      itemKey: `added-${input.mutationToken}`,
      label: `Added capture ${input.mutationToken}`,
      config: { value: input.numericValue },
      required: input.captureRequired,
      sortOrder: 1,
    },
    AUTHOR,
  );
  addComponent(
    addedStep.id,
    {
      type: input.componentType,
      payload: { added: input.mutationToken },
      sortOrder: 1,
    },
    AUTHOR,
  );
  addSignatureRequirement(
    addedStep.id,
    {
      signatureRole: input.signatureRole,
      stampRequired: input.stampRequired,
      dateRequired: input.dateRequired,
      sortOrder: 1,
    },
    AUTHOR,
  );
  removeProcessStep(deletedStep.id, AUTHOR, reason);

  const currentSteps = processStepRepo.listByCardId(revised.id);
  expect(currentSteps.map(({ id }) => id)).toContain(addedStep.id);
  expect(currentSteps.map(({ id }) => id)).not.toContain(deletedStep.id);
  expect(currentSteps.find(({ id }) => id === retainedStep.id).descriptionEn).toBe(
    `Revised content ${input.mutationToken}`,
  );
  expect(captureItemRepo.findById(capture.id).label).toBe(`Revised capture ${input.mutationToken}`);
  expect(componentRepo.findById(component.id).payload).toEqual({
    generated: input.numericValue,
    token: input.mutationToken,
  });
  expect(signatureRequirementRepo.findById(signature.id).sortOrder).toBe(23);

  return { deletedStep, retainedStep, addedStep, currentSteps };
}

// Feature: task-card-management, Property 34: JOB 工序快照隔离
// Validates: Requirements 49.5, 49.6, 49.7, 37.5, 44.6
describe('Property 34: JOB 工序快照隔离（服务层 + SQLite）', () => {
  it('升版并任意改写当前模板后，既有 JOB 的原始快照、执行内容与打印投影保持不变', () => {
    fc.assert(
      fc.property(mutationArb, (input) => {
        // Task 14.4 requires a fresh schema and complete seed inside every property iteration.
        const db = rebuildSeededDatabase();
        const { effective, sourceSteps } = buildEffectiveSource(input.taskToken);

        const released = release(effective.id, {
          ...AUTHOR,
          packageRef: `P34-PACKAGE-${input.taskToken}`,
        });
        const jobId = released.job.id;
        const jobProcesses = released.jobProcesses;
        expect(jobProcesses).toHaveLength(sourceSteps.length);

        const snapshotRowsBefore = clone(selectSnapshotRows(db, jobId));
        const executionBefore = clone(
          jobProcesses.map(({ id }) => getJobStepContent(id)),
        );
        const printBefore = clone(getPrintModel(effective.id, { jobNo: released.jobNo }));
        expect(snapshotRowsBefore).toHaveLength(sourceSteps.length);
        expect(executionBefore.map(({ content }) => content)).toEqual(
          snapshotRowsBefore.map(({ content }) => JSON.parse(content)),
        );
        for (const { content } of executionBefore) {
          expect(content.captureItems.length).toBeGreaterThan(0);
          expect(content.components.length).toBeGreaterThan(0);
          expect(content.signatureRequirements.length).toBeGreaterThan(0);
        }

        const revised = reviseCard(
          effective.id,
          `Property 34 revise ${input.mutationToken}`,
          AUTHOR,
        );
        expect(revised.status).toBe('New');
        expect(revised.revision).toBe(effective.revision + 1);
        const revisionMutation = mutateRevision(revised, input);

        // The Effective source remains frozen: all authored mutations above target only the New revision.
        const frozenWrite = captureError(() =>
          updateProcessStep(
            sourceSteps[0].id,
            { descriptionEn: 'forbidden effective-card edit' },
            AUTHOR,
            'must be rejected by editable-state gate',
          ),
        );
        expect(frozenWrite).not.toBeNull();
        expect(frozenWrite.code).toBe(CODE.UNPROCESSABLE);

        // Simulate template storage independently changing and disappearing after release. The dangling
        // trace FK is deliberate: execution must not need it because content lives in job_step_snapshot.
        const changedSource = sourceSteps[revisionMutation.retainedStep.processId === 'A' ? 0 : 1];
        const deletedSource = sourceSteps.find(({ id }) => id !== changedSource.id);
        db.prepare('UPDATE process_step SET description_en = ? WHERE id = ?').run(
          `DESTROYED TEMPLATE ${input.mutationToken}`,
          changedSource.id,
        );
        db.pragma('foreign_keys = OFF');
        db.prepare('DELETE FROM process_step WHERE id = ?').run(deletedSource.id);
        db.pragma('foreign_keys = ON');
        expect(
          db.prepare('SELECT description_en FROM process_step WHERE id = ?').get(changedSource.id)
            .description_en,
        ).toBe(`DESTROYED TEMPLATE ${input.mutationToken}`);
        expect(db.prepare('SELECT * FROM process_step WHERE id = ?').get(deletedSource.id)).toBeUndefined();

        const readSql = observeReadSql(db);
        const snapshotRowsAfter = selectSnapshotRows(db, jobId);
        const executionAfter = jobProcesses.map(({ id }) => getJobStepContent(id));
        const printAfter = getPrintModel(effective.id, { jobNo: released.jobNo });

        // Raw rows include the exact JSON TEXT bytes; deep equality covers every persisted column.
        expect(snapshotRowsAfter).toEqual(snapshotRowsBefore);
        expect(snapshotRowsAfter.map(({ content }) => content)).toEqual(
          snapshotRowsBefore.map(({ content }) => content),
        );
        expect(executionAfter).toEqual(executionBefore);
        expect(printAfter).toEqual(printBefore);

        const normalizedReadSql = readSql.map((sql) => sql.replace(/\s+/g, ' ').trim());
        expect(normalizedReadSql.some((sql) => /\bjob_step_snapshot\b/i.test(sql))).toBe(true);
        expect(normalizedReadSql.some((sql) => /\b(?:FROM|JOIN)\s+process_step\b/i.test(sql))).toBe(false);
      }),
      { numRuns: 30 },
    );
  });
});

afterAll(() => {
  closeDb();
});