/**
 * 单元测试：执行过程单据（含 SWS）复制（需求 23.1、23.2、38.1–38.3）。
 * 属性测试（Property 3 / Property 20）见任务 6.7、6.8，本文件只覆盖具体样例与边界。
 */

import { describe, it, expect } from 'vitest';
import {
  copyExecDocument,
  cloneExecDocContent,
  isSws,
  EXEC_DOC_STATUS_NEW,
  INITIAL_REVISION,
  COPY_RESET_FIELDS,
} from './exec-doc.js';

/** 与 seed.js 的 SWS 样例同形态：content 为 JSON 字符串（仓储层直读形态） */
function swsRow() {
  return {
    id: 7,
    exec_doc_type: 'SW',
    doc_no: 'SWS-2026-0001',
    revision: 3,
    status: 'Effective',
    title: '补充工作单 / Supplementary Work Sheet',
    content: JSON.stringify({
      acType: '320',
      steps: [{ seq: 1, descriptionZh: '打磨腐蚀区域' }],
    }),
    source_card_id: 1,
    created_by: 'E10001',
    created_at: '2026-01-12T02:00:00Z',
  };
}

describe('copyExecDocument（需求 23.1、38.1–38.3）', () => {
  it('副本除 id/doc_no/status/revision 外逐字段与源单据相等', () => {
    const source = swsRow();
    const copy = copyExecDocument(source, 'SWS-2026-0002');

    for (const key of Object.keys(source)) {
      if (COPY_RESET_FIELDS.includes(key)) continue;
      expect(copy[key]).toEqual(source[key]);
    }
    expect(Object.keys(copy).sort()).toEqual(Object.keys(source).sort());
  });

  it('副本 doc_no 取传入新值、status 置 New、revision 置初始版本、id 置 null', () => {
    const copy = copyExecDocument(swsRow(), 'SWS-2026-0002');

    expect(copy.doc_no).toBe('SWS-2026-0002');
    expect(copy.status).toBe(EXEC_DOC_STATUS_NEW);
    expect(copy.revision).toBe(INITIAL_REVISION);
    expect(copy.id).toBeNull();
  });

  it('源单据保持不变，且改副本不影响源单据（对象形态 content 不共享引用）', () => {
    const source = { ...swsRow(), content: { acType: '320', steps: [{ seq: 1 }] } };
    const snapshot = structuredClone(source);

    const copy = copyExecDocument(source, 'SWS-2026-0002');
    copy.content.steps[0].seq = 99;
    copy.content.acType = '737';
    copy.title = 'changed';

    expect(source).toEqual(snapshot);
  });

  it('content 为 JSON 字符串时原样保留，不解析也不重新序列化', () => {
    const source = swsRow();
    const copy = copyExecDocument(source, 'SWS-2026-0002');

    expect(typeof copy.content).toBe('string');
    expect(copy.content).toBe(source.content);
  });

  it('未出现在源单据的列不凭空添加', () => {
    const copy = copyExecDocument(
      { exec_doc_type: 'SW', doc_no: 'SWS-1', revision: 1, status: 'New' },
      'SWS-2',
    );
    expect(Object.keys(copy).sort()).toEqual(
      ['doc_no', 'exec_doc_type', 'id', 'revision', 'status'],
    );
  });

  it('编号为空/纯空白/非法时拒绝复制（需求 38.1）', () => {
    for (const bad of ['', '   ', null, undefined, {}, Number.NaN]) {
      expect(() => copyExecDocument(swsRow(), bad)).toThrow(TypeError);
    }
  });

  it('源单据非对象时拒绝复制', () => {
    for (const bad of [null, undefined, 'SWS-1', [], 42]) {
      expect(() => copyExecDocument(bad, 'SWS-2')).toThrow(TypeError);
    }
  });
});

describe('isSws / cloneExecDocContent（需求 23.2）', () => {
  it('仅 exec_doc_type === "SW" 判为 SWS', () => {
    expect(isSws(swsRow())).toBe(true);
    expect(isSws('SW')).toBe(true);
    expect(isSws({ exec_doc_type: 'CR' })).toBe(false);
    expect(isSws(null)).toBe(false);
  });

  it('cloneExecDocContent 对字符串原样返回、对对象深克隆', () => {
    const json = '{"a":1}';
    expect(cloneExecDocContent(json)).toBe(json);

    const obj = { a: { b: [1, 2] } };
    const cloned = cloneExecDocContent(obj);
    expect(cloned).toEqual(obj);
    expect(cloned.a).not.toBe(obj.a);
    expect(cloned.a.b).not.toBe(obj.a.b);
  });
});
