import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseComponent, serializeComponent } from './collections.js';
import { COMPONENT_TYPE } from './enums.js';

const jsonScalarArb = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.constant(null),
);

const metadataArb = fc.dictionary(
  fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'epsilon'),
  jsonScalarArb,
  { maxKeys: 5 },
);

const deepPayloadArb = fc.record({
  schema: fc.record({
    revision: fc.integer({ min: 0, max: 100 }),
    metadata: metadataArb,
    groups: fc.array(
      fc.record({
        label: fc.string({ maxLength: 20 }),
        values: fc.array(jsonScalarArb, { minLength: 1, maxLength: 6 }),
        flags: fc.record({ required: fc.boolean(), visible: fc.boolean() }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  }),
  rows: fc.array(fc.array(jsonScalarArb, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 4 }),
  extension: fc.record({
    nullable: jsonScalarArb,
    nested: fc.record({ codes: fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 }), note: fc.string({ maxLength: 30 }) }),
  }),
});

const payloadsForAllTypesArb = fc.tuple(...COMPONENT_TYPE.map(() => deepPayloadArb));
const stepBindingArb = fc.oneof(
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.string({ minLength: 1, maxLength: 16 }).filter((value) => value.trim().length > 0),
);

function expectRoundTrip(component, stepBinding, type, payload, sortOrder) {
  const before = structuredClone(component);
  const row = serializeComponent(component);
  const parsed = parseComponent(row);

  expect(component).toEqual(before);
  expect(row.step_id).toBe(stepBinding);
  expect(JSON.parse(row.payload)).toEqual(payload);
  expect(parsed.stepId).toBe(stepBinding);
  expect(parsed.type).toBe(type);
  expect(parsed.payload).toEqual(payload);
  expect(parsed.sortOrder).toBe(sortOrder);
}


// Feature: task-card-management, Property 12: 组件序列化往返 — For any 13 类 COMPONENT_TYPE 组件及其深层 JSON payload，serializeComponent 后再 parseComponent 与原 payload 深度等价，且无论输入使用 stepId 还是 step_id，所属工序绑定均保持不变。
describe('Property 12: 组件序列化往返', () => {
  it('全部 13 类组件的深层 payload 往返等价，并保持 stepId/step_id 工序绑定', () => {
    expect(COMPONENT_TYPE).toHaveLength(13);
    expect(new Set(COMPONENT_TYPE).size).toBe(13);

    fc.assert(
      fc.property(
        payloadsForAllTypesArb,
        stepBindingArb,
        fc.integer({ min: 0, max: 10_000 }),
        (payloads, stepBinding, sortOrder) => {
          const coveredTypes = [];

          COMPONENT_TYPE.forEach((type, index) => {
            const payload = payloads[index];
            coveredTypes.push(type);

            expectRoundTrip(
              { stepId: stepBinding, type, payload, sortOrder },
              stepBinding,
              type,
              payload,
              sortOrder,
            );
            expectRoundTrip(
              { step_id: stepBinding, type, payload, sort_order: sortOrder },
              stepBinding,
              type,
              payload,
              sortOrder,
            );
          });

          expect(coveredTypes).toEqual([...COMPONENT_TYPE]);
        },
      ),
      { numRuns: 100 },
    );
  });
});