import { describe, it, expect } from 'vitest';
import {
  SNAPSHOT_CONTENT_FIELDS,
  SnapshotError,
  buildStepSnapshots,
  parseSnapshotContent,
  serializeSnapshotContent,
  serializeStepSnapshot,
} from './snapshot.js';

const RELEASE_AT = '2026-01-15T02:00:00.000Z';

/** 一张两道工序的工卡：DB 行形态（snake_case），含参考文件、采集项、组件与签署项。 */
function fixture() {
  return {
    steps: [
      {
        id: 11,
        card_id: 1,
        process_id: 'B',
        seq: 2,
        skill: 'AS',
        ref_doc_id: 91,
        description_zh: '拆卸支柱',
        description_en: 'Remove strut',
        safety_warning: '注意液压残压',
        visual_cue: '{"attachmentId":7,"kind":"image"}',
        repair_tips: '先泄压',
        is_critical: 1,
      },
      {
        id: 10,
        card_id: 1,
        process_id: 'A',
        seq: 1,
        skill: 'CL',
        ref_doc_id: null,
        description_zh: '清洗',
        description_en: 'Clean',
        is_critical: 0,
      },
    ],
    referenceDocuments: [
      { id: 91, card_id: 1, doc_type: 'CMM', ref_no: '32-11-01', doc_revision: 'R3', ata_chapter: '32' },
    ],
    captureItems: [
      { id: 51, step_id: 11, type: 'text', item_key: 'SN', label: 'S/N', config: '{"maxLen":20}', required: 1, sort_order: 2 },
      { id: 50, step_id: 11, type: 'measurement', item_key: 'PN', label: 'P/N', config: '{"nominal":1.5,"unit":"mm"}', required: 0, sort_order: 1 },
      { id: 52, step_id: 999, type: 'text', item_key: 'ORPHAN', config: null },
    ],
    components: [
      { id: 61, step_id: 11, type: 'tool', payload: '{"qty":1,"toolPn":"T-1"}', sort_order: 1 },
      { id: 62, step_id: 10, type: 'image', payload: '{"attachmentId":8}', sort_order: 1 },
    ],
    sigReqs: [
      { id: 71, step_id: 11, signature_role: 'MECH', stamp_required: 1, sort_order: 1 },
      { id: 72, step_id: 10, signature_role: 'INSP', stamp_required: 0, date_required: 0, sort_order: 1 },
    ],
  };
}

function build(data, options = {}) {
  return buildStepSnapshots(data.steps, data.captureItems, data.components, data.sigReqs, {
    sourceCardRevision: 3,
    timestamp: RELEASE_AT,
    referenceDocuments: data.referenceDocuments,
    ...options,
  });
}

describe('buildStepSnapshots — 快照形状与内容（需求 49.5）', () => {
  it('每道工序恰产出一份快照，含 source_card_revision 与释放时间', () => {
    const snapshots = build(fixture());
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.sourceCardRevision).toBe(3);
      expect(snapshot.snapshotAt).toBe(RELEASE_AT);
    }
    expect(snapshots.map((s) => s.sourceStepId)).toEqual([10, 11]); // 按 seq 升序
  });

  it('content 含 design.md 约定的全部字段', () => {
    const [, second] = build(fixture());
    expect(Object.keys(second.content).sort()).toEqual([...SNAPSHOT_CONTENT_FIELDS].sort());
    expect(second.content.processId).toBe('B');
    expect(second.content.skill).toBe('AS');
    expect(second.content.descriptionZh).toBe('拆卸支柱');
    expect(second.content.descriptionEn).toBe('Remove strut');
    expect(second.content.safetyWarning).toBe('注意液压残压');
    expect(second.content.repairTips).toBe('先泄压');
    expect(second.content.isCritical).toBe(1);
    expect(second.content.visualCue).toEqual({ attachmentId: 7, kind: 'image' });
  });

  it('参考文件存解析后的文档内容而非仅 id（后续改参考文件不影响历史 JOB）', () => {
    const [first, second] = build(fixture());
    expect(second.content.refDoc).toEqual({
      id: 91,
      docType: 'CMM',
      refNo: '32-11-01',
      docRevision: 'R3',
      ataChapter: '32',
    });
    expect(first.content.refDoc).toBeNull(); // 未挂参考文件
  });

  it('采集项/组件/签署项按 step_id 归属，归不到工序的条目被丢弃', () => {
    const [first, second] = build(fixture());
    expect(second.content.captureItems.map((i) => i.itemKey)).toEqual(['PN', 'SN']); // 按 sortOrder
    expect(second.content.captureItems[0].config).toEqual({ nominal: 1.5, unit: 'mm' });
    expect(second.content.components.map((c) => c.type)).toEqual(['tool']);
    expect(second.content.signatureRequirements).toEqual([
      { id: 71, signatureRole: 'MECH', stampRequired: 1, dateRequired: 1, sortOrder: 1 },
    ]);
    expect(first.content.captureItems).toEqual([]); // ORPHAN（step_id=999）不入任何快照
    expect(first.content.signatureRequirements[0].dateRequired).toBe(0);
  });

  it('camelCase 内存态入参与 snake_case DB 行入参产出相同快照', () => {
    const rows = build(fixture());
    const camel = buildStepSnapshots(
      [{ id: 10, processId: 'A', seq: 1, skill: 'CL', descriptionZh: '清洗', descriptionEn: 'Clean', isCritical: 0 }],
      [],
      [{ id: 62, stepId: 10, type: 'image', payload: { attachmentId: 8 }, sortOrder: 1 }],
      [{ id: 72, stepId: 10, signatureRole: 'INSP', stampRequired: 0, dateRequired: 0, sortOrder: 1 }],
      { sourceCardRevision: 3, timestamp: RELEASE_AT },
    );
    expect(camel[0]).toEqual(rows[0]);
  });
});

