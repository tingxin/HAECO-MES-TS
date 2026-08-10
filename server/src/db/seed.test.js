/**
 * 种子数据单元测试（任务 3.6）。
 *
 * 关注点：
 * ① 幂等——`migrate` + `seed` 重复执行行数不变、第二次无新增；
 * ② 权限矩阵完整性（8×13 = 104 行）与需求 47 的角色边界；
 * ③ 配置表默认值（Stage×类型、横切、类型→商务分类、优先级链）与需求 43.2、46.9–46.13 一致；
 * ④ 覆盖分支用数据确实存在：`ppc_schedule` 故意缺 PID 的行、`capability_list` 的多 revision
 *    与跨生效期行、同一 `lot_list_ref` 下多条 Base、`exec_doc_type='SW'` 的 SWS 样例。
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';
import {
  DEFAULT_PRINT_TEMPLATE_BODY,
  ROLE_PERMISSION_MATRIX,
  SEED_USERS,
  buildRolePermissionRows,
  seed,
} from './seed.js';
import {
  CARD_TYPE_CODES,
  DERIVATION_PRIORITY,
  EXEC_DOC_TYPE,
  PERMISSION_POINT,
  ROLE,
  STAGE_CROSSCUT,
} from '../domain/enums.js';

/** 建库 + 建表 + 写种子 */
function seededDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  return db;
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function allowed(db, role, point) {
  return db
    .prepare('SELECT allowed FROM role_permission WHERE role = ? AND permission_point = ?')
    .get(role, point).allowed;
}

describe('seed 前置条件', () => {
  it('未建表时给出可执行的提示而非底层 SQL 错误', () => {
    const db = openDatabase(':memory:');
    try {
      expect(() => seed(db)).toThrow(/npm run migrate/);
    } finally {
      db.close();
    }
  });
});

