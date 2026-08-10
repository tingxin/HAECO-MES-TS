import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { clearSessions } from '../middleware/user-context.js';

let app;
let temporaryRoot;

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haeco-task-18-5-'));
  process.env.HAECO_ATTACHMENT_DIR = path.join(temporaryRoot, 'attachments');
  resetDb(':memory:');
  migrate();
  seed();
  clearSessions();
  app = createApp();
});

afterEach(() => {
  clearSessions();
  closeDb();
  delete process.env.HAECO_ATTACHMENT_DIR;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

afterAll(() => {
  clearSessions();
  closeDb();
});

async function login(staffNo = 'E10001') {
  const response = await request(app).post('/api/session').send({ staffNo }).expect(200);
  return response.body.data.token;
}

function auth(method, route, token) {
  return request(app)[method](route).set('Authorization', `Bearer ${token}`);
}

function editableCardId() {
  return getDb().prepare("SELECT id FROM task_card WHERE task_no = 'TC-2026-0002'").get().id;
}
async function addStep(token, cardId, body = {}) {
  const response = await auth('post', `/api/task-cards/${cardId}/steps`, token)
    .send({ skill: 'GR', descriptionZh: 'Acceptance step', ...body })
    .expect(200);
  return response.body.data;
}

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function expectMirrored400(response) {
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ code: 400 });
}

function createSparseFixture(filename, byteSize) {
  const fixturePath = path.join(temporaryRoot, filename);
  fs.closeSync(fs.openSync(fixturePath, 'w'));
  fs.truncateSync(fixturePath, byteSize);
  return fixturePath;
}

