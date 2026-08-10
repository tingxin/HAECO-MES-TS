import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import {
  finishJobProcess,
  startJobProcess,
  writeManHours,
} from './executionService.js';
import { release } from './releaseService.js';

const RELEASE_ACTOR = Object.freeze({ operatorId: 'E10001' });
const EXECUTION_ACTOR = Object.freeze({
  operatorId: 'E50001',
  staffNo: 'E50001',
  role: 'Production_Technician',
  method: 'PUT',
  path: '/api/job-processes/property-31/manhours',
});

const tokenArb = fc
  .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((characters) => characters.join(''));

const jobIndependenceArb = fc.record({
  releaseCount: fc.integer({ min: 1, max: 4 }),
  selectedJobSeed: fc.nat(),
  timestampOffsetMinutes: fc.integer({ min: 0, max: 365 * 24 * 60 }),
  effectiveManHours: fc.integer({ min: 0, max: 200 }),
  actualManHours: fc.integer({ min: 0, max: 200 }),
  token: tokenArb,
});

function rebuildSeededDatabase() {
  resetDb(':memory:');
  migrate();
  seed();
  return getDb();
}

function insertEffectiveCardWithStep(db, token) {
  const taskNo = `P31-${token}`;
  const cardId = Number(
    db
      .prepare(
        `INSERT INTO task_card
           (task_no, revision, title, date, ac_type, gear_type, stage, skill,
            ctrl_code, card_type, status, created_by, reviewed_by, last_update, operator_id)
         VALUES (?, 1, ?, '2026-01-01', '320', 'MLG', 'RTN', 'GR',
                 'IS', '01', 'Effective', 'E10001', 'E20001', '2026-01-02', 'E10001')`,
      )
      .run(taskNo, `Property 31 JOB independence ${token}`).lastInsertRowid,
  );

  const stepId = Number(
    db
      .prepare(
        `INSERT INTO process_step
           (card_id, process_id, seq, skill, operation, work_category,
            estimated_man_hours, description_zh, description_en, is_critical)
         VALUES (?, 'A', 1, 'GR', 'PROPERTY 31 EXECUTION', 'Inspection',
                 1.5, ?, ?, 0)`,
      )
      .run(cardId, `属性 31 工序 ${token}`, `Property 31 process ${token}`).lastInsertRowid,
  );

  return { cardId, stepId, taskNo };
}

function selectTaskCardRow(db, cardId) {
  return db.prepare('SELECT * FROM task_card WHERE id = ?').get(cardId);
}

function selectJobs(db, cardId) {
  return db.prepare('SELECT * FROM job WHERE card_id = ? ORDER BY id').all(cardId);
}

function selectJobProcesses(db, cardId) {
  return db
    .prepare(
      `SELECT jp.*
         FROM job_process jp
         JOIN job j ON j.id = jp.job_id
        WHERE j.card_id = ?
        ORDER BY jp.id`,
    )
    .all(cardId);
}

function selectSnapshots(db, cardId) {
  return db
    .prepare(
      `SELECT jss.*
         FROM job_step_snapshot jss
         JOIN job_process jp ON jp.id = jss.job_process_id
         JOIN job j ON j.id = jp.job_id
        WHERE j.card_id = ?
        ORDER BY jss.id`,
    )
    .all(cardId);
}

function rowsExcept(rows, excludedId) {
  return rows.filter(({ id }) => id !== excludedId);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
}

function isoPair(offsetMinutes) {
  const start = new Date(Date.UTC(2026, 0, 1, 0, offsetMinutes, 0));
  const finish = new Date(start.getTime() + 60_000);
  return { startTime: start.toISOString(), finishTime: finish.toISOString() };
}

