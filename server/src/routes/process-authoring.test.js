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

async function login(staffNo = 'E10001') {
  const response = await request(app).post('/api/session').send({ staffNo }).expect(200);
  return response.body.data.token;
}

function auth(method, path, token) {
  return request(app)[method](path).set('Authorization', `Bearer ${token}`);
}

function editableCardId() {
  return getDb().prepare("SELECT id FROM task_card WHERE task_no = 'TC-2026-0002'").get().id;
}

async function addStep(token, cardId, body = {}) {
  const response = await auth('post', `/api/task-cards/${cardId}/steps`, token)
    .send({ skill: 'GR', descriptionZh: '基础工序', ...body })
    .expect(200);
  return response.body.data;
}
describe('task 18.1 process-step endpoints', () => {
  it('creates, saves nested content, strips operation, reorders, and records deletion', async () => {
    const token = await login();
    const cardId = editableCardId();
    const first = await addStep(token, cardId, {
      operation: 'CLIENT-MUST-NOT-WRITE',
      captureItems: [{ type: 'text', itemKey: 'PN', config: { maxLength: 20 }, required: true }],
      components: [{ type: 'table', payload: { columns: ['A'], rows: [['1']] }, sortOrder: 1 }],
    });

    expect(first.processId).toBeTruthy();
    expect(first).not.toHaveProperty('barcode');
    expect(first.operation).toBeNull();
    expect(first.captureItems[0]).toMatchObject({ type: 'text', config: { maxLength: 20 } });
    expect(first.components[0]).toMatchObject({ type: 'table', payload: { columns: ['A'], rows: [['1']] } });

    const source = getDb().prepare(`SELECT pid_no, card_id, step_ref, part_no, part_sn,
      part_desc, operation_type, operation FROM process_data WHERE operation IS NOT NULL LIMIT 1`).get();
    const processData = await auth('get', '/api/process-data', token).query({
      pid: source.pid_no,
      cardId: source.card_id,
      ...(source.step_ref === null ? {} : { stepId: source.step_ref }),
    }).expect(200);
    expect(processData.body.data).toEqual({
      partNo: source.part_no,
      partSn: source.part_sn,
      partDesc: source.part_desc,
      operationType: source.operation_type,
      operation: source.operation,
    });

    const saved = await auth('put', `/api/task-cards/${cardId}/steps/${first.id}`, token).send({
      reason: '完善工序内容',
      operation: 'STILL-READONLY',
      descriptionEn: 'Updated step',
      captureItems: [{ ...first.captureItems[0], config: { maxLength: 40 } }],
      components: [{ ...first.components[0], payload: { columns: ['B'], rows: [['2']] } }],
    }).expect(200);
    expect(saved.body.data).toMatchObject({ descriptionEn: 'Updated step', operation: null });
    expect(saved.body.data.captureItems[0].config).toEqual({ maxLength: 40 });
    expect(saved.body.data.components[0].payload).toEqual({ columns: ['B'], rows: [['2']] });

    const second = await addStep(token, cardId, { descriptionZh: '第二工序' });
    const beforeReorder = await auth('get', `/api/task-cards/${cardId}`, token).expect(200);
    const remainingIds = beforeReorder.body.data.steps
      .map((step) => step.id)
      .filter((id) => id !== first.id && id !== second.id);
    const reordered = await auth('post', `/api/task-cards/${cardId}/steps/reorder`, token)
      .send({ orderedStepIds: [second.id, first.id, ...remainingIds], reason: '调整执行顺序' })
      .expect(200);
    expect(reordered.body.data.slice(0, 2).map((step) => step.id)).toEqual([second.id, first.id]);

    await auth('delete', `/api/task-cards/${cardId}/steps/${first.id}`, token)
      .send({ reason: '删除不适用工序' })
      .expect(200);
    const replacement = await addStep(token, cardId, { descriptionZh: '删除后新增工序' });
    expect(replacement.processId).toBeTruthy();
    expect(replacement.processId).not.toBe(second.processId);
    const records = await auth('get', `/api/task-cards/${cardId}/change-records`, token).expect(200);
    expect(records.body.data.some((entry) => entry.changeType === 'delete')).toBe(true);
  });
});
describe('task 18.2 signature and safety endpoints', () => {
  it('maintains per-step signatures, exposes the card union, and persists safety JSON', async () => {
    const token = await login();
    const cardId = editableCardId();
    const first = await addStep(token, cardId);
    const second = await addStep(token, cardId);

    const operator = await auth(
      'post', `/api/task-cards/${cardId}/steps/${first.id}/signature-requirements`, token,
    ).send({ signatureRole: 'Operator', stampRequired: true, dateRequired: true, sortOrder: 1 }).expect(200);
    await auth(
      'post', `/api/task-cards/${cardId}/steps/${second.id}/signature-requirements`, token,
    ).send({ signatureRole: 'QC', stampRequired: false, dateRequired: true, sortOrder: 1 }).expect(200);

    const union = await auth('get', `/api/task-cards/${cardId}/signature-requirements`, token).expect(200);
    expect(union.body.data.map((entry) => entry.signatureRole)).toEqual(['Operator', 'QC']);

    const safety = await auth('put', `/api/task-cards/${cardId}/steps/${first.id}/safety`, token).send({
      safetyWarning: '先确认设备已断电',
      visualCue: { type: 'image', attachmentId: 99 },
      repairTips: '使用绝缘工具',
      isCritical: true,
      operation: 'ignored',
      reason: '增加关键工序提示',
    }).expect(200);
    expect(safety.body.data).toMatchObject({
      safetyWarning: '先确认设备已断电',
      visualCue: { type: 'image', attachmentId: 99 },
      repairTips: '使用绝缘工具',
      isCritical: 1,
      operation: null,
    });

    await auth(
      'delete',
      `/api/task-cards/${cardId}/steps/${first.id}/signature-requirements/${operator.body.data.id}`,
      token,
    ).send({ reason: '签署职责调整' }).expect(200);
    const remaining = await auth('get', `/api/task-cards/${cardId}/signature-requirements`, token).expect(200);
    expect(remaining.body.data.map((entry) => entry.signatureRole)).toEqual(['QC']);
  });
});
describe('task 18.3 step-template and workbook endpoints', () => {
  it('creates/applies a reusable template and imports validated workbook rows independently', async () => {
    const token = await login();
    const cardId = editableCardId();
    const target = await addStep(token, cardId, { descriptionZh: '待套用' });

    const created = await auth('post', '/api/step-templates', token).send({
      name: '紧固件检查',
      payload: {
        skill: 'QC',
        descriptionZh: '检查紧固件',
        captureItems: [{ type: 'measurement', itemKey: 'TORQUE', config: { unit: 'Nm' } }],
        components: [{ type: 'text', payload: { html: '<b>记录结果</b>' } }],
      },
    }).expect(200);
    const templateId = created.body.data.id;

    const listed = await auth('get', '/api/step-templates', token).expect(200);
    expect(listed.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: templateId, name: '紧固件检查' }),
    ]));

    const applied = await auth(
      'post', `/api/task-cards/${cardId}/steps/${target.id}/apply-template`, token,
    ).send({ templateId, reason: '套用标准检查模板' }).expect(200);
    expect(applied.body.data).toMatchObject({ skill: 'QC', descriptionZh: '检查紧固件' });
    expect(applied.body.data.captureItems[0].config).toEqual({ unit: 'Nm' });
    expect(applied.body.data.components[0].payload).toEqual({ html: '<b>记录结果</b>' });

    const downloaded = await auth(
      'get', `/api/task-cards/${cardId}/steps/template-file`, token,
    ).buffer(true).parse((res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(downloaded.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(downloaded.body.length).toBeGreaterThan(0);
    await auth('get', '/api/task-cards/999999/steps/template-file', token).expect(404);

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      { skill: 'GR', description_zh: 'Excel 导入工序', components: JSON.stringify([
        { type: 'custom', payload: { schema: { result: 'string' } } },
      ]) },
      { skill: 'INVALID', description_zh: '应失败工序' },
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Process Steps');
    const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const imported = await auth('post', `/api/task-cards/${cardId}/steps/import`, token)
      .attach('file', file, { filename: 'steps.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      .expect(200);
    expect(imported.body.data).toMatchObject({ successCount: 1, failureCount: 1, totalCount: 2 });

    const detail = await auth('get', `/api/task-cards/${cardId}`, token).expect(200);
    const importedStep = detail.body.data.steps.find((step) => step.descriptionZh === 'Excel 导入工序');
    expect(importedStep.components[0].payload).toEqual({ schema: { result: 'string' } });
  });
});
