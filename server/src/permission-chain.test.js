import { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { closeDb, getDb, resetDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { sendOk } from './lib/response.js';
import authorize from './middleware/authorize.js';
import { clearSessions } from './middleware/user-context.js';

const PROBES = Object.freeze({
  ppcManhours: { method: 'put', path: '/api/permission-probes/ppc-manhours' },
  authoring: { method: 'put', path: '/api/permission-probes/authoring' },
  review: { method: 'post', path: '/api/permission-probes/review' },
  batchReplace: { method: 'post', path: '/api/permission-probes/batch-replace' },
  config: { method: 'put', path: '/api/permission-probes/config' },
  capability: { method: 'put', path: '/api/permission-probes/capability' },
});

function permissionProbeRouter() {
  const router = Router();
  const ok = (_req, res) => sendOk(res, true);
  router.put('/permission-probes/ppc-manhours', authorize('ppc_manhours_write'), ok);
  router.put('/permission-probes/authoring', authorize('card_edit'), ok);
  router.post('/permission-probes/review', authorize('card_review'), ok);
  router.post('/permission-probes/batch-replace', authorize('batch_replace'), ok);
  router.put('/permission-probes/config', authorize('config_write'), ok);
  router.put('/permission-probes/capability', authorize('capability_write'), ok);
  return router;
}

let app;

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();
  clearSessions();
  app = createApp({ additionalApiRouters: [permissionProbeRouter()] });
});

afterEach(() => {
  clearSessions();
  closeDb();
});

async function login(staffNo) {
  const response = await request(app).post('/api/session').send({ staffNo }).expect(200);
  return response.body.data.token;
}

function callProbe(probe, token) {
  const pending = request(app)[probe.method](probe.path);
  return token === undefined ? pending : pending.set('Authorization', `Bearer ${token}`);
}

function denialRows() {
  return getDb().prepare('SELECT * FROM access_denial_log ORDER BY id').all();
}

const permissionBoundaries = [
  {
    label: 'TS cannot write PPC manhours',
    probe: PROBES.ppcManhours,
    permissionPoint: 'ppc_manhours_write',
    denied: { staffNo: 'E10001', role: 'TS_Engineer' },
    allowedStaffNo: 'E40001',
  },
  {
    label: 'Planning cannot edit authoring content',
    probe: PROBES.authoring,
    permissionPoint: 'card_edit',
    denied: { staffNo: 'E40001', role: 'Planning_Engineer' },
    allowedStaffNo: 'E10001',
  },
  {
    label: 'Production cannot edit authoring content',
    probe: PROBES.authoring,
    permissionPoint: 'card_edit',
    denied: { staffNo: 'E50001', role: 'Production_Technician' },
    allowedStaffNo: 'E10001',
  },
  {
    label: 'QA cannot edit authoring content',
    probe: PROBES.authoring,
    permissionPoint: 'card_edit',
    denied: { staffNo: 'E60001', role: 'QA_Engineer' },
    allowedStaffNo: 'E10001',
  },
  {
    label: 'QA cannot review authoring content',
    probe: PROBES.review,
    permissionPoint: 'card_review',
    denied: { staffNo: 'E60001', role: 'QA_Engineer' },
    allowedStaffNo: 'E20001',
  },
  {
    label: 'batch replace requires batch_replace independently of card_edit',
    probe: PROBES.batchReplace,
    permissionPoint: 'batch_replace',
    denied: { staffNo: 'E10001', role: 'TS_Engineer' },
    allowedStaffNo: 'E20001',
    alsoAllowedProbe: PROBES.authoring,
  },
  {
    label: 'configuration maintenance requires config_write',
    probe: PROBES.config,
    permissionPoint: 'config_write',
    denied: { staffNo: 'E10001', role: 'TS_Engineer' },
    allowedStaffNo: 'E20001',
    alsoAllowedProbe: PROBES.authoring,
  },
  {
    label: 'capability maintenance requires capability_write',
    probe: PROBES.capability,
    permissionPoint: 'capability_write',
    denied: { staffNo: 'E10001', role: 'TS_Engineer' },
    allowedStaffNo: 'E60001',
    alsoAllowedProbe: PROBES.authoring,
  },
];

describe('assembled Express permission chain', () => {
  it.each(permissionBoundaries)('$label', async ({
    probe,
    permissionPoint,
    denied,
    allowedStaffNo,
    alsoAllowedProbe,
  }) => {
    const deniedToken = await login(denied.staffNo);

    if (alsoAllowedProbe !== undefined) {
      const prerequisite = await callProbe(alsoAllowedProbe, deniedToken).expect(200);
      expect(prerequisite.body).toEqual({ code: 0, message: 'ok', data: true });
    }

    expect(denialRows()).toHaveLength(0);
    const deniedResponse = await callProbe(probe, deniedToken).expect(403);
    expect(deniedResponse.body).toEqual({
      code: 403,
      message: `越权：角色 ${denied.role} 无 ${permissionPoint} 权限`,
      data: null,
    });

    const rowsAfterDenial = denialRows();
    expect(rowsAfterDenial).toHaveLength(1);
    expect(rowsAfterDenial[0]).toMatchObject({
      staff_no: denied.staffNo,
      role: denied.role,
      permission_point: permissionPoint,
      method: probe.method.toUpperCase(),
      path: probe.path,
    });
    expect(rowsAfterDenial[0].id).toEqual(expect.any(Number));
    expect(rowsAfterDenial[0].denied_at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(rowsAfterDenial[0].denied_at))).toBe(false);

    const allowedToken = await login(allowedStaffNo);
    const allowedResponse = await callProbe(probe, allowedToken).expect(200);
    expect(allowedResponse.body).toEqual({ code: 0, message: 'ok', data: true });
    expect(denialRows()).toHaveLength(1);
  });

  it('returns mirrored 401 before authorization and does not append a denial audit', async () => {
    const response = await callProbe(PROBES.authoring).expect(401);
    expect(response.body).toEqual({
      code: 401,
      message: '缺少或无效的身份令牌',
      data: null,
    });
    expect(denialRows()).toHaveLength(0);
  });

  it('reads role_permission at request time rather than caching seeded decisions', async () => {
    const token = await login('E30001');
    await callProbe(PROBES.authoring, token).expect(403);
    expect(denialRows()).toHaveLength(1);

    const update = getDb()
      .prepare(`UPDATE role_permission SET allowed = 1
        WHERE role = ? AND permission_point = ?`)
      .run('NDT_Reviewer', 'card_edit');
    expect(update.changes).toBe(1);

    const allowedResponse = await callProbe(PROBES.authoring, token).expect(200);
    expect(allowedResponse.body).toEqual({ code: 0, message: 'ok', data: true });
    expect(denialRows()).toHaveLength(1);
  });
});