// Feature: task-card-management, Property 31: JOB 实例独立性
// Validates: Requirements 37.1, 37.2, 37.3, 37.4, 37.5, 33.1, 33.2
describe('Property 31: JOB 实例独立性（服务层 + SQLite）', () => {
  it('多次释放生成独立 JOB；选中实例的报工与工时不会修改其他 JOB 或来源 task_card', () => {
    fc.assert(
      fc.property(jobIndependenceArb, (input) => {
        // Task 14.3 requires a fresh schema and complete seed inside every property iteration.
        const db = rebuildSeededDatabase();
        const { cardId, stepId, taskNo } = insertEffectiveCardWithStep(db, input.token);
        const taskCardBeforeRelease = selectTaskCardRow(db, cardId);

        expect(
          db
            .prepare(
              `SELECT allowed FROM role_permission
                WHERE role = ? AND permission_point = 'job_exec_write'`,
            )
            .get(EXECUTION_ACTOR.role).allowed,
        ).toBe(1);

        const releases = Array.from({ length: input.releaseCount }, (_, index) =>
          release(cardId, {
            ...RELEASE_ACTOR,
            packageRef: `P31-PACKAGE-${input.token}-${index + 1}`,
          }),
        );

        const jobsBeforeExecution = selectJobs(db, cardId);
        const processesBeforeExecution = selectJobProcesses(db, cardId);
        const snapshotsBeforeExecution = selectSnapshots(db, cardId);

        expect(releases.map(({ jobNo }) => jobNo)).toEqual(
          jobsBeforeExecution.map(({ job_no: jobNo }) => jobNo),
        );
        expect(new Set(releases.map(({ jobNo }) => jobNo)).size).toBe(input.releaseCount);
        expect(jobsBeforeExecution).toHaveLength(input.releaseCount);
        expect(processesBeforeExecution).toHaveLength(input.releaseCount);
        expect(snapshotsBeforeExecution).toHaveLength(input.releaseCount);

        const processIds = new Set();
        const snapshotIds = new Set();
        for (const job of jobsBeforeExecution) {
          const jobProcesses = processesBeforeExecution.filter(({ job_id: jobId }) => jobId === job.id);
          expect(jobProcesses).toHaveLength(1);
          const [jobProcess] = jobProcesses;
          const jobSnapshots = snapshotsBeforeExecution.filter(
            ({ job_process_id: jobProcessId }) => jobProcessId === jobProcess.id,
          );
          expect(jobSnapshots).toHaveLength(1);
          expect(jobProcess.step_id).toBe(stepId);
          expect(jobProcess.process_id).toBe('A');
          expect(jobProcess.barcode_value).toBe(`${job.job_no}-A`);
          expect(job.start_time).toBeNull();
          expect(job.finish_time).toBeNull();
          expect(jobProcess.start_time).toBeNull();
          expect(jobProcess.finish_time).toBeNull();
          expect(jobProcess.effective_man_hours).toBeNull();
          expect(jobProcess.actual_man_hours).toBeNull();
          expect(jobSnapshots[0].source_step_id).toBe(stepId);
          expect(jobSnapshots[0].source_card_revision).toBe(1);
          expect(JSON.parse(jobSnapshots[0].content).processId).toBe('A');
          processIds.add(jobProcess.id);
          snapshotIds.add(jobSnapshots[0].id);
        }
        expect(processIds.size).toBe(input.releaseCount);
        expect(snapshotIds.size).toBe(input.releaseCount);

        const selectedJob = jobsBeforeExecution[input.selectedJobSeed % jobsBeforeExecution.length];
        const selectedProcess = processesBeforeExecution.find(
          ({ job_id: jobId }) => jobId === selectedJob.id,
        );
        const { startTime, finishTime } = isoPair(input.timestampOffsetMinutes);

        startJobProcess(selectedProcess.id, { now: startTime });
        finishJobProcess(selectedProcess.id, { now: finishTime });
        writeManHours(
          selectedProcess.id,
          {
            effectiveManHours: input.effectiveManHours,
            actualManHours: input.actualManHours,
          },
          EXECUTION_ACTOR,
        );

        const jobsAfterExecution = selectJobs(db, cardId);
        const processesAfterExecution = selectJobProcesses(db, cardId);
        const snapshotsAfterExecution = selectSnapshots(db, cardId);
        const selectedJobAfter = jobsAfterExecution.find(({ id }) => id === selectedJob.id);
        const selectedProcessAfter = processesAfterExecution.find(({ id }) => id === selectedProcess.id);

        expect(selectedJobAfter.start_time).toBe(startTime);
        expect(selectedJobAfter.finish_time).toBe(finishTime);
        expect(selectedProcessAfter.start_time).toBe(startTime);
        expect(selectedProcessAfter.finish_time).toBe(finishTime);
        expect(selectedProcessAfter.effective_man_hours).toBe(input.effectiveManHours);
        expect(selectedProcessAfter.actual_man_hours).toBe(input.actualManHours);

        expect(rowsExcept(jobsAfterExecution, selectedJob.id)).toEqual(
          rowsExcept(jobsBeforeExecution, selectedJob.id),
        );
        expect(rowsExcept(processesAfterExecution, selectedProcess.id)).toEqual(
          rowsExcept(processesBeforeExecution, selectedProcess.id),
        );
        expect(snapshotsAfterExecution).toEqual(snapshotsBeforeExecution);

        // Release and all execution reporting must leave every source-card field byte-for-byte equal.
        expect(selectTaskCardRow(db, cardId)).toEqual(taskCardBeforeRelease);
        expect(taskCardBeforeRelease.task_no).toBe(taskNo);

        // Execution timing/manhours have physical homes only in job/job_process, never task_card.
        const taskCardColumns = columnNames(db, 'task_card');
        const executionOnlyColumns = [
          'job_no',
          'start_time',
          'finish_time',
          'effective_man_hours',
          'actual_man_hours',
        ];
        expect(taskCardColumns.filter((column) => executionOnlyColumns.includes(column))).toEqual([]);
        expect(columnNames(db, 'job')).toEqual(expect.arrayContaining(['start_time', 'finish_time']));
        expect(columnNames(db, 'job_process')).toEqual(
          expect.arrayContaining([
            'start_time',
            'finish_time',
            'effective_man_hours',
            'actual_man_hours',
          ]),
        );
      }),
      { numRuns: 30 },
    );
  });
});

afterAll(() => {
  closeDb();
});
