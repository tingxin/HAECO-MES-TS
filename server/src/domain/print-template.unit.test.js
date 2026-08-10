import { describe, it, expect } from 'vitest';
import {
  selectPrintTemplate,
  resolveTemplateTarget,
  isWildcardTargetCode,
  TEMPLATE_MATCH,
  TEMPLATE_TARGET_KIND,
} from './print-template.js';
import { DEFAULT_PRINT_TEMPLATE_BODY } from '../db/seed.js';

/** 与 print_template 同形的一行 */
const tpl = (id, targetKind, targetCode, isDefault = 0, body = `body-${id}`) => ({
  id,
  target_kind: targetKind,
  target_code: targetCode,
  template_body: body,
  is_default: isDefault,
});

/** seed.js 的现状：只有 ('card_type','01') 一条默认模板 */
const SEEDED = [tpl(1, 'card_type', '01', 1, DEFAULT_PRINT_TEMPLATE_BODY)];

describe('resolveTemplateTarget —— 模板目标解析（需求 40.1、40.2）', () => {
  it('工卡按 card_type、执行过程单据按 exec_doc_type', () => {
    expect(resolveTemplateTarget({ card_type: '04' })).toEqual({
      targetKind: TEMPLATE_TARGET_KIND.CARD_TYPE, targetCode: '04', isKnownCode: true,
    });
    expect(resolveTemplateTarget({ exec_doc_type: 'SW' })).toEqual({
      targetKind: TEMPLATE_TARGET_KIND.EXEC_DOC_TYPE, targetCode: 'SW', isKnownCode: true,
    });
  });

  it('兼容 camelCase 与 WBS 别名（需求 6.8：WBS 与工卡类型同字段）', () => {
    expect(resolveTemplateTarget({ cardType: '11' }).targetCode).toBe('11');
    expect(resolveTemplateTarget({ wbs: '02' })).toEqual({
      targetKind: TEMPLATE_TARGET_KIND.CARD_TYPE, targetCode: '02', isKnownCode: true,
    });
  });

  it('显式 target_kind / target_code 优先于实体列', () => {
    const target = resolveTemplateTarget({ target_kind: 'exec_doc_type', target_code: 'PC', card_type: '01' });
    expect(target.targetKind).toBe(TEMPLATE_TARGET_KIND.EXEC_DOC_TYPE);
    expect(target.targetCode).toBe('PC');
  });

  it('未知代码不阻断，仅标记 isKnownCode=false；无类型列则目标不可识别', () => {
    expect(resolveTemplateTarget({ card_type: '99' })).toEqual({
      targetKind: TEMPLATE_TARGET_KIND.CARD_TYPE, targetCode: '99', isKnownCode: false,
    });
    expect(resolveTemplateTarget({ task_no: 'TC-1' }).targetKind).toBeNull();
    expect(resolveTemplateTarget(null).targetKind).toBeNull();
  });
});

describe('isWildcardTargetCode —— 通配目标代码', () => {
  it('* / ALL / DEFAULT / 空 视为通配，具体类型码不是', () => {
    ['*', 'ALL', 'default', '', null, undefined].forEach((code) => {
      expect(isWildcardTargetCode(code)).toBe(true);
    });
    expect(isWildcardTargetCode('01')).toBe(false);
    expect(isWildcardTargetCode('SW')).toBe(false);
  });
});

describe('selectPrintTemplate —— L1 类型专属模板（需求 40.3）', () => {
  const templates = [
    tpl(1, 'card_type', '01', 1),
    tpl(2, 'card_type', '04'),
    tpl(3, 'exec_doc_type', 'SW'),
  ];

  it('按工卡类型选中对应模板', () => {
    const result = selectPrintTemplate({ card_type: '04' }, templates);
    expect(result.matchLevel).toBe(TEMPLATE_MATCH.EXACT);
    expect(result.isFallback).toBe(false);
    expect(result.templateId).toBe(2);
    expect(result.templateBody).toBe('body-2');
  });

  it('按执行单据类型选中对应模板，不跨类目串味（需求 40.2）', () => {
    expect(selectPrintTemplate({ exec_doc_type: 'SW' }, templates).templateId).toBe(3);
    // 同一代码字面量在两类目下互不干扰
    const crossed = [tpl(9, 'exec_doc_type', '01', 1), tpl(8, 'card_type', '01')];
    expect(selectPrintTemplate({ card_type: '01' }, crossed).templateId).toBe(8);
  });

  it('同目标多行时取 is_default，且与入参数组顺序无关', () => {
    const dup = [tpl(5, 'card_type', '02'), tpl(6, 'card_type', '02', 1)];
    expect(selectPrintTemplate({ card_type: '02' }, dup).templateId).toBe(6);
    expect(selectPrintTemplate({ card_type: '02' }, [...dup].reverse()).templateId).toBe(6);
  });
});

