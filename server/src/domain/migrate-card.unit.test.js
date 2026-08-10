import { describe, it, expect } from 'vitest';
import { migrateRecords, FAILURE_CATEGORY, RECORD_STATUS, REQUIRED_FIELDS } from './migrate-card.js';

// Stage 取横切值（NRC），保证无需额外配置即对任意工卡类型放行（stage-constraint.js 的种子默认值）
const VALID_ROW = {
  task_no: 'TS-01-0001',
  title: '收货检查工卡',
  card_type: '01',
  ac_type: '320',
  gear_type: 'MLG',
  stage: 'NRC',
  skill: 'AS',
};

describe('migrateRecords —— 逐条校验与报告（需求 17.1、17.2、41.1、41.3–41.6）', () => {
  it('空批次：三项计数均为 0', () => {
    const report = migrateRecords([]);
    expect(report).toEqual({
      successCount: 0,
      failureCount: 0,
      totalCount: 0,
      records: [],
      byCategory: {
        enum_invalid: 0,
        required_missing: 0,
        stage_card_type_invalid: 0,
        duplicate_task_no: 0,
      },
    });
  });

  it('null/undefined 输入视为空批次', () => {
    expect(migrateRecords(null).totalCount).toBe(0);
    expect(migrateRecords(undefined).totalCount).toBe(0);
  });

  it('全部字段合法：成功，状态置 New，task_no 不改写，naming_rule_origin 记录原编号', () => {
    const report = migrateRecords([VALID_ROW]);
    expect(report.successCount).toBe(1);
    expect(report.failureCount).toBe(0);
    expect(report.totalCount).toBe(1);
    const [record] = report.records;
    expect(record.status).toBe(RECORD_STATUS.SUCCESS);
    expect(record.card.status).toBe('New');
    expect(record.card.task_no).toBe('TS-01-0001');
    expect(record.card.naming_rule_origin).toBe('TS-01-0001');
    expect(record.failureCategory).toBeNull();
  });

  it('缺少必填字段：跳过该行，归类 required_missing，continue 处理其余', () => {
    const missingTitle = { ...VALID_ROW, title: undefined };
    const report = migrateRecords([missingTitle, VALID_ROW]);
    expect(report.successCount).toBe(1);
    expect(report.failureCount).toBe(1);
    expect(report.totalCount).toBe(2);
    expect(report.byCategory.required_missing).toBe(1);
    expect(report.records[0].status).toBe(RECORD_STATUS.FAILED);
    expect(report.records[0].failureCategory).toBe(FAILURE_CATEGORY.REQUIRED_MISSING);
    expect(report.records[0].reason).toContain('title');
    expect(report.records[1].status).toBe(RECORD_STATUS.SUCCESS);
  });

  it.each(REQUIRED_FIELDS)('必填字段清单包含 %s', (field) => {
    const row = { ...VALID_ROW, [field]: '' };
    const report = migrateRecords([row]);
    expect(report.records[0].failureCategory).toBe(FAILURE_CATEGORY.REQUIRED_MISSING);
  });

  it('枚举取值不合法：归类 enum_invalid', () => {
    const row = { ...VALID_ROW, ac_type: 'NOT_A_TYPE' };
    const report = migrateRecords([row]);
    expect(report.failureCount).toBe(1);
    expect(report.byCategory.enum_invalid).toBe(1);
    expect(report.records[0].failureCategory).toBe(FAILURE_CATEGORY.ENUM_INVALID);
  });

  it('未给出的可选枚举字段不视为失败', () => {
    const row = { task_no: 'TS-01-0002', title: '标题', card_type: '01' };
    const report = migrateRecords([row]);
    expect(report.successCount).toBe(1);
  });

  it('Stage×工卡类型组合不合法：归类 stage_card_type_invalid', () => {
    // WFD 属横切取值恒放行；构造一个约束表明确不允许的组合
    const row = { ...VALID_ROW, card_type: '01', stage: 'MOD' };
    const cfg = { constraints: [{ card_type: '01', allowed_stage: 'RTN', is_auto_fill: 1 }], crosscut: [] };
    const report = migrateRecords([row], [], cfg);
    expect(report.failureCount).toBe(1);
    expect(report.byCategory.stage_card_type_invalid).toBe(1);
    expect(report.records[0].failureCategory).toBe(FAILURE_CATEGORY.STAGE_CARD_TYPE_INVALID);
  });

  it('未给出 Stage 时不做组合校验', () => {
    const row = { task_no: 'TS-01-0003', title: '标题', card_type: '01' };
    const cfg = { constraints: [], crosscut: [] };
    const report = migrateRecords([row], [], cfg);
    expect(report.successCount).toBe(1);
  });

  it('编号与现存工卡重复：归类 duplicate_task_no', () => {
    const existing = [{ id: 1, task_no: 'TS-01-0001', revision: 1 }];
    const report = migrateRecords([VALID_ROW], existing);
    expect(report.failureCount).toBe(1);
    expect(report.byCategory.duplicate_task_no).toBe(1);
    expect(report.records[0].failureCategory).toBe(FAILURE_CATEGORY.DUPLICATE_TASK_NO);
  });

  it('批次内部重复：第二条同编号行被拦截，第一条仍成功', () => {
    const report = migrateRecords([VALID_ROW, { ...VALID_ROW }]);
    expect(report.successCount).toBe(1);
    expect(report.failureCount).toBe(1);
    expect(report.records[0].status).toBe(RECORD_STATUS.SUCCESS);
    expect(report.records[1].status).toBe(RECORD_STATUS.FAILED);
    expect(report.records[1].failureCategory).toBe(FAILURE_CATEGORY.DUPLICATE_TASK_NO);
  });

  it('批次内不同版本号的相同 task_no 不构成重复', () => {
    const rowRev1 = { ...VALID_ROW, revision: 1 };
    const rowRev2 = { ...VALID_ROW, revision: 2 };
    const report = migrateRecords([rowRev1, rowRev2]);
    expect(report.successCount).toBe(2);
    expect(report.failureCount).toBe(0);
  });

  it('一行多问题时只归因于检查顺序中最先命中的类别（必填 > 枚举 > Stage×类型 > 重复）', () => {
    // 同时缺必填(title)与枚举非法(ac_type)：应归 required_missing，而非 enum_invalid
    const row = { task_no: 'TS-01-0004', card_type: '01', ac_type: 'NOT_A_TYPE' };
    const report = migrateRecords([row]);
    expect(report.records[0].failureCategory).toBe(FAILURE_CATEGORY.REQUIRED_MISSING);
  });

  it('成功条数与失败条数之和恒等于输入总数；每条失败均带原因', () => {
    const rows = [
      VALID_ROW,
      { ...VALID_ROW, title: undefined },
      { ...VALID_ROW, ac_type: 'BAD' },
    ];
    const report = migrateRecords(rows);
    expect(report.successCount + report.failureCount).toBe(report.totalCount);
    for (const record of report.records) {
      if (record.status === RECORD_STATUS.FAILED) {
        expect(typeof record.reason).toBe('string');
        expect(record.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('源工卡（输入行）保持不变，不被本函数写入', () => {
    const row = { ...VALID_ROW };
    const snapshot = { ...row };
    migrateRecords([row]);
    expect(row).toEqual(snapshot);
  });

  it('非对象行（如字符串/数字/数组）视为不合法结构化记录，归类 required_missing', () => {
    const report = migrateRecords(['not-an-object', 42, [1, 2]]);
    expect(report.totalCount).toBe(3);
    expect(report.failureCount).toBe(3);
    expect(report.byCategory.required_missing).toBe(3);
  });
});
