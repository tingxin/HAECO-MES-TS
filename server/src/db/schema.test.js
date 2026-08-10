/**
 * schema 生成器单元测试（任务 3.2 编制域 + 3.3 执行域 + 3.4 流程与审计域 +
 * 3.5 配置、主数据与集成 mock）。
 *
 * 关注点是**生成机制本身**：占位符全部渲染、渲染结果可执行、各域对象齐备、
 * 以及不得回归的结构约束（部分唯一索引、两域分离、条码与工序编号唯一、快照一对一、
 * 审核意见与变更原因的 NOT NULL 闸门、分类结果的追加式轨迹、配置表的运行时权威性与
 * 集成 mock 的软引用）。
 * 更完整的约束矩阵（枚举 CHECK 拦非法值、各唯一约束拦重复）见任务 3.7。
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import {
  AC_TYPE,
  CARD_STATUS,
  DERIVATION_PRIORITY,
  EXEC_DOC_SIGN_RULE,
  EXEC_DOC_TYPE,
  renderCheckConstraint,
} from '../domain/enums.js';
import { buildSchemaSql, readSchemaTemplate, renderSchemaSql } from './schema.js';

/** 编制域应建立的表（任务 3.2 范围） */
const AUTHORING_TABLES = [
  'task_card',
  'reference_document',
  'process_step',
  'capture_item',
  'inserted_component',
  'signature_requirement',
  'attachment',
  'card_relation',
  'lot_list_link',
  'bom_base_output',
  'exec_document',
];

/** 执行域应建立的表（任务 3.3 范围） */
const EXECUTION_TABLES = [
  'job',
  'job_process',
  'job_step_snapshot',
  'safety_acknowledgement',
  'electronic_signature',
];

/** 流程与审计域应建立的表（任务 3.4 范围） */
const AUDIT_TABLES = [
  'review_record',
  'supersede_record',
  'change_record',
  'commercial_classification_result',
  'migration_batch',
  'migration_record',
  'work_package_release',
  'access_denial_log',
];

