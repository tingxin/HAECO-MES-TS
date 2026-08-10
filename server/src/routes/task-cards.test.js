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

async function login(staffNo = 'E10001') {
  const response = await request(app).post('/api/session').send({ staffNo }).expect(200);
  return response.body.data.token;
}

function auth(method, path, token) {
  return request(app)[method](path).set('Authorization', `Bearer ${token}`);
}

function cardId(taskNo = 'TC-2026-0002') {
  return getDb().prepare('SELECT id FROM task_card WHERE task_no = ?').get(taskNo).id;
}

function expectOk(response) {
  expect(response.body).toMatchObject({ code: 0, message: 'ok' });
}
describe('Task 17.1 list and query routes', () => {
  it('supports AND filters, pagination, empty results, detail aggregates, versions, and duplicate checks', async () => {
    const token = await login();
    const id = cardId();

    const list = await auth('get', '/api/task-cards?acType=320&status=New&page=1&pageSize=1', token).expect(200);
    expectOk(list);
    expect(list.body.data).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(list.body.data.list).toHaveLength(1);

    const empty = await auth('get', '/api/task-cards?taskNo=DOES-NOT-EXIST', token).expect(200);
    expect(empty.body).toMatchObject({ code: 0, data: { list: [], total: 0 } });

    const detail = await auth('get', `/api/task-cards/${id}`, token).expect(200);
    expect(detail.body.data).toMatchObject({ id, taskNo: 'TC-2026-0002' });
    expect(detail.body.data.referenceDocuments).toHaveLength(1);
    expect(detail.body.data.steps[0]).toMatchObject({ processId: 'A', captureItems: [], components: [] });
    expect(detail.body.data).toHaveProperty('relations');
    expect(detail.body.data).toHaveProperty('changeRecords');

    const versions = await auth('get', `/api/task-cards/${id}/versions`, token).expect(200);
    expect(versions.body.data.map((card) => card.revision)).toEqual([1]);

    const duplicate = await auth(
      'get',
      '/api/task-cards/check-duplicate?taskNo=TC-2026-0002&revision=1',
      token,
    ).expect(200);
    expect(duplicate.body.data).toMatchObject({ ok: false, duplicate: true, revision: 1 });

    const excluded = await auth(
      'get',
      `/api/task-cards/check-duplicate?taskNo=TC-2026-0002&revision=1&excludeId=${id}`,
      token,
    ).expect(200);
    expect(excluded.body.data).toMatchObject({ ok: true, duplicate: false });
  });

  it('attaches JOB execution fields and parsed immutable snapshot content when jobNo is supplied', async () => {
    const token = await login();
    const id = cardId('TC-2026-0001');
    const step = getDb().prepare('SELECT id FROM process_step WHERE card_id = ? ORDER BY id').get(id);
    const job = getDb().prepare(`INSERT INTO job (job_no, card_id, card_revision, exec_status, start_time)
      VALUES (?, ?, 1, 'InProgress', '2026-08-01T01:00:00Z')`).run('JOB-ROUTE-1', id);
    const process = getDb().prepare(`INSERT INTO job_process
      (job_id, step_id, process_id, barcode_value, actual_man_hours) VALUES (?, ?, 'A', 'JOB-ROUTE-1-A', 1.5)`)
      .run(job.lastInsertRowid, step.id);
    getDb().prepare(`INSERT INTO job_step_snapshot
      (job_process_id, source_step_id, source_card_revision, content, snapshot_at)
      VALUES (?, ?, 1, ?, '2026-08-01T00:00:00Z')`)
      .run(process.lastInsertRowid, step.id, JSON.stringify({ processId: 'A', descriptionZh: '冻结内容' }));

    const response = await auth('get', `/api/task-cards/${id}?jobNo=JOB-ROUTE-1`, token).expect(200);
    expect(response.body.data.jobContext).toMatchObject({ jobNo: 'JOB-ROUTE-1', execStatus: 'InProgress' });
    expect(response.body.data.jobContext.processes[0]).toMatchObject({
      processId: 'A',
      actualManHours: 1.5,
      snapshot: { content: { processId: 'A', descriptionZh: '冻结内容' } },
    });
  });
});
describe('Task 17.2 authoring routes', () => {
  it('creates and saves cards, manages reference docs, and binds attachment references through the edit gate', async () => {
    const token = await login('E10001');
    const created = await auth('post', '/api/task-cards', token).send({
      taskNo: 'TC-ROUTE-NEW',
      title: 'Route-created card',
      cardType: '01',
      stage: 'RTN',
      acType: '320',
      gearType: 'MLG',
      skill: 'GR',
      ctrlCode: 'IS',
    }).expect(200);
    expect(created.body.data).toMatchObject({ taskNo: 'TC-ROUTE-NEW', revision: 1, status: 'New', isFai: 0 });
    const id = created.body.data.id;

    const updated = await auth('put', `/api/task-cards/${id}`, token)
      .send({ title: 'Saved title', reason: '完善标题' })
      .expect(200);
    expect(updated.body.data).toMatchObject({ title: 'Saved title', operatorId: 'E10001' });

    const addedDoc = await auth('post', `/api/task-cards/${id}/reference-docs`, token)
      .send({ docType: 'CMM', refNo: '32-00-01', docRevision: 'Rev 1', ataChapter: '32' })
      .expect(200);
    expect(addedDoc.body.data).toMatchObject({ cardId: id, refNo: '32-00-01' });

    const removedDoc = await auth(
      'delete',
      `/api/task-cards/${id}/reference-docs/${addedDoc.body.data.id}`,
      token,
    ).send({ reason: '替换参考文件' }).expect(200);
    expect(removedDoc.body.data).toMatchObject({ removed: true });

    const seededId = cardId();
    const stepId = getDb().prepare('SELECT id FROM process_step WHERE card_id = ?').get(seededId).id;
    const attachment = getDb().prepare(`INSERT INTO attachment
      (kind, original_name, stored_path, mime_type, byte_size, sha256, uploaded_by)
      VALUES ('image', 'photo.png', 'fixture.png', 'image/png', 10, 'route-fixture', 'E10001')`).run();
    const bound = await auth('post', `/api/task-cards/${seededId}/attachment-references`, token)
      .send({ stepId, attachmentId: attachment.lastInsertRowid, type: 'image', sortOrder: 1 })
      .expect(200);
    expect(bound.body.data).toMatchObject({
      stepId,
      type: 'image',
      payload: { attachmentId: Number(attachment.lastInsertRowid), url: `/api/attachments/${attachment.lastInsertRowid}` },
    });

    const records = await auth('get', `/api/task-cards/${id}/change-records`, token).expect(200);
    expect(records.body.data.some((record) => record.changeType === 'edit')).toBe(true);
    expect(records.body.data.some((record) => record.changeType === 'delete')).toBe(true);
  });

  it('enforces card_edit authorization and service edit-state gates', async () => {
    const manager = await login('E20001');
    await auth('post', '/api/task-cards', manager)
      .send({ taskNo: 'DENIED', title: 'Denied', cardType: '01' })
      .expect(403);

    const engineer = await login('E10001');
    const effectiveId = cardId('TC-2026-0001');
    const response = await auth('put', `/api/task-cards/${effectiveId}`, engineer)
      .send({ title: 'Must not change', reason: 'illegal' })
      .expect(422);
    expect(response.body).toMatchObject({ code: 422 });
  });
});
describe('Task 17.3 review routes', () => {
  it('returns the submit checklist failures and supports approve, reject, and review history contracts', async () => {
    const engineer = await login('E10001');
    const incompleteId = cardId('TC-2026-0004');
    const submitted = await auth('post', `/api/task-cards/${incompleteId}/submit-review`, engineer)
      .send({ reason: '提交审核' })
      .expect(400);
    expect(submitted.body).toMatchObject({
      code: 400,
      data: { rejection: 'CHECKLIST_FAILED' },
    });
    expect(submitted.body.data.failedChecks).toBeInstanceOf(Array);
    expect(submitted.body.data.failedChecks.length).toBeGreaterThan(0);

    const approveId = cardId('TC-2026-0002');
    const rejectId = cardId('TC-2026-0003');
    getDb().prepare("UPDATE task_card SET status = 'UnderReview' WHERE id IN (?, ?)").run(approveId, rejectId);
    const manager = await login('E20001');

    const approved = await auth('post', `/api/task-cards/${approveId}/approve`, manager)
      .send({ comment: '批准' })
      .expect(200);
    expect(approved.body.data).toMatchObject({ status: 'Effective' });

    const rejected = await auth('post', `/api/task-cards/${rejectId}/reject`, manager)
      .send({ reviewComment: '补充资料' })
      .expect(200);
    expect(rejected.body.data).toMatchObject({ status: 'New' });

    const reviews = await auth('get', `/api/task-cards/${rejectId}/reviews`, engineer).expect(200);
    expect(reviews.body.data).toEqual([
      expect.objectContaining({ action: 'reject', reviewer: 'E20001', comment: '补充资料' }),
    ]);
  });

  it('declares distinct submit and review permissions and centralizes ServiceError envelopes', async () => {
    const engineer = await login('E10001');
    const id = cardId();
    await auth('post', `/api/task-cards/${id}/approve`, engineer).send({ comment: 'no' }).expect(403);

    const manager = await login('E20001');
    await auth('post', `/api/task-cards/${id}/submit-review`, manager).send({ reason: 'no' }).expect(403);
    const missingComment = await auth('post', `/api/task-cards/${id}/reject`, manager).send({}).expect(422);
    expect(missingComment.body).toMatchObject({ code: 422, data: { rejection: 'NOT_UNDER_REVIEW' } });
  });
});
describe('Task 17.4 version, void, batch, and relation routes', () => {
  it('copies, revises, previews/executes void, exposes changes, and batch-replaces with independent permission', async () => {
    const engineer = await login('E10001');
    const sourceId = cardId('TC-2026-0001');

    const copied = await auth('post', '/api/task-cards/copy', engineer).send({
      ids: [sourceId],
      numbering: { prefix: 'COPY-', suffix: '', startSeq: 1, step: 1 },
    }).expect(200);
    expect(copied.body.data).toHaveLength(1);
    expect(copied.body.data[0]).toMatchObject({ status: 'New', revision: 1 });
    expect(copied.body.data[0].taskNo).toMatch(/^COPY-/);

    const adjusted = await auth('patch', `/api/task-cards/${copied.body.data[0].id}/copied-task-no`, engineer)
      .send({ taskNo: 'COPY-ADJUSTED-001' })
      .expect(200);
    expect(adjusted.body.data).toMatchObject({ taskNo: 'COPY-ADJUSTED-001', status: 'New' });
    await auth('patch', `/api/task-cards/${copied.body.data[0].id}/copied-task-no`, engineer)
      .send({ taskNo: 'TC-2026-0002' })
      .expect(409);

    const revised = await auth('post', '/api/task-cards/revise', engineer)
      .send({ ids: [sourceId], reason: '计划修订' })
      .expect(200);
    expect(revised.body.data[0]).toMatchObject({ taskNo: 'TC-2026-0001', revision: 2, status: 'New' });

    const manuallyRevised = await auth('post', '/api/task-cards/revise', engineer)
      .send({ ids: [sourceId], reason: '手动调整版本', revision: 4 })
      .expect(200);
    expect(manuallyRevised.body.data[0]).toMatchObject({ taskNo: 'TC-2026-0001', revision: 4, status: 'New' });
    await auth('post', '/api/task-cards/revise', engineer)
      .send({ ids: [sourceId], reason: '重复版本', revision: 4 })
      .expect(409);

    const manager = await login('E20001');
    const precheck = await auth('get', `/api/task-cards/${sourceId}/void-precheck`, manager).expect(200);
    expect(precheck.body.data.referenceHits).toEqual({
      jobInProgress: [],
      jobNotStarted: [],
      inProgressPackage: [],
    });

    const voided = await auth('post', `/api/task-cards/${sourceId}/void`, manager)
      .send({ reason: '停止使用' })
      .expect(200);
    expect(voided.body.data).toMatchObject({ status: 'Void' });

    const changes = await auth('get', `/api/task-cards/${sourceId}/change-records`, engineer).expect(200);
    expect(changes.body.data.some((record) => record.changeType === 'revise')).toBe(true);
    expect(changes.body.data.some((record) => record.changeType === 'void')).toBe(true);

    const replaceId = cardId('TC-2026-0002');
    const replaced = await auth('post', '/api/task-cards/batch-replace', manager).send({
      ids: [replaceId],
      field: 'title',
      from: 'IR 检查工卡 / IR Inspection',
      to: '批量替换标题',
      reason: '统一标题',
    }).expect(200);
    expect(replaced.body.data).toMatchObject({ totalCount: 1, affectedCount: 1 });
    expect(getDb().prepare('SELECT title FROM task_card WHERE id = ?').get(replaceId).title).toBe('批量替换标题');
  });

  it.each([
    ['/api/task-cards/copy', { ids: [], numbering: {} }, 'E10001'],
    ['/api/task-cards/revise', { ids: [], reason: 'none' }, 'E10001'],
    ['/api/task-cards/batch-replace', { ids: [], field: 'title', reason: 'none' }, 'E20001'],
  ])('returns mirrored 400 for empty ids at %s', async (path, body, staffNo) => {
    const token = await login(staffNo);
    const response = await auth('post', path, token).send(body).expect(400);
    expect(response.body).toEqual({
      code: 400,
      message: '须先选择工卡',
      data: { rejection: 'EMPTY_IDS' },
    });
  });
  it('lists, adds, syncs, deletes, and auto-links relations with route-specific permissions', async () => {
    const engineer = await login('E10001');
    const editableId = cardId('TC-2026-0002');

    const added = await auth('post', `/api/task-cards/${editableId}/relations`, engineer)
      .send({ execDocType: 'SW', relatedDocNo: 'SWS-ROUTE-1' })
      .expect(200);
    expect(added.body.data).toMatchObject({
      cardId: editableId,
      execDocType: 'SW',
      relatedDocNo: 'SWS-ROUTE-1',
      origin: 'manual',
      createdBy: 'E10001',
    });

    const synced = await auth('post', `/api/task-cards/${editableId}/relations/sync`, engineer)
      .send({ keyInfo: { acType: '350', partNo: 'PN-NEW', serialNo: 'SN-NEW' } })
      .expect(200);
    expect(synced.body.data[0].keyInfoSnapshot).toMatchObject({
      acType: '350',
      partNo: 'PN-NEW',
      serialNo: 'SN-NEW',
    });

    const listed = await auth('get', `/api/task-cards/${editableId}/relations`, engineer).expect(200);
    expect(listed.body.data).toHaveLength(1);

    const removed = await auth(
      'delete',
      `/api/task-cards/${editableId}/relations/${added.body.data.id}`,
      engineer,
    ).expect(200);
    expect(removed.body.data).toMatchObject({ removed: true });

    const effectiveId = cardId('TC-2026-0001');
    await auth('post', `/api/task-cards/${effectiveId}/relations/sync`, engineer)
      .send({ keyInfo: { acType: '350' } })
      .expect(422);

    const production = await login('E50001');
    const automatic = await auth('post', `/api/task-cards/${effectiveId}/relations/auto`, production)
      .send({ execDocType: 'PC', relatedDocNo: 'PC-ROUTE-1' })
      .expect(200);
    expect(automatic.body.data).toMatchObject({ origin: 'auto', createdBy: 'E50001' });

    await auth('post', `/api/task-cards/${effectiveId}/relations/auto`, engineer)
      .send({ execDocType: 'PC', relatedDocNo: 'PC-DENIED' })
      .expect(403);
  });

  it('requires card_void for precheck/void and a nonblank void reason', async () => {
    const engineer = await login('E10001');
    const id = cardId('TC-2026-0004');
    await auth('get', `/api/task-cards/${id}/void-precheck`, engineer).expect(403);

    const manager = await login('E20001');
    const response = await auth('post', `/api/task-cards/${id}/void`, manager).send({ reason: ' ' }).expect(400);
    expect(response.body).toMatchObject({ code: 400, data: { rejection: 'REASON_REQUIRED' } });
  });
});


