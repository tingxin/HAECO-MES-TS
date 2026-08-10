import { describe, it, expect } from 'vitest';
import { ROLE, PERMISSION_POINT } from './enums.js';
import { ROLE_PERMISSION_MATRIX, buildRolePermissionRows } from '../db/seed.js';
import {
  PERMISSION_RESULT,
  READONLY_DERIVED_FIELDS,
  checkPermission,
  explainPermission,
  isKnownPermissionPoint,
  isKnownRole,
  isWritableField,
  resolveReadOnlyFields,
} from './permission.js';

const rows = buildRolePermissionRows();

describe('checkPermission —— 读 allowed 列而非行存在性（需求 47.1、47.10）', () => {
  it('104 行完整矩阵逐点与 ROLE_PERMISSION_MATRIX 一致', () => {
    expect(rows).toHaveLength(ROLE.length * PERMISSION_POINT.length);
    for (const role of ROLE) {
      for (const point of PERMISSION_POINT) {
        const expected = ROLE_PERMISSION_MATRIX[role].includes(point);
        expect(checkPermission(role, point, rows)).toBe(expected);
      }
    }
  });

  it('行存在但 allowed = 0 时拒绝，且原因为 DENIED_BY_CONFIG', () => {
    const result = explainPermission('TS_Engineer', 'card_review', rows);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(PERMISSION_RESULT.DENIED_BY_CONFIG);
    expect(result.isAuthorizationDecision).toBe(true);
  });

  it('兼容 camelCase 行与布尔 / 字符串 allowed 写法', () => {
    expect(checkPermission('TS_Engineer', 'card_edit', [
      { role: 'TS_Engineer', permissionPoint: 'card_edit', allowed: true },
    ])).toBe(true);
    expect(checkPermission('TS_Engineer', 'card_edit', [
      { role: 'TS_Engineer', permission_point: 'card_edit', allowed: '1' },
    ])).toBe(true);
    expect(checkPermission('TS_Engineer', 'card_edit', [
      { role: 'TS_Engineer', permission_point: 'card_edit', allowed: 0 },
    ])).toBe(false);
  });

  it('接受 ROLE_PERMISSION_MATRIX 映射形态', () => {
    expect(checkPermission('QA_Engineer', 'capability_write', ROLE_PERMISSION_MATRIX)).toBe(true);
    expect(checkPermission('QA_Engineer', 'card_edit', ROLE_PERMISSION_MATRIX)).toBe(false);
  });
});

describe('需求 47.2–47.9 各条边界由矩阵表达', () => {
  const ts = ['TS_Engineer', 'TS_Manager'];
  const planning = ['Planning_Engineer', 'Planning_Manager'];
  const production = ['Production_Technician', 'Production_Manager'];

  it('TS_Engineer 编制不审核；TS_Manager 审核不编制（47.2、47.3）', () => {
    expect(checkPermission('TS_Engineer', 'card_edit', rows)).toBe(true);
    expect(checkPermission('TS_Engineer', 'card_submit_review', rows)).toBe(true);
    expect(checkPermission('TS_Engineer', 'card_review', rows)).toBe(false);
    expect(checkPermission('TS_Manager', 'card_review', rows)).toBe(true);
    expect(checkPermission('TS_Manager', 'card_void', rows)).toBe(true);
    expect(checkPermission('TS_Manager', 'card_edit', rows)).toBe(false);
  });

  it('ppc_manhours_write 仅 Planning，TS 恒不可写（47.4、47.5、11.3）', () => {
    for (const role of planning) expect(checkPermission(role, 'ppc_manhours_write', rows)).toBe(true);
    for (const role of ROLE.filter((r) => !planning.includes(r))) {
      expect(checkPermission(role, 'ppc_manhours_write', rows)).toBe(false);
    }
    for (const role of ts) expect(checkPermission(role, 'ppc_manhours_write', rows)).toBe(false);
  });

  it('Planning / Production 只读编制域；job_exec_write 仅 Production（47.6、47.7）', () => {
    for (const role of [...planning, ...production]) {
      expect(checkPermission(role, 'card_read', rows)).toBe(true);
      expect(checkPermission(role, 'card_edit', rows)).toBe(false);
      expect(checkPermission(role, 'card_review', rows)).toBe(false);
    }
    for (const role of production) expect(checkPermission(role, 'job_exec_write', rows)).toBe(true);
    for (const role of planning) expect(checkPermission(role, 'job_exec_write', rows)).toBe(false);
  });

  it('QA_Engineer 维护能力清单但不编不审（47.8）', () => {
    expect(checkPermission('QA_Engineer', 'capability_write', rows)).toBe(true);
    expect(checkPermission('QA_Engineer', 'card_edit', rows)).toBe(false);
    expect(checkPermission('QA_Engineer', 'card_review', rows)).toBe(false);
    for (const role of ROLE.filter((r) => r !== 'QA_Engineer')) {
      expect(checkPermission(role, 'capability_write', rows)).toBe(false);
    }
  });

  it('batch_replace 不由 card_edit 继承（需求 20.9、47.9）', () => {
    for (const role of ROLE) {
      if (checkPermission(role, 'card_edit', rows)) {
        expect(checkPermission(role, 'batch_replace', rows)).toBe(false);
      }
    }
  });
});

