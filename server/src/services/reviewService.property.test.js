import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { approve } from './reviewService.js';

const TASK_SLOTS = 4;
const REVIEWER = Object.freeze({ operatorId: 'E20001' });

function rebuildSeededDatabase() {
  resetDb(':memory:');
  migrate();
  seed();
  return getDb();
}

function taskNoFor(slot) {
  return `P25-APPROVAL-${slot + 1}`;
}

function insertVersion(db, taskNo, revision, status) {
  return Number(
    db
      .prepare(
        `INSERT INTO task_card
           (task_no, revision, title, card_type, status, created_by)
         VALUES (?, ?, ?, '04', ?, 'E10001')`,
      )
      .run(taskNo, revision, `${taskNo} rev.${revision}`, status).lastInsertRowid,
  );
}

function effectiveCounts(db) {
  return db
    .prepare(
      `SELECT task_no AS taskNo, COUNT(*) AS effectiveCount
         FROM task_card
        WHERE status = 'Effective'
        GROUP BY task_no
        ORDER BY task_no`,
    )
    .all();
}
function expectSingleEffectiveInvariant(db) {
  const counts = effectiveCounts(db);
  expect(counts.every(({ effectiveCount }) => effectiveCount <= 1)).toBe(true);
  return counts;
}

function touchesApprovalPersistence(sql) {
  return /\b(?:task_card|supersede_record|review_record)\b/i.test(String(sql));
}

function approvalWriteKind(sql) {
  const match = /^\s*(?:UPDATE\s+(task_card)|INSERT\s+INTO\s+(supersede_record|review_record))\b/i.exec(
    String(sql),
  );
  return match === null ? null : match[1] ?? match[2];
}

/**
 * Wrap every statement execution used by the real service. After each statement touching approval
 * persistence, query through the unwrapped prepare method and assert the invariant immediately.
 * This observes SELECTs as well as all four mutation statements without changing service code.
 */
function observeApprovalStatements(db) {
  const originalPrepare = db.prepare.bind(db);
  const observations = [];

  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (!['run', 'get', 'all'].includes(property) || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }

        return (...args) => {
          const result = value.apply(target, args);
          if (touchesApprovalPersistence(sql)) {
            const counts = originalPrepare(
              `SELECT task_no AS taskNo, COUNT(*) AS effectiveCount
                 FROM task_card
                WHERE status = 'Effective'
                GROUP BY task_no
                ORDER BY task_no`,
            ).all();
            expect(counts.every(({ effectiveCount }) => effectiveCount <= 1)).toBe(true);
            observations.push({ sql: String(sql), counts });
          }
          return result;
        };
      },
    });
  };

  return observations;
}

function countFor(observation, taskNo) {
  return observation.counts.find((row) => row.taskNo === taskNo)?.effectiveCount ?? 0;
}

function statusOf(db, taskNo, revision) {
  return db
    .prepare('SELECT status FROM task_card WHERE task_no = ? AND revision = ?')
    .get(taskNo, revision).status;
}

function errorMessageOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return null;
}
const approvalSequenceArb = fc.record({
  initialEffective: fc.array(fc.boolean(), { minLength: TASK_SLOTS, maxLength: TASK_SLOTS }),
  taskSlots: fc.array(fc.integer({ min: 0, max: TASK_SLOTS - 1 }), {
    minLength: 1,
    maxLength: 12,
  }),
});

// Feature: task-card-management, Property 25: 单一生效版本不变式（版本取代）
describe('Property 25: 单一生效版本不变式（服务层 + SQLite）', () => {
  it('随机批准序列中，每条批准相关 SQL 执行后每个 task_no 的 Effective 版本数均不超过 1', () => {
    fc.assert(
      fc.property(approvalSequenceArb, ({ initialEffective, taskSlots }) => {
        // Task 14.1 requires a genuinely fresh schema and full seed inside every property iteration.
        const db = rebuildSeededDatabase();

        for (let slot = 0; slot < TASK_SLOTS; slot += 1) {
          if (initialEffective[slot]) insertVersion(db, taskNoFor(slot), 1, 'Effective');
        }
        expectSingleEffectiveInvariant(db);

        const observations = observeApprovalStatements(db);
        for (const slot of taskSlots) {
          const taskNo = taskNoFor(slot);
          const latest = db
            .prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM task_card WHERE task_no = ?')
            .get(taskNo).revision;
          const revision = latest + 1;
          const hadIncumbent = db
            .prepare(
              "SELECT EXISTS(SELECT 1 FROM task_card WHERE task_no = ? AND status = 'Effective') AS yes",
            )
            .get(taskNo).yes === 1;
          const pendingId = insertVersion(db, taskNo, revision, 'UnderReview');
          const beforeApprove = observations.length;

          const approved = approve(pendingId, REVIEWER, `approve ${taskNo} rev.${revision}`);
          expect(approved.status).toBe('Effective');
          expect(approved.revision).toBe(revision);

          const serviceObservations = observations.slice(beforeApprove);
          expect(serviceObservations.length).toBeGreaterThan(0);
          const writes = serviceObservations
            .map((observation) => ({ ...observation, kind: approvalWriteKind(observation.sql) }))
            .filter(({ kind }) => kind !== null);
          expect(writes.map(({ kind }) => kind)).toEqual(
            hadIncumbent
              ? ['task_card', 'supersede_record', 'task_card', 'review_record']
              : ['task_card', 'review_record'],
          );
          expect(writes.map((observation) => countFor(observation, taskNo))).toEqual(
            hadIncumbent ? [0, 0, 1, 1] : [1, 1],
          );

          expectSingleEffectiveInvariant(db);
          expect(statusOf(db, taskNo, revision)).toBe('Effective');
        }
      }),
      { numRuns: 30 },
    );
  });

  it('反向原始 SQL：先生效后降级立即撞部分唯一索引，并整体回滚为原有合法状态', () => {
    const db = rebuildSeededDatabase();
    const taskNo = 'P25-REVERSE-ORDER';
    const incumbentId = insertVersion(db, taskNo, 1, 'Effective');
    const pendingId = insertVersion(db, taskNo, 2, 'UnderReview');

    const promote = db.prepare("UPDATE task_card SET status = 'Effective' WHERE id = ?");
    const demote = db.prepare("UPDATE task_card SET status = 'Superseded' WHERE id = ?");
    const recordSupersede = db.prepare(
      `INSERT INTO supersede_record
         (task_no, superseded_revision, superseding_revision, superseded_at)
       VALUES (?, 1, 2, '2026-01-01T00:00:00.000Z')`,
    );

    const reverseOrder = db.transaction(() => {
      promote.run(pendingId);
      demote.run(incumbentId);
      recordSupersede.run(taskNo);
    });

    const message = errorMessageOf(() => reverseOrder());
    expect(message).toMatch(/UNIQUE/i);
    expect(message).toContain('task_card.task_no');
    expect(message).not.toContain('task_card.revision');

    expect(statusOf(db, taskNo, 1)).toBe('Effective');
    expect(statusOf(db, taskNo, 2)).toBe('UnderReview');
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM task_card WHERE task_no = ? AND status = 'Effective'")
        .get(taskNo).count,
    ).toBe(1);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM supersede_record WHERE task_no = ?').get(taskNo)
        .count,
    ).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM review_record WHERE card_id = ?').get(pendingId)
        .count,
    ).toBe(0);
    expectSingleEffectiveInvariant(db);
  });
});

afterAll(() => {
  closeDb();
});
