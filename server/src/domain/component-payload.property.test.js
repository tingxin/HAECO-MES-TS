import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalizeComponentPayload, parseComponent, serializeComponent } from './collections.js';

const tokenArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const pointArb = fc.tuple(fc.integer(), fc.integer());

// Feature: task-card-management, Property 40: structured image/tool/consumable payload round-trip
// Validates: Requirements 54.1-54.7
describe('Property 40: structured component payloads', () => {
  it('round-trips annotations and structured rows and normalizes legacy single rows', () => {
    fc.assert(fc.property(tokenArb, tokenArb, fc.array(pointArb, { minLength: 1, maxLength: 8 }),
      (partNo, description, points) => {
        const payloads = {
          image: { attachmentId: 7, url: '/a/7', annotations: [
            { id: 'a', type: 'pen', points, color: '#abc' },
          ] },
          tool: { rows: [{ partNo, description }] },
          consumable: { rows: [{ partNo, description, qty: '2', category: 'EA' }] },
        };
        for (const [type, payload] of Object.entries(payloads)) {
          expect(parseComponent(serializeComponent({ stepId: 1, type, payload })).payload).toEqual(payload);
        }
        expect(normalizeComponentPayload('tool', { toolPn: partNo, toolDesc: description, qty: 9 }))
          .toEqual({ rows: [{ partNo, description }] });
        expect(normalizeComponentPayload('consumable', {
          materialNo: partNo, desc: description, qty: '2', unit: 'EA',
        })).toEqual({ rows: [{ partNo, description, qty: '2', category: 'EA' }] });
      }), { numRuns: 100 });
  });

  it('rejects inline images and annotations without coordinates', () => {
    fc.assert(fc.property(tokenArb, (value) => {
      expect(() => normalizeComponentPayload('image', { attachmentId: 1, dataUrl: value })).toThrow();
      expect(() => normalizeComponentPayload('image', { attachmentId: 1,
        originalImage: `data:image/png;base64,${value}` })).toThrow();
      expect(() => normalizeComponentPayload('image', { attachmentId: 1,
        annotations: [{ type: 'rect', color: value }] })).toThrow();
    }), { numRuns: 100 });
  });
});
