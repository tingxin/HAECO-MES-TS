/**
 * 数据库约束矩阵单元测试（任务 3.7）。
 *
 * 与 schema.test.js 的分工：schema.test.js 关注**生成机制**（占位符渲染、各域对象齐备）
 * 并逐表点检代表性约束；本文件关注**约束矩阵的完整性**——矩阵由 `domain/enums.js` 的
 * `ENUMS` 与运行期自省（sqlite_master + PRAGMA）共同推导，新增一列枚举 CHECK 或一条唯一
 * 约束会自动进入用例，不需要手工补断言，因此矩阵不会随建表悄悄失配。
 *
 * 覆盖四组断言：
 *   1. 枚举 CHECK：全部 41 张表上每一个绑定 `ENUMS` 值域的列，写入域外值一律被拒（需求 6.9）。
 *   2. Property 25 成因：同一 `task_no` 出现第二个 `Effective` 时，部分唯一索引在**该条语句
 *      执行瞬间**即报错——先置生效后降级的顺序整体回滚，先降级后置生效方可成功
 *      （需求 38.7、44.7、44.8）。
 *   3. 两域分离：`task_card` 无执行期列，`process_step` 无条码与执行工时列（需求 15.3、33.1）。
 *   4. 唯一性与必填闸门：每条 UNIQUE / 部分唯一索引拦其重复（需求 38.6、23.2 等），
 *      审核意见 / 变更原因 / 发布结果 / 快照三列的 NOT NULL 拦 null（需求 34.11、19.2、24.3、49.5）。
 *
 * 需求：38.6, 38.7, 44.7, 6.9, 15.3, 23.2, 33.1
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { ENUMS } from '../domain/enums.js';
import { buildSchemaSql } from './schema.js';

/** 渲染一次复用：DDL 文本与枚举值域在整个用例集内恒定 */
const SCHEMA_SQL = buildSchemaSql();

/** 域外取值：不属于任何枚举与局部取值集，用于触发 CHECK */
const OUT_OF_DOMAIN = '__NOT_IN_DOMAIN__';

function freshDb() {
  const db = openDatabase(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

// =====================================================================
// DDL 自省：从 sqlite_master 与 PRAGMA 推导约束模型
// =====================================================================

/** 剥离 SQL 行注释：sqlite_master.sql 保留 DDL 原文（含中文 -- 注释），解析前须去除 */
function stripComments(sql) {
  return String(sql)
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * 解析 `IN (...)` 的字面量列表。
 * 手写扫描而非正则：`COMMERCIAL_CLASSIFICATION` 含 `Configuration(MOD)`，
 * 值内的右括号会让 `\(([^)]*)\)` 提前收尾。
 */
function scanInList(text, from) {
  const values = [];
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ')') return { values, end: i };
    if (ch === "'") {
      let j = i + 1;
      let buf = '';
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") {
          buf += "'";
          j += 2;
          continue;
        }
        if (text[j] === "'") break;
        buf += text[j];
        j += 1;
      }
      values.push(buf);
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      let buf = '';
      while (j < text.length && /[0-9.]/.test(text[j])) {
        buf += text[j];
        j += 1;
      }
      values.push(Number(buf));
      i = j;
      continue;
    }
    i += 1; // 逗号与空白
  }
  return { values, end: -1 };
}

