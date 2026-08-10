import { describe, it, expect } from 'vitest';
import {
  addReferenceDocument,
  removeReferenceDocument,
  hasReferenceDocument,
  referenceDocumentKey,
  normalizeReferenceDocument,
  serializePayload,
  parsePayload,
  serializeComponent,
  parseComponent,
  serializeCaptureItem,
  parseCaptureItem,
  isValidComponentType,
  COMPONENT_PAYLOAD_FIELDS,
  PayloadError,
} from './collections.js';
import { COMPONENT_TYPE } from './enums.js';

const refDoc = (over = {}) => ({
  id: null,
  cardId: 7,
  docType: 'CMM',
  refNo: '32-11-05',
  docRevision: 'Rev.3',
  ataChapter: '32-11',
  ...over,
});

describe('参考文件集合增删（需求 9.1–9.3）', () => {
  it('新增后集合包含该条，且不修改原集合', () => {
    const before = [refDoc({ id: 1 })];
    const after = addReferenceDocument(before, refDoc({ id: 2, refNo: '32-41-00' }));
    expect(after).toHaveLength(2);
    expect(hasReferenceDocument(after, refDoc({ id: 2, refNo: '32-41-00' }))).toBe(true);
    expect(before).toHaveLength(1); // 原集合不变
  });

  it('删除某条后不再包含该条，其它条目原值原序保留', () => {
    const a = refDoc({ id: 1 });
    const b = refDoc({ id: 2, refNo: '32-41-00' });
    const c = refDoc({ id: 3, docType: 'AMM' });
    const { list, removed } = removeReferenceDocument([a, b, c], b);
    expect(removed).toBe(1);
    expect(hasReferenceDocument(list, b)).toBe(false);
    expect(list.map((d) => d.id)).toEqual([1, 3]);
    expect(list[0]).toEqual(normalizeReferenceDocument(a));
    expect(list[1]).toEqual(normalizeReferenceDocument(c));
  });

  it('删除不存在的条目：集合不变且 removed 为 0', () => {
    const before = [refDoc({ id: 1 })];
    const { list, removed } = removeReferenceDocument(before, refDoc({ id: 99 }));
    expect(removed).toBe(0);
    expect(list).toHaveLength(1);
  });

  it('未落库条目（无 id）按四个业务字段 + 归属工卡结构键定位（需求 9.1）', () => {
    const draft = refDoc();
    const list = addReferenceDocument([], draft);
    expect(hasReferenceDocument(list, { ...draft })).toBe(true);
    // 任一业务字段不同即视为另一条
    expect(hasReferenceDocument(list, { ...draft, ataChapter: '32-42' })).toBe(false);
    const { removed } = removeReferenceDocument(list, { ...draft });
    expect(removed).toBe(1);
  });

  it('身份键优先取 id：snake_case 与 camelCase 同键', () => {
    expect(referenceDocumentKey({ id: 5, doc_type: 'CMM' })).toBe(referenceDocumentKey({ id: 5, docType: 'AMM' }));
    expect(referenceDocumentKey(refDoc({ id: null }))).toBe(referenceDocumentKey({
      card_id: 7, doc_type: 'CMM', ref_no: '32-11-05', doc_revision: 'Rev.3', ata_chapter: '32-11',
    }));
  });

  it('一张工卡可关联多条参考文件（需求 9.3），不做去重', () => {
    const doc = refDoc();
    const list = addReferenceDocument(addReferenceDocument([], doc), doc);
    expect(list).toHaveLength(2);
  });
});

