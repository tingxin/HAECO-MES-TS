/**
 * 仓储层往返单元测试（任务 12.5）。
 *
 * 每个用例均在全新的内存 SQLite 库执行 migrate + seed，覆盖编制域字段、双语工序、
 * JSON 列、运行时配置排序，以及三个集成仓储的只读导出契约。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import * as captureItemRepo from './captureItemRepo.js';
import * as componentRepo from './componentRepo.js';
import * as derivationPriorityRepo from './derivationPriorityRepo.js';
import * as execDocumentRepo from './execDocumentRepo.js';
import * as lotListBaseRepo from './lotListBaseRepo.js';
import * as ppcScheduleRepo from './ppcScheduleRepo.js';
import * as processDataRepo from './processDataRepo.js';
import * as processStepRepo from './processStepRepo.js';
import * as taskCardRepo from './taskCardRepo.js';
import * as classificationResultRepo from './classificationResultRepo.js';

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();
});

afterAll(() => {
  closeDb();
});

function seededCardId(taskNo = 'TC-2026-0002') {
  return taskCardRepo.findByTaskNoAndRevision(taskNo, 1).id;
}

function createRoundTripStep() {
  return processStepRepo.create({
    cardId: seededCardId(),
    processId: 'RT',
    seq: 90,
    skill: 'IR',
    descriptionZh: '检查衬套孔径，并记录所有测量结果。',
    descriptionEn: 'Inspect the bush bore and record every measurement result.',
    isCritical: true,
  });
}
describe('taskCardRepo 往返', () => {
  it('保存后逐字段一致，并执行 camelCase ↔ snake_case 转换且 revision 保持 INTEGER', () => {
    const input = {
      taskNo: 'TC-ROUNDTRIP-0001', revision: '7', title: '仓储往返测试 / Repository round trip',
      date: '2026-08-09', acType: '350', gearType: 'WLG', stage: 'RTN', skill: 'AS',
      ctrlCode: 'DA', cardType: '09', isFai: true, templateType: 'Repair', status: 'New',
      documentType: 'CMM', refNo: '32-21-00', documentRevision: 'Rev 9',
      documentDesc: 'Wheel maintenance manual', baseNumber: 'BASE-RT-001',
      ipcItemNo: '32-21-00-001', createdBy: 'E10001', reviewedBy: 'E20001',
      ndtReviewer: 'E30001', ataChapter: '32-21', checkType: 'Detailed',
      commercialClassification: 'Routine', outsourceSubtype: 'L sub',
      lastUpdate: '2026-08-09T10:11:12Z', operatorId: 'E10002',
      namingRuleOrigin: 'LEGACY-ROUNDTRIP-001',
    };

    const id = taskCardRepo.create(input);
    const stored = taskCardRepo.findById(id);
    const expected = { ...input, revision: 7, isFai: 1 };

    expect(stored).toMatchObject(expected);
    expect(typeof stored.revision).toBe('number');
    expect(Object.keys(stored).some((key) => key.includes('_'))).toBe(false);

    const raw = getDb().prepare('SELECT task_no, ac_type, card_type, is_fai, revision FROM task_card WHERE id = ?').get(id);
    expect(raw).toEqual({ task_no: input.taskNo, ac_type: input.acType, card_type: input.cardType, is_fai: 1, revision: 7 });
  });
});

describe('processStepRepo 双语描述往返', () => {
  it('中文和英文描述保存后均逐字读取，归属与整数列保持一致', () => {
    const id = createRoundTripStep();
    const stored = processStepRepo.findById(id);

    expect(stored).toMatchObject({
      cardId: seededCardId(), processId: 'RT', seq: 90, skill: 'IR',
      descriptionZh: '检查衬套孔径，并记录所有测量结果。',
      descriptionEn: 'Inspect the bush bore and record every measurement result.',
      isCritical: 1,
    });
    expect(getDb().prepare('SELECT description_zh, description_en FROM process_step WHERE id = ?').get(id)).toEqual({
      description_zh: stored.descriptionZh,
      description_en: stored.descriptionEn,
    });
  });
});
describe('采集项与插入组件 JSON 往返', () => {
  it('capture_item 的 type/config 与 step_id 绑定关系无损往返', () => {
    const stepId = createRoundTripStep();
    const config = {
      label: 'Bore diameter / 衬套孔径', unit: 'mm', limits: { min: 40.01, max: 40.09 },
      options: ['actual', 'repeat'], metadata: { bilingual: true, note: null },
    };
    const id = captureItemRepo.create({
      stepId, type: 'measurement', itemKey: 'boreDiameter', label: '衬套孔径',
      config, required: true, sortOrder: 3,
    });

    expect(captureItemRepo.findById(id)).toEqual({
      id, stepId, type: 'measurement', itemKey: 'boreDiameter', label: '衬套孔径',
      config, required: 1, sortOrder: 3,
    });
    const raw = getDb().prepare('SELECT step_id, type, config FROM capture_item WHERE id = ?').get(id);
    expect(raw.step_id).toBe(stepId);
    expect(raw.type).toBe('measurement');
    expect(JSON.parse(raw.config)).toEqual(config);
  });

  it('inserted_component 的 payload JSON 与 step_id 绑定关系无损往返', () => {
    const stepId = createRoundTripStep();
    const payload = {
      columns: [{ key: 'point', title: '测点' }, { key: 'value', title: 'Value' }],
      rows: [{ point: 'A', value: 12.34 }, { point: 'B', value: null }],
      settings: { striped: true, precision: 2 },
    };
    const id = componentRepo.create({ stepId, type: 'table', payload, sortOrder: 4 });

    expect(componentRepo.findById(id)).toEqual({ id, stepId, type: 'table', payload, sortOrder: 4 });
    const raw = getDb().prepare('SELECT step_id, type, payload FROM inserted_component WHERE id = ?').get(id);
    expect(raw.step_id).toBe(stepId);
    expect(raw.type).toBe('table');
    expect(JSON.parse(raw.payload)).toEqual(payload);
  });
});

describe('execDocumentRepo JSON 往返', () => {
  it('对象 content 序列化落库后可等价读取，revision 读取为 INTEGER', () => {
    const content = {
      acType: '350', findings: '腐蚀 / Corrosion',
      steps: [
        { seq: 1, descriptionZh: '清洁表面', descriptionEn: 'Clean the surface' },
        { seq: 2, values: [0, 1.25, null], accepted: true },
      ],
    };
    const id = execDocumentRepo.create({
      execDocType: 'SW', docNo: 'SWS-ROUNDTRIP-0001', revision: '3', status: 'New',
      title: '补充工作单往返测试', content, sourceCardId: seededCardId(),
      createdBy: 'E10001', createdAt: '2026-08-09T12:00:00Z',
    });

    const stored = execDocumentRepo.findById(id);
    expect(stored).toMatchObject({ execDocType: 'SW', docNo: 'SWS-ROUNDTRIP-0001', revision: 3 });
    expect(typeof stored.revision).toBe('number');
    expect(JSON.parse(stored.content)).toEqual(content);
    expect(JSON.parse(getDb().prepare('SELECT content FROM exec_document WHERE id = ?').get(id).content)).toEqual(content);
  });
});
describe('derivationPriorityRepo 运行时配置驱动排序', () => {
  it('直接修改表中 tier_order 后，读取顺序立即随配置变化', () => {
    const before = derivationPriorityRepo.list();
    const first = before[0];
    const last = before.at(-1);
    expect(before.map((row) => row.tierOrder)).toEqual([1, 2, 3, 4, 5, 6]);

    getDb().transaction(() => {
      getDb().prepare('UPDATE derivation_priority_config SET tier_order = -1 WHERE id = ?').run(first.id);
      getDb().prepare('UPDATE derivation_priority_config SET tier_order = 1 WHERE id = ?').run(last.id);
      getDb().prepare('UPDATE derivation_priority_config SET tier_order = 6 WHERE id = ?').run(first.id);
    })();

    const after = derivationPriorityRepo.list();
    expect(after.map((row) => row.tierCode)).toEqual([
      last.tierCode,
      ...before.slice(1, -1).map((row) => row.tierCode),
      first.tierCode,
    ]);
    expect(after.map((row) => row.tierOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(derivationPriorityRepo.listEnabled().map((row) => row.tierCode)).toEqual(after.map((row) => row.tierCode));
  });
});

describe('集成仓储只读导出契约', () => {
  it.each([
    ['ppcScheduleRepo', ppcScheduleRepo],
    ['processDataRepo', processDataRepo],
    ['lotListBaseRepo', lotListBaseRepo],
  ])('%s 不暴露任何写方法', (_name, repository) => {
    const forbidden = /^(create|insert|update|upsert|save|remove|delete|replace|reorder)/i;
    expect(Object.keys(repository).filter((key) => key !== 'default' && forbidden.test(key))).toEqual([]);
    expect(Object.keys(repository.default).filter((key) => forbidden.test(key))).toEqual([]);
  });
});


describe('classificationResultRepo 快照 JSON 往返', () => {
  it('完整序列化并解析候选与已求值层级', () => {
    const candidates = [{ classification: 'Outsource', hitTier: 'P3_OutsourceList', sourceRef: 'OS-1', outsourceSubtypes: ['L sub'], sources: [{ hitTier: 'P3_OutsourceList', sourceRef: 'OS-1', outsourceSubtype: 'L sub' }] }, { classification: 'Routine', hitTier: 'P6_CardTypeFallback', sourceRef: 'card_type:08', sources: [] }];
    const evaluatedTiers = [{ tierCode: 'P3_OutsourceList', tierOrder: 3, hitCount: 1 }, { tierCode: 'P6_CardTypeFallback', tierOrder: 6, hitCount: 1 }];
    const id = classificationResultRepo.create({
      cardId: seededCardId(), status: 'requires_confirmation', classification: null,
      candidatesJson: candidates, recommendedClassification: 'Outsource', outsourceSubtype: null,
      reasonCode: 'MULTIPLE_CANDIDATES', evaluatedTiersJson: evaluatedTiers,
      derivationResultId: null, isManualConfirmed: false,
    });
    expect(classificationResultRepo.findById(id)).toMatchObject({ candidates, evaluatedTiers, recommendedClassification: 'Outsource' });
    const raw = getDb().prepare('SELECT candidates_json, evaluated_tiers_json FROM commercial_classification_result WHERE id = ?').get(id);
    expect(JSON.parse(raw.candidates_json)).toEqual(candidates);
    expect(JSON.parse(raw.evaluated_tiers_json)).toEqual(evaluatedTiers);
  });
});