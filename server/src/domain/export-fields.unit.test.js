import { describe, it, expect } from 'vitest';
import {
  exportFields,
  isExportMode,
  formatRevision,
  formatExportValue,
  EXPORT_MODES,
  EXPORT_ROW_TYPE,
  KEY_EXPORT_FIELDS,
  CARD_EXPORT_FIELDS,
  FIELD_FORMAT,
} from './export-fields.js';

const keys = (fields) => fields.map((f) => f.key);

describe('exportFields("key") —— 关键信息导出（需求 3.6、D-05）', () => {
  const result = exportFields('key');

  it('字段 = 需求 2.1 六项 + 状态 + 版本，无多无少', () => {
    expect(keys(result.fields)).toEqual([
      'is_fai', 'gear_type', 'template_type', 'card_type', 'task_no', 'title', 'status', 'revision',
    ]);
  });

  it('单一分节、无行类别列', () => {
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].name).toBe(EXPORT_ROW_TYPE.CARD);
    expect(result.sections[0].parentKeys).toEqual([]);
    expect(result.discriminator).toBeNull();
  });

  it('需求 2.1 要求展示工卡类型，故 card_type 属关键字段（需求 5.2 只约束打印）', () => {
    expect(keys(result.fields)).toContain('card_type');
  });

  it('revision 以两位补零文本导出', () => {
    const revField = result.fields.find((f) => f.key === 'revision');
    expect(revField.format).toBe(FIELD_FORMAT.REVISION);
    expect(formatExportValue(revField, 1)).toBe('01');
  });
});

describe('exportFields("all") —— 全量导出（需求 3.7、D-05）', () => {
  const result = exportFields('all');

  it('卡头字段覆盖 task_card 全部列，且为关键字段的超集', () => {
    expect(keys(result.fields)).toEqual(keys(CARD_EXPORT_FIELDS));
    keys(KEY_EXPORT_FIELDS).forEach((key) => {
      expect(keys(result.fields)).toContain(key);
    });
    expect(result.fields).toHaveLength(30);
  });

  it('三个分节：卡头 + 参考文件展开行 + 工序展开行', () => {
    expect(result.sections.map((s) => s.name)).toEqual([
      EXPORT_ROW_TYPE.CARD, EXPORT_ROW_TYPE.REFERENCE_DOC, EXPORT_ROW_TYPE.PROCESS_STEP,
    ]);
  });

  it('子行以 task_no + revision 回指所属工卡，首列为行类别', () => {
    const [, refs, steps] = result.sections;
    expect(keys(refs.parentKeys)).toEqual(['task_no', 'revision']);
    expect(keys(steps.parentKeys)).toEqual(['task_no', 'revision']);
    expect(refs.headers.slice(0, 2)).toEqual(['Task No', 'Revision']);
    expect(result.discriminator.key).toBe('row_type');
  });

  it('展开行字段覆盖各自表的业务列', () => {
    const [, refs, steps] = result.sections;
    expect(keys(refs.fields)).toEqual(['id', 'doc_type', 'ref_no', 'doc_revision', 'ata_chapter']);
    expect(keys(steps.fields)).toContain('process_id');
    expect(keys(steps.fields)).toContain('estimated_man_hours');
    expect(keys(steps.fields)).toContain('is_critical');
  });

  it('工序表头不含执行域列（两域分离：条码/实际工时/起止时间在 job_process）', () => {
    const stepKeys = keys(result.sections[2].fields);
    ['barcode_value', 'actual_man_hours', 'effective_man_hours', 'start_time', 'finish_time']
      .forEach((key) => expect(stepKeys).not.toContain(key));
  });
});

describe('exportFields —— 模式校验与不可变性', () => {
  it('模式越界即抛错（服务层据此回 400）', () => {
    ['KEY', 'full', '', null, undefined, 1].forEach((mode) => {
      expect(() => exportFields(mode)).toThrow(TypeError);
    });
    expect(isExportMode('key')).toBe(true);
    expect(isExportMode('all')).toBe(true);
    expect(isExportMode('other')).toBe(false);
    expect(EXPORT_MODES).toEqual(['key', 'all']);
  });

  it('返回值与其中的字段数组均冻结，且同模式返回同一份定义', () => {
    EXPORT_MODES.forEach((mode) => {
      const result = exportFields(mode);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.fields)).toBe(true);
      expect(Object.isFrozen(result.sections)).toBe(true);
      result.sections.forEach((s) => expect(Object.isFrozen(s.fields)).toBe(true));
      expect(exportFields(mode)).toBe(result);
    });
  });
});

describe('formatRevision —— 两位补零（design.md：库内 INTEGER，展示补零）', () => {
  it('补零至两位，超两位不截断', () => {
    expect(formatRevision(1)).toBe('01');
    expect(formatRevision(9)).toBe('09');
    expect(formatRevision(10)).toBe('10');
    expect(formatRevision(100)).toBe('100');
    expect(formatRevision('3')).toBe('03');
  });

  it('空值 / 非数值 → 空串', () => {
    [null, undefined, '', 'abc', NaN, {}].forEach((value) => {
      expect(formatRevision(value)).toBe('');
    });
  });
});

describe('formatExportValue —— 单元格取值', () => {
  const of = (key) => CARD_EXPORT_FIELDS.find((f) => f.key === key);

  it('空值一律空串，不写 "null"', () => {
    expect(formatExportValue(of('title'), null)).toBe('');
    expect(formatExportValue(of('title'), undefined)).toBe('');
    expect(formatExportValue(of('id'), null)).toBe('');
  });

  it('flag 列输出 1/0（兼容 SQLite 0/1 与布尔）', () => {
    expect(formatExportValue(of('is_fai'), 1)).toBe('1');
    expect(formatExportValue(of('is_fai'), 0)).toBe('0');
    expect(formatExportValue(of('is_fai'), true)).toBe('1');
    expect(formatExportValue(of('is_fai'), 'false')).toBe('0');
  });

  it('文本原样、整数截断、实数保留小数', () => {
    expect(formatExportValue(of('title'), 'MLG Receiving')).toBe('MLG Receiving');
    expect(formatExportValue(of('id'), '12')).toBe('12');
    const manHours = exportFields('all').sections[2].fields.find((f) => f.key === 'estimated_man_hours');
    expect(formatExportValue(manHours, 1.5)).toBe('1.5');
  });
});
