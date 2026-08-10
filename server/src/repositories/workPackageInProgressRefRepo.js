import { getDb } from '../db/connection.js';
import { rowsToCamel } from './case-convert.js';

export function listByCardId(cardId) {
  return rowsToCamel(getDb()
    .prepare('SELECT * FROM work_package_in_progress_ref WHERE card_id = ? ORDER BY id ASC')
    .all(cardId));
}

export default { listByCardId };
