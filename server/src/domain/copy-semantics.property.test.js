import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  copyCard,
  reviseCard,
  COPY_RESET_FIELDS as CARD_COPY_RESET_FIELDS,
  INITIAL_REVISION as CARD_INITIAL_REVISION,
} from './card-rules.js';
import {
  copyExecDocument,
  COPY_RESET_FIELDS as DOC_COPY_RESET_FIELDS,
  EXEC_DOC_STATUS_NEW,
  INITIAL_REVISION as DOC_INITIAL_REVISION,
} from './exec-doc.js';
import { generateTaskNoBatch } from './task-no.js';
import { CARD_STATUS } from './enums.js';

/** 五态之首即「新增」，与 card-rules.js 内部私有的 STATUS_NEW 常量同值（未导出，故取自权威枚举）。 */
const CARD_STATUS_NEW = CARD_STATUS[0];

/* ══════════════════════════════════════════════════════════════════════════════
 * 生成器：两类实体的任意记录（键值对，字段为字符串/数字），复用于 6.7 与 6.8
 * ══════════════════════════════════════════════════════════════════════════════ */

const RESERVED_CARD_KEYS = ['id', 'task_no', 'status', 'revision', '__proto__', 'constructor', 'prototype'];
const RESERVED_DOC_KEYS = ['id', 'doc_no', 'status', 'revision', 'content', '__proto__', 'constructor', 'prototype'];

const scalarFieldArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

const extraFieldsArb = (reservedKeys) =>
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 10 }).filter((key) => !reservedKeys.includes(key)),
    scalarFieldArb,
    { maxKeys: 6 },
  );

/** 非空编号字符串（Task No / Doc No 均适用），避免空白串触发 copyCard/copyExecDocument 的形态拒绝。 */
const nonBlankIdArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.trim().length > 0);

/** 任意工卡记录：`id`/`task_no`/`status`/`revision` 固定字段 + 任意额外字符串/数字字段。 */
const cardArb = fc
  .record({
    id: fc.oneof(fc.integer({ min: 1 }), nonBlankIdArb),
    task_no: nonBlankIdArb,
    status: fc.constantFrom(...CARD_STATUS),
    revision: fc.integer({ min: 1, max: 50 }),
    extra: extraFieldsArb(RESERVED_CARD_KEYS),
  })
  .map(({ extra, ...rest }) => ({ ...rest, ...extra }));

/** 任意执行过程单据记录（含 SWS，`content` 为业务字段之一，随其余字段一并逐字段克隆比对）。 */
const execDocArb = fc
  .record({
    id: fc.oneof(fc.integer({ min: 1 }), nonBlankIdArb),
    doc_no: nonBlankIdArb,
    status: fc.constantFrom(...CARD_STATUS),
    revision: fc.integer({ min: 1, max: 50 }),
    content: fc.oneof(
      fc.string({ maxLength: 40 }), // 仓储层直读的 JSON 字符串形态
      fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), scalarFieldArb, { maxKeys: 4 }), // 已解析对象形态
    ),
    extra: extraFieldsArb(RESERVED_DOC_KEYS),
  })
  .map(({ extra, ...rest }) => ({ ...rest, ...extra }));

/* ══════════════════════════════════════════════════════════════════════════════
 * 6.7 → Property 3: 复制内容一致
 * ══════════════════════════════════════════════════════════════════════════════ */

