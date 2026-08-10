import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import { batchReplaceCards } from './versionService.js';

const AUTHORIZED_ACTOR = Object.freeze({
  operatorId: 'E20001',
  staffNo: 'E20001',
  role: 'TS_Manager',
  method: 'POST',
  path: '/api/task-cards/batch-replace',
  now: '2026-01-01T00:00:00.000Z',
});

const REPLACEABLE_FIELDS = Object.freeze({
  title: 'title',
  templateType: 'template_type',
  checkType: 'check_type',
  ataChapter: 'ata_chapter',
  namingRuleOrigin: 'naming_rule_origin',
});

const tokenArb = fc
  .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((characters) => characters.join(''));

const rollbackBatchArb = fc.record({
  field: fc.constantFrom(...Object.keys(REPLACEABLE_FIELDS)),
  batchSize: fc.integer({ min: 2, max: 7 }),
  failureSeed: fc.nat(),
  token: tokenArb,
  reasonToken: tokenArb,
});

function rebuildSeededDatabase() {
  resetDb(':memory:');
  migrate();
  seed();
  return getDb();
}

function insertBatchCard(db, index, token, field, value) {
  const values = {
    title: `Property 13 valid card ${index}`,
    template_type: null,
    check_type: null,
    ata_chapter: null,
    naming_rule_origin: null,
  };
  values[REPLACEABLE_FIELDS[field]] = value;

  return Number(
    db
      .prepare(
        `INSERT INTO task_card
           (task_no, revision, title, card_type, status, template_type,
            check_type, ata_chapter, naming_rule_origin, created_by)
         VALUES (?, 1, ?, '04', 'New', ?, ?, ?, ?, 'E10001')`,
      )
      .run(
        `P13-${token}-${index}`,
        values.title,
        values.template_type,
        values.check_type,
        values.ata_chapter,
        values.naming_rule_origin,
      ).lastInsertRowid,
  );
}
function snapshotCards(db, ids) {
  return db
    .prepare(`SELECT * FROM task_card WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`)
    .all(...ids);
}

function snapshotChangeRecords(db) {
  return db.prepare('SELECT * FROM change_record ORDER BY id').all();
}

function installFailureTrigger(db, failureCardId) {
  db.function('p13_fail_selected_card', () => {
    throw new ServiceError(
      CODE.CONFLICT,
      'Property 13 injected card persistence failure',
      { rejection: 'P13_INJECTED_PERSISTENCE_FAILURE', cardId: failureCardId },
    );
  });
  db.exec(`
    CREATE TEMP TRIGGER p13_fail_selected_change_record
    BEFORE INSERT ON change_record
    WHEN NEW.card_id = ${Number(failureCardId)}
      AND NEW.change_type = 'batch_replace'
    BEGIN
      SELECT p13_fail_selected_card();
    END;
  `);
}

function observeTransactionalWrites(db) {
  const originalPrepare = db.prepare.bind(db);
  const events = [];

  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const kind = /^\s*UPDATE\s+task_card\s+SET\b/i.test(String(sql))
      ? 'card-update'
      : /^\s*INSERT\s+INTO\s+change_record\b/i.test(String(sql))
        ? 'record-insert'
        : null;
    if (kind === null) return statement;

    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'run' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args) => {
          try {
            const result = value.apply(target, args);
            events.push({ kind, outcome: 'succeeded' });
            return result;
          } catch (error) {
            events.push({ kind, outcome: 'failed' });
            throw error;
          }
        };
      },
    });
  };

  return events;
}

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

// Feature: task-card-management, Property 13: 批量替换正确、幂等且受管控（回滚部分）
describe('Property 13: 批量替换整批回滚（服务层 + SQLite）', () => {
  it('任一工卡在事务写入中失败时，全部工卡与全部变更记录恢复到调用前快照', () => {
    fc.assert(
      fc.property(rollbackBatchArb, ({ field, batchSize, failureSeed, token, reasonToken }) => {
        // Task 14.2 requires a genuinely fresh schema and full seed inside every iteration.
        const db = rebuildSeededDatabase();
        const from = `${token}-BEFORE`;
        const to = `${token}-AFTER`;
        const ids = Array.from({ length: batchSize }, (_, index) =>
          insertBatchCard(db, index, token, field, from),
        );
        const failureIndex = 1 + (failureSeed % (ids.length - 1));

        expect(
          db
            .prepare(
              `SELECT allowed FROM role_permission
                WHERE role = ? AND permission_point = 'batch_replace'`,
            )
            .get(AUTHORIZED_ACTOR.role).allowed,
        ).toBe(1);

        const cardsBefore = snapshotCards(db, ids);
        const recordsBefore = snapshotChangeRecords(db);
        installFailureTrigger(db, ids[failureIndex]);
        const writes = observeTransactionalWrites(db);

        const error = captureError(() =>
          batchReplaceCards(
            ids,
            { field, from, to },
            `Property 13 rollback ${reasonToken}`,
            AUTHORIZED_ACTOR,
          ),
        );

        expect(error).toBeInstanceOf(ServiceError);
        expect(error.code).toBe(CODE.CONFLICT);
        expect(error.httpStatus).toBe(CODE.CONFLICT);
        expect(error.data).toEqual({
          rejection: 'P13_INJECTED_PERSISTENCE_FAILURE',
          cardId: ids[failureIndex],
        });
        expect(error.message).toContain('Property 13 injected card persistence failure');

        const cardWrites = writes.filter(({ kind }) => kind === 'card-update');
        const recordWrites = writes.filter(({ kind }) => kind === 'record-insert');
        expect(cardWrites).toHaveLength(batchSize);
        expect(cardWrites.every(({ outcome }) => outcome === 'succeeded')).toBe(true);
        expect(recordWrites.filter(({ outcome }) => outcome === 'succeeded')).toHaveLength(failureIndex);
        expect(recordWrites.filter(({ outcome }) => outcome === 'failed')).toHaveLength(1);

        expect(snapshotCards(db, ids)).toEqual(cardsBefore);
        expect(snapshotChangeRecords(db)).toEqual(recordsBefore);
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM change_record
                WHERE card_id IN (${ids.map(() => '?').join(', ')})
                  AND change_type = 'batch_replace'`,
            )
            .get(...ids).count,
        ).toBe(0);
      }),
      { numRuns: 30 },
    );
  });
});

afterAll(() => {
  closeDb();
});