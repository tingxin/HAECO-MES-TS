import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { closeDb, resetDb } from '../db/connection.js';
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

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('task 18.4 attachment endpoints', () => {
  it('uploads with card_edit, streams by id without path leakage, and deletes with card_edit', async () => {
    const engineer = await login();
    const manager = await login('E20001');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await auth('post', '/api/attachments', manager)
      .attach('file', bytes, { filename: 'denied.png', contentType: 'image/png' })
      .expect(403);

    const uploaded = await auth('post', '/api/attachments', engineer)
      .attach('file', bytes, { filename: '../diagram.png', contentType: 'image/png' })
      .expect(200);
    expect(uploaded.body.data).toEqual({
      id: expect.any(Number),
      url: expect.stringMatching(/^\/api\/attachments\/\d+$/),
    });
    expect(JSON.stringify(uploaded.body)).not.toMatch(/storedPath|[A-Z]:\\|data[\\/]attachments/i);

    const fetched = await auth('get', uploaded.body.data.url, manager)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.headers['content-disposition']).not.toContain('..');
    expect(fetched.body).toEqual(bytes);

    await auth('delete', uploaded.body.data.url, manager).expect(403);
    await auth('delete', uploaded.body.data.url, engineer).expect(200);
    await auth('get', uploaded.body.data.url, engineer).expect(404);
  });

  it('rejects a non-whitelisted MIME type with the normal error envelope', async () => {
    const token = await login();
    const response = await auth('post', '/api/attachments', token)
      .attach('file', Buffer.from('plain text'), { filename: 'note.txt', contentType: 'text/plain' })
      .expect(400);
    expect(response.body).toMatchObject({ code: 400, data: { mimeType: 'text/plain' } });
  });
});