/** 表 DDL → Map(列名 → 该列 CHECK 的允许取值数组) */
function parseCheckSets(tableSql) {
  const sql = stripComments(tableSql);
  const sets = new Map();
  const head = /CHECK\s*\(\s*([A-Za-z_][A-Za-z_0-9]*)\s+IN\s*\(/gi;
  let match = head.exec(sql);
  while (match !== null) {
    const { values, end } = scanInList(sql, head.lastIndex);
    if (end !== -1 && values.length > 0) sets.set(match[1], values);
    match = head.exec(sql);
  }
  return sets;
}

/** 索引 DDL → 部分索引的谓词赋值 `{ column, value }`；非部分索引为 null */
function parseIndexPredicate(indexSql) {
  if (!indexSql) return null;
  const m = /WHERE\s+([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(?:'([^']*)'|(\d+))/i.exec(indexSql);
  if (m === null) return null;
  return { column: m[1], value: m[2] !== undefined ? m[2] : Number(m[3]) };
}

/** 建库自省一次，得到全库约束模型 */
function introspect() {
  const db = freshDb();
  try {
    const tables = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();

    const indexSqlOf = (name) =>
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)?.sql
      ?? null;

    const model = Object.create(null);
    for (const { name, sql } of tables) {
      model[name] = {
        sql,
        columns: db.prepare('SELECT * FROM pragma_table_info(?)').all(name),
        fks: db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name),
        checkSets: parseCheckSets(sql),
        uniqueIndexes: db
          .prepare('SELECT * FROM pragma_index_list(?)')
          .all(name)
          .filter((idx) => idx.unique === 1)
          .map((idx) => ({
            table: name,
            name: idx.name,
            origin: idx.origin,
            partial: idx.partial === 1,
            columns: db
              .prepare('SELECT * FROM pragma_index_info(?)')
              .all(idx.name)
              .map((c) => c.name),
            predicate: parseIndexPredicate(indexSqlOf(idx.name)),
          })),
      };
    }
    return model;
  } finally {
    db.close();
  }
}

const MODEL = introspect();
const TABLE_NAMES = Object.keys(MODEL);

/** 数组值域相等（顺序与内容一致） */
function sameValues(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 列的 CHECK 值域若与某个 ENUMS 条目一致，则该列为「枚举绑定列」 */
function enumFieldOf(values) {
  for (const [field, domain] of Object.entries(ENUMS)) {
    if (sameValues(values, [...domain])) return field;
  }
  return null;
}

/** 枚举绑定列矩阵：{table, column, field, values} */
const ENUM_COLUMNS = TABLE_NAMES.flatMap((table) =>
  [...MODEL[table].checkSets.entries()].flatMap(([column, values]) => {
    const field = enumFieldOf(values);
    return field === null ? [] : [{ table, column, field, values }];
  }),
);

/** 表内局部取值集（非全系统枚举）矩阵：{table, column, values} */
const LOCAL_CHECK_COLUMNS = TABLE_NAMES.flatMap((table) =>
  [...MODEL[table].checkSets.entries()].flatMap(([column, values]) =>
    enumFieldOf(values) === null ? [{ table, column, values }] : [],
  ),
);

/** 全库唯一约束（含部分唯一索引）矩阵 */
const UNIQUE_INDEXES = TABLE_NAMES.flatMap((table) => MODEL[table].uniqueIndexes);

// =====================================================================
// 最小合法行构造：由 PRAGMA 推导必填列，外键逐级补父行
// =====================================================================

/** INTEGER PRIMARY KEY 即 rowid 别名，由 SQLite 自动赋值，不参与构造 */
function isRowidPk(column) {
  return column.pk === 1 && String(column.type).toUpperCase() === 'INTEGER';
}

/**
 * 必填列：NOT NULL 无默认值，或非 rowid 的主键列。
 * 后者是 SQLite 的已知口径差异——`TEXT PRIMARY KEY` 的 `PRAGMA table_info.notnull` 为 0，
 * 但写入 NULL 仍被拒，故一并视为必填。
 */
function requiredColumns(table) {
  return MODEL[table].columns.filter(
    (c) => (c.notnull === 1 || c.pk > 0) && c.dflt_value === null && !isRowidPk(c),
  );
}

function scalarValue(column, salt, bump) {
  const type = String(column.type).toUpperCase();
  if (type.includes('INT') || type.includes('REAL')) return 1 + bump;
  return `${salt}-${column.name}`;
}

let parentSeq = 0;

/** 为外键补一行父记录（父表自身的外键递归补齐），返回其 rowid */
function insertParent(db, table) {
  const salt = `P${(parentSeq += 1)}`;
  const row = buildRow(db, table, { salt });
  return Number(insertRow(db, table, row).lastInsertRowid);
}

function defaultValue(db, table, column, salt) {
  const fk = MODEL[table].fks.find((f) => f.from === column.name);
  if (fk !== undefined) return insertParent(db, fk.table);
  const set = MODEL[table].checkSets.get(column.name);
  if (set !== undefined) return set[0];
  return scalarValue(column, salt, 0);
}

/** 与 defaultValue 必然不同的取值：用于制造「仅目标唯一约束冲突」的第二行 */
function variedValue(db, table, column) {
  const fk = MODEL[table].fks.find((f) => f.from === column.name);
  if (fk !== undefined) return insertParent(db, fk.table);
  const set = MODEL[table].checkSets.get(column.name);
  if (set !== undefined) return set.length > 1 ? set[1] : set[0];
  return scalarValue(column, 'B', 1);
}

function columnOf(table, name) {
  return MODEL[table].columns.find((c) => c.name === name);
}

function insertRow(db, table, row) {
  const cols = Object.keys(row);
  // 全列可空的表（如 electronic_signature、集成 mock 表）最小合法行为空对象
  if (cols.length === 0) return db.prepare(`INSERT INTO ${table} DEFAULT VALUES`).run();
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return db.prepare(sql).run(...cols.map((c) => row[c]));
}

/**
 * 构造一行最小合法数据。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {{overrides?: Record<string, unknown>, include?: string[], salt?: string}} [options]
 *   `include` 额外纳入的列（如唯一索引列）；`overrides` 最后覆盖，可显式置 null。
 */
function buildRow(db, table, options = {}) {
  const { overrides = {}, include = [], salt = 'A' } = options;
  const wanted = new Set([...requiredColumns(table).map((c) => c.name), ...include]);
  const row = {};
  for (const column of MODEL[table].columns) {
    if (!wanted.has(column.name)) continue;
    row[column.name] = defaultValue(db, table, column, salt);
  }
  for (const [key, value] of Object.entries(overrides)) {
    row[key] = value;
  }
  return row;
}

/** 使该行不落入其他部分唯一索引的谓词范围，避免误撞非目标约束 */
function avoidOtherPartials(db, table, row, targetIndexName) {
  for (const idx of MODEL[table].uniqueIndexes) {
    if (idx.name === targetIndexName || idx.predicate === null) continue;
    const { column, value } = idx.predicate;
    if (row[column] === value) {
      row[column] = variedValue(db, table, columnOf(table, column));
    }
  }
  return row;
}

function messageOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return null;
}

// =====================================================================
// 用例
// =====================================================================

describe('约束矩阵自省口径', () => {
  it('全库 44 张表被纳入矩阵，最小合法行均可写入（矩阵非空转）', () => {
    expect(TABLE_NAMES).toHaveLength(44);

    for (const table of TABLE_NAMES) {
      const db = freshDb();
      try {
        expect(() => insertRow(db, table, buildRow(db, table)), table).not.toThrow();
      } finally {
        db.close();
      }
    }
  });

  it('除 stageCrosscut 外，ENUMS 每个值域都至少绑定一列 CHECK', () => {
    const bound = new Set(ENUM_COLUMNS.map((c) => c.field));
    const unbound = Object.keys(ENUMS).filter((field) => !bound.has(field));
    // stage_crosscut.stage 刻意绑定完整 STAGE 而非 STAGE_CROSSCUT：本表是运行时权威，
    // 业务方增删横切取值属配置动作（需求 46.13、46.14）。
    expect(unbound).toEqual(['stageCrosscut']);
  });

  it('枚举绑定列与唯一约束数量不低于建表时的规模（约束被摘除即失败）', () => {
    expect(ENUM_COLUMNS.length).toBeGreaterThanOrEqual(33);
    expect(UNIQUE_INDEXES.length).toBeGreaterThanOrEqual(19);
    expect(UNIQUE_INDEXES.filter((i) => i.partial)).toHaveLength(2);
  });
});

describe('枚举 CHECK 拦域外值（需求 6.9）', () => {
  for (const { table, column, field, values } of ENUM_COLUMNS) {
    it(`${table}.${column} 绑定 ${field} 值域，域外值被拒`, () => {
      expect(values).not.toContain(OUT_OF_DOMAIN);
      const db = freshDb();
      try {
        const row = buildRow(db, table, { overrides: { [column]: OUT_OF_DOMAIN } });
        expect(() => insertRow(db, table, row)).toThrow(/CHECK/i);
        // 合法值可写入，证明失败确由该列取值引起
        expect(() =>
          insertRow(db, table, buildRow(db, table, { overrides: { [column]: values[0] } })),
        ).not.toThrow();
      } finally {
        db.close();
      }
    });
  }
});

describe('表内局部取值集 CHECK 拦域外值', () => {
  for (const { table, column, values } of LOCAL_CHECK_COLUMNS) {
    const invalid = typeof values[0] === 'number' ? 9 : OUT_OF_DOMAIN;
    it(`${table}.${column} 仅接受 ${JSON.stringify(values)}`, () => {
      expect(values).not.toContain(invalid);
      const db = freshDb();
      try {
        const row = buildRow(db, table, { overrides: { [column]: invalid } });
        expect(() => insertRow(db, table, row)).toThrow(/CHECK/i);
      } finally {
        db.close();
      }
    });
  }
});

describe('唯一性约束拦重复', () => {
  for (const idx of UNIQUE_INDEXES) {
    const { table, name, columns, predicate, origin } = idx;
    const label = origin === 'c' ? name : `UNIQUE(${columns.join(', ')})`;
    it(`${table} 的 ${label}${predicate ? `（WHERE ${predicate.column} = ${predicate.value}）` : ''} 拒绝重复`, () => {
      const db = freshDb();
      try {
        const include = [...columns];
        if (predicate !== null) include.push(predicate.column);
        const overrides = predicate === null ? {} : { [predicate.column]: predicate.value };

        const first = avoidOtherPartials(db, table, buildRow(db, table, { include, overrides }), name);
        insertRow(db, table, first);

        // 第二行仅在目标约束上与第一行相同：其他唯一约束涉及的列一律取不同值
        const second = { ...first };
        const otherUniqueColumns = new Set(
          MODEL[table].uniqueIndexes
            .filter((other) => other.name !== name)
            .flatMap((other) => other.columns)
            .filter((col) => !columns.includes(col)),
        );
        for (const col of otherUniqueColumns) {
          second[col] = variedValue(db, table, columnOf(table, col));
        }

        const message = messageOf(() => insertRow(db, table, second));
        expect(message, `${table}.${name} 未拒绝重复`).toMatch(/UNIQUE/i);
        // 报错须指向目标约束的列，而非顺带撞上的其他约束
        // （SQLite 对部分唯一索引亦报列名而非索引名，故两类索引口径一致）
        for (const col of columns) {
          expect(message).toContain(`${table}.${col}`);
        }
      } finally {
        db.close();
      }
    });
  }
});

describe('NOT NULL 闸门（需求 34.11、19.2、24.3、49.5）', () => {
  const GATES = [
    ['review_record', 'comment', '审核意见必填'],
    ['change_record', 'reason', '变更原因必填'],
    ['work_package_release', 'result', '发布结果无论成败均须记录'],
    ['job_step_snapshot', 'source_card_revision', '快照须标明来源版本号'],
    ['job_step_snapshot', 'content', '快照内容不可为空'],
    ['job_step_snapshot', 'snapshot_at', '快照须标明生成时间'],
  ];

  for (const [table, column, why] of GATES) {
    it(`${table}.${column} 为 NOT NULL（${why}）`, () => {
      const db = freshDb();
      try {
        expect(requiredColumns(table).map((c) => c.name)).toContain(column);
        const row = buildRow(db, table, { overrides: { [column]: null } });
        expect(() => insertRow(db, table, row)).toThrow(/NOT NULL/i);
      } finally {
        db.close();
      }
    });
  }
});

describe('Property 25 成因：部分唯一索引的语句级立即校验（需求 38.7、44.7、44.8）', () => {
  const TASK_NO = 'TC-APPROVE-001';

  function seedTwoRevisions(db) {
    const insert = db.prepare(
      'INSERT INTO task_card (task_no, revision, title, card_type, status) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run(TASK_NO, 1, '第一版', '04', 'Effective');
    insert.run(TASK_NO, 2, '第二版', '04', 'UnderReview');
  }

  function statusOf(db, revision) {
    return db
      .prepare('SELECT status FROM task_card WHERE task_no = ? AND revision = ?')
      .get(TASK_NO, revision).status;
  }

  function effectiveCount(db) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM task_card WHERE task_no = ? AND status = 'Effective'")
      .get(TASK_NO).n;
  }

  it('顺序颠倒（先置生效、后降级）在第一条 UPDATE 即失败并整体回滚', () => {
    const db = freshDb();
    try {
      seedTwoRevisions(db);
      const promote = db.prepare(
        "UPDATE task_card SET status = 'Effective' WHERE task_no = ? AND revision = ?",
      );
      const demote = db.prepare(
        "UPDATE task_card SET status = 'Superseded' WHERE task_no = ? AND revision = ?",
      );

      const wrongOrder = db.transaction(() => {
        promote.run(TASK_NO, 2); // 此刻同一 task_no 出现两个 Effective → 立即报错
        demote.run(TASK_NO, 1); // 永不执行
      });

      const message = messageOf(() => wrongOrder());
      // 撞的是 (task_no) WHERE status='Effective' 部分唯一索引：仅 task_no 一列参与，
      // 而 UNIQUE(task_no, revision) 会同时报出 revision——据此区分是哪条约束报错
      expect(message).toMatch(/UNIQUE/i);
      expect(message).toContain('task_card.task_no');
      expect(message).not.toContain('task_card.revision');

      // 回滚后两行状态均未变：新版本没进生效态，原生效版本仍生效（需求 44.8）
      expect(statusOf(db, 1)).toBe('Effective');
      expect(statusOf(db, 2)).toBe('UnderReview');
      expect(effectiveCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('正确顺序（先降级、后置生效）成功，且事务内每条语句执行后生效版本数恒 ≤ 1', () => {
    const db = freshDb();
    try {
      seedTwoRevisions(db);
      const promote = db.prepare(
        "UPDATE task_card SET status = 'Effective' WHERE task_no = ? AND revision = ?",
      );
      const demote = db.prepare(
        "UPDATE task_card SET status = 'Superseded' WHERE task_no = ? AND revision = ?",
      );
      const recordSupersede = db.prepare(
        `INSERT INTO supersede_record
           (task_no, superseded_revision, superseding_revision, superseded_at)
         VALUES (?, ?, ?, ?)`,
      );

      const observed = [];
      const rightOrder = db.transaction(() => {
        demote.run(TASK_NO, 1);
        observed.push(effectiveCount(db));
        promote.run(TASK_NO, 2);
        observed.push(effectiveCount(db));
        recordSupersede.run(TASK_NO, 1, 2, '2026-01-01T00:00:00Z');
        observed.push(effectiveCount(db));
      });

      expect(() => rightOrder()).not.toThrow();
      expect(observed).toEqual([0, 1, 1]);
      expect(observed.every((n) => n <= 1)).toBe(true);
      expect(statusOf(db, 1)).toBe('Superseded');
      expect(statusOf(db, 2)).toBe('Effective');
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM supersede_record WHERE task_no = ?').get(TASK_NO).n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('非生效态不受部分索引约束：同一 task_no 可并存多个非生效版本', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        'INSERT INTO task_card (task_no, revision, title, card_type, status) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run(TASK_NO, 1, 'v1', '04', 'Superseded');
      insert.run(TASK_NO, 2, 'v2', '04', 'Void');
      insert.run(TASK_NO, 3, 'v3', '04', 'New');
      insert.run(TASK_NO, 4, 'v4', '04', 'UnderReview');
      insert.run(TASK_NO, 5, 'v5', '04', 'Effective');

      expect(effectiveCount(db)).toBe(1);
      expect(() => insert.run(TASK_NO, 6, 'v6', '04', 'Effective')).toThrow(/UNIQUE/i);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM task_card WHERE task_no = ?').get(TASK_NO).n,
      ).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe('两域分离的列缺失断言（需求 15.3、33.1、37.5）', () => {
  const columnsOf = (table) => MODEL[table].columns.map((c) => c.name);

  it('task_card 不含工卡级起止时间、WBS 独立列与执行期字段', () => {
    const cardColumns = columnsOf('task_card');
    for (const forbidden of [
      'start_time',
      'finish_time',
      'wbs',
      'owner',
      'job_target_date',
      'inbound_gear_pn',
      'inbound_sn',
      'outbound_gear_pn',
      'cs_no',
      'work_order',
      'part_no',
      'part_sn',
      'part_desc',
      'operation_type',
      'job_no',
      'exec_status',
    ]) {
      expect(cardColumns, `task_card 不应有 ${forbidden}`).not.toContain(forbidden);
    }
    // WBS 与工卡类型是同一字段的两种称法，仅 card_type 单列（需求 6.8）
    expect(cardColumns).toContain('card_type');

    // 工卡级起止时间的唯一落位是 job 表（需求 33.1）
    const jobColumns = columnsOf('job');
    expect(jobColumns).toContain('start_time');
    expect(jobColumns).toContain('finish_time');
  });

  it('process_step 不含条码列、执行期工时与工序起止时间', () => {
    const stepColumns = columnsOf('process_step');
    for (const forbidden of [
      'barcode_value',
      'barcode_type',
      'start_time',
      'finish_time',
      'effective_man_hours',
      'actual_man_hours',
    ]) {
      expect(stepColumns, `process_step 不应有 ${forbidden}`).not.toContain(forbidden);
    }
    // 条码与执行期工时只在 job_process（需求 15.3、11.4）
    const jobProcessColumns = columnsOf('job_process');
    for (const required of [
      'barcode_value',
      'barcode_type',
      'start_time',
      'finish_time',
      'effective_man_hours',
      'actual_man_hours',
    ]) {
      expect(jobProcessColumns).toContain(required);
    }
  });
});
