import path from 'node:path';
import { pathToFileURL } from 'node:url';

import app from './app.js';
import { closeDb, getDb, getDbPath } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';

export const DEFAULT_PORT = 3000;

export function resolvePort(value = process.env.PORT) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`PORT 必须是 0–65535 的整数，收到：${String(value)}`);
  }
  return port;
}

/** Open the configured singleton database and idempotently initialize schema/default data. */
export function initializeDatabase(connection = getDb()) {
  migrate(connection);
  seed(connection);
  return connection;
}

export function startServer({ application = app, port = resolvePort(), logger = console } = {}) {
  initializeDatabase();
  const server = application.listen(port, () => {
    const address = server.address();
    const listeningPort = typeof address === 'object' && address !== null ? address.port : port;
    logger.log(`[server] listening on port ${listeningPort}`);
    logger.log(`[server] database: ${getDbPath()}`);
  });
  return server;
}

function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isCliEntry()) {
  try {
    const server = startServer();
    server.on('error', (error) => {
      console.error('[server] startup failed', error);
      closeDb();
      process.exitCode = 1;
    });
  } catch (error) {
    console.error('[server] startup failed', error);
    closeDb();
    process.exitCode = 1;
  }
}