describe('Task 17.5 main-chain HTTP regression', () => {
  const frozenStatuses = ['UnderReview', 'Effective', 'Superseded', 'Void'];

  async function createCard(token, suffix, overrides = {}) {
    const response = await auth('post', '/api/task-cards', token).send({
      taskNo: `TC-17-5-${suffix}`,
      title: `Task 17.5 ${suffix}`,
      cardType: '01',
      stage: 'RTN',
      acType: '320',
      gearType: 'MLG',
      skill: 'GR',
      ctrlCode: 'IS',
      ...overrides,
    }).expect(200);
    expectOk(response);
    const card = response.body.data;
    const derivation = await auth('post', `/api/task-cards/${card.id}/classification/derive`, token).send({}).expect(200);
    await auth('post', `/api/task-cards/${card.id}/classification/confirm`, token).send({
      classification: 'Gear Inspection', derivationResultId: derivation.body.data.resultId,
    }).expect(200);
    return card;
  }

  async function addStepAndSignature(cardId, operatorId = 'E10001') {
    // Task 18 routes are intentionally not mounted yet. Use the real authoring service—not
    // hand-written checklist data—to establish the process/signature prerequisites.
    const { default: taskCardService } = await import('../services/taskCardService.js');
    const step = taskCardService.addProcessStep(cardId, {
      skill: 'GR',
      descriptionZh: '执行主链路检查',
      descriptionEn: 'Execute the main-chain inspection',
    }, { operatorId });
    taskCardService.addSignatureRequirement(step.id, {
      signatureRole: 'Operator',
      stampRequired: false,
      dateRequired: true,
      sortOrder: 1,
    }, { operatorId });
    return step;
  }

  async function detail(cardId, token) {
    const response = await auth('get', `/api/task-cards/${cardId}`, token).expect(200);
    expectOk(response);
    return response.body.data;
  }

  function setStatus(cardId, status) {
    getDb().prepare('UPDATE task_card SET status = ? WHERE id = ?').run(status, cardId);
  }

  async function createAuthoringFixture(engineer, suffix) {
    const card = await createCard(engineer, suffix);
    const reference = await auth('post', `/api/task-cards/${card.id}/reference-docs`, engineer).send({
      docType: 'CMM',
      refNo: `REF-${suffix}`,
      docRevision: 'Rev 1',
      ataChapter: '32',
    }).expect(200);
    const relation = await auth('post', `/api/task-cards/${card.id}/relations`, engineer).send({
      execDocType: 'SW',
      relatedDocNo: `SW-${suffix}`,
    }).expect(200);
    const step = await addStepAndSignature(card.id);
    const attachment = getDb().prepare(`INSERT INTO attachment
      (kind, original_name, stored_path, mime_type, byte_size, sha256, uploaded_by)
      VALUES ('image', ?, ?, 'image/png', 16, ?, 'E10001')`)
      .run(`${suffix}.png`, `${suffix}.png`, `sha-${suffix}`);
    return {
      card,
      reference: reference.body.data,
      relation: relation.body.data,
      step,
      attachmentId: Number(attachment.lastInsertRowid),
    };
  }

  const authoringOperations = [
    {
      name: 'PUT card save',
      invoke: ({ fixture, engineer }) => auth('put', `/api/task-cards/${fixture.card.id}`, engineer)
        .send({ title: 'Status-gate saved title', reason: '状态闸门保存' }),
    },
    {
      name: 'POST reference document',
      invoke: ({ fixture, engineer }) => auth(
        'post', `/api/task-cards/${fixture.card.id}/reference-docs`, engineer,
      ).send({ docType: 'AMM', refNo: 'REF-NEW', docRevision: 'Rev 2', ataChapter: '32' }),
    },
    {
      name: 'DELETE reference document',
      invoke: ({ fixture, engineer }) => auth(
        'delete',
        `/api/task-cards/${fixture.card.id}/reference-docs/${fixture.reference.id}`,
        engineer,
      ).send({ reason: '状态闸门删除参考文件' }),
    },
    {
      name: 'POST attachment reference',
      invoke: ({ fixture, engineer }) => auth(
        'post', `/api/task-cards/${fixture.card.id}/attachment-references`, engineer,
      ).send({
        stepId: fixture.step.id,
        attachmentId: fixture.attachmentId,
        type: 'image',
        sortOrder: 1,
      }),
    },
    {
      name: 'POST manual relation',
      invoke: ({ fixture, engineer }) => auth(
        'post', `/api/task-cards/${fixture.card.id}/relations`, engineer,
      ).send({ execDocType: 'PC', relatedDocNo: 'PC-STATUS-GATE' }),
    },
    {
      name: 'DELETE manual relation',
      invoke: ({ fixture, engineer }) => auth(
        'delete', `/api/task-cards/${fixture.card.id}/relations/${fixture.relation.id}`, engineer,
      ),
    },
    {
      name: 'POST relation key-info sync',
      invoke: ({ fixture, engineer }) => auth(
        'post', `/api/task-cards/${fixture.card.id}/relations/sync`, engineer,
      ).send({ keyInfo: { acType: '350', partNo: 'PN-STATUS-GATE', serialNo: 'SN-STATUS-GATE' } }),
    },
    {
      name: 'POST batch replace',
      invoke: ({ fixture, manager }) => auth('post', '/api/task-cards/batch-replace', manager).send({
        ids: [fixture.card.id],
        field: 'title',
        from: fixture.card.title,
        to: 'Status-gate batch title',
        reason: '状态闸门批量替换',
      }),
    },
  ];

  const runMainChain = async () => {
    const engineer = await login('E10001');
    const firstManager = await login('E20001');
    const finalManager = await login('E20002');

    const created = await createCard(engineer, 'MAIN', { title: 'Main-chain draft' });
    const saved = await auth('put', `/api/task-cards/${created.id}`, engineer)
      .send({ title: 'Main-chain ready', reason: '完成主链路卡头' })
      .expect(200);
    expect(saved.body.data).toMatchObject({ status: 'New', title: 'Main-chain ready' });

    await auth('post', `/api/task-cards/${created.id}/reference-docs`, engineer).send({
      docType: 'CMM', refNo: 'CMM-17-5', docRevision: 'Rev 1', ataChapter: '32',
    }).expect(200);
    await addStepAndSignature(created.id);
    await auth('post', `/api/task-cards/${created.id}/relations`, engineer).send({
      execDocType: 'SW', relatedDocNo: 'SWS-17-5',
    }).expect(200);

    const ready = await detail(created.id, engineer);
    expect(ready.referenceDocuments).toHaveLength(1);
    expect(ready.steps).toHaveLength(1);
    expect(ready.steps[0].signatureRequirements).toHaveLength(1);
    expect(ready.relations).toEqual([
      expect.objectContaining({ execDocType: 'SW', relatedDocNo: 'SWS-17-5' }),
    ]);
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM capability_list
      WHERE ac_type = '320' AND gear_type = 'MLG' AND skill = 'GR'`).get().count).toBeGreaterThan(0);
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM stage_card_type_constraint
      WHERE card_type = '01' AND allowed_stage = 'RTN'`).get().count).toBe(1);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM task_card WHERE task_no = ? AND revision = 1')
      .get(created.taskNo).count).toBe(1);

    const firstSubmit = await auth('post', `/api/task-cards/${created.id}/submit-review`, engineer)
      .send({ reason: '七项校验首次提交' })
      .expect(200);
    expect(firstSubmit.body.data).toMatchObject({ status: 'UnderReview' });

    const rejected = await auth('post', `/api/task-cards/${created.id}/reject`, firstManager)
      .send({ comment: '补充复核说明' })
      .expect(200);
    expect(rejected.body.data).toMatchObject({ status: 'New' });

    await auth('post', `/api/task-cards/${created.id}/submit-review`, engineer)
      .send({ reason: '补充后重新提交' })
      .expect(200);
    const incumbent = await auth('post', `/api/task-cards/${created.id}/approve`, firstManager)
      .send({ comment: '批准首版以建立生效基线' })
      .expect(200);
    expect(incumbent.body.data).toMatchObject({ revision: 1, status: 'Effective' });

    const revisionResponse = await auth('post', '/api/task-cards/revise', engineer).send({
      ids: [created.id], reason: '建立待审新版本',
    }).expect(200);
    const candidate = revisionResponse.body.data[0];
    expect(candidate).toMatchObject({ taskNo: created.taskNo, revision: 2, status: 'New' });
    const candidateDerivation = await auth('post', `/api/task-cards/${candidate.id}/classification/derive`, engineer).send({}).expect(200);
    await auth('post', `/api/task-cards/${candidate.id}/classification/confirm`, engineer).send({
      classification: 'Gear Inspection', derivationResultId: candidateDerivation.body.data.resultId,
    }).expect(200);

    await auth('put', `/api/task-cards/${candidate.id}`, engineer)
      .send({ title: 'Main-chain revision 2', reason: '修订生效版本' })
      .expect(200);
    await auth('post', `/api/task-cards/${candidate.id}/relations`, engineer).send({
      execDocType: 'SW', relatedDocNo: 'SWS-17-5-R2',
    }).expect(200);
    await auth('post', `/api/task-cards/${candidate.id}/submit-review`, engineer)
      .send({ reason: '新版本七项校验提交' })
      .expect(200);
    await auth('post', `/api/task-cards/${candidate.id}/reject`, firstManager)
      .send({ comment: '新版本退回一次' })
      .expect(200);
    await auth('post', `/api/task-cards/${candidate.id}/submit-review`, engineer)
      .send({ reason: '新版本重新提交' })
      .expect(200);

    const approved = await auth('post', `/api/task-cards/${candidate.id}/approve`, finalManager)
      .send({ comment: '由另一经理批准新版本' })
      .expect(200);
    expect(approved.body.data).toMatchObject({ revision: 2, status: 'Effective' });

    const versions = await auth('get', `/api/task-cards/${candidate.id}/versions`, engineer).expect(200);
    expect(versions.body.data.map(({ revision, status }) => ({ revision, status }))).toEqual([
      { revision: 1, status: 'Superseded' },
      { revision: 2, status: 'Effective' },
    ]);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM task_card WHERE task_no = ? AND status = 'Effective'")
      .get(created.taskNo).count).toBe(1);
    expect(getDb().prepare('SELECT * FROM supersede_record WHERE task_no = ?').all(created.taskNo)).toEqual([
      expect.objectContaining({ superseded_revision: 1, superseding_revision: 2 }),
    ]);

    const reviews = await auth('get', `/api/task-cards/${candidate.id}/reviews`, engineer).expect(200);
    expect(reviews.body.data.map(({ action, reviewer }) => ({ action, reviewer }))).toEqual([
      { action: 'reject', reviewer: 'E20001' },
      { action: 'approve', reviewer: 'E20002' },
    ]);

    // Effective exemptions currently exposed by Task 17: view, copy, revise, and void.
    await auth('get', `/api/task-cards/${candidate.id}`, engineer).expect(200);
    const copied = await auth('post', '/api/task-cards/copy', engineer).send({
      ids: [candidate.id], numbering: { prefix: 'TC-17-5-COPY-', suffix: '', startSeq: 1, step: 1 },
    }).expect(200);
    expect(copied.body.data[0]).toMatchObject({ revision: 1, status: 'New' });

    const revised = await auth('post', '/api/task-cards/revise', engineer).send({
      ids: [candidate.id], reason: '验证生效态可升版',
    }).expect(200);
    expect(revised.body.data[0]).toMatchObject({ revision: 3, status: 'New' });
    const editableRevision = await auth('put', `/api/task-cards/${revised.body.data[0].id}`, engineer)
      .send({ title: 'Editable revision 3', reason: '验证升版后可编辑' })
      .expect(200);
    expect(editableRevision.body.data).toMatchObject({ status: 'New', title: 'Editable revision 3' });

    const voided = await auth('post', `/api/task-cards/${candidate.id}/void`, firstManager)
      .send({ reason: '验证生效态可作废' })
      .expect(200);
    expect(voided.body.data).toMatchObject({ status: 'Void' });

    // Deferred by task ownership: DELETE steps (Task 18.1), release (Task 19.1), and
    // print/export (Task 20.6) are not mounted and are deliberately not asserted here.
  };

  it.each(authoringOperations)(
    'enforces the five-status New-only gate for $name with frozen data unchanged',
    async (operation) => {
      const engineer = await login('E10001');
      const manager = await login('E20001');
      const fixture = await createAuthoringFixture(engineer, operation.name.replace(/\W+/g, '-'));

      for (const status of frozenStatuses) {
        setStatus(fixture.card.id, status);
        const before = await detail(fixture.card.id, engineer);
        const response = await operation.invoke({ fixture, engineer, manager });
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({ code: 422 });
        expect(await detail(fixture.card.id, engineer)).toEqual(before);
      }

      setStatus(fixture.card.id, 'New');
      const before = await detail(fixture.card.id, engineer);
      const response = await operation.invoke({ fixture, engineer, manager });
      expect(response.status).toBe(200);
      expectOk(response);
      expect(await detail(fixture.card.id, engineer)).not.toEqual(before);
    },
  );

  it('returns an exact interface-side trace for save, revise, batch replace, and void', async () => {
    const engineer = await login('E10001');
    const manager = await login('E20001');
    const card = await createCard(engineer, 'TRACE', { title: 'Trace draft' });

    await auth('put', `/api/task-cards/${card.id}`, engineer)
      .send({ title: 'Trace saved', reason: 'trace-save' })
      .expect(200);
    await auth('post', '/api/task-cards/revise', engineer)
      .send({ ids: [card.id], reason: 'trace-revise' })
      .expect(200);
    await auth('post', '/api/task-cards/batch-replace', manager).send({
      ids: [card.id], field: 'title', from: 'Trace saved', to: 'Trace replaced', reason: 'trace-batch',
    }).expect(200);
    await auth('post', `/api/task-cards/${card.id}/void`, manager)
      .send({ reason: 'trace-void' })
      .expect(200);

    const response = await auth('get', `/api/task-cards/${card.id}/change-records`, engineer).expect(200);
    expect(response.body.data).toHaveLength(4);
    expect(response.body.data.map(({ changeType, field, reason }) => ({ changeType, field, reason }))).toEqual([
      { changeType: 'edit', field: 'title', reason: 'trace-save' },
      { changeType: 'revise', field: 'revision', reason: 'trace-revise' },
      { changeType: 'batch_replace', field: 'title', reason: 'trace-batch' },
      { changeType: 'void', field: 'status', reason: 'trace-void' },
    ]);

    // Process-step deletion is the fifth Property 35 operation, but its HTTP route belongs to
    // unchecked Task 18.1. It is intentionally deferred rather than bypassed or implemented here.
  });

  // Keep this transaction-heavy scenario last. On Windows/Node 24, a Vitest fork that
  // continues with more tests after this scenario can fast-fail with 0xC0000409.
  it(
    'runs create/save/seven-check review/reject/resubmit/approve and demotes the incumbent first',
    runMainChain,
  );
});


describe('商务分类普通写接口防绕过', () => {
  it('POST/PUT 显式拒绝 commercialClassification 与 outsourceSubtype', async () => {
    const engineer = await login('E10001');
    const create = await auth('post', '/api/task-cards', engineer).send({
      taskNo: 'CLS-BYPASS-CREATE', title: 'bypass', cardType: '04',
      commercialClassification: 'Routine',
    }).expect(400);
    expect(create.body.data.rejection).toBe('COMMERCIAL_CLASSIFICATION_DIRECT_WRITE_FORBIDDEN');

    const id = cardId('TC-2026-0002');
    const before = getDb().prepare('SELECT commercial_classification, outsource_subtype FROM task_card WHERE id = ?').get(id);
    const update = await auth('put', `/api/task-cards/${id}`, engineer).send({
      commercialClassification: 'Outsource', outsourceSubtype: 'L sub', reason: 'bypass',
    }).expect(400);
    expect(update.body.data.rejection).toBe('COMMERCIAL_CLASSIFICATION_DIRECT_WRITE_FORBIDDEN');
    expect(getDb().prepare('SELECT commercial_classification, outsource_subtype FROM task_card WHERE id = ?').get(id)).toEqual(before);
  });
});