describe('Task 18.5 process-step acceptance', () => {
  it('round-trips authored content while generated and integrated fields remain authoritative', async () => {
    const token = await login();
    const cardId = editableCardId();
    const created = await addStep(token, cardId, {
      operation: 'CLIENT-CREATE-OPERATION',
      barcode: 'CLIENT-BARCODE',
      barcodeValue: 'CLIENT-BARCODE-VALUE',
    });

    expect(created.processId).toEqual(expect.any(String));
    expect(created.processId).not.toHaveLength(0);
    expect(created).not.toHaveProperty('barcode');
    expect(created).not.toHaveProperty('barcodeValue');
    expect(created.operation).toBeNull();

    const source = getDb().prepare(`SELECT pid_no, card_id, step_ref, part_no, part_sn,
      part_desc, operation_type, operation FROM process_data WHERE operation IS NOT NULL LIMIT 1`).get();
    const processDataQuery = {
      pid: source.pid_no,
      cardId: source.card_id,
      ...(source.step_ref === null ? {} : { stepId: source.step_ref }),
    };
    const authoritativeBefore = await auth('get', '/api/process-data', token)
      .query(processDataQuery)
      .expect(200);
    expect(authoritativeBefore.body.data).toEqual({
      partNo: source.part_no,
      partSn: source.part_sn,
      partDesc: source.part_desc,
      operationType: source.operation_type,
      operation: source.operation,
    });

    const captureItems = [{
      type: 'measurement',
      itemKey: 'TORQUE',
      config: { unit: 'Nm', limits: { min: 12, max: 18 }, precision: 2 },
      required: true,
      sortOrder: 3,
    }];
    const components = [{
      type: 'custom',
      payload: { schema: { result: 'number' }, ui: { suffix: 'Nm' }, values: [12, 15, 18] },
      sortOrder: 4,
    }];
    const saved = await auth('put', `/api/task-cards/${cardId}/steps/${created.id}`, token)
      .send({
        reason: 'Task 18.5 authored content round-trip',
        descriptionEn: 'Torque inspection',
        operation: 'CLIENT-UPDATE-OPERATION',
        captureItems,
        components,
      })
      .expect(200);
    expect(saved.body.data.operation).toBeNull();

    const detail = await auth('get', `/api/task-cards/${cardId}`, token).expect(200);
    const persisted = detail.body.data.steps.find((step) => step.id === created.id);
    expect(persisted).toBeDefined();
    expect(persisted.operation).toBeNull();
    expect(persisted.captureItems).toHaveLength(1);
    expect(persisted.captureItems[0]).toMatchObject({
      type: 'measurement', itemKey: 'TORQUE', config: captureItems[0].config, required: 1, sortOrder: 3,
    });
    expect(persisted.components).toHaveLength(1);
    expect(persisted.components[0]).toMatchObject({
      type: 'custom', payload: components[0].payload, sortOrder: 4,
    });

    const authoritativeAfter = await auth('get', '/api/process-data', token)
      .query(processDataQuery)
      .expect(200);
    expect(authoritativeAfter.body.data).toEqual(authoritativeBefore.body.data);
  });

  it('returns the exact card-wide signature union and persists critical safety content', async () => {
    const token = await login();
    const cardId = editableCardId();
    const first = await addStep(token, cardId, { descriptionZh: '签署工序一' });
    const second = await addStep(token, cardId, { descriptionZh: '签署工序二' });

    const operator = await auth(
      'post', `/api/task-cards/${cardId}/steps/${first.id}/signature-requirements`, token,
    ).send({ signatureRole: 'Operator', stampRequired: true, dateRequired: false, sortOrder: 2 })
      .expect(200);
    const qc = await auth(
      'post', `/api/task-cards/${cardId}/steps/${second.id}/signature-requirements`, token,
    ).send({ signatureRole: 'QC', stampRequired: false, dateRequired: true, sortOrder: 1 })
      .expect(200);

    const union = await auth('get', `/api/task-cards/${cardId}/signature-requirements`, token)
      .expect(200);
    expect(union.body.data).toEqual([
      {
        id: operator.body.data.id,
        stepId: first.id,
        signatureRole: 'Operator',
        roleValid: true,
        stampRequired: true,
        dateRequired: false,
        sortOrder: 2,
        key: `id:${operator.body.data.id}`,
      },
      {
        id: qc.body.data.id,
        stepId: second.id,
        signatureRole: 'QC',
        roleValid: true,
        stampRequired: false,
        dateRequired: true,
        sortOrder: 1,
        key: `id:${qc.body.data.id}`,
      },
    ]);

    const safetyPayload = {
      safetyWarning: '确认液压系统已隔离并释放残余压力',
      visualCue: { type: 'video', attachmentId: 731, caption: '隔离点确认' },
      repairTips: '佩戴护目镜并使用校准工具',
      isCritical: true,
      operation: 'CLIENT-SAFETY-OPERATION',
      reason: 'Task 18.5 critical safety content',
    };
    const safety = await auth(
      'put', `/api/task-cards/${cardId}/steps/${first.id}/safety`, token,
    ).send(safetyPayload).expect(200);
    expect(safety.body.data).toMatchObject({
      safetyWarning: safetyPayload.safetyWarning,
      visualCue: safetyPayload.visualCue,
      repairTips: safetyPayload.repairTips,
      isCritical: 1,
      operation: null,
    });

    const detail = await auth('get', `/api/task-cards/${cardId}`, token).expect(200);
    expect(detail.body.data.steps.find((step) => step.id === first.id)).toMatchObject({
      safetyWarning: safetyPayload.safetyWarning,
      visualCue: safetyPayload.visualCue,
      repairTips: safetyPayload.repairTips,
      isCritical: 1,
      operation: null,
    });
  });

  it('deletes only the selected step and exposes the Property 35 delete trace', async () => {
    const token = await login();
    const cardId = editableCardId();
    const victim = await addStep(token, cardId, {
      descriptionZh: '待删除工序',
      captureItems: [{ type: 'text', itemKey: 'DELETE-ME', config: { maxLength: 8 } }],
    });
    const survivor = await addStep(token, cardId, {
      descriptionZh: '不相关保留工序',
      components: [{ type: 'text', payload: { html: '<b>must survive</b>' } }],
    });
    const before = await auth('get', `/api/task-cards/${cardId}`, token).expect(200);
    const expectedRemainingSteps = before.body.data.steps.filter((step) => step.id !== victim.id);
    expect(expectedRemainingSteps.some((step) => step.id === survivor.id)).toBe(true);

    const reason = 'Task 18.5 remove obsolete step';
    await auth('delete', `/api/task-cards/${cardId}/steps/${victim.id}`, token)
      .send({ reason })
      .expect(200);

    const after = await auth('get', `/api/task-cards/${cardId}`, token).expect(200);
    expect(after.body.data.steps).toEqual(expectedRemainingSteps);
    expect(after.body.data.steps.some((step) => step.id === victim.id)).toBe(false);

    const records = await auth('get', `/api/task-cards/${cardId}/change-records`, token).expect(200);
    const deletionRecords = records.body.data.filter(
      (record) => record.changeType === 'delete' && record.reason === reason,
    );
    expect(deletionRecords).toHaveLength(1);
    expect(deletionRecords[0]).toMatchObject({
      cardId,
      changeType: 'delete',
      field: null,
      newValue: null,
      reason,
      operatorId: 'E10001',
    });
    expect(JSON.parse(deletionRecords[0].oldValue)).toMatchObject({
      id: victim.id,
      cardId,
      processId: victim.processId,
      descriptionZh: '待删除工序',
    });
  });
});

