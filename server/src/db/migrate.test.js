/**
 * 迁移脚本单元测试（任务 3.6）。
 *
 * 关注点：① 迁移经 schema.js 渲染而非读取 schema.sql 原文（占位符不会被执行）；
 * ② 44 张表齐备；③ 可重复执行（幂等）；④ 既可作用于内存库也可作用于临时文件库，
 * 后者是属性/接口测试逐次重建数据库的前提。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { listTables, migrate, runMigration } from './migrate.js';

/** schema.sql 应建立的表（含 Section 20 三张只读集成 mock 表，共 44 张） */
const EXPECTED_TABLE_COUNT = 44;

const tempDirs = [];

function tempDbPath(name = 'migrate.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haeco-mes-migrate-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('migrate(connection)', () => {
  it('在内存库上建立全部 44 张表', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db);
      const tables = listTables(db);
      expect(tables).toHaveLength(EXPECTED_TABLE_COUNT);
      // 四个域各取代表表，确认分节均已执行
      for (const table of ['task_card', 'job', 'change_record', 'role_permission', 'ppc_schedule']) {
        expect(tables).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('可重复执行且表数量不变（DDL 全部 IF NOT EXISTS）', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db);
      const first = listTables(db);
      expect(() => migrate(db)).not.toThrow();
      expect(listTables(db)).toEqual(first);
    } finally {
      db.close();
    }
  });

  it('迁移后的枚举列受 CHECK 约束（DDL 经 enums.js 渲染，占位符未被原样执行）', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db);
      const insert = db.prepare(
        'INSERT INTO task_card (task_no, revision, title, card_type, status) VALUES (?, ?, ?, ?, ?)',
      );
      expect(() => insert.run('TC-MIG-001', 1, '标题', '99', 'New')).toThrow(/CHECK/i);
      expect(() => insert.run('TC-MIG-001', 1, '标题', '04', 'New')).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('runMigration({ dbPath })', () => {
  it('在临时文件库上建库并返回表清单，重复执行不报错', () => {
    const dbPath = tempDbPath();

    const first = runMigration({ dbPath });
    expect(first.dbPath).toBe(dbPath);
    expect(first.tables).toHaveLength(EXPECTED_TABLE_COUNT);
    expect(fs.existsSync(dbPath)).toBe(true);

    const second = runMigration({ dbPath });
    expect(second.tables).toEqual(first.tables);
  });
});


describe('commercial_classification_result 兼容迁移', () => {
  it('幂等补列并保留旧行数据', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db);
      const cardId = db.prepare("INSERT INTO task_card (task_no, revision, title, card_type, status) VALUES ('LEGACY-CLS', 1, 'legacy', '04', 'New')").run().lastInsertRowid;
      db.exec('DROP TABLE commercial_classification_result');
      db.exec(`CREATE TABLE commercial_classification_result (
        id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL,
        classification TEXT, hit_tier TEXT, source_ref TEXT,
        is_manual_confirmed INTEGER NOT NULL DEFAULT 0, confirmed_by TEXT,
        confirmed_at TEXT, created_at TEXT)`);
      db.prepare("INSERT INTO commercial_classification_result (card_id, classification, hit_tier, source_ref) VALUES (?, 'Routine', 'P6_CardTypeFallback', 'legacy')").run(cardId);
      migrate(db);
      migrate(db);
      const columns = db.prepare('PRAGMA table_info(commercial_classification_result)').all().map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(['status', 'candidates_json', 'recommended_classification', 'outsource_subtype', 'reason_code', 'evaluated_tiers_json', 'derivation_result_id']));
      expect(db.prepare('SELECT classification, source_ref FROM commercial_classification_result').get())
        .toEqual({ classification: 'Routine', source_ref: 'legacy' });
    } finally { db.close(); }
  });
});