import { getDb } from '../db/connection.js';
import { rowToCamel } from './case-convert.js';

function parseScope(row) {
  if (row === undefined) return null;
  const result = rowToCamel(row);
  try {
    result.scope = result.scopeJson ? JSON.parse(result.scopeJson) : null;
  } catch {
    result.scope = null;
  }
  delete result.scopeJson;
  return result;
}

export function findByPid(pid) {
  return parseScope(getDb().prepare('SELECT * FROM pid_scope WHERE pid_no = ?').get(pid));
}

export default { findByPid };
