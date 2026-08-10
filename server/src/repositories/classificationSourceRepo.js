import { getDb } from '../db/connection.js';
import { rowToCamel } from './case-convert.js';

const SOURCE_FIELDS = Object.freeze([
  'planDummyJob', 'nrcOriginatingDoc', 'outsourceEntry', 'partNature', 'packageDivision',
]);

function parseValue(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return value; }
}

export function findByCardId(cardId) {
  const row = getDb().prepare('SELECT * FROM classification_source WHERE card_id = ?').get(cardId);
  if (row === undefined) return null;
  const result = rowToCamel(row);
  const sources = {};
  for (const field of SOURCE_FIELDS) sources[field] = parseValue(result[field]);
  return sources;
}

export default { findByCardId };
