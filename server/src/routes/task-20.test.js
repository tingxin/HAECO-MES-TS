import fs from 'node:fs';
import request from 'supertest';
import XLSX from 'xlsx';
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

function auth(method, url, token) {
  return request(app)[method](url).set('Authorization', `Bearer ${token}`);
}

function cardId(taskNo) {
  return getDb().prepare('SELECT id FROM task_card WHERE task_no = ?').get(taskNo).id;
}

function rawParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

const validMigrationRow = (taskNo) => ({
  task_no: taskNo,
  title: `迁移工卡 ${taskNo}`,
  card_type: '01',
  ac_type: '320',
  gear_type: 'MLG',
  stage: 'NRC',
  skill: 'AS',
});
describe('Section 20 configuration routes', () => {
  it('returns all enums and runtime stage defaults/selectable ranges, including WFD for 01-10', async () => {
    const token = await login('E10001');
    const enums = await auth('get', '/api/enums', token).expect(200);
    expect(enums.body.data).toEqual(expect.objectContaining({
      derivationPriority: expect.any(Array),
      signatureRole: expect.any(Array),
      role: expect.any(Array),
      permissionPoint: expect.any(Array),
    }));

    const response = await auth('get', '/api/stage-constraints', token).expect(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      constraints: expect.any(Array),
      crosscut: expect.any(Array),
      stageOptions: expect.any(Array),
    }));
    for (const type of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']) {
      expect(response.body.data.byCardType[type].selectableStages).toContain('WFD');
      expect(response.body.data.byCardType[type]).toHaveProperty('defaultStage');
    }
  });

  it('uses config_write once, writes exactly one denial, validates enums, and atomically changes real stage validation', async () => {
    const engineer = await login('E10001');
    const manager = await login('E20001');
    const id = cardId('TC-2026-0002');

    await auth('put', `/api/task-cards/${id}`, engineer)
      .send({ stage: 'RTN', reason: '配置变更前验证' })
      .expect(200);

    const original = (await auth('get', '/api/stage-constraints', manager).expect(200)).body.data;
    await auth('put', '/api/stage-constraints', engineer)
      .send({ constraints: original.constraints, crosscut: original.crosscut })
      .expect(403);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM access_denial_log WHERE staff_no = 'E10001' AND permission_point = 'config_write'").get().count).toBe(1);

    const invalid = structuredClone({ constraints: original.constraints, crosscut: original.crosscut });
    invalid.constraints[0].allowedStage = 'INVALID';
    await auth('put', '/api/stage-constraints', manager).send(invalid).expect(400);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM stage_card_type_constraint').get().count)
      .toBe(original.constraints.length);

    const changed = {
      constraints: original.constraints.filter((row) => !(row.cardType === '04' && row.allowedStage === 'RTN')),
      crosscut: original.crosscut,
    };
    await auth('put', '/api/stage-constraints', manager).send(changed).expect(200);
    await auth('put', `/api/task-cards/${id}`, engineer)
      .send({ stage: 'RTN', reason: '配置变更后验证' })
      .expect(400);
  });
  it('keeps capability_write independent from config_write', async () => {
    const manager = await login('E20001');
    const qa = await login('E60001');
    const capabilities = (await auth('get', '/api/capabilities', qa).expect(200)).body.data;

    await auth('put', '/api/capabilities', manager).send({ capabilities }).expect(403);
    await auth('put', '/api/capabilities', qa).send({ capabilities }).expect(200);

    const stages = (await auth('get', '/api/stage-constraints', qa).expect(200)).body.data;
    await auth('put', '/api/stage-constraints', qa)
      .send({ constraints: stages.constraints, crosscut: stages.crosscut })
      .expect(403);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM access_denial_log WHERE staff_no = 'E60001' AND permission_point = 'config_write'").get().count).toBe(1);
  });

  it('persists complete pending snapshots, rejects stale confirmation, preserves authority, and serves latest/history', async () => {
    const engineer = await login('E10001');
    const manager = await login('E20001');
    const id = cardId('TC-2026-0002');
    getDb().prepare("UPDATE task_card SET commercial_classification = 'Routine' WHERE id = ?").run(id);
    getDb().prepare(`INSERT INTO classification_source
      (card_id, plan_dummy_job, nrc_originating_doc)
      VALUES (?, ?, ?)`)
      .run(id, JSON.stringify({ isDummyJob: true, planRef: 'PLAN-04' }), JSON.stringify({ docNo: 'NRC-04' }));

    const first = await auth('post', `/api/task-cards/${id}/classification/derive`, engineer).send({}).expect(200);
    expect(first.body.data).toMatchObject({ status: 'requires_confirmation', recommendedClassification: 'Dummy Job' });
    expect(first.body.data.candidates.map((item) => item.classification)).toEqual(['Dummy Job', 'NRC', 'Routine']);
    expect(getDb().prepare('SELECT commercial_classification FROM task_card WHERE id = ?').get(id).commercial_classification).toBe('Routine');

    const priority = (await auth('get', '/api/derivation-priority', manager).expect(200)).body.data.all;
    const reordered = priority.map((row) => ({
      ...row,
      tierOrder: row.tierCode === 'P1_PlanSetting' ? 2 : row.tierCode === 'P2_OriginatingDoc' ? 1 : row.tierOrder,
    }));
    await auth('put', '/api/derivation-priority', manager).send({ tiers: reordered }).expect(200);
    const second = await auth('post', `/api/task-cards/${id}/classification/derive`, engineer).send({}).expect(200);
    expect(second.body.data.recommendedClassification).toBe('NRC');

    const unbound = await auth('post', `/api/task-cards/${id}/classification/confirm`, engineer)
      .send({ classification: 'NRC' }).expect(400);
    expect(unbound.body.data.rejection).toBe('DERIVATION_RESULT_REQUIRED');
    const stale = await auth('post', `/api/task-cards/${id}/classification/confirm`, engineer)
      .send({ classification: 'NRC', derivationResultId: first.body.data.resultId }).expect(409);
    expect(stale.body.data.rejection).toBe('STALE_DERIVATION_RESULT');
    const confirmed = await auth('post', `/api/task-cards/${id}/classification/confirm`, engineer)
      .send({ classification: 'NRC', derivationResultId: second.body.data.resultId }).expect(200);
    expect(confirmed.body.data).toMatchObject({ classification: 'NRC', derivationResultId: second.body.data.resultId, isManualConfirmed: true });

    const latest = await auth('get', `/api/task-cards/${id}/classification/latest`, engineer).expect(200);
    const history = await auth('get', `/api/task-cards/${id}/classification/history`, engineer).expect(200);
    expect(latest.body.data).toMatchObject({ status: 'confirmed', classification: 'NRC', candidates: expect.any(Array) });
    expect(history.body.data).toHaveLength(3);
  });
});
describe('Section 20 read-only integration contracts', () => {
  it('serves all integration paths with demo/missing messages and exposes no write endpoint', async () => {
    const token = await login('E10001');
    const id = cardId('TC-2026-0001');
    const reads = [
      `/api/ppc/process-data?cardId=${id}`,
      `/api/process-data?pid=PID-2026-0001&cardId=${id}`,
      `/api/ppc/schedule?pid=PID-2026-0001&cardId=${id}`,
      '/api/lot-lists/LT-2026-001/bases',
    ];
    for (const url of reads) {
      const response = await auth('get', url, token).expect(200);
      expect(response.body).toMatchObject({ code: 0, message: expect.stringContaining('演示数据') });
    }

    const missing = await auth('get', '/api/process-data?pid=DOES-NOT-EXIST', token).expect(200);
    expect(missing.body).toEqual({
      code: 0,
      message: expect.stringContaining('集成数据缺失'),
      data: {
        partNo: null,
        partSn: null,
        partDesc: null,
        operationType: null,
        operation: null,
      },
    });
    const missingSources = await auth('get', '/api/classification-sources?cardId=999999', token).expect(200);
    expect(missingSources.body).toEqual({
      code: 0,
      message: expect.stringContaining('集成数据缺失'),
      data: {
        planDummyJob: null,
        nrcOriginatingDoc: null,
        outsourceEntry: null,
        partNature: null,
        packageDivision: null,
      },
    });
    const missingLot = await auth('get', '/api/lot-lists/DOES-NOT-EXIST/bases', token).expect(200);
    expect(missingLot.body).toEqual({ code: 0, message: expect.stringContaining('集成数据缺失'), data: [] });

    for (const url of ['/api/ppc/process-data', '/api/process-data', '/api/ppc/schedule', '/api/lot-lists/LT-2026-001/bases']) {
      for (const method of ['post', 'put', 'patch', 'delete']) {
        await auth(method, url, token).send({}).expect(404);
      }
    }
  });

  it('reads TPC, PID scope, P1-P5 sources and in-progress work-package references from mock tables', async () => {
    const token = await login('E10001');
    const id = cardId('TC-2026-0001');
    const tpc = await auth('get', '/api/tpc/documents?keyword=MLG', token).expect(200);
    expect(tpc.body.data[0]).toEqual(expect.objectContaining({ refNo: '32-11-51' }));
    const scope = await auth('get', '/api/pid/PID-2026-0001/scope', token).expect(200);
    expect(scope.body.data.scope).toEqual(expect.objectContaining({ acType: '320' }));
    const sources = await auth('get', `/api/classification-sources?cardId=${id}`, token).expect(200);
    expect(sources.body.data).toEqual(expect.objectContaining({
      planDummyJob: expect.any(Object),
      nrcOriginatingDoc: expect.any(Object),
      outsourceEntry: null,
      partNature: null,
      packageDivision: expect.any(Object),
    }));
    const refs = await auth('get', `/api/work-packages/in-progress-refs?cardId=${id}`, token).expect(200);
    expect(refs.body.data).toEqual([expect.objectContaining({ packageRef: 'WP-IN-PROGRESS-001' })]);
  });
});
describe('Section 20 documents, output, migration and BOM', () => {
  it('copies SWS content exactly and rejects duplicate document numbers', async () => {
    const token = await login('E10001');
    const source = getDb().prepare("SELECT * FROM exec_document WHERE doc_no = 'SWS-2026-0001'").get();
    const copied = await auth('post', '/api/exec-documents/copy', token)
      .send({ id: source.id, newDocNo: 'SWS-2026-COPY' })
      .expect(200);
    expect(copied.body.data).toMatchObject({ execDocType: source.exec_doc_type, docNo: 'SWS-2026-COPY', content: source.content });
    await auth('post', '/api/exec-documents/copy', token)
      .send({ id: source.id, newDocNo: 'SWS-2026-COPY' })
      .expect(409);
    const detail = await auth('get', `/api/exec-documents/${copied.body.data.id}`, token).expect(200);
    expect(detail.body.data.content).toBe(source.content);
  });

  it('returns print triple without cardType and projects signature columns from live configuration', async () => {
    const token = await login('E20001');
    const id = cardId('TC-2026-0001');
    const expected = getDb().prepare(`SELECT sr.signature_role, sr.stamp_required, sr.date_required
      FROM signature_requirement sr JOIN process_step ps ON ps.id = sr.step_id
      WHERE ps.card_id = ? AND ps.process_id = 'A' ORDER BY sr.sort_order`).all(id);
    const response = await auth('get', `/api/task-cards/${id}/print`, token).expect(200);
    expect(Object.keys(response.body.data).sort()).toEqual(['model', 'templateBody', 'templateId']);
    expect(response.body.data.model).not.toHaveProperty('cardType');
    expect(response.body.data.model.steps[0].signatures).toEqual(expected.map((row) => ({
      signatureRole: row.signature_role,
      stampRequired: Boolean(row.stamp_required),
      dateRequired: Boolean(row.date_required),
      signedBy: null,
      stampId: null,
      signedAt: null,
    })));
  });

  it('exports raw CSV with UTF-8 BOM and a safe attachment disposition', async () => {
    const token = await login('E20001');
    const id = cardId('TC-2026-0001');
    const response = await auth('get', `/api/task-cards/export?mode=key&ids=${id}`, token)
      .buffer(true)
      .parse(rawParser)
      .expect(200);
    expect(response.body.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="task-cards\.csv"/);
  });
  it('imports CSV and Excel with failure isolation and count conservation, and reports byCategory', async () => {
    const token = await login('E10001');
    const csv = [
      'task_no,title,card_type,ac_type,gear_type,stage,skill',
      'MIG-CSV-001,CSV success,01,320,MLG,NRC,AS',
      'MIG-CSV-002,,01,320,MLG,NRC,AS',
    ].join('\n');
    const csvResponse = await auth('post', '/api/migrations', token)
      .field('sourceChannel', 'csv')
      .attach('file', Buffer.from(csv), { filename: 'cards.csv', contentType: 'text/csv' })
      .expect(200);
    expect(csvResponse.body.data).toMatchObject({ totalCount: 2, successCount: 1, failureCount: 1 });
    expect(csvResponse.body.data.successCount + csvResponse.body.data.failureCount).toBe(csvResponse.body.data.totalCount);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM task_card WHERE task_no = 'MIG-CSV-001'").get().count).toBe(1);

    const report = await auth('get', `/api/migrations/${csvResponse.body.data.batchId}/report`, token).expect(200);
    expect(report.body.data.records).toHaveLength(2);
    expect(report.body.data.batch.successCount + report.body.data.batch.failureCount).toBe(report.body.data.batch.totalCount);
    expect(report.body.data.byCategory.required_missing).toBe(1);

    const sheet = XLSX.utils.json_to_sheet([validMigrationRow('MIG-XLSX-001')]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Cards');
    const excel = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const excelResponse = await auth('post', '/api/migrations', token)
      .attach('file', excel, { filename: 'cards.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      .expect(200);
    expect(excelResponse.body.data).toMatchObject({ totalCount: 1, successCount: 1, failureCount: 0 });
  });

  it('confirms edited Word/RTF rows through the shared migration path and reports failures by reason', async () => {
    const token = await login('E10001');
    const denied = await login('E60001');
    await auth('post', '/api/migrations/confirm', denied)
      .send({ sourceChannel: 'word', rows: [] })
      .expect(403);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM access_denial_log WHERE staff_no = 'E60001' AND permission_point = 'migration_run'").get().count).toBe(1);

    const word = await auth('post', '/api/migrations/confirm', token).send({
      sourceChannel: 'word',
      sourceName: 'legacy.docx',
      rows: [
        validMigrationRow('MIG-WORD-001'),
        { ...validMigrationRow('MIG-WORD-002'), title: '' },
        { ...validMigrationRow('MIG-WORD-003'), ac_type: 'INVALID' },
      ],
    }).expect(200);
    expect(word.body.data).toMatchObject({
      totalCount: 3,
      successCount: 1,
      failureCount: 2,
      byCategory: { required_missing: 1, enum_invalid: 1 },
    });
    expect(word.body.data.records).toHaveLength(3);
    expect(getDb().prepare('SELECT source_channel, source_name, executed_by FROM migration_batch WHERE id = ?')
      .get(word.body.data.batchId)).toEqual({
      source_channel: 'word',
      source_name: 'legacy.docx',
      executed_by: 'E10001',
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM task_card WHERE task_no = 'MIG-WORD-001'").get().count).toBe(1);

    const report = await auth('get', `/api/migrations/${word.body.data.batchId}/report`, token).expect(200);
    expect(report.body.data.byCategory).toMatchObject({ required_missing: 1, enum_invalid: 1 });
    expect(report.body.data.records.map(({ failureCategory }) => failureCategory).filter(Boolean).sort())
      .toEqual(['enum_invalid', 'required_missing']);

    const rtf = await auth('post', '/api/migrations/confirm', token).send({
      sourceChannel: 'rtf',
      sourceName: 'legacy.rtf',
      rows: [validMigrationRow('MIG-RTF-001')],
    }).expect(200);
    expect(rtf.body.data).toMatchObject({ totalCount: 1, successCount: 1, failureCount: 0 });
    expect(getDb().prepare('SELECT source_channel FROM migration_batch WHERE id = ?').get(rtf.body.data.batchId))
      .toEqual({ source_channel: 'rtf' });

    await auth('post', '/api/migrations/confirm', token)
      .send({ sourceChannel: 'excel', rows: [] })
      .expect(400);
    await auth('post', '/api/migrations/confirm', token)
      .send({ sourceChannel: 'word', rows: null })
      .expect(400);
  });

  it('previews real Word and RTF without persistence; RTF output is escaped plain text', async () => {
    const token = await login('E10001');
    const before = getDb().prepare('SELECT COUNT(*) AS count FROM task_card').get().count;
    const docxPath = new URL('../../node_modules/mammoth/test/test-data/single-paragraph.docx', import.meta.url);
    const word = await auth('post', '/api/migrations', token)
      .attach('file', fs.readFileSync(docxPath), { filename: 'preview.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      .expect(200);
    expect(word.body.data).toEqual(expect.objectContaining({ rawHtml: expect.any(String), candidateSteps: expect.any(Array) }));

    const rtfSource = String.raw`{\rtf1\ansi First step\par <script>alert(1)</script>}`;
    const rtf = await auth('post', '/api/migrations', token)
      .attach('file', Buffer.from(rtfSource), { filename: 'preview.rtf', contentType: 'application/rtf' })
      .expect(200);
    expect(rtf.body.data.rawText).toContain('<script>');
    expect(rtf.body.data.rawHtml).not.toContain('<script>');
    expect(rtf.body.data.rawHtml).toContain('&lt;script&gt;');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM task_card').get().count).toBe(before);
  });
  it('refreshes and returns both BOM source forms, and supports lot-link add/delete/list', async () => {
    const reader = await login('E10001');
    const irId = cardId('TC-2026-0002');
    const lotId = cardId('TC-2026-0003');

    const ir = await auth('get', `/api/task-cards/${irId}/bom-bases`, reader).expect(200);
    expect(ir.body.data).toEqual([expect.objectContaining({
      taskNo: 'TC-2026-0002', taskTitle: 'IR 检查工卡 / IR Inspection',
      source: 'ir_card', baseNumber: 'BASE-320-MLG-001', lotNumber: null,
    })]);
    const lot = await auth('get', `/api/task-cards/${lotId}/bom-bases`, reader).expect(200);
    expect(lot.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'lot_list', baseNumber: 'BASE-320-MLG-101', lotNumber: 'LOT-2026-0001' }),
      expect.objectContaining({ source: 'lot_list', baseNumber: 'BASE-320-MLG-103', lotNumber: 'LOT-2026-0001' }),
    ]));

    const existingLinks = await auth('get', `/api/task-cards/${lotId}/lot-links`, reader).expect(200);
    expect(existingLinks.body.data).toEqual([
      expect.objectContaining({ cardId: lotId, lotNumber: 'LOT-2026-0001', lotListRef: 'LT-2026-001' }),
    ]);

    const added = await auth('post', `/api/task-cards/${lotId}/lot-links`, reader)
      .send({ lotNumber: 'LOT-2026-0002', lotListRef: 'LT-2026-002' })
      .expect(200);
    const linksAfterAdd = await auth('get', `/api/task-cards/${lotId}/lot-links`, reader).expect(200);
    expect(linksAfterAdd.body.data).toContainEqual(expect.objectContaining({
      id: added.body.data.id, lotNumber: 'LOT-2026-0002', lotListRef: 'LT-2026-002',
    }));
    const afterAdd = await auth('get', `/api/task-cards/${lotId}/bom-bases`, reader).expect(200);
    expect(afterAdd.body.data).toContainEqual(expect.objectContaining({ baseNumber: 'BASE-777-NLG-201', source: 'lot_list' }));
    await auth('delete', `/api/task-cards/${lotId}/lot-links/${added.body.data.id}`, reader).expect(200);
    const afterDelete = await auth('get', `/api/task-cards/${lotId}/bom-bases`, reader).expect(200);
    expect(afterDelete.body.data.some((row) => row.baseNumber === 'BASE-777-NLG-201')).toBe(false);
  });

  it('reads every remaining configuration table and rejects an illegal print-template enum', async () => {
    const reader = await login('E10001');
    const manager = await login('E20001');
    for (const url of ['/api/card-type-commercial-map', '/api/derivation-priority', '/api/capabilities', '/api/print-templates', '/api/system-parameters']) {
      const response = await auth('get', url, reader).expect(200);
      expect(response.body.code).toBe(0);
    }
    const template = (await auth('get', '/api/print-templates', reader).expect(200)).body.data[0];
    await auth('put', `/api/print-templates/${template.id}`, manager)
      .send({ targetKind: 'card_type', targetCode: '99' })
      .expect(400);
  });
});