// Feature: task-card-management, Property 3: 复制内容一致 — For any 工卡，`copyCard` 产出的副本除 `id`、`task_no`、`status`（置 New）、`revision`（置初始）外，其余业务字段与源工卡逐字段相等；源工卡保持不变。For any 执行过程单据实例（含 SWS，即 `exec_doc_type === "SW"`），`copyExecDocument` 产出的副本除 `id`、`doc_no`、`status`（置 New）、`revision`（置初始）外，`content` 与其余业务字段与源单据逐字段相等，源单据保持不变——即复制语义对两类实体一致。
describe('Property 3: 复制内容一致', () => {
  it('copyCard：除 COPY_RESET_FIELDS 外逐字段相等，源工卡不变，副本状态为 New 且版本为初始值', () => {
    fc.assert(
      fc.property(cardArb, nonBlankIdArb, (card, newTaskNo) => {
        const before = structuredClone(card);

        const copy = copyCard(card, newTaskNo);

        // 源工卡保持不变
        expect(card).toEqual(before);

        // 除 COPY_RESET_FIELDS 外逐字段相等
        for (const key of Object.keys(card)) {
          if (CARD_COPY_RESET_FIELDS.includes(key)) continue;
          expect(copy[key]).toEqual(card[key]);
        }

        expect(copy.status).toBe(CARD_STATUS_NEW);
        expect(copy.revision).toBe(CARD_INITIAL_REVISION);
      }),
      { numRuns: 100 },
    );
  });

  it('copyExecDocument：除 COPY_RESET_FIELDS 外逐字段相等（含 content），源单据不变，副本状态为 New 且版本为初始值', () => {
    fc.assert(
      fc.property(execDocArb, nonBlankIdArb, (doc, newDocNo) => {
        const before = structuredClone(doc);

        const copy = copyExecDocument(doc, newDocNo);

        // 源单据保持不变
        expect(doc).toEqual(before);

        // 除 COPY_RESET_FIELDS 外逐字段相等（含 content）
        for (const key of Object.keys(doc)) {
          if (DOC_COPY_RESET_FIELDS.includes(key)) continue;
          expect(copy[key]).toEqual(doc[key]);
        }

        expect(copy.status).toBe(EXEC_DOC_STATUS_NEW);
        expect(copy.revision).toBe(DOC_INITIAL_REVISION);
      }),
      { numRuns: 100 },
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 6.8 → Property 20: 复制/升版的编号与状态规则
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 编号生成规则（`task_no_sequence` / 通用编号规则同构，前后缀任意、起始序号与步长受限）。 */
const numberRuleArb = fc.record({
  prefix: fc.string({ maxLength: 4 }),
  suffix: fc.string({ maxLength: 4 }),
  next_seq: fc.integer({ min: 0, max: 500 }),
  step: fc.integer({ min: 1, max: 5 }),
});

const existingIdsArb = fc.uniqueArray(nonBlankIdArb, { maxLength: 15 });

// Feature: task-card-management, Property 20: 复制/升版的编号与状态规则 — For any 工卡：复制产出的副本 `task_no` 必与库中所有现存工卡不重复、版本号为初始版本、状态为「新增」（批量复制时按规则自动生成并跳过占用序号）；升版产出的新版本 `task_no` 与原工卡相同、版本号为原版本加一、状态为「新增」。For any 执行过程单据实例（含 SWS），其复制副本的 `doc_no` 必与现存单据不重复、版本号为初始版本、状态为「新增」——即编号与初始状态规则对两类实体一致。
describe('Property 20: 复制/升版的编号与状态规则', () => {
  it('copyCard/reviseCard：生成的新 task_no 不与现存冲突；复制状态为 New + 初始版本；升版编号不变、状态为 New', () => {
    fc.assert(
      fc.property(numberRuleArb, existingIdsArb, cardArb, (rule, existingTaskNos, card) => {
        // 现存集合须包含源工卡自身的编号，模拟真实的「与库中所有现存工卡不重复」口径
        const existing = [...new Set([...existingTaskNos, card.task_no])];

        const batch = generateTaskNoBatch(rule, existing, 1);
        const newTaskNo = batch.taskNos[0];

        // 生成的新编号不与现存工卡编号重复
        expect(existing.includes(newTaskNo)).toBe(false);

        const copy = copyCard(card, newTaskNo);
        expect(copy.task_no).toBe(newTaskNo);
        expect(copy.status).toBe(CARD_STATUS_NEW);
        expect(copy.revision).toBe(CARD_INITIAL_REVISION);

        const revised = reviseCard(card);
        // 升版：task_no 与原工卡相同、不变
        expect(revised.task_no).toBe(card.task_no);
        // 升版：状态为新增
        expect(revised.status).toBe(CARD_STATUS_NEW);
        // 升版：版本号为原版本加一（默认值）
        expect(revised.revision).toBe(card.revision + 1);
      }),
      { numRuns: 100 },
    );
  });

  it('copyExecDocument：生成的新 doc_no 不与现存冲突；副本状态为 New + 初始版本', () => {
    fc.assert(
      fc.property(numberRuleArb, existingIdsArb, execDocArb, (rule, existingDocNos, doc) => {
        const existing = [...new Set([...existingDocNos, doc.doc_no])];

        const batch = generateTaskNoBatch(rule, existing, 1);
        const newDocNo = batch.taskNos[0];

        // 生成的新编号不与现存单据编号重复
        expect(existing.includes(newDocNo)).toBe(false);

        const copy = copyExecDocument(doc, newDocNo);
        expect(copy.doc_no).toBe(newDocNo);
        expect(copy.status).toBe(EXEC_DOC_STATUS_NEW);
        expect(copy.revision).toBe(DOC_INITIAL_REVISION);
      }),
      { numRuns: 100 },
    );
  });
});
