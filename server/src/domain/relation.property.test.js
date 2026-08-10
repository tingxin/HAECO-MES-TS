import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildRelation,
  addRelation,
  removeRelation,
  hasRelation,
  syncRelationKeyInfo,
  readKeyInfoSnapshot,
  requiredSignDocTypes,
  SIGN_RULE_REQUIRED,
} from './relation.js';
import { EXEC_DOC_TYPE, EXEC_DOC_SIGN_RULE } from './enums.js';
import { serializePayload } from './collections.js';

// Feature: task-card-management, Property 33: 工卡关联的完整性、自动建立与信息同步 —— For any Task Card 与任意关联操作序列：关联记录的 exec_doc_type 恒属于 11 类执行过程单据类型；新增后可从该 Task Card 查得、删除后不再查得且其它关联不受影响；同一 (card, exec_doc_type, related_doc_no) 三元组不重复。For any 执行期产生的衍生单据（PC / CR / TS 等），其与来源 Task Card 的关联恒被自动建立且 origin === "auto"，不需要人工关联动作。For any 关键信息（机型、件号、序列号、工卡编号）变更，变更后关联记录的 key_info_snapshot 恒与来源当前值一致。For any 工卡，其「要求签署的关联单据集合」恒等于关联中 exec_doc_type.sign_rule === "签署" 的子集。
describe('Property 33: 工卡关联的完整性、自动建立与信息同步', () => {
  // -------------------------------------------------------------------
  // 1. 类型封闭：buildRelation 只接受 11 类执行过程单据类型
  // -------------------------------------------------------------------
  it('1) exec_doc_type 越界（非 11 类之一）时 buildRelation 抛出 TypeError', () => {
    const bogusTypeArb = fc
      .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split('')), { minLength: 1, maxLength: 5 })
      .map((chars) => chars.join(''))
      .filter((s) => !EXEC_DOC_TYPE.includes(s));

    fc.assert(
      fc.property(bogusTypeArb, (bogusType) => {
        const card = { id: 1 };
        const doc = { exec_doc_type: bogusType, related_doc_no: 'D-1' };
        expect(() => buildRelation(card, doc)).toThrow(TypeError);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------
  // 2. 增删互不影响：新增后可查得，删除「另一条」后其它关联原值原序不受影响
  // -------------------------------------------------------------------
  const tripleArb = fc.record({
    card_id: fc.integer({ min: 1, max: 50 }),
    exec_doc_type: fc.constantFrom(...EXEC_DOC_TYPE),
    related_doc_no: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim() !== ''),
  });

  const addRemoveScenarioArb = fc
    .uniqueArray(tripleArb, {
      minLength: 3,
      maxLength: 8,
      selector: (t) => `${t.card_id}|${t.exec_doc_type}|${t.related_doc_no}`,
    })
    .chain((triples) =>
      fc.integer({ min: 0, max: triples.length - 2 }).map((removeIdx) => ({ triples, removeIdx })),
    );

  it('2) 新增一条后可查得；删除另一条后，其余原有关联仍可查得且值不变', () => {
    fc.assert(
      fc.property(addRemoveScenarioArb, ({ triples, removeIdx }) => {
        const relations = triples.map((t, i) => Object.freeze({ ...t, created_by: `U${i}` }));
        const base = relations.slice(0, -1);
        const extra = relations[relations.length - 1];
        const removedTarget = base[removeIdx];

        const afterAdd = addRelation(base, extra).relations;
        expect(hasRelation(afterAdd, extra)).toBe(true);

        const afterRemove = removeRelation(afterAdd, removedTarget).relations;

        // 被删除的那一条不再可查得
        expect(hasRelation(afterRemove, removedTarget)).toBe(false);
        // 新增的那一条不受删除影响
        expect(hasRelation(afterRemove, extra)).toBe(true);

        // 其余原有关联（除被删除者外）仍可查得，且值原封不变
        for (const relation of base) {
          if (relation === removedTarget) continue;
          expect(hasRelation(afterRemove, relation)).toBe(true);
          const found = afterRemove.find(
            (item) =>
              item.card_id === relation.card_id &&
              item.exec_doc_type === relation.exec_doc_type &&
              item.related_doc_no === relation.related_doc_no,
          );
          expect(found).toEqual(relation);
        }
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------
  // 3. 三元组不重复：同 (card_id, exec_doc_type, related_doc_no) 再次新增不产生重复条目
  // -------------------------------------------------------------------
  it('3) 同一三元组重复新增时 added===false 且集合中不产生重复条目', () => {
    fc.assert(
      fc.property(tripleArb, fc.string({ minLength: 1, maxLength: 4 }), (triple, otherField) => {
        const first = Object.freeze({ ...triple, created_by: 'ORIGINAL' });
        const duplicate = Object.freeze({ ...triple, created_by: `DUP-${otherField}` });

        const base = [first];
        const result = addRelation(base, duplicate);

        expect(result.added).toBe(false);
        expect(result.relations).toHaveLength(1);
        // 保留原有记录，不被重复的新记录覆盖
        expect(result.relations[0]).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------
  // 4. 执行期衍生单据自动建立关联：origin 恒为 'auto'；非衍生且无 job_id 时为 'manual'
  // -------------------------------------------------------------------
  const execPeriodDocArb = fc.record({
    exec_doc_type: fc.constantFrom('PC', 'CR', 'TS'),
    related_doc_no: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim() !== ''),
  });

  const jobBoundDocArb = fc.record({
    exec_doc_type: fc.constantFrom(...EXEC_DOC_TYPE),
    related_doc_no: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim() !== ''),
    job_id: fc.integer({ min: 1, max: 999 }),
  });

  const manualDocArb = fc.record({
    exec_doc_type: fc.constantFrom(...EXEC_DOC_TYPE.filter((c) => !['PC', 'CR', 'TS'].includes(c))),
    related_doc_no: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim() !== ''),
  });

  it('4a) PC/CR/TS 类型衍生单据，不显式传 origin 时 buildRelation 结果恒为 auto', () => {
    fc.assert(
      fc.property(execPeriodDocArb, (doc) => {
        const relation = buildRelation({ id: 1 }, doc);
        expect(relation.origin).toBe('auto');
      }),
      { numRuns: 100 },
    );
  });

  it('4b) 携带 job_id 的单据（任意类型），不显式传 origin 时 buildRelation 结果恒为 auto', () => {
    fc.assert(
      fc.property(jobBoundDocArb, (doc) => {
        const relation = buildRelation({ id: 1 }, doc);
        expect(relation.origin).toBe('auto');
      }),
      { numRuns: 100 },
    );
  });

  it('4c) 非 PC/CR/TS 且无 job_id 的单据，不显式传 origin 时 buildRelation 结果恒为 manual', () => {
    fc.assert(
      fc.property(manualDocArb, (doc) => {
        const relation = buildRelation({ id: 1 }, doc);
        expect(relation.origin).toBe('manual');
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------
  // 5. 关键信息快照同步：合并语义 —— keyInfo 出现的字段覆盖，未出现的字段保留原快照
  // -------------------------------------------------------------------
  const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
  const wordArb = fc
    .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 6 })
    .map((chars) => chars.join(''));
  const valueArb = fc.option(wordArb, { nil: null });
  const fieldScenarioArb = fc.record({
    previous: valueArb,
    include: fc.boolean(),
    updateValue: valueArb,
  });
  const KEY_INFO_NAMES = ['acType', 'partNo', 'serialNo', 'taskNo'];
  const syncScenarioArb = fc.record(
    Object.fromEntries(KEY_INFO_NAMES.map((name) => [name, fieldScenarioArb])),
  );

  it('5) syncRelationKeyInfo 的合并结果：出现的字段取新值，未出现的字段保留原快照值', () => {
    fc.assert(
      fc.property(syncScenarioArb, (scenario) => {
        const previousInfo = {};
        const keyInfoUpdate = {};
        for (const name of KEY_INFO_NAMES) {
          previousInfo[name] = scenario[name].previous;
          if (scenario[name].include) {
            keyInfoUpdate[name] = scenario[name].updateValue;
          }
        }

        const relation = {
          card_id: 1,
          exec_doc_type: 'CR',
          related_doc_no: 'D-1',
          key_info_snapshot: serializePayload(previousInfo),
        };

        const result = syncRelationKeyInfo(relation, keyInfoUpdate);
        const snapshot = readKeyInfoSnapshot(result);

        const expected = {};
        for (const name of KEY_INFO_NAMES) {
          expected[name] = scenario[name].include ? scenario[name].updateValue : scenario[name].previous;
        }

        expect(snapshot).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------
  // 6. 要求签署的单据类型集合：精确等于 '签署'，SC 恒不入选（即便其取值含"签署"子串）
  // -------------------------------------------------------------------
  const requiresSignFlagsArb = fc.record(
    Object.fromEntries(EXEC_DOC_TYPE.map((code) => [code, fc.boolean()])),
  );
  const presentCodesArb = fc.uniqueArray(fc.constantFrom(...EXEC_DOC_TYPE), {
    minLength: 1,
    maxLength: EXEC_DOC_TYPE.length,
  });

  it('6) requiredSignDocTypes 恰好返回 present 且 sign_rule 精确等于「签署」的类型；SC 恒排除', () => {
    fc.assert(
      fc.property(requiresSignFlagsArb, presentCodesArb, (flags, presentCodes) => {
        const signRuleCfg = {};
        for (const code of EXEC_DOC_TYPE) {
          if (code === 'SC') {
            // SC 的取值字面包含"签署"二字，但不精确等于该值（需求 16.5）
            signRuleCfg[code] = EXEC_DOC_SIGN_RULE.SC;
          } else {
            signRuleCfg[code] = flags[code] ? SIGN_RULE_REQUIRED : 'N/A';
          }
        }

        const result = requiredSignDocTypes(presentCodes, signRuleCfg);

        const expected = EXEC_DOC_TYPE.filter(
          (code) => presentCodes.includes(code) && signRuleCfg[code] === SIGN_RULE_REQUIRED,
        );

        expect(result).toEqual(expected);
        expect(result).not.toContain('SC');
      }),
      { numRuns: 100 },
    );
  });
});
