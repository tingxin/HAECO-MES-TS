import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  migrateRecords,
  FAILURE_CATEGORY,
  RECORD_STATUS,
} from './migrate-card.js';

const STAGE_CFG = Object.freeze({
  constraints: [{ card_type: '01', allowed_stage: 'RTN', is_auto_fill: 1 }],
  crosscut: ['NRC'],
});

const rowKindArb = fc.constantFrom('valid', 'required', 'enum', 'stage', 'duplicate');
const suffixArb = fc.stringMatching(/^[A-Z0-9]{1,8}$/);

function buildCaseRows(kinds, suffix) {
  const existingCards = [];
  const rows = kinds.map((kind, index) => {
    const taskNo = kind === 'duplicate' ? `EXISTING-${index}-${suffix}` : `LEGACY-${index}-${suffix}`;
    const row = {
      task_no: taskNo,
      title: `Legacy title ${index}`,
      card_type: '01',
      ac_type: '320',
      stage: 'NRC',
      revision: 1,
      source_payload: { row: index },
    };
    if (kind === 'required') row.title = '   ';
    if (kind === 'enum') row.ac_type = 'INVALID-AC';
    if (kind === 'stage') row.stage = 'MOD';
    if (kind === 'duplicate') existingCards.push({ task_no: taskNo, revision: 1 });
    return row;
  });
  return { rows, existingCards };
}

const CATEGORY_BY_KIND = Object.freeze({
  required: FAILURE_CATEGORY.REQUIRED_MISSING,
  enum: FAILURE_CATEGORY.ENUM_INVALID,
  stage: FAILURE_CATEGORY.STAGE_CARD_TYPE_INVALID,
  duplicate: FAILURE_CATEGORY.DUPLICATE_TASK_NO,
});


// Feature: task-card-management, Property 32: 迁移失败隔离与报告完备性 —— For any 迁移记录集合，校验失败的记录被跳过且不阻断其余记录处理；成功记录状态置「新增」并保留原命名规则；迁移报告中成功条数与失败条数之和恒等于输入记录总数，且每条失败均带失败原因。
describe('Property 32: 迁移失败隔离与报告完备性', () => {
  it('逐条结果与输入一一对应，报告计数完整，失败有分类和原因，成功保持原编号并置 New', () => {
    fc.assert(
      fc.property(
        fc.array(rowKindArb, { minLength: 0, maxLength: 30 }),
        suffixArb,
        (kinds, suffix) => {
          const { rows, existingCards } = buildCaseRows(kinds, suffix);
          const inputSnapshot = JSON.stringify(rows);
          const report = migrateRecords(rows, existingCards, STAGE_CFG);

          expect(report.totalCount).toBe(rows.length);
          expect(report.records).toHaveLength(rows.length);
          expect(report.successCount + report.failureCount).toBe(rows.length);
          expect(report.records.map((record) => record.rowNo))
            .toEqual(rows.map((_, index) => index + 1));

          const expectedCategoryCounts = Object.fromEntries(
            Object.values(FAILURE_CATEGORY).map((category) => [category, 0]),
          );

          report.records.forEach((record, index) => {
            const kind = kinds[index];
            if (kind === 'valid') {
              expect(record.status).toBe(RECORD_STATUS.SUCCESS);
              expect(record.failureCategory).toBeNull();
              expect(record.reason).toBeNull();
              expect(record.card).not.toBeNull();
              expect(record.card.status).toBe('New');
              expect(record.card.task_no).toBe(rows[index].task_no);
              expect(record.card.naming_rule_origin).toBe(rows[index].task_no);
              expect(record.card.source_payload).toEqual(rows[index].source_payload);
            } else {
              const category = CATEGORY_BY_KIND[kind];
              expectedCategoryCounts[category] += 1;
              expect(record.status).toBe(RECORD_STATUS.FAILED);
              expect(record.card).toBeNull();
              expect(record.failureCategory).toBe(category);
              expect(typeof record.reason).toBe('string');
              expect(record.reason.trim().length).toBeGreaterThan(0);
            }
          });

          expect(report.byCategory).toEqual(expectedCategoryCounts);
          expect(JSON.stringify(rows)).toBe(inputSnapshot);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('在任意有效行之前插入失败行不改变全部有效行的迁移结果', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        suffixArb,
        (insertFailure, suffix) => {
          const validRows = insertFailure.map((_, index) => ({
            task_no: `LEGACY-ISOLATED-${index}-${suffix}`,
            title: `Valid ${index}`,
            card_type: '01',
            stage: 'NRC',
            payload: { index },
          }));
          const mixedRows = validRows.flatMap((row, index) => (
            insertFailure[index]
              ? [{ ...row, task_no: `BROKEN-${index}-${suffix}`, title: '' }, row]
              : [row]
          ));

          const baseline = migrateRecords(validRows, [], STAGE_CFG);
          const mixed = migrateRecords(mixedRows, [], STAGE_CFG);
          const successfulCards = mixed.records
            .filter((record) => record.status === RECORD_STATUS.SUCCESS)
            .map((record) => record.card);

          expect(successfulCards).toEqual(baseline.records.map((record) => record.card));
          expect(mixed.successCount).toBe(validRows.length);
          expect(mixed.failureCount).toBe(insertFailure.filter(Boolean).length);
          expect(mixed.successCount + mixed.failureCount).toBe(mixedRows.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});