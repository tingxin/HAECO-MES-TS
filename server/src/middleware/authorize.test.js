import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { CODE, sendFail, sendOk } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import accessDenialLogRepo from '../repositories/accessDenialLogRepo.js';
import appUserRepo from '../repositories/appUserRepo.js';
import { createAccessDenialsRouter } from '../routes/access-denials.js';
import { createAuthorize } from './authorize.js';

const FIXED_TIME = '2026-08-10T12:34:56.000Z';

function createTestApp() {
  const app = express();
  const authorize = createAuthorize({ now: () => FIXED_TIME });
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = appUserRepo.findByStaffNo(req.get('x-staff-no') || 'E10001');
    next();
  });
  app.get('/probe/edit', authorize('card_edit'), (_req, res) => sendOk(res, { allowed: true }));
  app.get('/probe/review', authorize('card_review'), (_req, res) => sendOk(res, { allowed: true }));
  app.use('/api', createAccessDenialsRouter({
    protect: (_req, _res, next) => next(),
    authorizePermission: authorize,
  }));
  app.use((error, _req, res, _next) => {
    if (error instanceof ServiceError) return sendFail(res, error.code, error.message, error.data);
    return sendFail(res, CODE.INTERNAL, error.message);
  });
  return app;
}

let app;

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();
  app = createTestApp();
});

afterAll(() => closeDb());
describe('authorize(permissionPoint)', () => {
  it('allows a runtime-configured role and does not append an audit row', async () => {
    const response = await request(app).get('/probe/edit').expect(200);
    expect(response.body).toEqual({ code: 0, message: 'ok', data: { allowed: true } });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM access_denial_log').get().count).toBe(0);
  });

  it('returns mirrored 403 and appends exactly one complete denial audit row', async () => {
    const response = await request(app).get('/probe/review').expect(403);
    expect(response.body).toEqual({
      code: 403,
      message: '越权：角色 TS_Engineer 无 card_review 权限',
      data: null,
    });

    const rows = getDb().prepare('SELECT * FROM access_denial_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      staff_no: 'E10001',
      role: 'TS_Engineer',
      permission_point: 'card_review',
      method: 'GET',
      path: '/probe/review',
      denied_at: FIXED_TIME,
    });
  });

  it('rejects an invalid route permission declaration as a ServiceError without auditing', () => {
    const authorize = createAuthorize();
    expect(() => authorize('not_a_permission')).toThrowError(
      expect.objectContaining({ name: 'ServiceError', code: 500 }),
    );
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM access_denial_log').get().count).toBe(0);
  });
});

describe('GET /api/access-denials', () => {
  beforeEach(() => {
    accessDenialLogRepo.create({
      staffNo: 'E10001', role: 'TS_Engineer', permissionPoint: 'card_review',
      method: 'POST', path: '/api/task-cards/1/approve', deniedAt: '2026-08-10T10:00:00.000Z',
    });
    accessDenialLogRepo.create({
      staffNo: 'E40001', role: 'Planning_Engineer', permissionPoint: 'card_edit',
      method: 'PUT', path: '/api/task-cards/1', deniedAt: '2026-08-10T11:00:00.000Z',
    });
  });

  it('queries the current user and permits a config_write audit reader to query all rows', async () => {
    const own = await request(app).get('/api/access-denials').expect(200);
    expect(own.body.data).toMatchObject({ total: 1, staffNo: 'E10001' });
    expect(own.body.data.list).toHaveLength(1);
    expect(own.body.data.list[0]).toMatchObject({ staffNo: 'E10001', permissionPoint: 'card_review' });

    const all = await request(app)
      .get('/api/access-denials?scope=all')
      .set('x-staff-no', 'E20001')
      .expect(200);
    expect(all.body.data).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(all.body.data.list.map((row) => row.staffNo).sort()).toEqual(['E10001', 'E40001']);
  });
});

describe('GET /api/access-denials audit authorization declaration', () => {
  it('requires config_write for an all-log query and audits that denial once', async () => {
    const response = await request(app).get('/api/access-denials?scope=all').expect(403);
    expect(response.body).toMatchObject({ code: 403, data: null });

    const rows = getDb()
      .prepare(`SELECT * FROM access_denial_log WHERE permission_point = 'config_write'`)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      staff_no: 'E10001',
      role: 'TS_Engineer',
      method: 'GET',
      path: '/api/access-denials',
      denied_at: FIXED_TIME,
    });
  });
});
