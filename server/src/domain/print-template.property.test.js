import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { CARD_TYPE_CODES, EXEC_DOC_TYPE } from './enums.js';
import { printProjection } from './card-rules.js';
import {
  selectPrintTemplate,
  TEMPLATE_MATCH,
  TEMPLATE_TARGET_KIND,
} from './print-template.js';

const targetArb = fc.oneof(
  fc.constantFrom(...CARD_TYPE_CODES).map((code) => ({
    kind: TEMPLATE_TARGET_KIND.CARD_TYPE,
    code,
    entity: { card_type: code },
  })),
  fc.constantFrom(...EXEC_DOC_TYPE).map((code) => ({
    kind: TEMPLATE_TARGET_KIND.EXEC_DOC_TYPE,
    code,
    entity: { exec_doc_type: code },
  })),
);

const bodyArb = fc.string({ maxLength: 40 });
const template = (id, kind, code, body, isDefault = 0) => ({
  id,
  target_kind: kind,
  target_code: code,
  template_body: body,
  is_default: isDefault,
});

const MINIMUM_FIELDS = Object.freeze([
  'organizationName', 'taskNo', 'title', 'referenceDocuments', 'revisionLabel',
  'date', 'acType', 'gearType', 'partNo', 'manHours', 'startTime', 'finishTime', 'steps',
]);

const printableCardArb = fc.record({
  task_no: fc.stringMatching(/^TC-[A-Z0-9]{1,8}$/),
  title: fc.string({ maxLength: 30 }),
  revision: fc.integer({ min: 1, max: 99 }),
  card_type: fc.constantFrom(...CARD_TYPE_CODES),
  ac_type: fc.constantFrom('320', '330', '350'),
  gear_type: fc.constantFrom('MLG', 'NLG', 'WLG'),
  date: fc.date({ noInvalidDate: true }).map((value) => value.toISOString().slice(0, 10)),
});


function otherCode(kind, code) {
  const codes = kind === TEMPLATE_TARGET_KIND.CARD_TYPE ? CARD_TYPE_CODES : EXEC_DOC_TYPE;
  return codes.find((candidate) => candidate !== code);
}

function oppositeKind(kind) {
  return kind === TEMPLATE_TARGET_KIND.CARD_TYPE
    ? TEMPLATE_TARGET_KIND.EXEC_DOC_TYPE
    : TEMPLATE_TARGET_KIND.CARD_TYPE;
}

// Feature: task-card-management, Property 22: 打印模板选用与分类隐藏 —— For any 工卡，打印时选用与其类型匹配的模板；无专属模板时选用默认模板；无论选用哪个模板，输出字段集合均不含 card_type 且均含最小信息集字段。
describe('Property 22: 打印模板选用与分类隐藏', () => {
  it('工卡与执行过程单据均精确选中同类目、同类型的专属模板', () => {
    fc.assert(
      fc.property(targetArb, bodyArb, bodyArb, (target, selectedBody, decoyBody) => {
        const templates = [
          template(101, target.kind, otherCode(target.kind, target.code), decoyBody),
          template(102, oppositeKind(target.kind), target.code, decoyBody, 1),
          template(103, target.kind, target.code, selectedBody),
        ];
        const result = selectPrintTemplate(target.entity, templates);

        expect(result.matchLevel).toBe(TEMPLATE_MATCH.EXACT);
        expect(result.isFallback).toBe(false);
        expect(result.templateId).toBe(103);
        expect(result.templateBody).toBe(selectedBody);
        expect(result.matchedKind).toBe(target.kind);
        expect(result.matchedCode).toBe(target.code);
      }),
      { numRuns: 100 },
    );
  });

  it('无专属模板时选用同类目默认模板；同类目无模板时选用全局默认模板', () => {
    fc.assert(
      fc.property(targetArb, bodyArb, fc.boolean(), (target, defaultBody, hasSameKindDefault) => {
        const defaultKind = hasSameKindDefault ? target.kind : oppositeKind(target.kind);
        const templates = [
          template(201, defaultKind, '*', defaultBody, 1),
          template(202, oppositeKind(defaultKind), otherCode(oppositeKind(defaultKind), target.code), 'decoy'),
        ];
        const result = selectPrintTemplate(target.entity, templates);

        expect(result.templateId).toBe(201);
        expect(result.templateBody).toBe(defaultBody);
        expect(result.isFallback).toBe(true);
        expect(result.matchLevel).toBe(
          hasSameKindDefault ? TEMPLATE_MATCH.KIND_DEFAULT : TEMPLATE_MATCH.GLOBAL_DEFAULT,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('无论选中专属或默认模板，打印模型都隐藏分类并完整保留最小信息集字段', () => {
    fc.assert(
      fc.property(printableCardArb, bodyArb, fc.boolean(), (card, body, hasExact) => {
        const templates = hasExact
          ? [template(301, TEMPLATE_TARGET_KIND.CARD_TYPE, card.card_type, body)]
          : [template(302, TEMPLATE_TARGET_KIND.CARD_TYPE, '*', body, 1)];
        const selected = selectPrintTemplate(card, templates);
        const model = printProjection({ ...card, steps: [], reference_documents: [] }, selected);

        expect(selected.template).not.toBeNull();
        expect(selected.matchLevel).toBe(hasExact ? TEMPLATE_MATCH.EXACT : TEMPLATE_MATCH.KIND_DEFAULT);
        expect(Object.prototype.hasOwnProperty.call(model, 'card_type')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(model, 'cardType')).toBe(false);
        for (const field of MINIMUM_FIELDS) {
          expect(Object.prototype.hasOwnProperty.call(model, field)).toBe(true);
        }
        expect(model.taskNo).toBe(card.task_no);
        expect(model.title).toBe(card.title);
        expect(model.steps).toEqual([]);
        expect(model.referenceDocuments).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});