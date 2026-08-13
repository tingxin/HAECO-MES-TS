import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { arrangedSteps, cloneStepAggregate, insertAfter } from './process-arrangement.js';
import { generateProcessId } from './process-id.js';

// Feature: task-card-management, Property 38: insertion, copy isolation, and renumbering
// Validates: Requirements 52.1-52.5
describe('Property 38: process arrangement', () => {
  it('inserts after any step, deep-copies children, and emits A..Z/AA ids', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 60 }), fc.nat(), (count, rawIndex) => {
      const steps = Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
      const index = rawIndex % count;
      const inserted = insertAfter(steps, { id: 'new' }, steps[index].id);
      expect(inserted[index + 1].id).toBe('new');
      expect(inserted.map(({ seq }) => seq)).toEqual(inserted.map((_step, i) => i + 1));
      expect(inserted.map(({ processId }) => processId))
        .toEqual(inserted.map((_step, i) => generateProcessId(null, i + 1)));

      const source = { id: 1, cardId: 7, processId: 'A', seq: 1,
        components: [{ id: 2, stepId: 1, payload: { attachmentId: 9,
          annotations: [{ type: 'rect', points: [[0, 0], [1, 1]], color: 'red' }] } }],
        captureItems: [{ id: 3, stepId: 1, config: { value: 'x' } }],
        signatureRequirements: [{ id: 4, stepId: 1, signatureRole: 'QC' }] };
      const copy = cloneStepAggregate(source);
      copy.components[0].payload.annotations[0].color = 'blue';
      expect(source.components[0].payload.annotations[0].color).toBe('red');
      expect(copy.components[0].payload.attachmentId).toBe(9);
      expect(copy).not.toHaveProperty('id');
      expect(copy).not.toHaveProperty('cardId');
      expect(copy.components[0]).not.toHaveProperty('id');
      expect(copy.components[0]).not.toHaveProperty('stepId');
      expect(arrangedSteps([])).toEqual([]);
    }), { numRuns: 100 });
  });
});
