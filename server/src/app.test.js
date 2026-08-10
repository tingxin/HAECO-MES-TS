import { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { closeDb, getDb, resetDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { CODE, sendOk } from './lib/response.js';
import { ServiceError } from './lib/service-error.js';
import authorize from './middleware/authorize.js';
import { clearSessions } from './middleware/user-context.js';

let app;

function probeRouter() {
  const router = Router();
  router.get('/review-probe', authorize('card_review'), (_req, res) => sendOk(res, true));
  router.get('/service-error-probe', (_req, _res, next) =>
    next(new ServiceError(CODE.UNPROCESSABLE, '前置条件不满足', { state: 'New' })),
  );
  router.get('/unique-error-probe', (_req, _res, next) => {
    const error = new Error('UNIQUE constraint failed: secret_table.secret_column');
    error.code = 'SQLITE_CONSTRAINT_UNIQUE';
    next(error);
  });
  router.get('/check-error-probe', (_req, _res, next) => {
    const error = new Error('CHECK constraint failed: hidden_rule');
    error.code = 'SQLITE_CONSTRAINT_CHECK';
    next(error);
  });
  router.get('/uncaught-error-probe', (_req, _res, next) =>
    next(new Error('sensitive implementation detail')),
  );
  return router;
}

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();
  clearSessions();
  app = createApp({ additionalApiRouters: [probeRouter()] });
});

afterAll(() => {
  clearSessions();
  closeDb();
});

async function login(staffNo = 'E10001', target = app) {
  const response = await request(target).post('/api/session').send({ staffNo }).expect(200);
  return response.body.data.token;
}

function authenticatedGet(path, token) {
  return request(app).get(path).set('Authorization', `Bearer ${token}`);
}

describe('Express application assembly', () => {
  it('runs JSON parsing before identity and routes, while POST /api/session remains public', async () => {
    const events = [];
    const identity = (req, _res, next) => {
      events.push(`identity:${req.body.marker}`);
      req.user = { staffNo: 'TEST', role: 'TS_Engineer' };
      next();
    };
    const router = Router();
    router.post('/order-probe', (req, res) => {
      events.push(`route:${req.user.staffNo}`);
      sendOk(res, req.body);
    });
    const orderedApp = createApp({ identity, apiRouters: [router] });

    const response = await request(orderedApp)
      .post('/api/order-probe')
      .send({ marker: 'parsed' })
      .expect(200);
    expect(response.body.data).toEqual({ marker: 'parsed' });
    expect(events).toEqual(['identity:parsed', 'route:TEST']);

    const session = await request(app).post('/api/session').send({ staffNo: 'E10001' }).expect(200);
    expect(session.body).toMatchObject({ code: 0, data: { user: { staffNo: 'E10001' } } });
  });

  it('completes session creation, authenticated identity lookup, and revocation', async () => {
    const token = await login();
    const me = await authenticatedGet('/api/me', token).expect(200);
    expect(me.body.data).toMatchObject({ staffNo: 'E10001', role: 'TS_Engineer' });

    await request(app)
      .delete('/api/session')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await authenticatedGet('/api/me', token).expect(401);
  });

  it('returns mirrored 401 before protected routing when identity is absent', async () => {
    const response = await request(app).get('/api/me').expect(401);
    expect(response.body).toEqual({
      code: 401,
      message: '缺少或无效的身份令牌',
      data: null,
    });
  });

  it('returns mirrored 403 and writes exactly one audit row for a declared denial', async () => {
    const token = await login('E10001');
    const response = await authenticatedGet('/api/review-probe', token).expect(403);
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
      path: '/api/review-probe',
    });
  });

  it('maps ServiceError code, message, and data to the identical HTTP envelope', async () => {
    const token = await login();
    const response = await authenticatedGet('/api/service-error-probe', token).expect(422);
    expect(response.body).toEqual({
      code: 422,
      message: '前置条件不满足',
      data: { state: 'New' },
    });
  });

  it.each([
    ['/api/unique-error-probe', 409, '数据已存在，违反唯一性约束'],
    ['/api/check-error-probe', 400, '数据不满足约束条件'],
  ])('translates known SQLite constraints at the application boundary', async (path, status, message) => {
    const token = await login();
    const response = await authenticatedGet(path, token).expect(status);
    expect(response.body).toMatchObject({ code: status, message });
  });

  it('returns the mirrored 404 envelope after identity and all mounted routers', async () => {
    const token = await login();
    const response = await authenticatedGet('/api/not-a-route', token).expect(404);
    expect(response.body).toEqual({ code: 404, message: '未找到', data: null });
  });

  it('logs uncaught errors and returns a generic mirrored 500 without stack or message leakage', async () => {
    const logger = { error: vi.fn() };
    const isolatedApp = createApp({
      additionalApiRouters: [probeRouter()],
      logger,
    });
    const token = await login('E10001', isolatedApp);
    const response = await request(isolatedApp)
      .get('/api/uncaught-error-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(500);

    expect(response.body).toEqual({ code: 500, message: '服务器异常', data: null });
    expect(JSON.stringify(response.body)).not.toContain('sensitive implementation detail');
    expect(JSON.stringify(response.body)).not.toContain('app.test.js');
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][1]).toBeInstanceOf(Error);
  });
});