function freshDb() {
  const db = openDatabase(':memory:');
  db.exec(buildSchemaSql());
  return db;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

describe('schema.sql 模板与渲染', () => {
  it('模板不手写枚举字面量，枚举 CHECK 一律为占位符', () => {
    const template = readSchemaTemplate();
    // 取一个有代表性的枚举值域：模板中不得出现其成员列表
    const acTypeList = AC_TYPE.map((v) => `'${v}'`).join(',');
    expect(template).not.toContain(acTypeList);
    expect(template).toContain('{{CHECK:acType}}');
  });

  it('渲染后不残留占位符，且 CHECK 子句取自 enums.js', () => {
    const sql = buildSchemaSql();
    // 注释块内的语法示例不算残留；DDL 正文（去注释后）不得留任何占位符
    const ddlOnly = sql
      .split('\n')
      .map((line) => (line.includes('--') ? line.slice(0, line.indexOf('--')) : line))
      .join('\n');
    expect(ddlOnly).not.toContain('{{');
    expect(sql).toContain(renderCheckConstraint('cardType'));
    expect(sql).toContain(renderCheckConstraint('cardStatus', 'status'));
    expect(sql).toContain(renderCheckConstraint('componentType', 'type'));
  });

  it('未知枚举字段的占位符在生成期即失败', () => {
    expect(() => renderSchemaSql('x TEXT {{CHECK:notAnEnum}}')).toThrow(/未知枚举字段/);
  });
});

describe('编制域 DDL 可执行且对象齐备', () => {
  it('在内存库执行后编制域表全部存在', () => {
    const db = freshDb();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      for (const table of AUTHORING_TABLES) {
        expect(tables).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('DDL 可重复执行（IF NOT EXISTS 幂等）', () => {
    const db = freshDb();
    try {
      expect(() => db.exec(buildSchemaSql())).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('task_card 建立 UNIQUE(task_no, revision) 与生效版本部分唯一索引', () => {
    const db = freshDb();
    try {
      const indexes = db
        .prepare("SELECT name, partial FROM pragma_index_list('task_card')")
        .all();
      expect(indexes.some((i) => i.name === 'ux_task_card_effective_task_no' && i.partial === 1))
        .toBe(true);

      const insert = db.prepare(
        'INSERT INTO task_card (task_no, revision, title, card_type, status) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('TC-001', 1, '标题', '04', 'New');
      expect(() => insert.run('TC-001', 1, '标题', '04', 'New')).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('同一 task_no 出现第二个 Effective 版本时被部分唯一索引拒绝', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        'INSERT INTO task_card (task_no, revision, title, card_type, status) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('TC-002', 1, '第一版', '04', 'Effective');
      expect(() => insert.run('TC-002', 2, '第二版', '04', 'Effective')).toThrow(/UNIQUE/i);

      // 非生效态不受该索引约束：同编号可并存多个非生效版本
      insert.run('TC-002', 3, '第三版', '04', 'New');
      insert.run('TC-002', 4, '第四版', '04', 'Superseded');
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM task_card WHERE task_no = ?')
        .get('TC-002').n;
      expect(count).toBe(3);
      expect(CARD_STATUS).toContain('Superseded');
    } finally {
      db.close();
    }
  });

  it('两域分离：task_card 无执行期列，process_step 无条码与执行工时列', () => {
    const db = freshDb();
    try {
      const cardColumns = columnNames(db, 'task_card');
      for (const forbidden of [
        'start_time', 'finish_time', 'wbs', 'owner', 'job_target_date',
        'cs_no', 'work_order', 'part_no', 'part_sn', 'part_desc', 'operation_type',
      ]) {
        expect(cardColumns).not.toContain(forbidden);
      }

      const stepColumns = columnNames(db, 'process_step');
      for (const forbidden of [
        'barcode_value', 'barcode_type', 'start_time', 'finish_time',
        'effective_man_hours', 'actual_man_hours',
      ]) {
        expect(stepColumns).not.toContain(forbidden);
      }
      expect(stepColumns).toContain('operation');
    } finally {
      db.close();
    }
  });

  it('exec_document 建立 UNIQUE(exec_doc_type, doc_no, revision)', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        'INSERT INTO exec_document (exec_doc_type, doc_no, revision, status, content) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('SW', 'SWS-001', 1, 'New', JSON.stringify({ steps: [] }));
      expect(() => insert.run('SW', 'SWS-001', 1, 'New', '{}')).toThrow(/UNIQUE/i);
      insert.run('SW', 'SWS-001', 2, 'New', '{}');

      const row = db.prepare('SELECT content FROM exec_document WHERE revision = 1').get();
      expect(JSON.parse(row.content)).toEqual({ steps: [] });
    } finally {
      db.close();
    }
  });
});

/** 建一张最小可用工卡，返回其 id */
function insertCard(db, taskNo = 'TC-JOB-001', status = 'Effective') {
  return db
    .prepare(
      'INSERT INTO task_card (task_no, revision, title, card_type, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run(taskNo, 1, '标题', '04', status).lastInsertRowid;
}

/** 建一个最小可用 JOB，返回其 id */
function insertJob(db, jobNo, cardId = null) {
  return db
    .prepare(
      'INSERT INTO job (job_no, card_id, card_revision, exec_status) VALUES (?, ?, ?, ?)',
    )
    .run(jobNo, cardId, 1, 'Pending').lastInsertRowid;
}

/** 建一个最小可用 JOB 工序实例，返回其 id */
function insertJobProcess(db, jobId, processId, barcodeValue) {
  return db
    .prepare(
      `INSERT INTO job_process (job_id, process_id, barcode_value, barcode_type)
       VALUES (?, ?, ?, 'barcode')`,
    )
    .run(jobId, processId, barcodeValue).lastInsertRowid;
}

describe('执行域 DDL 可执行且对象齐备', () => {
  it('在内存库执行后执行域表全部存在', () => {
    const db = freshDb();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      for (const table of EXECUTION_TABLES) {
        expect(tables).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('job 是工卡级起止时间与执行期字段的唯一落位，job_no 唯一', () => {
    const db = freshDb();
    try {
      const jobColumns = columnNames(db, 'job');
      for (const required of [
        'start_time', 'finish_time', 'exec_status',
        'owner', 'job_target_date', 'check_type',
        'inbound_gear_pn', 'inbound_sn', 'cs_no', 'work_order', 'outbound_gear_pn',
        'part_no', 'part_sn', 'part_desc', 'operation_type',
      ]) {
        expect(jobColumns).toContain(required);
      }

      const cardId = insertCard(db);
      insertJob(db, 'JOB-001', cardId);
      // 同一 Task Card 多次释放各得独立 JOB No（需求 37.3）
      insertJob(db, 'JOB-002', cardId);
      expect(() => insertJob(db, 'JOB-001', cardId)).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('job.exec_status 局部取值集拦非法值', () => {
    const db = freshDb();
    try {
      expect(() =>
        db
          .prepare('INSERT INTO job (job_no, exec_status) VALUES (?, ?)')
          .run('JOB-BAD', '执行中'),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('job_process 同时受 UNIQUE(job_id, process_id) 与 UNIQUE(barcode_value) 约束', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db);
      const jobA = insertJob(db, 'JOB-001', cardId);
      const jobB = insertJob(db, 'JOB-002', cardId);

      insertJobProcess(db, jobA, 'A', 'JOB-001-A');

      // 同一 JOB 内工序编号不可重复（条码另取以隔离两个约束）
      expect(() => insertJobProcess(db, jobA, 'A', 'JOB-001-A-DUP')).toThrow(/UNIQUE/i);

      // 条码全局唯一：跨 JOB 复用同一条码值亦被拒绝
      expect(() => insertJobProcess(db, jobB, 'A', 'JOB-001-A')).toThrow(/UNIQUE/i);

      // 不同 JOB 的同名工序各取自身条码，两者可共存
      insertJobProcess(db, jobB, 'A', 'JOB-002-A');
      const count = db.prepare('SELECT COUNT(*) AS n FROM job_process').get().n;
      expect(count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('job_step_snapshot 与 job_process 一对一，且快照三列非空', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db);
      const jobId = insertJob(db, 'JOB-001', cardId);
      const processId = insertJobProcess(db, jobId, 'A', 'JOB-001-A');

      const insertSnapshot = db.prepare(
        `INSERT INTO job_step_snapshot
           (job_process_id, source_step_id, source_card_revision, content, snapshot_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const content = { processId: 'A', skill: 'GR', isCritical: 1, captureItems: [] };
      insertSnapshot.run(processId, null, 1, JSON.stringify(content), '2026-01-01T00:00:00Z');

      // 一对一：同一 job_process 不得有第二条快照
      expect(() =>
        insertSnapshot.run(processId, null, 1, '{}', '2026-01-01T00:00:00Z'),
      ).toThrow(/UNIQUE/i);

      // content / source_card_revision / snapshot_at 均 NOT NULL
      const process2 = insertJobProcess(db, jobId, 'B', 'JOB-001-B');
      expect(() => insertSnapshot.run(process2, null, 1, null, '2026-01-01T00:00:00Z'))
        .toThrow(/NOT NULL/i);
      expect(() => insertSnapshot.run(process2, null, null, '{}', '2026-01-01T00:00:00Z'))
        .toThrow(/NOT NULL/i);
      expect(() => insertSnapshot.run(process2, null, 1, '{}', null)).toThrow(/NOT NULL/i);

      const row = db
        .prepare('SELECT content, source_card_revision FROM job_step_snapshot WHERE job_process_id = ?')
        .get(processId);
      expect(JSON.parse(row.content)).toEqual(content);
      expect(row.source_card_revision).toBe(1);
    } finally {
      db.close();
    }
  });

  it('safety_acknowledgement 与 electronic_signature 可落库并受 FK 约束', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db);
      const jobId = insertJob(db, 'JOB-001', cardId);
      const processId = insertJobProcess(db, jobId, 'A', 'JOB-001-A');

      db.prepare(
        `INSERT INTO safety_acknowledgement (job_process_id, acknowledged_by, acknowledged_at)
         VALUES (?, ?, ?)`,
      ).run(processId, 'E10001', '2026-01-01T00:00:00Z');
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM safety_acknowledgement').get().n,
      ).toBe(1);

      // 不存在的 job_process 被外键拒绝
      expect(() =>
        db
          .prepare('INSERT INTO safety_acknowledgement (job_process_id) VALUES (?)')
          .run(999999),
      ).toThrow(/FOREIGN KEY/i);

      const stepId = db
        .prepare(
          'INSERT INTO process_step (card_id, process_id, seq) VALUES (?, ?, ?)',
        )
        .run(cardId, 'A', 1).lastInsertRowid;
      const requirementId = db
        .prepare(
          'INSERT INTO signature_requirement (step_id, signature_role) VALUES (?, ?)',
        )
        .run(stepId, 'QC').lastInsertRowid;

      db.prepare(
        `INSERT INTO electronic_signature
           (card_id, job_id, signature_requirement_id, signed_by, stamp_id, signed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(cardId, jobId, requirementId, 'E10002', 'STAMP-1', '2026-01-02T00:00:00Z');

      // job_id 为 NULL 表示编制态签署
      db.prepare(
        `INSERT INTO electronic_signature
           (card_id, job_id, signature_requirement_id, signed_by, signed_at)
         VALUES (?, NULL, ?, ?, ?)`,
      ).run(cardId, requirementId, 'E10003', '2026-01-03T00:00:00Z');

      expect(db.prepare('SELECT COUNT(*) AS n FROM electronic_signature').get().n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('job 表建立后 card_relation 写入不再报 no such table: main.job', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db);
      const jobId = insertJob(db, 'JOB-001', cardId);

      const insertRelation = db.prepare(
        `INSERT INTO card_relation (card_id, exec_doc_type, related_doc_no, job_id, origin)
         VALUES (?, ?, ?, ?, ?)`,
      );
      // 编制期人工关联：job_id 为 NULL
      expect(() => insertRelation.run(cardId, 'SW', 'SWS-001', null, 'manual')).not.toThrow();
      // 执行期自动关联：job_id 指向已存在的 JOB
      expect(() => insertRelation.run(cardId, 'PC', 'PC-001', jobId, 'auto')).not.toThrow();
      // 三元组不重复
      expect(() => insertRelation.run(cardId, 'SW', 'SWS-001', null, 'manual')).toThrow(/UNIQUE/i);

      expect(db.prepare('SELECT COUNT(*) AS n FROM card_relation').get().n).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('流程与审计域 DDL 可执行且约束到位', () => {
  it('在内存库执行后流程与审计域表全部存在', () => {
    const db = freshDb();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      for (const table of AUDIT_TABLES) {
        expect(tables).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('review_record.comment 为 NOT NULL，审核意见缺失时写入被拒（需求 34.11）', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db, 'TC-REV-001', 'New');
      const insert = db.prepare(
        `INSERT INTO review_record (card_id, card_revision, action, reviewer, comment, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insert.run(cardId, 1, 'approve', 'E20001', '内容完整，同意生效', '2026-01-01T00:00:00Z');
      insert.run(cardId, 1, 'reject', 'E20001', '工序 B 缺参考文件', '2026-01-02T00:00:00Z');

      expect(() => insert.run(cardId, 1, 'approve', 'E20001', null, '2026-01-03T00:00:00Z'))
        .toThrow(/NOT NULL/i);
      // action 局部取值集拦非法值
      expect(() => insert.run(cardId, 1, '通过', 'E20001', '意见', '2026-01-03T00:00:00Z'))
        .toThrow(/CHECK/i);

      // 记录按版本归集：升版后的新版本从 0 条起算（需求 34.9）
      const v1 = db
        .prepare('SELECT COUNT(*) AS n FROM review_record WHERE card_id = ? AND card_revision = ?')
        .get(cardId, 1).n;
      const v2 = db
        .prepare('SELECT COUNT(*) AS n FROM review_record WHERE card_id = ? AND card_revision = ?')
        .get(cardId, 2).n;
      expect(v1).toBe(2);
      expect(v2).toBe(0);
    } finally {
      db.close();
    }
  });

  it('supersede_record 按 task_no 记录取代关系', () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO supersede_record
           (task_no, superseded_revision, superseding_revision, superseded_at)
         VALUES (?, ?, ?, ?)`,
      ).run('TC-SUP-001', 1, 2, '2026-01-05T00:00:00Z');

      const row = db
        .prepare('SELECT * FROM supersede_record WHERE task_no = ?')
        .get('TC-SUP-001');
      expect(row.superseded_revision).toBe(1);
      expect(row.superseding_revision).toBe(2);

      // 被取代版本号与取代版本号均 NOT NULL
      expect(() =>
        db
          .prepare(
            'INSERT INTO supersede_record (task_no, superseded_revision, superseding_revision) VALUES (?, ?, ?)',
          )
          .run('TC-SUP-002', null, 2),
      ).toThrow(/NOT NULL/i);
    } finally {
      db.close();
    }
  });

  it('change_record.reason 为 NOT NULL，change_type 局部取值集拦非法值（需求 19.2、20.8）', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db, 'TC-CHG-001', 'New');
      const insert = db.prepare(
        `INSERT INTO change_record
           (card_id, card_revision, change_type, field, old_value, new_value, reason, operator_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // 五类变更类型全部被接受
      for (const changeType of ['edit', 'delete', 'revise', 'batch_replace', 'void']) {
        insert.run(cardId, 1, changeType, 'title', '旧标题', '新标题', '客户要求', 'E10001', '2026-01-01T00:00:00Z');
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM change_record').get().n).toBe(5);

      expect(() =>
        insert.run(cardId, 1, 'archive', 'title', '旧', '新', '原因', 'E10001', '2026-01-01T00:00:00Z'),
      ).toThrow(/CHECK/i);

      // 原因缺失整体拒绝（纯空白原因的拒绝在领域层）
      expect(() =>
        insert.run(cardId, 1, 'edit', 'title', '旧', '新', null, 'E10001', '2026-01-01T00:00:00Z'),
      ).toThrow(/NOT NULL/i);

      // 整体性变更（作废/删除）允许 field / old_value / new_value 为 NULL
      expect(() =>
        insert.run(cardId, 1, 'void', null, null, null, '工卡不再适用', 'E10001', '2026-01-02T00:00:00Z'),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('commercial_classification_result 为追加式轨迹，同卡可多行且枚举列受 enums.js 约束', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db, 'TC-CLS-001', 'New');
      const insert = db.prepare(
        `INSERT INTO commercial_classification_result
           (card_id, classification, hit_tier, source_ref, is_manual_confirmed, confirmed_by, confirmed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // ① 自动派生待人工确认：类型 11 无命中，classification 留空
      insert.run(cardId, null, 'P6_CardTypeFallback', 'card_type=11', 0, null, null, '2026-01-01T00:00:00Z');
      // ② 人工确认后追加一行，不更新既有行
      insert.run(cardId, 'Routine', 'P5_PackageDivision', 'WP-001', 1, 'E30001', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

      const rows = db
        .prepare('SELECT * FROM commercial_classification_result WHERE card_id = ? ORDER BY created_at')
        .all(cardId);
      expect(rows).toHaveLength(2);
      expect(rows[0].classification).toBeNull();
      expect(rows[1].is_manual_confirmed).toBe(1);

      // classification 与 hit_tier 的 CHECK 取自 enums.js（COMMERCIAL_CLASSIFICATION / DERIVATION_PRIORITY）
      expect(buildSchemaSql()).toContain(
        renderCheckConstraint('commercialClassification', 'classification'),
      );
      expect(buildSchemaSql()).toContain(renderCheckConstraint('derivationPriority', 'hit_tier'));
      expect(() =>
        insert.run(cardId, '常规', 'P1_PlanSetting', null, 0, null, null, '2026-01-03T00:00:00Z'),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert.run(cardId, 'Routine', 'P9_Unknown', null, 0, null, null, '2026-01-03T00:00:00Z'),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('migration_record 逐条结果受 status 与 failure_category 约束，失败行不影响成功行', () => {
    const db = freshDb();
    try {
      const batchId = db
        .prepare(
          `INSERT INTO migration_batch
             (source_channel, source_name, total_count, success_count, failure_count, executed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('excel', '存量工卡.xlsx', 3, 1, 2, '2026-01-01T00:00:00Z').lastInsertRowid;

      const cardId = insertCard(db, 'TC-MIG-001', 'New');
      const insert = db.prepare(
        `INSERT INTO migration_record
           (batch_id, row_no, source_task_no, card_id, status, failure_category, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(batchId, 1, 'TC-MIG-001', cardId, 'success', null, null);
      insert.run(batchId, 2, 'TC-MIG-002', null, 'failed', 'enum_invalid', 'skill 取值不在词表内');
      insert.run(batchId, 3, 'TC-MIG-003', null, 'failed', 'stage_card_type_invalid', 'Stage 与类型组合不合法');

      expect(() => insert.run(batchId, 4, 'TC-MIG-004', null, 'skipped', null, null)).toThrow(/CHECK/i);
      expect(() => insert.run(batchId, 4, 'TC-MIG-004', null, 'failed', '其它', '原因')).toThrow(/CHECK/i);

      // 成功 + 失败恒等于批次总数，且失败原因可按类型分组统计（需求 41.5）
      const batch = db.prepare('SELECT * FROM migration_batch WHERE id = ?').get(batchId);
      const stats = db
        .prepare(
          `SELECT status, failure_category, COUNT(*) AS n
             FROM migration_record WHERE batch_id = ? GROUP BY status, failure_category`,
        )
        .all(batchId);
      expect(batch.success_count + batch.failure_count).toBe(batch.total_count);
      expect(stats.filter((s) => s.status === 'failed').map((s) => s.failure_category).sort())
        .toEqual(['enum_invalid', 'stage_card_type_invalid']);
    } finally {
      db.close();
    }
  });

  it('work_package_release 无论成功与否都必须落一条结果（需求 24.3）', () => {
    const db = freshDb();
    try {
      const cardId = insertCard(db, 'TC-REL-001', 'Effective');
      const insert = db.prepare(
        `INSERT INTO work_package_release (card_id, job_no, package_ref, released_at, result)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run(cardId, 'JOB-100', 'WP-001', '2026-01-01T00:00:00Z', 'success');
      insert.run(cardId, null, 'WP-002', '2026-01-02T00:00:00Z', 'failed');

      expect(() => insert.run(cardId, null, 'WP-003', '2026-01-03T00:00:00Z', null))
        .toThrow(/NOT NULL/i);
      expect(() => insert.run(cardId, null, 'WP-003', '2026-01-03T00:00:00Z', '部分成功'))
        .toThrow(/CHECK/i);

      expect(db.prepare('SELECT COUNT(*) AS n FROM work_package_release').get().n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('access_denial_log 的 role / permission_point 取值域来自 enums.js（需求 47.10）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        `INSERT INTO access_denial_log (staff_no, role, permission_point, method, path, denied_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insert.run('E40001', 'QA_Engineer', 'card_edit', 'PUT', '/api/task-cards/1', '2026-01-01T00:00:00Z');
      insert.run('E40002', 'TS_Engineer', 'batch_replace', 'POST', '/api/task-cards/batch-replace', '2026-01-01T01:00:00Z');

      expect(() =>
        insert.run('E40003', 'Auditor', 'card_edit', 'PUT', '/api/task-cards/1', '2026-01-01T02:00:00Z'),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert.run('E40003', 'QA_Engineer', 'card_delete', 'DELETE', '/api/task-cards/1', '2026-01-01T02:00:00Z'),
      ).toThrow(/CHECK/i);

      const sql = buildSchemaSql();
      expect(sql).toContain(renderCheckConstraint('role'));
      expect(sql).toContain(renderCheckConstraint('permissionPoint'));
      expect(db.prepare('SELECT COUNT(*) AS n FROM access_denial_log').get().n).toBe(2);
    } finally {
      db.close();
    }
  });
});

/** 配置、主数据与集成 mock 表（任务 3.5 范围） */
const CONFIG_TABLES = [
  'app_user',
  'role_permission',
  'system_parameter',
  'stage_card_type_constraint',
  'stage_crosscut',
  'card_type_commercial_map',
  'derivation_priority_config',
  'capability_list',
  'print_template',
  'exec_doc_type',
  'task_no_sequence',
  'step_template',
];

/** 集成 mock 表（任务 3.5 范围，本模块只读） */
const INTEGRATION_MOCK_TABLES = [
  'tpc_document',
  'ppc_process_data',
  'ppc_schedule',
  'process_data',
  'lot_list_base',
];

describe('配置、主数据与集成 mock DDL 可执行且约束到位', () => {
  it('在内存库执行后配置表与集成 mock 表全部存在', () => {
    const db = freshDb();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      for (const table of [...CONFIG_TABLES, ...INTEGRATION_MOCK_TABLES]) {
        expect(tables).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('app_user 无口令列，staff_no 唯一，role 取值域来自 enums.js（需求 47.1）', () => {
    const db = freshDb();
    try {
      const columns = columnNames(db, 'app_user');
      for (const forbidden of ['password', 'password_hash', 'passwd', 'salt', 'token']) {
        expect(columns).not.toContain(forbidden);
      }
      expect(columns).toEqual(['id', 'staff_no', 'name', 'role', 'is_active']);

      const insert = db.prepare(
        'INSERT INTO app_user (staff_no, name, role, is_active) VALUES (?, ?, ?, ?)',
      );
      insert.run('E10001', '张工', 'TS_Engineer', 1);
      insert.run('E20001', '李经理', 'TS_Manager', 1);

      // 工号唯一：一编一审以 staff_no 比较（需求 22.3）
      expect(() => insert.run('E10001', '重名', 'TS_Engineer', 1)).toThrow(/UNIQUE/i);
      // 角色受 ROLE 值域约束
      expect(() => insert.run('E30001', '外部', 'Auditor', 1)).toThrow(/CHECK/i);
      // 角色必填
      expect(() => insert.run('E30002', '无角色', null, 1)).toThrow(/NOT NULL/i);
      // is_active 为 0/1 布尔列
      expect(() => insert.run('E30003', '非法布尔', 'QA_Engineer', 2)).toThrow(/CHECK/i);

      expect(buildSchemaSql()).toContain(renderCheckConstraint('role'));
    } finally {
      db.close();
    }
  });

  it('role_permission 逐点配置，batch_replace 不由 card_edit 继承（需求 47.9、20.9）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        'INSERT INTO role_permission (role, permission_point, allowed) VALUES (?, ?, ?)',
      );
      insert.run('TS_Engineer', 'card_edit', 1);
      insert.run('TS_Engineer', 'batch_replace', 0);
      insert.run('QA_Engineer', 'capability_write', 1);

      // 同一角色同一权限点仅一条判定
      expect(() => insert.run('TS_Engineer', 'card_edit', 0)).toThrow(/UNIQUE/i);
      // 权限点受 PERMISSION_POINT 值域约束
      expect(() => insert.run('TS_Engineer', 'card_delete', 1)).toThrow(/CHECK/i);

      // card_edit 允许并不隐含 batch_replace 允许
      const allowed = db
        .prepare(
          'SELECT allowed FROM role_permission WHERE role = ? AND permission_point = ?',
        )
        .get('TS_Engineer', 'batch_replace').allowed;
      expect(allowed).toBe(0);

      expect(buildSchemaSql()).toContain(renderCheckConstraint('permissionPoint'));
    } finally {
      db.close();
    }
  });

  it('stage_card_type_constraint 绑定 CARD_TYPE 与 STAGE 两个值域（需求 46.9–46.12）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        `INSERT INTO stage_card_type_constraint (card_type, allowed_stage, is_auto_fill)
         VALUES (?, ?, ?)`,
      );
      insert.run('01', 'RTN', 1);
      insert.run('10', 'SPC', 1);
      insert.run('11', 'CUS', 0);
      insert.run('11', 'MOD', 0);

      // 同一组合不重复登记
      expect(() => insert.run('01', 'RTN', 1)).toThrow(/UNIQUE/i);
      // card_type 用 CARD_TYPE 值域
      expect(() => insert.run('12', 'RTN', 0)).toThrow(/CHECK/i);
      // allowed_stage 用 STAGE 值域（列名与枚举字段名不同，须由占位符第二段绑定）
      expect(() => insert.run('02', 'XXX', 0)).toThrow(/CHECK/i);

      const sql = buildSchemaSql();
      expect(sql).toContain(renderCheckConstraint('stage', 'allowed_stage'));

      // 类型 11 允许多个 Stage 组合（需求 46.10）
      const stages = db
        .prepare('SELECT allowed_stage FROM stage_card_type_constraint WHERE card_type = ? ORDER BY allowed_stage')
        .all('11')
        .map((r) => r.allowed_stage);
      expect(stages).toEqual(['CUS', 'MOD']);
    } finally {
      db.close();
    }
  });

  it('stage_crosscut 为运行时权威，取值域为完整 STAGE（需求 46.13、46.14）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare('INSERT INTO stage_crosscut (stage) VALUES (?)');
      for (const stage of ['DMY', 'NRC', 'WCC', 'WFD']) {
        insert.run(stage);
      }
      // 主键去重
      expect(() => insert.run('DMY')).toThrow(/UNIQUE|PRIMARY KEY/i);
      // 业务方可新增其他 STAGE 成员为横切取值（配置化，不改代码）
      expect(() => insert.run('SPC')).not.toThrow();
      // 非 STAGE 成员仍被拒绝
      expect(() => insert.run('ZZZ')).toThrow(/CHECK/i);

      expect(db.prepare('SELECT COUNT(*) AS n FROM stage_crosscut').get().n).toBe(5);
    } finally {
      db.close();
    }
  });

  it('card_type_commercial_map 仅作 P6 兜底，同一类型可多命中（需求 43.1–43.4）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        'INSERT INTO card_type_commercial_map (card_type, commercial_classification) VALUES (?, ?)',
      );
      insert.run('01', 'Gear Inspection');
      insert.run('11', 'Routine');
      insert.run('11', 'NRC');

      expect(() => insert.run('01', 'Gear Inspection')).toThrow(/UNIQUE/i);
      expect(() => insert.run('01', '常规')).toThrow(/CHECK/i);

      const candidates = db
        .prepare('SELECT COUNT(*) AS n FROM card_type_commercial_map WHERE card_type = ?')
        .get('11').n;
      expect(candidates).toBe(2);
    } finally {
      db.close();
    }
  });

  it('derivation_priority_config 是优先级链权威源，tier_code 与 tier_order 均唯一（需求 29.8）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        'INSERT INTO derivation_priority_config (tier_code, tier_order, enabled) VALUES (?, ?, ?)',
      );
      DERIVATION_PRIORITY.forEach((code, idx) => insert.run(code, idx + 1, 1));

      // 层级代码不重复
      expect(() => insert.run('P1_PlanSetting', 99, 1)).toThrow(/UNIQUE/i);
      // 顺序不重复：同序会使 ORDER BY 结果依赖插入顺序，破坏派生确定性
      expect(() => insert.run('P6_CardTypeFallback', 1, 1)).toThrow(/UNIQUE/i);
      // 层级代码受 DERIVATION_PRIORITY 值域约束
      expect(() => insert.run('P9_Unknown', 9, 1)).toThrow(/CHECK/i);

      const ordered = db
        .prepare('SELECT tier_code FROM derivation_priority_config WHERE enabled = 1 ORDER BY tier_order')
        .all()
        .map((r) => r.tier_code);
      expect(ordered).toEqual([...DERIVATION_PRIORITY]);
      expect(buildSchemaSql()).toContain(
        renderCheckConstraint('derivationPriority', 'tier_code'),
      );
    } finally {
      db.close();
    }
  });

  it('capability_list 支持多版本与生效期，可查出当前生效版本（需求 39.4）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        `INSERT INTO capability_list
           (ac_type, gear_type, skill, revision, effective_from, effective_to)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      // 同一能力项两个版本：rev1 已失效，rev2 当前生效（effective_to 为 NULL 表示无限期）
      insert.run('320', 'MLG', 'GR', 1, '2024-01-01', '2025-12-31');
      insert.run('320', 'MLG', 'GR', 2, '2026-01-01', null);

      expect(() => insert.run('320', 'MLG', 'GR', 2, '2026-06-01', null)).toThrow(/UNIQUE/i);
      expect(() => insert.run('999', 'MLG', 'XX', 1, '2026-01-01', null)).toThrow(/CHECK/i);
      expect(() => insert.run('ZZZ', 'MLG', 'GR', 3, '2026-01-01', null)).toThrow(/CHECK/i);

      const current = db
        .prepare(
          `SELECT revision FROM capability_list
             WHERE ac_type = ? AND gear_type = ? AND skill = ?
               AND effective_from <= ?
               AND (effective_to IS NULL OR effective_to >= ?)
             ORDER BY revision DESC LIMIT 1`,
        )
        .get('320', 'MLG', 'GR', '2026-03-01', '2026-03-01');
      expect(current.revision).toBe(2);
    } finally {
      db.close();
    }
  });

  it('print_template 同一目标至多一个默认模板（需求 40.1、40.4）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        `INSERT INTO print_template (target_kind, target_code, template_body, is_default)
         VALUES (?, ?, ?, ?)`,
      );
      insert.run('card_type', '04', '<div>{{taskNo}}</div>', 1);
      insert.run('card_type', '04', '<div>备用</div>', 0);
      insert.run('exec_doc_type', 'SW', '<div>{{docNo}}</div>', 1);

      // 部分唯一索引拦第二个默认模板
      expect(() => insert.run('card_type', '04', '<div>第二默认</div>', 1)).toThrow(/UNIQUE/i);
      // target_kind 为表内局部取值集
      expect(() => insert.run('job', '04', '<div/>', 0)).toThrow(/CHECK/i);

      const row = db
        .prepare('SELECT template_body FROM print_template WHERE target_kind = ? AND target_code = ? AND is_default = 1')
        .get('card_type', '04');
      expect(row.template_body).toContain('{{taskNo}}');
    } finally {
      db.close();
    }
  });

  it('exec_doc_type 覆盖 11 类单据且 sign_rule 必填（需求 16.2、16.4、16.5）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        'INSERT INTO exec_doc_type (code, name, sign_rule) VALUES (?, ?, ?)',
      );
      for (const code of EXEC_DOC_TYPE) {
        insert.run(code, `${code} 单据`, EXEC_DOC_SIGN_RULE[code]);
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM exec_doc_type').get().n).toBe(11);

      expect(() => insert.run('SW', '重复', '签署')).toThrow(/UNIQUE|PRIMARY KEY/i);
      expect(() => insert.run('ZZ', '未知类型', '签署')).toThrow(/CHECK/i);

      // sign_rule 必填：缺值会使需求 45.8 的签署项缺失检查静默放过
      db.prepare('DELETE FROM exec_doc_type WHERE code = ?').run('TA');
      expect(() => insert.run('TA', '缺规则', null)).toThrow(/NOT NULL/i);
      insert.run('TA', 'TA 单据', EXEC_DOC_SIGN_RULE.TA);

      // SC 的签署要求与其余类型不同（需求 16.5）
      const sc = db.prepare('SELECT sign_rule FROM exec_doc_type WHERE code = ?').get('SC');
      expect(sc.sign_rule).toBe(EXEC_DOC_SIGN_RULE.SC);
      expect(buildSchemaSql()).toContain(renderCheckConstraint('execDocType', 'code'));
    } finally {
      db.close();
    }
  });

  it('task_no_sequence 与 step_template 支撑编号规则与工序模板（需求 38.8、38.9、14.1）', () => {
    const db = freshDb();
    try {
      const insertSeq = db.prepare(
        'INSERT INTO task_no_sequence (prefix, suffix, next_seq, step) VALUES (?, ?, ?, ?)',
      );
      insertSeq.run('TC-320-', '-A', 1, 1);
      // 同一前后缀组合仅一条流水，否则批量复制会生成重复编号
      expect(() => insertSeq.run('TC-320-', '-A', 100, 1)).toThrow(/UNIQUE/i);
      // 缺省前后缀落到 '' 而非 NULL，唯一约束方可生效（NULL 在 SQLite 中互不相等）
      const insertDefault = db.prepare(
        'INSERT INTO task_no_sequence (next_seq, step) VALUES (?, ?)',
      );
      insertDefault.run(1, 5);
      const defaults = db.prepare('SELECT prefix, suffix, step FROM task_no_sequence WHERE step = 5').get();
      expect(defaults.prefix).toBe('');
      expect(defaults.suffix).toBe('');
      expect(() => insertDefault.run(1, 9)).toThrow(/UNIQUE/i);

      const payload = { skill: 'GR', descriptionZh: '拆卸', captureItems: [{ type: 'text' }] };
      db.prepare('INSERT INTO step_template (name, payload) VALUES (?, ?)').run(
        '标准拆卸工序',
        JSON.stringify(payload),
      );
      expect(() =>
        db.prepare('INSERT INTO step_template (name, payload) VALUES (?, ?)').run('标准拆卸工序', '{}'),
      ).toThrow(/UNIQUE/i);

      const row = db.prepare('SELECT payload FROM step_template WHERE name = ?').get('标准拆卸工序');
      expect(JSON.parse(row.payload)).toEqual(payload);
    } finally {
      db.close();
    }
  });

  it('system_parameter 以键为主键存组织名称等参数（需求 35.1、35.2）', () => {
    const db = freshDb();
    try {
      const insert = db.prepare('INSERT INTO system_parameter (key, value) VALUES (?, ?)');
      insert.run('organizationName', 'HAECO Landing Gear Services');
      expect(() => insert.run('organizationName', '重复键')).toThrow(/UNIQUE|PRIMARY KEY/i);

      const row = db.prepare('SELECT value FROM system_parameter WHERE key = ?').get('organizationName');
      expect(row.value).toBe('HAECO Landing Gear Services');
    } finally {
      db.close();
    }
  });

  it('集成 mock 表为软引用无外键，可写入本地不存在的 card_id 与缺失 PID（需求 26.4）', () => {
    const db = freshDb();
    try {
      // 无外键：外部系统的行不因本地工卡缺失而无法落地
      db.prepare(
        'INSERT INTO ppc_schedule (pid_no, card_id, job_target_date) VALUES (?, ?, ?)',
      ).run('PID-001', 999999, '2026-03-01');
      // 故意缺失 PID：覆盖「取不到值则留空且不阻断」分支
      db.prepare(
        'INSERT INTO ppc_schedule (pid_no, card_id, job_target_date) VALUES (?, ?, ?)',
      ).run(null, 999998, null);

      const noDate = db
        .prepare('SELECT job_target_date FROM ppc_schedule WHERE pid_no IS NULL')
        .get();
      expect(noDate.job_target_date).toBeNull();

      db.prepare(
        `INSERT INTO process_data
           (pid_no, card_id, step_ref, part_no, part_sn, part_desc, operation_type, operation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('PID-001', 999999, 'A', 'PN-1', 'SN-1', '主起落架外筒', 'Overhaul', '按 CMM 拆解');
      const pd = db.prepare('SELECT * FROM process_data WHERE step_ref = ?').get('A');
      expect(pd.part_desc).toBe('主起落架外筒');
      expect(pd.operation).toBe('按 CMM 拆解');

      db.prepare(
        'INSERT INTO ppc_process_data (card_id, step_ref, work_category, estimated_man_hours) VALUES (?, ?, ?, ?)',
      ).run(999999, 'A', 'Disassembly', 2.5);
      expect(
        db.prepare('SELECT estimated_man_hours AS h FROM ppc_process_data').get().h,
      ).toBe(2.5);

      db.prepare(
        'INSERT INTO tpc_document (doc_type, ref_no, doc_revision, doc_desc, keyword) VALUES (?, ?, ?, ?, ?)',
      ).run('CMM', 'CMM-32-11-05', 'R3', '主起落架维修手册', 'MLG');
      expect(db.prepare('SELECT COUNT(*) AS n FROM tpc_document').get().n).toBe(1);

      // 同一 Lot List 下多条 Base 并存（不去重）
      const insertBase = db.prepare(
        'INSERT INTO lot_list_base (lot_list_ref, lot_number, base_number) VALUES (?, ?, ?)',
      );
      insertBase.run('LT-001', 'LOT-1', 'BASE-1');
      insertBase.run('LT-001', 'LOT-1', 'BASE-2');
      insertBase.run('LT-001', 'LOT-2', 'BASE-1');
      expect(() => insertBase.run('LT-002', 'LOT-1', null)).toThrow(/NOT NULL/i);
      const bases = db
        .prepare('SELECT COUNT(*) AS n FROM lot_list_base WHERE lot_list_ref = ?')
        .get('LT-001').n;
      expect(bases).toBe(3);
    } finally {
      db.close();
    }
  });
});
