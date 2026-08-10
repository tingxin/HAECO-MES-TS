import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { clearSessions, tokenToStaffNo, userContext } from '../middleware/user-context.js';
import sessionRouter from './session.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(userContext);
  app.use('/api', sessionRouter);
  app.get('/api/protected-probe', (req, res) => res.json({ user: req.user }));
  return app;
}

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

async function createSession(staffNo = 'E10001') {
  const response = await request(app).post('/api/session').send({ staffNo }).expect(200);
  return response.body.data.token;
}

describe('POST /api/session', () => {
  it('issues distinct non-predictable opaque tokens for an active app_user', async () => {
    const first = await request(app).post('/api/session').send({ staffNo: 'E10001' }).expect(200);
    const second = await request(app).post('/api/session').send({ staffNo: 'E10001' }).expect(200);

    expect(first.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: { user: { staffNo: 'E10001', role: 'TS_Engineer' } },
    });
    expect(first.body.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.data.token).not.toContain('E10001');
    expect(second.body.data.token).not.toBe(first.body.data.token);
    expect(tokenToStaffNo.get(first.body.data.token)).toBe('E10001');
  });

  it.each([
    [{}, 400, 'staffNo 为必填项'],
    [{ staffNo: 'UNKNOWN' }, 401, '用户不存在或已停用'],
  ])('rejects missing, unknown, or inactive identities with a mirrored envelope', async (body, status, message) => {
    const response = await request(app).post('/api/session').send(body).expect(status);
    expect(response.body).toEqual({ code: status, message, data: null });
  });

  it('rejects an inactive app_user', async () => {
    getDb().prepare('UPDATE app_user SET is_active = 0 WHERE staff_no = ?').run('E10001');
    const response = await request(app).post('/api/session').send({ staffNo: 'E10001' }).expect(401);
    expect(response.body).toEqual({ code: 401, message: '用户不存在或已停用', data: null });
  });
});

describe('user-context and identity routes', () => {
  it.each([
    [undefined],
    ['Basic abc'],
    ['Bearer'],
    ['Bearer invalid-token'],
  ])('returns mirrored 401 for a missing or invalid Authorization identity', async (authorization) => {
    const call = request(app).get('/api/me');
    if (authorization !== undefined) call.set('Authorization', authorization);
    const response = await call.expect(401);
    expect(response.body).toEqual({ code: 401, message: '缺少或无效的身份令牌', data: null });
  });

  it('loads the active user, attaches req.user, and exposes the public identity', async () => {
    const token = await createSession();
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body).toEqual({
      code: 0,
      message: 'ok',
      data: { staffNo: 'E10001', name: '张伟（TS 工程师）', role: 'TS_Engineer' },
    });

    const probe = await request(app)
      .get('/api/protected-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(probe.body.user).toMatchObject({ staffNo: 'E10001', role: 'TS_Engineer', isActive: 1 });
  });

  it('returns only allowed permission points for the current role', async () => {
    const token = await createSession();
    const response = await request(app)
      .get('/api/me/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      code: 0,
      message: 'ok',
      data: [
        'card_edit',
        'card_print_export',
        'card_read',
        'card_release',
        'card_submit_review',
        'migration_run',
      ],
    });
  });

  it('revokes the current token through DELETE /api/session', async () => {
    const token = await createSession();
    const response = await request(app)
      .delete('/api/session')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({ code: 0, message: 'ok', data: null });
    expect(tokenToStaffNo.has(token)).toBe(false);

    await request(app).get('/api/me').set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('invalidates an existing token when its app_user is subsequently deactivated', async () => {
    const token = await createSession();
    getDb().prepare('UPDATE app_user SET is_active = 0 WHERE staff_no = ?').run('E10001');

    const response = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(response.body).toEqual({ code: 401, message: '身份不存在或已停用', data: null });
    expect(tokenToStaffNo.has(token)).toBe(false);
  });
});