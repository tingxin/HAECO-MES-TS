import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import XLSX from 'xlsx';
import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { importSteps } from './processStepService.js';

const tokenArb = fc.string({ minLength: 1, maxLength: 12 })
  .filter((value) => value.trim().length > 0 && !value.includes("'"));

function rawAggregate(db, cardId) {
  const steps = db.prepare('SELECT * FROM process_step WHERE card_id = ? ORDER BY id').all(cardId);
  const ids = steps.map(({ id }) => id);
  const children = (table) => ids.flatMap((id) =>
    db.prepare(`SELECT * FROM ${table} WHERE step_id = ? ORDER BY id`).all(id));
  return { steps, captureItems: children('capture_item'), components: children('inserted_component'),
    signatures: children('signature_requirement') };
}

// Feature: task-card-management, Property 39: replace rollback
// Validates: Requirements 53.5, 53.6, 53.7
describe('Property 39: replace import rollback', () => {
  it('restores every original step and child row when any replacement insert fails', async () => {
    await fc.assert(fc.asyncProperty(tokenArb, async (token) => {
      resetDb(':memory:');
      migrate();
      seed();
      const db = getDb();
      const cardId = db.prepare("SELECT id FROM task_card WHERE task_no = 'TC-2026-0002'").get().id;
      const before = rawAggregate(db, cardId);
      const failing = `FAIL-${token}`;
      db.exec(`CREATE TRIGGER fail_section_29 BEFORE INSERT ON process_step
        WHEN NEW.description_zh = '${failing}' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook,
        XLSX.utils.aoa_to_sheet([['Step', 'Inspection Item'], ['valid', 'ok'], [failing, 'bad']]), 'Steps');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      await expect(importSteps(cardId, buffer, { operatorId: 'E10001' },
        { mode: 'replace', reason: 'property rollback' })).rejects.toThrow('forced failure');
      expect(rawAggregate(db, cardId)).toEqual(before);
    }), { numRuns: 30 });
  });
});

afterAll(() => closeDb());