describe('Task 18.5 attachment acceptance', () => {
  it('mirrors invalid MIME and every per-kind oversize rejection as HTTP/code 400', async () => {
    const token = await login();
    const invalidMime = await auth('post', '/api/attachments', token)
      .attach('file', Buffer.from('not an allowed attachment'), {
        filename: 'payload.txt', contentType: 'text/plain',
      });
    expectMirrored400(invalidMime);
    expect(invalidMime.body.data).toEqual({ mimeType: 'text/plain' });

    const oversizedCases = [
      { mimeType: 'image/png', filename: 'too-large.png', bytes: 10 * 1024 * 1024 + 1 },
      { mimeType: 'audio/wav', filename: 'too-large.wav', bytes: 20 * 1024 * 1024 + 1 },
      { mimeType: 'video/mp4', filename: 'too-large.mp4', bytes: 100 * 1024 * 1024 + 1 },
    ];
    for (const item of oversizedCases) {
      const fixturePath = createSparseFixture(item.filename, item.bytes);
      const response = await auth('post', '/api/attachments', token)
        .attach('file', fixturePath, {
          filename: item.filename, contentType: item.mimeType,
        });
      expectMirrored400(response);
    }

    expect(getDb().prepare('SELECT COUNT(*) AS count FROM attachment').get().count).toBe(0);
    expect(fs.existsSync(process.env.HAECO_ATTACHMENT_DIR)).toBe(false);
  }, 120_000);

  it('uploads and fetches exact image, video, and audio bytes with traversal-safe names', async () => {
    const token = await login();
    const cases = [
      {
        mimeType: 'image/png', filename: '../diagram.png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x18]),
      },
      {
        mimeType: 'video/mp4', filename: '..\\inspection.mp4',
        bytes: Buffer.from('representative-mp4-bytes-18.5'),
      },
      {
        mimeType: 'audio/wav', filename: '../../instruction.wav',
        bytes: Buffer.from('representative-wav-bytes-18.5'),
      },
    ];

    for (const item of cases) {
      const uploaded = await auth('post', '/api/attachments', token)
        .attach('file', item.bytes, { filename: item.filename, contentType: item.mimeType })
        .expect(200);
      expect(uploaded.body).toEqual({
        code: 0,
        message: 'ok',
        data: {
          id: expect.any(Number),
          url: expect.stringMatching(/^\/api\/attachments\/\d+$/),
        },
      });
      expect(JSON.stringify(uploaded.body)).not.toMatch(/storedPath|[A-Z]:\\|data[\\/]attachments/i);

      const fetched = await auth('get', uploaded.body.data.url, token)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      expect(fetched.headers['content-type']).toBe(item.mimeType);
      expect(fetched.headers['content-disposition']).not.toMatch(/\.\.|[\\/]/);
      expect(fetched.body).toEqual(item.bytes);
    }

    const storedNames = fs.readdirSync(process.env.HAECO_ATTACHMENT_DIR);
    expect(storedNames).toHaveLength(cases.length);
    expect(storedNames.every((name) => !name.includes('..') && !name.includes('/') && !name.includes('\\')))
      .toBe(true);
  });
});
