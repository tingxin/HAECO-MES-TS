import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyImportMode, mapSimplifiedRows } from './process-import.js';

const textArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

// Feature: task-card-management, Property 39: import mode semantics and newline preservation
// Validates: Requirements 53.1-53.7
describe('Property 39: simplified process import', () => {
  it('maps two columns, preserves newlines, and implements append/replace exactly', () => {
    fc.assert(fc.property(fc.array(textArb, { maxLength: 8 }),
      fc.array(fc.tuple(textArb, textArb), { minLength: 1, maxLength: 8 }),
      (existing, values) => {
        const rows = values.map(([step, inspection]) => [`${step}\nnext`, `${inspection}\nvalue`]);
        const imported = mapSimplifiedRows(rows);
        expect(imported.map(({ descriptionZh }) => descriptionZh))
          .toEqual(rows.map(([step]) => step));
        expect(imported.map(({ captureItems }) => captureItems[0].config.value))
          .toEqual(rows.map(([, inspection]) => inspection));
        expect(applyImportMode(existing, imported, 'append')).toEqual([...existing, ...imported]);
        expect(applyImportMode(existing, imported, 'replace')).toEqual(imported);
      }), { numRuns: 100 });
  });

  it('rejects empty or invalid rows without mutating input', () => {
    fc.assert(fc.property(fc.array(textArb, { maxLength: 8 }), (existing) => {
      const before = structuredClone(existing);
      expect(() => mapSimplifiedRows([])).toThrow();
      expect(() => mapSimplifiedRows([[null, 'inspection only']])).toThrow();
      expect(existing).toEqual(before);
    }), { numRuns: 100 });
  });
});
