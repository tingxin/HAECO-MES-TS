import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { clearSessions } from '../middleware/user-context.js';

let app;

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();
  clearSessions();
  app = createApp();
});

afterAll(() => {
  clearSessions();
  closeDb();
});

async function login(staffNo) {
  const response = await request(app).post('/api/session').send({ staffNo }).expect(200);
  return response.body.data.token;
}

function auth(method, path, token) {
  return request(app)[method](path).set('Authorization', `Bearer ${token}`);
}

function cardId(taskNo) {
  return getDb().prepare('SELECT id FROM task_card WHERE task_no = ?').get(taskNo).id;
}

async function releaseCard(token, id, body = {}) {
  return auth('post', `/api/task-cards/${id}/release`, token).send(body).expect(200);
}

function jobProcesses(jobId) {
  return getDb().prepare('SELECT * FROM job_process WHERE job_id = ? ORDER BY process_id').all(jobId);
}

describe('Task 19.1-19.2 release and immutable JOB query routes', () => {
  it('rejects non-Effective release, records failure, and enforces card_release permission', async () => {
    const engineer = await login('E10001');
    const draftId = cardId('TC-2026-0002');

    const rejected = await auth('post', `/api/task-cards/${draftId}/release`, engineer)
      .send({ packageRef: 'WP-REJECTED' })
      .expect(422);
    expect(rejected.body).toMatchObject({
      code: 422,
      message: '工卡尚未生效，不可发布至工包',
      data: { status: 'New' },
    });
    expect(getDb().prepare('SELECT result, package_ref FROM work_package_release WHERE card_id = ?')
      .get(draftId)).toEqual({ result: 'failed', package_ref: 'WP-REJECTED' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM job WHERE card_id = ?').get(draftId).count).toBe(0);

    const manager = await login('E20001');
    const effectiveId = cardId('TC-2026-0001');
    await auth('post', `/api/task-cards/${effectiveId}/release`, manager).send({}).expect(403);
    expect(getDb().prepare(`SELECT permission_point, staff_no FROM access_denial_log
      WHERE path = ? ORDER BY id DESC`).get(`/api/task-cards/${effectiveId}/release`)).toEqual({
      permission_point: 'card_release',
      staff_no: 'E20001',
    });
  });

  it('releases independent JOBs with integration data, barcodes and immutable snapshot-only queries', async () => {
    const engineer = await login('E10001');
    const id = cardId('TC-2026-0001');
    const cardBefore = getDb().prepare('SELECT * FROM task_card WHERE id = ?').get(id);

    const first = await releaseCard(engineer, id, {
      pidNo: 'PID-2026-0001',
      packageRef: 'WP-19-FIRST',
    });
    expect(first.body).toMatchObject({
      code: 0,
      message: '发布成功',
      data: {
        packageRef: 'WP-19-FIRST',
        message: '发布成功',
        integrationDataMissing: false,
        job: {
          cardId: id,
          pidNo: 'PID-2026-0001',
          owner: 'HAECO',
          jobTargetDate: '2026-09-30',
          partNo: 'P/N-32-11-51-001',
          partSn: 'SN-0001',
          partDesc: 'MLG SHOCK STRUT',
          operationType: 'OVERHAUL',
        },
      },
    });
    expect(first.body.message).toBe(first.body.data.message);
    expect(getDb().prepare('SELECT * FROM task_card WHERE id = ?').get(id)).toEqual(cardBefore);

    const firstJob = first.body.data.job;
    const firstRows = jobProcesses(firstJob.id);
    expect(firstRows).toHaveLength(2);
    expect(firstRows.map(({ barcode_value: barcode }) => barcode)).toEqual([
      `${first.body.data.jobNo}-A`,
      `${first.body.data.jobNo}-B`,
    ]);
    const firstSnapshots = getDb().prepare(`SELECT jss.* FROM job_step_snapshot jss
      JOIN job_process jp ON jp.id = jss.job_process_id WHERE jp.job_id = ? ORDER BY jp.process_id`).all(firstJob.id);
    expect(firstSnapshots).toHaveLength(2);
    expect(firstSnapshots.map(({ content }) => JSON.parse(content).operation)).toEqual([
      'RECEIVING INSPECTION',
      'DIMENSION CHECK',
    ]);

    const detail = await auth('get', `/api/jobs/${first.body.data.jobNo}`, engineer).expect(200);
    expect(detail.body.data).toMatchObject({
      id: firstJob.id,
      jobNo: first.body.data.jobNo,
      startTime: null,
      finishTime: null,
      processes: [
        { processId: 'A', barcodeValue: `${first.body.data.jobNo}-A`, snapshot: { content: { processId: 'A' } } },
        { processId: 'B', barcodeValue: `${first.body.data.jobNo}-B`, snapshot: { content: { processId: 'B' } } },
      ],
    });
    const processList = await auth('get', `/api/jobs/${first.body.data.jobNo}/processes`, engineer).expect(200);
    expect(processList.body.data).toEqual(detail.body.data.processes);

    const second = await releaseCard(engineer, id, { pidNo: 'PID-2026-0001', packageRef: 'WP-19-SECOND' });
    expect(second.body.data.jobNo).not.toBe(first.body.data.jobNo);
    const secondSnapshots = getDb().prepare(`SELECT jss.id FROM job_step_snapshot jss
      JOIN job_process jp ON jp.id = jss.job_process_id WHERE jp.job_id = ? ORDER BY jss.id`)
      .all(second.body.data.job.id).map(({ id: snapshotId }) => snapshotId);
    expect(secondSnapshots).toHaveLength(2);
    expect(secondSnapshots).not.toEqual(firstSnapshots.map(({ id: snapshotId }) => snapshotId));

    getDb().prepare("UPDATE process_step SET description_zh = '发布后编制域已变化' WHERE card_id = ? AND process_id = 'A'")
      .run(id);
    const frozen = await auth('get', `/api/jobs/${first.body.data.jobNo}`, engineer).expect(200);
    expect(frozen.body.data.processes[0].snapshot.content.descriptionZh)
      .toBe('目视检查起落架外观并记录进厂件号与序号。');
  });

  it('keeps missing integration columns null while release still succeeds and preserves task_card', async () => {
    const engineer = await login('E10001');
    const id = cardId('TC-2026-0002');
    getDb().prepare("UPDATE task_card SET status = 'Effective' WHERE id = ?").run(id);
    const cardBefore = getDb().prepare('SELECT * FROM task_card WHERE id = ?').get(id);

    const response = await releaseCard(engineer, id, { pidNo: 'PID-NO-DATA' });
    expect(response.body).toMatchObject({
      code: 0,
      data: {
        integrationDataMissing: true,
        job: {
          jobTargetDate: null,
          partNo: null,
          partSn: null,
          partDesc: null,
          operationType: null,
        },
      },
    });
    expect(response.body.message).toBe(response.body.data.message);
    expect(response.body.message).toContain('集成数据缺失');
    expect(getDb().prepare('SELECT * FROM task_card WHERE id = ?').get(id)).toEqual(cardBefore);
  });
});

describe('Task 19.3 execution routes, safety gate, authorization and chronology', () => {
  it('gates critical start, aggregates times/status, writes manhours, and rejects invalid finish ordering', async () => {
    const engineer = await login('E10001');
    const production = await login('E50001');
    const id = cardId('TC-2026-0001');
    const cardBefore = getDb().prepare('SELECT * FROM task_card WHERE id = ?').get(id);
    const released = await releaseCard(engineer, id, { pidNo: 'PID-2026-0001' });
    const job = released.body.data.job;
    const [critical, regular] = jobProcesses(job.id);

    await auth('post', `/api/job-processes/${critical.id}/start`, engineer).send({}).expect(403);
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM access_denial_log
      WHERE staff_no = 'E10001' AND permission_point = 'job_exec_write'`).get().count).toBe(1);

    const gated = await auth('post', `/api/job-processes/${critical.id}/start`, production)
      .send({}).expect(422);
    expect(gated.body).toMatchObject({ code: 422, data: { rejection: 'notAcknowledged' } });
    expect(getDb().prepare('SELECT start_time FROM job_process WHERE id = ?').get(critical.id).start_time).toBeNull();

    const ack = await auth('post', `/api/job-processes/${critical.id}/safety-ack`, production)
      .send({}).expect(200);
    expect(ack.body.data).toMatchObject({ jobProcessId: critical.id, acknowledgedBy: 'E50001' });
    expect(ack.body.data.acknowledgedAt).toEqual(expect.any(String));

    const started = await auth('post', `/api/job-processes/${critical.id}/start`, production)
      .send({}).expect(200);
    expect(started.body.data.jobProcess.startTime).toEqual(expect.any(String));
    let persistedJob = getDb().prepare('SELECT * FROM job WHERE id = ?').get(job.id);
    expect(persistedJob.start_time).toBe(started.body.data.jobProcess.startTime);
    expect(persistedJob.finish_time).toBeNull();
    expect(persistedJob.exec_status).toBe('InProgress');

    const hours = await auth('put', `/api/job-processes/${critical.id}/manhours`, production)
      .send({ effectiveManHours: 2.25, actualManHours: 2.5, barcodeValue: 'MUST-NOT-WRITE' })
      .expect(200);
    expect(hours.body.data).toMatchObject({
      effectiveManHours: 2.25,
      actualManHours: 2.5,
      barcodeValue: `${released.body.data.jobNo}-A`,
    });

    const notStarted = await auth('post', `/api/job-processes/${regular.id}/finish`, production)
      .send({}).expect(422);
    expect(notStarted.body).toMatchObject({ code: 422, data: { rejection: 'processNotStarted' } });

    await auth('post', `/api/job-processes/${regular.id}/start`, production).send({}).expect(200);
    getDb().prepare("UPDATE job_process SET start_time = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(regular.id);
    const reversed = await auth('post', `/api/job-processes/${regular.id}/finish`, production)
      .send({}).expect(422);
    expect(reversed.body).toMatchObject({ code: 422, data: { rejection: 'finishBeforeStart' } });
    expect(getDb().prepare('SELECT finish_time FROM job_process WHERE id = ?').get(regular.id).finish_time).toBeNull();

    getDb().prepare("UPDATE job_process SET start_time = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(regular.id);
    await auth('post', `/api/job-processes/${critical.id}/finish`, production).send({}).expect(200);
    persistedJob = getDb().prepare('SELECT * FROM job WHERE id = ?').get(job.id);
    expect(persistedJob.finish_time).toBeNull();
    await auth('post', `/api/job-processes/${regular.id}/finish`, production).send({}).expect(200);
    persistedJob = getDb().prepare('SELECT * FROM job WHERE id = ?').get(job.id);
    expect(persistedJob.finish_time).toEqual(expect.any(String));
    expect(persistedJob.exec_status).toBe('Completed');
    expect(new Date(persistedJob.finish_time).getTime()).toBeGreaterThanOrEqual(
      new Date(persistedJob.start_time).getTime(),
    );
    expect(getDb().prepare('SELECT * FROM task_card WHERE id = ?').get(id)).toEqual(cardBefore);
  });
});


describe('Task 19.3 signatures and archive ownership', () => {
  it('validates card/JOB/snapshot ownership and becomes archivable only after all required signatures', async () => {
    const engineer = await login('E10001');
    const production = await login('E50001');
    const id = cardId('TC-2026-0001');
    const otherCardId = cardId('TC-2026-0002');
    const released = await releaseCard(engineer, id, { pidNo: 'PID-2026-0001' });
    const { job } = released.body.data;

    await request(app).get(`/api/jobs/${released.body.data.jobNo}`).expect(401);
    const noJob = await auth('get', `/api/task-cards/${id}/archive-status`, engineer).expect(400);
    expect(noJob.body).toMatchObject({ code: 400, message: '缺少 JOB 标识（jobId 或 jobNo）' });

    const before = await auth(
      'get',
      `/api/task-cards/${id}/archive-status?jobNo=${encodeURIComponent(released.body.data.jobNo)}`,
      engineer,
    ).expect(200);
    expect(before.body.data).toMatchObject({
      jobId: job.id,
      jobNo: released.body.data.jobNo,
      ok: false,
      total: 2,
      satisfiedCount: 0,
    });

    const wrongCard = await auth(
      'get',
      `/api/task-cards/${otherCardId}/archive-status?jobId=${job.id}`,
      engineer,
    ).expect(422);
    expect(wrongCard.body).toMatchObject({ code: 422, data: { rejection: 'jobCardMismatch' } });

    const queriedProcesses = await auth(
      'get', `/api/jobs/${released.body.data.jobNo}/processes`, engineer,
    ).expect(200);
    const requirements = queriedProcesses.body.data.flatMap(
      ({ snapshot }) => snapshot.content.signatureRequirements,
    );
    expect(requirements).toHaveLength(2);
    const operatorRequirement = requirements.find(({ signatureRole }) => signatureRole === 'Operator');
    const qcRequirement = requirements.find(({ signatureRole }) => signatureRole === 'QC');

    await auth('post', `/api/task-cards/${id}/signatures`, engineer).send({
      jobId: job.id,
      signatureRequirementId: operatorRequirement.id,
    }).expect(403);

    const sourceStepId = queriedProcesses.body.data[0].snapshot.sourceStepId;
    const postReleaseRequirement = getDb().prepare(`INSERT INTO signature_requirement
      (step_id, signature_role, stamp_required, date_required, sort_order)
      VALUES (?, 'NDT', 0, 1, 99)`).run(sourceStepId).lastInsertRowid;
    const notInSnapshot = await auth('post', `/api/task-cards/${id}/signatures`, production).send({
      jobId: job.id,
      signatureRequirementId: Number(postReleaseRequirement),
    }).expect(422);
    expect(notInSnapshot.body).toMatchObject({
      code: 422,
      data: { rejection: 'signatureRequirementJobMismatch' },
    });

    // 改写编制域当前要求不得影响已释放 JOB：签署仍按冻结快照判定无需盖章。
    getDb().prepare('UPDATE signature_requirement SET stamp_required = 1 WHERE id = ?')
      .run(operatorRequirement.id);

    const mismatchedJob = await auth('post', `/api/task-cards/${otherCardId}/signatures`, production).send({
      jobId: job.id,
      signatureRequirementId: operatorRequirement.id,
    }).expect(422);
    expect(mismatchedJob.body).toMatchObject({ code: 422, data: { rejection: 'jobCardMismatch' } });

    const stampMissing = await auth('post', `/api/task-cards/${id}/signatures`, production).send({
      jobId: job.id,
      signatureRequirementId: qcRequirement.id,
    }).expect(400);
    expect(stampMissing.body.message).toContain('stampId');

    const operatorSigned = await auth('post', `/api/task-cards/${id}/signatures`, production).send({
      jobId: job.id,
      signatureRequirementId: operatorRequirement.id,
    }).expect(200);
    expect(operatorSigned.body.data).toMatchObject({
      cardId: id,
      jobId: job.id,
      signatureRequirementId: operatorRequirement.id,
      signedBy: 'E50001',
      stampId: null,
    });
    expect(operatorSigned.body.data.signedAt).toEqual(expect.any(String));

    await auth('post', `/api/task-cards/${id}/signatures`, production).send({
      jobNo: released.body.data.jobNo,
      signatureRequirementId: qcRequirement.id,
      stampId: 'STAMP-QC-19',
    }).expect(200);

    const ready = await auth(
      'get', `/api/task-cards/${id}/archive-status?jobId=${job.id}`, engineer,
    ).expect(200);
    expect(ready.body.data).toMatchObject({
      jobId: job.id,
      jobNo: released.body.data.jobNo,
      ok: true,
      vacuous: false,
      total: 2,
      satisfiedCount: 2,
      missing: [],
    });
    // 发布后新增的第三条 live requirement 不得进入该 JOB 的归档口径。
    expect(ready.body.data.total).toBe(requirements.length);
  });
});