describe('seed 幂等性', () => {
  it('重复执行不新增行，各表行数保持一致', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db);
      const first = seed(db);
      expect(Object.values(first).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

      const tables = [
        'app_user', 'role_permission', 'system_parameter', 'exec_doc_type',
        'stage_card_type_constraint', 'stage_crosscut', 'card_type_commercial_map',
        'derivation_priority_config', 'capability_list', 'print_template', 'task_no_sequence',
        'task_card', 'reference_document', 'process_step', 'signature_requirement',
        'lot_list_link', 'bom_base_output', 'exec_document',
        'tpc_document', 'ppc_process_data', 'ppc_schedule', 'process_data', 'lot_list_base',
      ];
      const before = tables.map((t) => [t, count(db, t)]);

      const second = seed(db);
      expect(Object.values(second).reduce((a, b) => a + b, 0)).toBe(0);
      expect(tables.map((t) => [t, count(db, t)])).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe('用户主数据（需求 47.1、22.3）', () => {
  it('每角色至少一个账号，TS_Engineer 与 TS_Manager 各不少于两个', () => {
    const db = seededDb();
    try {
      const byRole = new Map(
        db.prepare('SELECT role, COUNT(*) AS n FROM app_user GROUP BY role').all().map((r) => [r.role, r.n]),
      );
      for (const role of ROLE) {
        expect(byRole.get(role) ?? 0).toBeGreaterThanOrEqual(1);
      }
      expect(byRole.get('TS_Engineer')).toBeGreaterThanOrEqual(2);
      expect(byRole.get('TS_Manager')).toBeGreaterThanOrEqual(2);
      expect(count(db, 'app_user')).toBe(SEED_USERS.length);
    } finally {
      db.close();
    }
  });
});

describe('角色 × 权限点矩阵（需求 47.2–47.9、20.9）', () => {
  it('矩阵完整：8 角色 × 13 权限点，无缺格', () => {
    const db = seededDb();
    try {
      expect(ROLE).toHaveLength(8);
      expect(PERMISSION_POINT).toHaveLength(13);
      expect(buildRolePermissionRows()).toHaveLength(104);
      expect(count(db, 'role_permission')).toBe(104);

      for (const role of ROLE) {
        const points = db
          .prepare('SELECT permission_point FROM role_permission WHERE role = ? ORDER BY permission_point')
          .all(role)
          .map((r) => r.permission_point);
        expect(points).toEqual([...PERMISSION_POINT].sort());
      }
    } finally {
      db.close();
    }
  });

  it('角色边界：TS 不可写 PPC 工时、Planning/Production 不可编制、QA 不可编制或审核', () => {
    const db = seededDb();
    try {
      // TS_Engineer：编制/提交/释放可，审核与 PPC 工时不可（需求 47.2、47.5）
      expect(allowed(db, 'TS_Engineer', 'card_edit')).toBe(1);
      expect(allowed(db, 'TS_Engineer', 'card_submit_review')).toBe(1);
      expect(allowed(db, 'TS_Engineer', 'card_release')).toBe(1);
      expect(allowed(db, 'TS_Engineer', 'card_review')).toBe(0);
      expect(allowed(db, 'TS_Manager', 'ppc_manhours_write')).toBe(0);
      expect(allowed(db, 'TS_Engineer', 'ppc_manhours_write')).toBe(0);

      // TS_Manager：审核与作废可，编制不可（需求 47.3）
      expect(allowed(db, 'TS_Manager', 'card_review')).toBe(1);
      expect(allowed(db, 'TS_Manager', 'card_void')).toBe(1);
      expect(allowed(db, 'TS_Manager', 'card_edit')).toBe(0);

      // Planning：PPC 工时可写，编制内容不可（需求 47.4、47.6）
      for (const role of ['Planning_Engineer', 'Planning_Manager']) {
        expect(allowed(db, role, 'ppc_manhours_write')).toBe(1);
        expect(allowed(db, role, 'card_read')).toBe(1);
        expect(allowed(db, role, 'card_edit')).toBe(0);
        expect(allowed(db, role, 'card_review')).toBe(0);
      }

      // Production：JOB 执行数据可写，编制内容不可（需求 47.7）
      for (const role of ['Production_Technician', 'Production_Manager']) {
        expect(allowed(db, role, 'job_exec_write')).toBe(1);
        expect(allowed(db, role, 'card_edit')).toBe(0);
      }

      // QA：能力清单可维护，编制与审核不可（需求 47.8）
      expect(allowed(db, 'QA_Engineer', 'capability_write')).toBe(1);
      expect(allowed(db, 'QA_Engineer', 'card_edit')).toBe(0);
      expect(allowed(db, 'QA_Engineer', 'card_review')).toBe(0);

      // 三个独立权限点不由 card_edit 继承（需求 20.9、47.9）
      for (const point of ['batch_replace', 'config_write', 'capability_write']) {
        expect(allowed(db, 'TS_Engineer', point)).toBe(0);
      }
      // 且各自确有被授予的角色，矩阵不出现「全 0 的权限点」
      for (const point of PERMISSION_POINT) {
        const grants = db
          .prepare('SELECT COUNT(*) AS n FROM role_permission WHERE permission_point = ? AND allowed = 1')
          .get(point).n;
        expect(grants).toBeGreaterThanOrEqual(1);
      }
    } finally {
      db.close();
    }
  });

  it('矩阵常量与落库结果一致', () => {
    const db = seededDb();
    try {
      for (const [role, points] of Object.entries(ROLE_PERMISSION_MATRIX)) {
        const grantedInDb = db
          .prepare('SELECT permission_point FROM role_permission WHERE role = ? AND allowed = 1')
          .all(role)
          .map((r) => r.permission_point)
          .sort();
        expect(grantedInDb).toEqual([...points].sort());
      }
    } finally {
      db.close();
    }
  });
});

describe('执行单据类型字典（需求 16.2、16.4、16.5）', () => {
  it('11 条齐备，SC 为「单据不签署，所发工卡步骤需签署」，其余为「签署」', () => {
    const db = seededDb();
    try {
      const rows = db.prepare('SELECT code, sign_rule FROM exec_doc_type ORDER BY code').all();
      expect(rows).toHaveLength(EXEC_DOC_TYPE.length);
      expect(rows.map((r) => r.code)).toEqual([...EXEC_DOC_TYPE].sort());

      const byCode = new Map(rows.map((r) => [r.code, r.sign_rule]));
      expect(byCode.get('SC')).toBe('单据不签署，所发工卡步骤需签署');
      for (const code of EXEC_DOC_TYPE.filter((c) => c !== 'SC')) {
        expect(byCode.get(code)).toBe('签署');
      }
    } finally {
      db.close();
    }
  });
});

describe('Stage × 类型约束与横切取值（需求 46.9–46.13，⚠ A4）', () => {
  it('01–09 → RTN 自动填入、10 → SPC 自动填入、11 → CUS/MOD 不自动填入', () => {
    const db = seededDb();
    try {
      for (const cardType of ['01', '02', '03', '04', '05', '06', '07', '08', '09']) {
        const rows = db
          .prepare('SELECT allowed_stage, is_auto_fill FROM stage_card_type_constraint WHERE card_type = ?')
          .all(cardType);
        expect(rows).toEqual([{ allowed_stage: 'RTN', is_auto_fill: 1 }]);
      }

      expect(
        db.prepare('SELECT allowed_stage, is_auto_fill FROM stage_card_type_constraint WHERE card_type = ?').all('10'),
      ).toEqual([{ allowed_stage: 'SPC', is_auto_fill: 1 }]);

      const type11 = db
        .prepare(
          'SELECT allowed_stage, is_auto_fill FROM stage_card_type_constraint WHERE card_type = ? ORDER BY allowed_stage',
        )
        .all('11');
      expect(type11).toEqual([
        { allowed_stage: 'CUS', is_auto_fill: 0 },
        { allowed_stage: 'MOD', is_auto_fill: 0 },
      ]);

      // 每个类型都有至少一条允许组合，校验不会因缺配置而全拒
      for (const cardType of CARD_TYPE_CODES) {
        const n = db
          .prepare('SELECT COUNT(*) AS n FROM stage_card_type_constraint WHERE card_type = ?')
          .get(cardType).n;
        expect(n).toBeGreaterThanOrEqual(1);
      }
    } finally {
      db.close();
    }
  });

  it('横切取值为 DMY/NRC/WCC/WFD', () => {
    const db = seededDb();
    try {
      const stages = db.prepare('SELECT stage FROM stage_crosscut ORDER BY stage').all().map((r) => r.stage);
      expect(stages).toEqual([...STAGE_CROSSCUT].sort());
    } finally {
      db.close();
    }
  });
});

describe('类型 → 商务分类映射（需求 43.1、43.2）', () => {
  it('包含需求 43.2 全部条目，01 与 11 各为双值', () => {
    const db = seededDb();
    try {
      const byType = (cardType) =>
        db
          .prepare(
            'SELECT commercial_classification FROM card_type_commercial_map WHERE card_type = ? ORDER BY commercial_classification',
          )
          .all(cardType)
          .map((r) => r.commercial_classification);

      expect(byType('01')).toEqual(['Gear Inspection', 'Routine']);
      for (const cardType of ['02', '03', '04', '05', '06', '07', '08', '09']) {
        expect(byType(cardType)).toEqual(['Routine']);
      }
      expect(byType('10')).toEqual(['SB/AD/SL']);
      expect(byType('11')).toEqual(['Configuration(MOD)', 'Material Special Replacement']);

      // 11 类型多命中合法（需求 43.4）：不自动裁决，由人工确认
      expect(byType('11')).toHaveLength(2);
      expect(count(db, 'card_type_commercial_map')).toBe(13);
    } finally {
      db.close();
    }
  });
});

describe('派生优先级链（需求 29.8，⚠ A1）', () => {
  it('P1–P6 按序落库且全部启用，tier_order 连续', () => {
    const db = seededDb();
    try {
      const rows = db
        .prepare('SELECT tier_code, tier_order, enabled FROM derivation_priority_config ORDER BY tier_order')
        .all();
      expect(rows.map((r) => r.tier_code)).toEqual([...DERIVATION_PRIORITY]);
      expect(rows.map((r) => r.tier_order)).toEqual(DERIVATION_PRIORITY.map((_, i) => i + 1));
      expect(rows.every((r) => r.enabled === 1)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('能力清单样例（需求 39.1、39.4）', () => {
  it('含多 revision、已过期与未生效行，当前生效版本取同期 revision 最大者', () => {
    const db = seededDb();
    try {
      const scope = { ac_type: '320', gear_type: 'MLG', skill: 'GR' };
      const revisions = db
        .prepare(
          'SELECT revision FROM capability_list WHERE ac_type = ? AND gear_type = ? AND skill = ? ORDER BY revision',
        )
        .all(scope.ac_type, scope.gear_type, scope.skill)
        .map((r) => r.revision);
      expect(revisions.length).toBeGreaterThanOrEqual(2);

      const today = new Date().toISOString().slice(0, 10);

      // 已过期行存在（effective_to 早于今日）
      const expired = db
        .prepare('SELECT COUNT(*) AS n FROM capability_list WHERE effective_to IS NOT NULL AND effective_to < ?')
        .get(today).n;
      expect(expired).toBeGreaterThanOrEqual(1);

      // 尚未生效行存在（effective_from 晚于今日）
      const future = db
        .prepare('SELECT COUNT(*) AS n FROM capability_list WHERE effective_from > ?')
        .get(today).n;
      expect(future).toBeGreaterThanOrEqual(1);

      // 需求 39.4 的「当前生效版本」判定：生效期覆盖今日，同期取 revision 最大者
      const current = db
        .prepare(
          `SELECT revision FROM capability_list
            WHERE ac_type = ? AND gear_type = ? AND skill = ?
              AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
            ORDER BY revision DESC LIMIT 1`,
        )
        .get(scope.ac_type, scope.gear_type, scope.skill, today, today);
      expect(current.revision).toBe(Math.max(...revisions.filter((r) => r > 1)));
      expect(current.revision).toBe(3);
    } finally {
      db.close();
    }
  });
});

describe('打印模板（需求 40.2、40.4）', () => {
  it('同一目标至多一个默认模板，模板正文不含工卡类型占位符', () => {
    const db = seededDb();
    try {
      const defaults = db
        .prepare('SELECT target_kind, target_code, template_body FROM print_template WHERE is_default = 1')
        .all();
      expect(defaults).toHaveLength(1);
      expect(defaults[0].template_body).toBe(DEFAULT_PRINT_TEMPLATE_BODY);
      // 需求 5.2：打印输出不展示工卡分类
      expect(defaults[0].template_body).not.toMatch(/cardType|card_type/);

      // 同目标插入第二个默认模板被部分唯一索引拒绝
      expect(() =>
        db
          .prepare('INSERT INTO print_template (target_kind, target_code, template_body, is_default) VALUES (?, ?, ?, 1)')
          .run(defaults[0].target_kind, defaults[0].target_code, '<div/>'),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });
});

describe('系统参数（需求 35.1）', () => {
  it('组织名称已配置且非空', () => {
    const db = seededDb();
    try {
      const row = db.prepare('SELECT value FROM system_parameter WHERE key = ?').get('organizationName');
      expect(row).toBeDefined();
      expect(row.value.trim().length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe('演示工卡与工序（需求 6.3–6.8、16.1）', () => {
  it('四类演示工卡落库，工序挂在工卡下且参考文件可引用', () => {
    const db = seededDb();
    try {
      const cards = db
        .prepare('SELECT task_no, card_type, status FROM task_card ORDER BY task_no')
        .all();
      expect(cards.map((c) => c.card_type)).toEqual(['01', '04', '05', '11']);
      expect(cards.find((c) => c.task_no === 'TC-2026-0001').status).toBe('Effective');

      // IR 卡（04）带 Base Number 与 IPC 项号（需求 8.1、8.2）
      const irCard = db
        .prepare('SELECT base_number, ipc_item_no FROM task_card WHERE task_no = ?')
        .get('TC-2026-0002');
      expect(irCard.base_number).toBeTruthy();
      expect(irCard.ipc_item_no).toBeTruthy();

      // 类型 11 多命中，商务分类留空待人工确认（需求 29.6、43.4）
      expect(
        db.prepare('SELECT commercial_classification FROM task_card WHERE task_no = ?').get('TC-2026-0004')
          .commercial_classification,
      ).toBeNull();

      const steps = db
        .prepare(
          `SELECT s.process_id, s.ref_doc_id, s.is_critical, c.task_no
             FROM process_step s JOIN task_card c ON c.id = s.card_id
            ORDER BY c.task_no, s.seq`,
        )
        .all();
      expect(steps.length).toBeGreaterThanOrEqual(3);
      const step1A = steps.find((s) => s.task_no === 'TC-2026-0001' && s.process_id === 'A');
      expect(step1A.ref_doc_id).not.toBeNull();
      expect(step1A.is_critical).toBe(1);

      // 签署项（⚠ A3）：同一工序多签署角色（需求 45.3）
      const sigRoles = db
        .prepare(
          `SELECT r.signature_role, r.stamp_required FROM signature_requirement r
             JOIN process_step s ON s.id = r.step_id
            WHERE s.card_id = (SELECT id FROM task_card WHERE task_no = 'TC-2026-0001')
            ORDER BY r.sort_order`,
        )
        .all();
      expect(sigRoles.map((r) => r.signature_role)).toEqual(['Operator', 'QC']);
      expect(sigRoles.find((r) => r.signature_role === 'QC').stamp_required).toBe(1);
    } finally {
      db.close();
    }
  });

  it('exec_document 含 exec_doc_type=SW 的 SWS 样例（需求 23.1、23.2）', () => {
    const db = seededDb();
    try {
      const sws = db.prepare("SELECT * FROM exec_document WHERE exec_doc_type = 'SW'").all();
      expect(sws).toHaveLength(1);
      expect(sws[0].status).toBe('New');
      expect(sws[0].revision).toBe(1);
      expect(JSON.parse(sws[0].content).steps.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});

describe('集成 mock 数据（需求 25.1、25.2、26.4、27.2、30.1、48.3）', () => {
  it('TPC 文档可按参考号与关键字检索', () => {
    const db = seededDb();
    try {
      const byRef = db.prepare('SELECT * FROM tpc_document WHERE ref_no = ?').get('32-11-51');
      expect(byRef.doc_type).toBe('CMM');
      expect(byRef.doc_revision).toBeTruthy();
      expect(count(db, 'tpc_document')).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it('PPC 排产同时含带目标日期的行与故意缺 PID 的行（需求 26.4 两条分支）', () => {
    const db = seededDb();
    try {
      const withTarget = db
        .prepare('SELECT COUNT(*) AS n FROM ppc_schedule WHERE pid_no IS NOT NULL AND job_target_date IS NOT NULL')
        .get().n;
      expect(withTarget).toBeGreaterThanOrEqual(1);

      // 「取不到值则留空且不阻断」分支的数据样例
      const missingPid = db.prepare('SELECT * FROM ppc_schedule WHERE pid_no IS NULL').all();
      expect(missingPid).toHaveLength(1);
      expect(missingPid[0].job_target_date).toBeNull();
      expect(missingPid[0].card_id).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('Process Data 含 Process Card 四字段与工序 Operation', () => {
    const db = seededDb();
    try {
      const cardLevel = db
        .prepare('SELECT * FROM process_data WHERE step_ref IS NULL')
        .get();
      expect(cardLevel.part_no).toBeTruthy();
      expect(cardLevel.part_sn).toBeTruthy();
      expect(cardLevel.part_desc).toBeTruthy();
      expect(cardLevel.operation_type).toBeTruthy();

      const stepLevel = db.prepare('SELECT * FROM process_data WHERE step_ref = ?').get('A');
      expect(stepLevel.operation).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('PPC 工作分类与预计工时按工序落库（本模块只读）', () => {
    const db = seededDb();
    try {
      const rows = db.prepare('SELECT * FROM ppc_process_data').all();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r) => r.work_category !== null && r.estimated_man_hours !== null)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('同一 lot_list_ref 下含多条 Base，且 BOM 输出区分两类来源（需求 48.3–48.6，⚠ A6）', () => {
    const db = seededDb();
    try {
      const bases = db
        .prepare('SELECT base_number FROM lot_list_base WHERE lot_list_ref = ? ORDER BY base_number')
        .all('LT-2026-001')
        .map((r) => r.base_number);
      expect(bases.length).toBeGreaterThanOrEqual(3);

      const sources = db
        .prepare('SELECT DISTINCT source FROM bom_base_output ORDER BY source')
        .all()
        .map((r) => r.source);
      expect(sources).toEqual(['ir_card', 'lot_list']);

      // 来源为 Lot List 的行必须携带 Lot Number 以区别来源（需求 48.6）
      const lotSourced = db.prepare("SELECT * FROM bom_base_output WHERE source = 'lot_list'").all();
      expect(lotSourced.every((r) => r.lot_number !== null)).toBe(true);

      // IR Lot 卡与 Lot List 的关联存在（需求 48.1、48.2）
      const link = db.prepare('SELECT * FROM lot_list_link').get();
      expect(link.lot_list_ref).toBe('LT-2026-001');
      expect(link.lot_number).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
