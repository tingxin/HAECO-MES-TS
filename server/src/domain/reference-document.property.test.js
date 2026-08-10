import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  addReferenceDocument,
  hasReferenceDocument,
  normalizeReferenceDocument,
  referenceDocumentKey,
  removeReferenceDocument,
} from './collections.js';

const textOrNullArb = fc.oneof(fc.string({ maxLength: 20 }), fc.constant(null));
const idArb = fc.oneof(
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.constant(null),
);

const referenceDocumentArb = fc.record({
  id: idArb,
  cardId: fc.oneof(fc.integer({ min: 1, max: 10_000 }), fc.string({ minLength: 1, maxLength: 8 })),
  docType: textOrNullArb,
  refNo: textOrNullArb,
  docRevision: textOrNullArb,
  ataChapter: textOrNullArb,
});

const existingEntryArb = fc.record({
  id: idArb,
  cardId: fc.integer({ min: 1, max: 10_000 }),
  docType: textOrNullArb,
  refNo: textOrNullArb,
  docRevision: textOrNullArb,
  ataChapter: textOrNullArb,
  unrelatedMetadata: fc.record({ marker: fc.string({ maxLength: 12 }), flags: fc.array(fc.boolean(), { maxLength: 4 }) }),
});

// Feature: task-card-management, Property 9: 参考文件集合完整性 — For any 参考文件集合，新增文件后集合包含该文件且所有原条目原值原序保留；删除文件后所有同身份条目均不再存在，所有无关条目原值原序保留；一张工卡可关联多条参考文件且操作不修改输入集合。
describe('Property 9: 参考文件集合完整性', () => {
  it('新增在末尾追加归一化条目，完整保留所有原条目且不修改输入集合', () => {
    fc.assert(
      fc.property(fc.array(existingEntryArb, { maxLength: 20 }), referenceDocumentArb, (documents, added) => {
        const before = structuredClone(documents);
        const result = addReferenceDocument(documents, added);

        expect(documents).toEqual(before);
        expect(result).toHaveLength(documents.length + 1);
        expect(result.slice(0, -1)).toEqual(documents);
        expect(result.at(-1)).toEqual(normalizeReferenceDocument(added));
        expect(hasReferenceDocument(result, added)).toBe(true);
        expect(Object.isFrozen(result)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });


  it('删除所有同身份条目，完整保留无关条目的原值原序且不修改输入集合', () => {
    fc.assert(
      fc.property(
        fc.array(existingEntryArb, { minLength: 1, maxLength: 20 }),
        fc.nat(),
        (documents, targetIndex) => {
          const before = structuredClone(documents);
          const target = documents[targetIndex % documents.length];
          const targetKey = referenceDocumentKey(target);
          const expectedUnrelated = documents.filter((document) => referenceDocumentKey(document) !== targetKey);
          const expectedRemoved = documents.length - expectedUnrelated.length;

          const result = removeReferenceDocument(documents, target);

          expect(documents).toEqual(before);
          expect(result.removed).toBe(expectedRemoved);
          expect(result.list).toEqual(expectedUnrelated);
          expect(hasReferenceDocument(result.list, target)).toBe(false);
          expect(Object.isFrozen(result)).toBe(true);
          expect(Object.isFrozen(result.list)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('集合允许重复关联；删除按身份移除全部匹配项而不影响其它文件', () => {
    fc.assert(
      fc.property(referenceDocumentArb, referenceDocumentArb, (document, unrelated) => {
        fc.pre(referenceDocumentKey(document) !== referenceDocumentKey(unrelated));
        const withDuplicate = addReferenceDocument(
          addReferenceDocument(addReferenceDocument([], unrelated), document),
          document,
        );

        expect(withDuplicate).toHaveLength(3);
        expect(withDuplicate.filter((item) => referenceDocumentKey(item) === referenceDocumentKey(document))).toHaveLength(2);

        const result = removeReferenceDocument(withDuplicate, document);
        expect(result.removed).toBe(2);
        expect(result.list).toEqual([normalizeReferenceDocument(unrelated)]);
      }),
      { numRuns: 100 },
    );
  });
});