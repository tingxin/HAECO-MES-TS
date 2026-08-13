import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { diffVersionSnapshots, immutableVersionSnapshot } from './version-history.js';

const tokenArb = fc.string({ maxLength: 20 });

// Feature: task-card-management, Property 37: immutable version snapshots and deterministic diff
// Validates: Requirements 51.1-51.5
describe('Property 37: version history', () => {
  it('deep-freezes snapshots and deterministically compares the direct predecessor', () => {
    fc.assert(fc.property(tokenArb, tokenArb, (beforeTitle, afterTitle) => {
      const previous = immutableVersionSnapshot({
        id: 1, revision: 1, title: beforeTitle,
        referenceDocuments: [{ id: 1, docType: 'CMM', refNo: 'A', docRevision: '1' }],
        steps: [{ id: 1, processId: 'A', descriptionZh: beforeTitle,
          components: [{ payload: { nested: [beforeTitle] } }] }],
      });
      const selected = immutableVersionSnapshot({
        id: 2, revision: 2, title: afterTitle,
        referenceDocuments: [{ id: 2, docType: 'CMM', refNo: 'A', docRevision: '2' }],
        steps: [{ id: 2, processId: 'A', descriptionZh: afterTitle,
          components: [{ payload: { nested: [afterTitle] } }] }],
      });
      expect(Object.isFrozen(previous.steps[0].components[0].payload)).toBe(true);
      const first = diffVersionSnapshots(previous, selected);
      expect(diffVersionSnapshots(previous, selected)).toEqual(first);
      expect(first.steps.changed.length).toBe(beforeTitle === afterTitle ? 0 : 1);
      expect(diffVersionSnapshots(null, previous)).toEqual({
        headerChanges: [], referenceDocuments: { added: [], removed: [], changed: [] },
        steps: { added: [], removed: [], changed: [] },
      });
    }), { numRuns: 100 });
  });
});
