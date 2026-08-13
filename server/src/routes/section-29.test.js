import request from 'supertest';
import XLSX from 'xlsx';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { clearSessions } from '../middleware/user-context.js';

let app;
beforeEach(() => { resetDb(':memory:'); migrate(); seed(); clearSessions(); app = createApp(); });
afterAll(() => { clearSessions(); closeDb(); });
async function login(staffNo = 'E10001') {
  return (await request(app).post('/api/session').send({ staffNo }).expect(200)).body.data.token;
}
function auth(method, path, token) {
  return request(app)[method](path).set('Authorization', `Bearer ${token}`);
}
function cardId(taskNo = 'TC-2026-0002') {
  return getDb().prepare('SELECT id FROM task_card WHERE task_no = ?').get(taskNo).id;
}
function workbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Steps');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

describe('Section 29 backend routes', () => {
  it('filters with same-step EXISTS semantics, projects CMM references, and keeps distinct totals', async () => {
    const token = await login();
    const id = cardId();
    getDb().prepare("UPDATE process_step SET skill = 'GR', description_zh = 'needle' WHERE card_id = ?").run(id);
    getDb().prepare(`INSERT INTO reference_document
      (card_id, doc_type, ref_no, doc_revision, ata_chapter) VALUES (?, 'CMM', 'CMM-32-10', 'Rev 4', '32')`)
      .run(id);
    const response = await auth('get', '/api/task-cards', token).query({
      cmm: '32-10', processSkills: 'GR,QC', processDescription: 'needle', page: 1, pageSize: 1,
    }).expect(200);
    expect(response.body.data).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(response.body.data.list[0].id).toBe(id);
    expect(response.body.data.list[0].cmmRevision).toContain('32-11-51 Rev 12');
    expect(response.body.data.list[0].cmmRevision).toContain('CMM-32-10 Rev 4');
    await auth('get', '/api/task-cards', token).query({ page: 0 }).expect(400);
  });

  it('inserts and deep-copies after a source, renumbers safely, and protects the final step', async () => {
    const token = await login();
    const id = cardId();
    const source = (await auth('post', `/api/task-cards/${id}/steps`, token).send({
      descriptionZh: 'source', components: [{ type: 'image', payload: { attachmentId: 77,
        annotations: [{ type: 'rect', points: [[0, 0], [2, 2]], color: 'red' }] } }],
      captureItems: [{ type: 'text', itemKey: 'X', config: { value: 'x' } }],
      signatureRequirements: [{ signatureRole: 'QC' }],
    }).expect(200)).body.data;
    const copied = (await auth('post', `/api/task-cards/${id}/steps/${source.id}/copy`, token)
      .send({ reason: 'copy complete aggregate' }).expect(200)).body.data;
    expect(copied).toMatchObject({ descriptionZh: 'source' });
    expect(copied.id).not.toBe(source.id);
    expect(copied.components[0].id).not.toBe(source.components[0].id);
    expect(copied.components[0].payload).toEqual(source.components[0].payload);
    const detail = (await auth('get', `/api/task-cards/${id}`, token).expect(200)).body.data;
    expect(detail.steps.map(({ processId }) => processId)).toEqual(['A', 'B', 'C']);
    expect(detail.steps.findIndex(({ id: stepId }) => stepId === copied.id))
      .toBe(detail.steps.findIndex(({ id: stepId }) => stepId === source.id) + 1);

    const created = (await auth('post', '/api/task-cards', token).send({
      taskNo: 'SECTION-29-LAST', title: 'last step', cardType: '01',
    }).expect(200)).body.data;
    const only = (await auth('post', `/api/task-cards/${created.id}/steps`, token)
      .send({ descriptionZh: 'only' }).expect(200)).body.data;
    await auth('delete', `/api/task-cards/${created.id}/steps/${only.id}`, token)
      .send({ reason: 'must reject' }).expect(422);
  });
  it('enforces one structured table per type and atomically imports append/replace workbooks', async () => {
    const token = await login();
    const id = cardId();
    const step = (await auth('post', `/api/task-cards/${id}/steps`, token)
      .send({ descriptionZh: 'tables', components: [{ type: 'tool', payload: {
        rows: [{ partNo: 'T1', description: 'Tool' }],
      } }] }).expect(200)).body.data;
    await auth('put', `/api/task-cards/${id}/steps/${step.id}`, token).send({
      reason: 'duplicate table', components: [
        ...step.components,
        { type: 'tool', payload: { rows: [{ partNo: 'T2', description: 'Other' }] } },
      ],
    }).expect(400);
    const replacedTable = (await auth('put', `/api/task-cards/${id}/steps/${step.id}`, token).send({
      reason: 'replace table',
      components: [{ type: 'tool', payload: { rows: [{ partNo: 'T2', description: 'Other' }] } }],
    }).expect(200)).body.data;
    expect(replacedTable.components).toHaveLength(1);
    expect(replacedTable.components[0].payload.rows[0].partNo).toBe('T2');

    const appended = await auth('post', `/api/task-cards/${id}/steps/import`, token)
      .field('mode', 'append').attach('file', workbook([
        ['Step', 'Inspection Item'], ['line 1\nline 2', 'inspect\nvalue'],
      ]), 'append.xlsx').expect(200);
    expect(appended.body.data).toMatchObject({ mode: 'append', successCount: 1, failureCount: 0 });
    await auth('post', `/api/task-cards/${id}/steps/import`, token)
      .field('mode', 'replace').attach('file', workbook([['replacement', 'item']]), 'replace.xlsx')
      .expect(400);
    const replaced = await auth('post', `/api/task-cards/${id}/steps/import`, token)
      .field('mode', 'replace').field('reason', 'replace all')
      .attach('file', workbook([['replacement', 'item']]), 'replace.xlsx').expect(200);
    expect(replaced.body.data).toMatchObject({ mode: 'replace', totalCount: 1 });
    const detail = (await auth('get', `/api/task-cards/${id}`, token).expect(200)).body.data;
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0].captureItems[0].config).toEqual({ value: 'item' });
  });

  it('returns descending complete history and exact historical print with exact permissions', async () => {
    const engineer = await login();
    const sourceId = cardId('TC-2026-0001');
    getDb().prepare(`INSERT INTO card_relation
      (card_id, exec_doc_type, related_doc_no, origin, key_info_snapshot, created_by)
      VALUES (?, 'SW', 'SWS-HISTORY-1', 'manual', '{"taskNo":"TC-2026-0001"}', 'E10001')`)
      .run(sourceId);
    const revised = (await auth('post', '/api/task-cards/revise', engineer)
      .send({ ids: [sourceId], reason: 'history reason' }).expect(200)).body.data[0];
    await auth('put', `/api/task-cards/${revised.id}`, engineer)
      .send({ title: 'revision two', reason: 'change title' }).expect(200);

    const versions = await auth('get', `/api/task-cards/${revised.id}/versions`, engineer).expect(200);
    expect(versions.body.data.map(({ revision }) => revision)).toEqual([2, 1]);
    expect(versions.body.data[0]).toHaveProperty('reviews');
    const snapshot = await auth('get', `/api/task-cards/${revised.id}/versions/1/snapshot`, engineer)
      .expect(200);
    expect(snapshot.body.data).toMatchObject({ id: sourceId, revision: 1 });
    expect(snapshot.body.data.steps[0]).toHaveProperty('components');
    expect(snapshot.body.data.relations).toEqual([
      expect.objectContaining({ execDocType: 'SW', relatedDocNo: 'SWS-HISTORY-1' }),
    ]);
    const revisedSnapshot = await auth(
      'get', `/api/task-cards/${revised.id}/versions/${revised.id}/snapshot`, engineer,
    ).expect(200);
    expect(revisedSnapshot.body.data.relations).toEqual([
      expect.objectContaining({ execDocType: 'SW', relatedDocNo: 'SWS-HISTORY-1' }),
    ]);
    const diff = await auth('get', `/api/task-cards/${revised.id}/versions/${revised.id}/diff`, engineer)
      .expect(200);
    expect(diff.body.data).toMatchObject({ revision: 2, previousRevision: 1 });
    expect(diff.body.data.diff.headerChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'title' }),
    ]));
    const print = await auth('get', `/api/task-cards/${revised.id}/versions/1/print`, engineer).expect(200);
    expect(print.body.data.model.taskNo).toBe('TC-2026-0001');
    expect(print.body.data.model.title).not.toBe('revision two');
    const batch = await auth('post', '/api/task-cards/print', engineer)
      .send({ ids: [sourceId, revised.id] }).expect(200);
    expect(batch.body.data.map(({ pageBreakAfter }) => pageBreakAfter)).toEqual([true, false]);

    const manager = await login('E20001');
    await auth('post', `/api/task-cards/${revised.id}/steps`, manager)
      .send({ descriptionZh: 'forbidden' }).expect(403);
    await auth('get', `/api/task-cards/${revised.id}/versions/1/snapshot`, manager).expect(200);
    await auth('get', `/api/task-cards/${revised.id}/versions/1/print`, manager).expect(200);
  });
});
