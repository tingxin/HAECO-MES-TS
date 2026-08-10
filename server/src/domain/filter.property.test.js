import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { filterCards, matchesFilters } from './filter.js';

const statusArb = fc.constantFrom('New', 'UnderReview', 'Effective', 'Superseded', 'Void');
const cardArb = fc.record({
  id: fc.nat(),
  acType: fc.constantFrom('320', '330', '350'),
  taskNo: fc.stringMatching(/^TC-[A-Z0-9]{1,8}$/),
  gearType: fc.constantFrom('MLG', 'NLG', 'WLG'),
  title: fc.stringMatching(/^[A-Za-z0-9 ]{1,24}$/),
  status: statusArb,
  stage: fc.constantFrom('RTN', 'NRC', 'WFD'),
  cardType: fc.constantFrom('01', '04', '10', '11'),
});

const filterArb = fc.record({
  acType: fc.option(fc.constantFrom('320', '330', '350', '777'), { nil: undefined }),
  taskNo: fc.option(fc.stringMatching(/^[A-Z0-9]{1,4}$/), { nil: undefined }),
  gearType: fc.option(fc.constantFrom('MLG', 'NLG', 'WLG', 'N/A'), { nil: undefined }),
  title: fc.option(fc.stringMatching(/^[A-Za-z0-9]{1,4}$/), { nil: undefined }),
  status: fc.option(statusArb, { nil: undefined }),
  stage: fc.option(fc.constantFrom('RTN', 'NRC', 'WFD', 'CUS'), { nil: undefined }),
  cardType: fc.option(fc.constantFrom('01', '04', '10', '11', '99'), { nil: undefined }),
});

const FIELD_RULES = Object.freeze({
  acType: 'exact',
  taskNo: 'substring',
  gearType: 'exact',
  title: 'substring',
  status: 'exact',
  stage: 'exact',
  cardType: 'exact',
});

function oracleMatches(card, filters) {
  return Object.entries(FIELD_RULES).every(([field, mode]) => {
    const condition = filters[field];
    if (condition === undefined || condition === null || String(condition).trim() === '') return true;
    const actual = card[field];
    if (actual === undefined || actual === null) return false;
    const expected = String(condition).trim();
    return mode === 'substring'
      ? String(actual).toLowerCase().includes(expected.toLowerCase())
      : String(actual) === expected;
  });
}


const blankArb = fc.constantFrom(undefined, null, '', ' ', '  \t\n', []);

// Feature: task-card-management, Property 4: 筛选 AND 语义 —— For any 工卡集合与任意筛选条件，matchesFilters 结果中每条工卡都同时满足所有非空筛选条件；当所有条件为空时结果等于全集；无匹配时为空集。
describe('Property 4: 筛选 AND 语义', () => {
  it('集合结果恰等于同时满足全部非空维度的工卡，任一条件不满足即排除', () => {
    fc.assert(
      fc.property(
        fc.array(cardArb, { minLength: 0, maxLength: 40 }),
        filterArb,
        (cards, filters) => {
          const expected = cards.filter((card) => oracleMatches(card, filters));
          const actual = filterCards(cards, filters);

          expect(actual).toEqual(expected);
          for (const card of actual) {
            expect(oracleMatches(card, filters)).toBe(true);
            expect(matchesFilters(card, filters)).toBe(true);
          }
          for (const card of cards.filter((candidate) => !oracleMatches(candidate, filters))) {
            expect(matchesFilters(card, filters)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('所有条件均为空时返回完整输入集合并保持顺序', () => {
    fc.assert(
      fc.property(
        fc.array(cardArb, { minLength: 0, maxLength: 40 }),
        fc.record({
          acType: blankArb,
          taskNo: blankArb,
          gearType: blankArb,
          title: blankArb,
          status: blankArb,
          stage: blankArb,
          cardType: blankArb,
        }),
        (cards, filters) => {
          const result = filterCards(cards, filters);
          expect(result).toEqual(cards);
          expect(result).not.toBe(cards);
          for (const card of cards) expect(matchesFilters(card, filters)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('任一必不匹配的非空条件使结果为空，且状态条件参与同一 AND 组合', () => {
    fc.assert(
      fc.property(
        fc.array(cardArb, { minLength: 0, maxLength: 40 }),
        statusArb,
        (cards, status) => {
          const impossible = { status, taskNo: '__NO_TASK_CAN_CONTAIN_THIS__' };
          expect(filterCards(cards, impossible)).toEqual([]);
          for (const card of cards) expect(matchesFilters(card, impossible)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});