describe('serializePayload / parsePayload —— JSON TEXT 往返（需求 13、18）', () => {
  it('键顺序不影响落库文本（稳定序列化）', () => {
    expect(serializePayload({ unit: 'mm', label: 'A', nominal: 1 }))
      .toBe(serializePayload({ nominal: 1, label: 'A', unit: 'mm' }));
  });

  it('往返等价：嵌套对象与数组', () => {
    const payload = { columns: ['P/N', 'S/N'], rows: [{ 'P/N': 'X', ok: true }], meta: { depth: [1, { a: null }] } };
    expect(parsePayload(serializePayload(payload))).toEqual(payload);
  });

  it('空载荷落 SQL NULL，空列解析回 null', () => {
    expect(serializePayload(null)).toBeNull();
    expect(serializePayload(undefined)).toBeNull();
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload('')).toBeNull();
  });

  it('undefined 成员剔除，数组成员的 undefined 归 null（与 JSON 一致）', () => {
    expect(parsePayload(serializePayload({ a: 1, b: undefined }))).toEqual({ a: 1 });
    expect(parsePayload(serializePayload({ items: [1, undefined] }))).toEqual({ items: [1, null] });
  });

  it('已解析对象重复 parse 幂等', () => {
    const payload = { html: '<p>x</p>' };
    expect(parsePayload(payload)).toBe(payload);
  });

  it('非 JSON 原生取值与非法 JSON 一律拒绝，不静默失真', () => {
    expect(() => serializePayload({ at: new Date() })).toThrow(PayloadError);
    expect(() => serializePayload({ n: Number.NaN })).toThrow(PayloadError);
    expect(() => parsePayload('{not json')).toThrow(PayloadError);
  });
});

describe('组件往返与 step_id 绑定（需求 13.1–13.3、18.1、18.2）', () => {
  it('13 类组件类型均被承认，且各有 payload 字段约定', () => {
    expect(COMPONENT_TYPE).toHaveLength(13);
    for (const type of COMPONENT_TYPE) {
      expect(isValidComponentType(type)).toBe(true);
      expect(COMPONENT_PAYLOAD_FIELDS[type]).toBeDefined();
    }
    expect(isValidComponentType('unknownType')).toBe(false);
  });

  it('serialize → parse 往返保持 payload 与 step_id 绑定', () => {
    const component = {
      id: 11,
      stepId: 42,
      type: 'image',
      payload: { attachmentId: 9, url: '/api/attachments/9', annotations: [{ x: 1, y: 2 }] },
      sortOrder: 3,
    };
    const row = serializeComponent(component);
    expect(row.step_id).toBe(42);
    expect(typeof row.payload).toBe('string');

    const back = parseComponent(row);
    expect(back.stepId).toBe(42);
    expect(back.type).toBe('image');
    expect(back.payload).toEqual(component.payload);
    expect(back.sortOrder).toBe(3);
  });

  it('二次往返稳定（幂等）', () => {
    const component = { stepId: 1, type: 'measurement', payload: { label: 'L', unit: 'mm', nominal: 12.5 }, sortOrder: 0 };
    const once = parseComponent(serializeComponent(component));
    const twice = parseComponent(serializeComponent(once));
    expect(twice).toEqual(once);
  });

  it('snake_case 行入参亦可解析，缺失 payload 归 null', () => {
    const back = parseComponent({ id: 3, step_id: 8, type: 'text', payload: null, sort_order: '2' });
    expect(back.stepId).toBe(8);
    expect(back.payload).toBeNull();
    expect(back.sortOrder).toBe(2);
  });
});

describe('采集项往返（需求 12.2、12.3）', () => {
  it('config 与组件 payload 同一管道，required 归一为 0/1', () => {
    const item = { stepId: 5, type: 'measurement', itemKey: 'PN', label: '件号', config: { unit: 'mm', nominal: 3 }, required: true, sortOrder: 1 };
    const row = serializeCaptureItem(item);
    expect(row.step_id).toBe(5);
    expect(row.required).toBe(1);
    expect(typeof row.config).toBe('string');

    const back = parseCaptureItem(row);
    expect(back).toEqual({
      id: null, stepId: 5, type: 'measurement', itemKey: 'PN', label: '件号',
      config: { unit: 'mm', nominal: 3 }, required: 1, sortOrder: 1,
    });
  });

  it('未标记必填时 required 为 0', () => {
    expect(serializeCaptureItem({ stepId: 1, type: 'text' }).required).toBe(0);
    expect(parseCaptureItem({ step_id: 1, type: 'text', required: 0 }).required).toBe(0);
  });
});
