import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { filterAndPage, matchesAdvancedFilters } from './advanced-filter.js';

const skillArb = fc.constantFrom('GR', 'QC', 'NDT', 'TS');
const tokenArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0);

// Feature: task-card-management, Property 36: advanced aggregate filtering
// Validates: Requirements 50.1, 50.2, 50.7
describe('Property 36: advanced aggregate filtering', () => {
  it('uses OR within skills, same-step conjunction, and stable totals before paging', () => {
    fc.assert(fc.property(skillArb, skillArb, tokenArb, fc.integer({ min: 1, max: 8 }),
      (wanted, other, needle, pageSize) => {
        const cards = [
          { id: 1, steps: [{ skill: wanted, descriptionZh: `hit ${needle}` }] },
          { id: 2, steps: [{ skill: wanted, descriptionZh: 'different' }, { skill: other, descriptionZh: needle }] },
          { id: 3, steps: [{ skill: other, descriptionZh: `also ${needle}` }] },
        ];
        const filters = { processSkills: [wanted, 'NDT'], processDescription: needle };
        const normalizedNeedle = needle.trim().toLowerCase();
        const expected = cards.filter((card) => card.steps.some((step) =>
          filters.processSkills.includes(step.skill)
          && `${step.descriptionZh ?? ''} ${step.descriptionEn ?? ''}`.toLowerCase().includes(normalizedNeedle)));
        expect(cards.filter((card) => matchesAdvancedFilters(card, filters)).map(({ id }) => id))
          .toEqual(expected.map(({ id }) => id));
        const cmmCards = [
          { id: 11, documentType: 'CMM', refNo: `CMM-${needle.trim()}` },
          { id: 12, referenceDocuments: [{ docType: 'CMM', refNo: `REF-${needle.trim()}` }] },
          { id: 13, referenceDocuments: [{ docType: 'AMM', refNo: `REF-${needle.trim()}` }] },
        ];
        expect(cmmCards.filter((card) => matchesAdvancedFilters(card, { cmm: needle })).map(({ id }) => id))
          .toEqual([11, 12]);

        const first = filterAndPage(cards, filters, 1, pageSize);
        const second = filterAndPage(cards, filters, 2, pageSize);
        expect(first.total).toBe(expected.length);
        expect(second.total).toBe(expected.length);
        expect(new Set([...first.list, ...second.list].map(({ id }) => id)).size)
          .toBe(Math.min(expected.length, pageSize * 2));
      }), { numRuns: 100 });
  });
});
