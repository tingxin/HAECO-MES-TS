import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_PATH_ENV,
  DEFAULT_DB_PATH,
  PROJECT_ROOT,
  closeDb,
  db,
  getDb,
  getDbPath,
  isMemoryPath,
  openDatabase,
  resetDb,
  resolveDbPath,
} from './connection.js';

const originalEnv = process.env[DB_PATH_ENV];

function restoreEnv() {
  if (originalEnv === undefined) delete process.env[DB_PATH_ENV];
  else process.env[DB_PATH_ENV] = originalEnv;
}

describe('resolveDbPath', () => {
  beforeEach(() => {
    delete process.env[DB_PATH_ENV];
  });

  afterEach(() => {
    restoreEnv();
  });

  it('默认指向项目根目录下的 data/haeco-mes-ts.db', () => {
    expect(resolveDbPath()).toBe(DEFAULT_DB_PATH);
    expect(DEFAULT_DB_PATH).toBe(path.join(PROJECT_ROOT, 'data', 'haeco-mes-ts.db'));
    // data/ 位于项目根，而非 server/ 下
    expect(path.basename(PROJECT_ROOT)).not.toBe('server');
  });

  it('环境变量可指向 :memory:', () => {
    process.env[DB_PATH_ENV] = ':memory:';
    expect(resolveDbPath()).toBe(':memory:');
    expect(isMemoryPath(resolveDbPath())).toBe(true);
  });

  it('环境变量中的相对路径以项目根目录解析', () => {
    process.env[DB_PATH_ENV] = 'tmp/test.db';
    expect(resolveDbPath()).toBe(path.resolve(PROJECT_ROOT, 'tmp/test.db'));
  });

  it('显式入参优先于环境变量，绝对路径原样保留', () => {
    process.env[DB_PATH_ENV] = ':memory:';
    const abs = path.join(os.tmpdir(), 'haeco-explicit.db');
    expect(resolveDbPath(abs)).toBe(path.normalize(abs));
  });

  it('空白环境变量回退到默认库文件', () => {
    process.env[DB_PATH_ENV] = '   ';
    expect(resolveDbPath()).toBe(DEFAULT_DB_PATH);
  });
});

describe('openDatabase', () => {
  it('开启外键约束并可执行同步查询', () => {
    const conn = openDatabase(':memory:');
    try {
      expect(conn.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(conn.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    } finally {
      conn.close();
    }
  });

  it('外键约束实际生效（违反引用时抛错）', () => {
    const conn = openDatabase(':memory:');
    try {
      conn.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      `);
      expect(() => conn.prepare('INSERT INTO child (id, parent_id) VALUES (1, 999)').run()).toThrow(
        /FOREIGN KEY/i,
      );
    } finally {
      conn.close();
    }
  });

  it('每次调用返回独立连接，便于测试逐次重建', () => {
    const a = openDatabase(':memory:');
    const b = openDatabase(':memory:');
    try {
      expect(a).not.toBe(b);
      a.exec('CREATE TABLE only_in_a (id INTEGER)');
      expect(() => b.prepare('SELECT * FROM only_in_a').get()).toThrow();
    } finally {
      a.close();
      b.close();
    }
  });

  it('文件库缺失父目录时自动创建', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haeco-db-'));
    const target = path.join(dir, 'nested', 'deep', 'test.db');
    const conn = openDatabase(target);
    try {
      conn.exec('CREATE TABLE t (id INTEGER)');
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      conn.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('单例与重置', () => {
  beforeEach(() => {
    closeDb();
    process.env[DB_PATH_ENV] = ':memory:';
  });

  afterEach(() => {
    closeDb();
    restoreEnv();
  });

  it('getDb 多次调用返回同一连接', () => {
    expect(getDb()).toBe(getDb());
    expect(getDbPath()).toBe(':memory:');
  });

  it('导出的 db 代理复用单例', () => {
    const instance = getDb();
    db.exec('CREATE TABLE proxy_check (id INTEGER)');
    expect(instance.prepare('SELECT COUNT(*) AS n FROM proxy_check').get()).toEqual({ n: 0 });
  });

  it('resetDb 丢弃旧数据并建立新连接', () => {
    const first = getDb();
    first.exec('CREATE TABLE tmp_state (id INTEGER)');

    const second = resetDb();
    expect(second).not.toBe(first);
    expect(first.open).toBe(false);
    expect(() => second.prepare('SELECT * FROM tmp_state').get()).toThrow();
    expect(second.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('resetDb 可切换到指定库路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haeco-db-'));
    const target = path.join(dir, 'switch.db');
    try {
      resetDb(target);
      expect(getDbPath()).toBe(path.normalize(target));
      db.exec('CREATE TABLE persisted (id INTEGER)');
      closeDb();
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closeDb 幂等，且关闭后 getDb 重新建立连接', () => {
    const first = getDb();
    closeDb();
    closeDb();
    expect(first.open).toBe(false);
    expect(getDbPath()).toBe(null);

    const next = getDb();
    expect(next.open).toBe(true);
    expect(next).not.toBe(first);
  });
});