describe('fail-closed 与错误可区分（需求 47.10）', () => {
  it('未知角色 / 未知权限点 / cfg 缺失一律拒绝', () => {
    expect(checkPermission('Intern', 'card_edit', rows)).toBe(false);
    expect(checkPermission('TS_Engineer', 'card_delete', rows)).toBe(false);
    expect(checkPermission('TS_Engineer', 'card_edit', null)).toBe(false);
    expect(checkPermission('TS_Engineer', 'card_edit', undefined)).toBe(false);
    expect(checkPermission(null, undefined, rows)).toBe(false);
    expect(isKnownRole('Intern')).toBe(false);
    expect(isKnownPermissionPoint('card_delete')).toBe(false);
  });

  it('未知权限点与「已知但被拒」结论码不同', () => {
    const unknown = explainPermission('TS_Engineer', 'card_delete', rows);
    expect(unknown.reason).toBe(PERMISSION_RESULT.UNKNOWN_PERMISSION_POINT);
    expect(unknown.isAuthorizationDecision).toBe(false);

    const denied = explainPermission('TS_Engineer', 'card_review', rows);
    expect(denied.reason).toBe(PERMISSION_RESULT.DENIED_BY_CONFIG);
    expect(denied.isAuthorizationDecision).toBe(true);
    expect(unknown.reason).not.toBe(denied.reason);
  });

  it('缺行、冲突行、形态非法各有独立结论码', () => {
    expect(explainPermission('TS_Engineer', 'card_edit', []).reason)
      .toBe(PERMISSION_RESULT.NO_CONFIG_ROW);
    expect(explainPermission('TS_Engineer', 'card_edit', [
      { role: 'TS_Engineer', permission_point: 'card_edit', allowed: 1 },
      { role: 'TS_Engineer', permission_point: 'card_edit', allowed: 0 },
    ])).toMatchObject({ allowed: false, reason: PERMISSION_RESULT.CONFLICTING_CONFIG_ROWS });
    expect(explainPermission('TS_Engineer', 'card_edit', { TS_Engineer: 'card_edit' }).reason)
      .toBe(PERMISSION_RESULT.INVALID_CONFIG);
    expect(explainPermission('TS_Engineer', 'card_edit', 'card_edit').reason)
      .toBe(PERMISSION_RESULT.INVALID_CONFIG);
  });
});

describe('isWritableField —— 只读带出字段恒不可写（需求 11.3、11.4、26.5、27.3、30.2）', () => {
  it('登记 17 项只读字段，覆盖 26.1 / 27.1 / 30.1 / 11.3 / 11.4', () => {
    expect(READONLY_DERIVED_FIELDS).toHaveLength(17);
    expect(READONLY_DERIVED_FIELDS).toEqual(expect.arrayContaining([
      'job.owner', 'job.job_target_date', 'job.check_type', 'job.inbound_gear_pn',
      'job.inbound_sn', 'job.cs_no', 'job.work_order', 'job.outbound_gear_pn',
      'job.part_no', 'job.part_sn', 'job.part_desc', 'job.operation_type',
      'process_step.operation', 'process_step.work_category', 'process_step.estimated_man_hours',
      'job_process.effective_man_hours', 'job_process.actual_man_hours',
    ]));
  });

  it('全部只读字段的限定名与裸列名均不可写', () => {
    for (const qualified of READONLY_DERIVED_FIELDS) {
      expect(isWritableField(qualified)).toBe(false);
      expect(isWritableField(qualified.slice(qualified.indexOf('.') + 1))).toBe(false);
    }
  });

  it('接受 camelCase 与蓝图标签写法', () => {
    for (const field of [
      'job.jobTargetDate', 'estimatedManHours', 'effectiveManHours', 'actualManHours',
      'OWNER', 'JOB TARGET DATE', 'Check', 'INBOUND GEAR P/N', 'S/N', 'CSNo.',
      'WORK ORDER', 'OUTBOUND GEAR P/N', 'PART No', 'PART S/N', 'PART DES.',
      'Operation Type', 'Operation', 'Work Category', 'Estimated ManHours',
    ]) {
      expect(isWritableField(field)).toBe(false);
    }
  });

  it('编制域可写字段不受影响；task_card.check_type 须以限定名区分（需求 28.4）', () => {
    for (const field of [
      'task_card.title', 'task_card.check_type', 'task_card.ata_chapter',
      'process_step.skill', 'process_step.ref_doc_id', 'process_step.description_zh',
      'skill', 'safety_warning', 'repair_tips',
    ]) {
      expect(isWritableField(field)).toBe(true);
    }
    // 裸 check_type 歧义 → 从严拒绝
    expect(isWritableField('check_type')).toBe(false);
    expect(resolveReadOnlyFields('check_type')).toEqual(['job.check_type']);
    expect(resolveReadOnlyFields('S/N')).toEqual(['job.inbound_sn', 'job.part_sn']);
    expect(resolveReadOnlyFields('task_card.check_type')).toEqual([]);
  });

  it('空值与非字符串一律不可写', () => {
    for (const field of ['', '   ', null, undefined, 0, {}, ['job.owner']]) {
      expect(isWritableField(field)).toBe(false);
    }
  });
});