describe('selectPrintTemplate —— 无专属模板则回退默认（需求 40.4）', () => {
  it('L2 同类目通配行优先于具体类型的默认行', () => {
    const templates = [tpl(1, 'card_type', '01', 1), tpl(2, 'card_type', '*', 1)];
    const result = selectPrintTemplate({ card_type: '07' }, templates);
    expect(result.matchLevel).toBe(TEMPLATE_MATCH.KIND_DEFAULT);
    expect(result.isFallback).toBe(true);
    expect(result.templateId).toBe(2);
  });

  it('L3 同类目 is_default 行：类型 07 无专属，兜到 card_type 的默认模板', () => {
    const result = selectPrintTemplate({ card_type: '07' }, SEEDED);
    expect(result.matchLevel).toBe(TEMPLATE_MATCH.KIND_DEFAULT);
    expect(result.templateId).toBe(1);
    expect(result.templateBody).toBe(DEFAULT_PRINT_TEMPLATE_BODY);
    expect(result.isDefaultTemplate).toBe(true);
  });

  it('L4 跨类目默认：种子期打印执行过程单据借用 card_type 的默认模板', () => {
    const result = selectPrintTemplate({ exec_doc_type: 'SW' }, SEEDED);
    expect(result.matchLevel).toBe(TEMPLATE_MATCH.GLOBAL_DEFAULT);
    expect(result.matchedKind).toBe(TEMPLATE_TARGET_KIND.CARD_TYPE);
    expect(result.templateBody).toBe(DEFAULT_PRINT_TEMPLATE_BODY);
  });

  it('目标不可识别时直接走默认回退，不报错', () => {
    const result = selectPrintTemplate({ task_no: 'TC-2026-0001' }, SEEDED);
    expect(result.matchLevel).toBe(TEMPLATE_MATCH.GLOBAL_DEFAULT);
    expect(result.targetKind).toBeNull();
    expect(result.templateId).toBe(1);
  });

  it('对全部 11 类工卡，种子数据均能选出模板（需求 40.1、40.4）', () => {
    ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'].forEach((code) => {
      const result = selectPrintTemplate({ card_type: code }, SEEDED);
      expect(result.template).not.toBeNull();
      expect(result.templateBody).toBe(DEFAULT_PRINT_TEMPLATE_BODY);
      expect(result.matchLevel).toBe(code === '01' ? TEMPLATE_MATCH.EXACT : TEMPLATE_MATCH.KIND_DEFAULT);
    });
  });
});

describe('selectPrintTemplate —— 边界与不可变性', () => {
  it('模板表为空 / 非数组 / 全为非法 target_kind：matchLevel=none 且模板为空', () => {
    [[], null, undefined, [tpl(1, 'job', '01', 1)], ['x', 42]].forEach((templates) => {
      const result = selectPrintTemplate({ card_type: '01' }, templates);
      expect(result.matchLevel).toBe(TEMPLATE_MATCH.NONE);
      expect(result.template).toBeNull();
      expect(result.templateBody).toBeNull();
    });
  });

  it('同类目既无专属亦无默认时不擅自借用非默认模板', () => {
    const result = selectPrintTemplate({ card_type: '05' }, [tpl(1, 'card_type', '01', 0)]);
    expect(result.matchLevel).toBe(TEMPLATE_MATCH.NONE);
  });

  it('兼容 camelCase 模板行，返回值冻结', () => {
    const camel = [{ id: 7, targetKind: 'card_type', targetCode: '03', templateBody: 'b7', isDefault: true }];
    const result = selectPrintTemplate({ cardType: '03' }, camel);
    expect(result.templateId).toBe(7);
    expect(result.templateBody).toBe('b7');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('入参模板行集不被改写', () => {
    const templates = [tpl(2, 'card_type', '04'), tpl(1, 'card_type', '01', 1)];
    const snapshot = JSON.stringify(templates);
    selectPrintTemplate({ card_type: '04' }, templates);
    expect(JSON.stringify(templates)).toBe(snapshot);
  });
});