describe('buildStepSnapshots — 与来源解耦（Property 34 的前提，需求 49.6、49.7、37.5）', () => {
  it('建成后修改来源工序、采集项、组件、签署项均不改变快照', () => {
    const data = fixture();
    const before = build(data);
    const frozen = JSON.parse(JSON.stringify(before));

    // 模拟后续编制域改动：改描述、改关键标记、改载荷、增删条目
    data.steps[0].description_zh = '改过的描述';
    data.steps[0].is_critical = 0;
    data.steps.push({ id: 12, process_id: 'C', seq: 3, skill: 'AS' });
    data.captureItems[0].label = '改过的标签';
    data.captureItems.length = 0;
    data.components[0].payload = '{"qty":99}';
    data.sigReqs[0].signature_role = 'INSP';
    data.referenceDocuments[0].doc_revision = 'R9';

    expect(JSON.parse(JSON.stringify(before))).toEqual(frozen);
    expect(before).toHaveLength(2);
    expect(before[1].content.refDoc.docRevision).toBe('R3');
  });

  it('入参为内存对象时载荷不与来源共享引用', () => {
    const payload = { qty: 1, toolPn: 'T-1' };
    const visualCue = { attachmentId: 7 };
    const [snapshot] = buildStepSnapshots(
      [{ id: 10, processId: 'A', seq: 1, visualCue }],
      [],
      [{ id: 61, stepId: 10, type: 'tool', payload, sortOrder: 1 }],
      [],
      { sourceCardRevision: 1, timestamp: RELEASE_AT },
    );
    payload.qty = 99;
    visualCue.attachmentId = 99;
    expect(snapshot.content.components[0].payload).toEqual({ qty: 1, toolPn: 'T-1' });
    expect(snapshot.content.visualCue).toEqual({ attachmentId: 7 });
  });

  it('快照深度冻结：无法就地改写内容', () => {
    const [snapshot] = build(fixture());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.content)).toBe(true);
    expect(Object.isFrozen(snapshot.content.captureItems)).toBe(true);
    expect(() => {
      'use strict';
      snapshot.content.processId = 'Z';
    }).toThrow();
  });

  it('相同内容重复构建（除时间戳外）逐字段一致，输出确定', () => {
    const a = build(fixture());
    const b = build(fixture());
    expect(b).toEqual(a);
    // 键插入顺序不同的等价载荷序列化后文本相同
    expect(serializeSnapshotContent({ b: 1, a: 2 })).toBe(serializeSnapshotContent({ a: 2, b: 1 }));
  });
});

describe('buildStepSnapshots — 边界与前置校验', () => {
  it('缺少 source_card_revision 时抛 SnapshotError（列为 NOT NULL）', () => {
    expect(() => buildStepSnapshots([{ id: 1, processId: 'A' }], [], [], [], {})).toThrow(SnapshotError);
  });

  it('可从 options.card.revision 取版本号', () => {
    const [snapshot] = buildStepSnapshots([{ id: 1, processId: 'A' }], [], [], [], {
      card: { revision: 7 },
      timestamp: RELEASE_AT,
    });
    expect(snapshot.sourceCardRevision).toBe(7);
  });

  it('空工序集产出空快照集；缺失集合按空集处理', () => {
    expect(buildStepSnapshots([], null, undefined, null, { sourceCardRevision: 1 })).toEqual([]);
    const [snapshot] = buildStepSnapshots([{ id: 1, processId: 'A' }], null, undefined, null, {
      sourceCardRevision: 1,
      timestamp: RELEASE_AT,
    });
    expect(snapshot.content.captureItems).toEqual([]);
    expect(snapshot.content.components).toEqual([]);
    expect(snapshot.content.signatureRequirements).toEqual([]);
  });

  it('ref_doc_id 无法解析时保留 id 溯源，其余为 null', () => {
    const [snapshot] = buildStepSnapshots([{ id: 1, processId: 'A', ref_doc_id: 91 }], [], [], [], {
      sourceCardRevision: 1,
      timestamp: RELEASE_AT,
    });
    expect(snapshot.content.refDoc).toEqual({
      id: 91,
      docType: null,
      refNo: null,
      docRevision: null,
      ataChapter: null,
    });
  });
});

describe('content 列往返（与在线行共用同一序列化管道）', () => {
  it('serialize → parse 回到等价内容', () => {
    const [, snapshot] = build(fixture());
    const text = serializeSnapshotContent(snapshot.content);
    expect(typeof text).toBe('string');
    expect(parseSnapshotContent(text)).toEqual(snapshot.content);
  });

  it('serializeStepSnapshot 产出 job_step_snapshot 行形状', () => {
    const [, snapshot] = build(fixture());
    const row = serializeStepSnapshot(snapshot, 501);
    expect(row.job_process_id).toBe(501);
    expect(row.source_step_id).toBe(11);
    expect(row.source_card_revision).toBe(3);
    expect(row.snapshot_at).toBe(RELEASE_AT);
    expect(parseSnapshotContent(row.content)).toEqual(snapshot.content);
  });
});
