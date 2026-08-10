import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aggregateBomBase, IR_CARD_TYPE, IR_LOT_CARD_TYPE, BOM_BASE_SOURCE } from './bom.js';

/** 非空、不含首尾空白、不含空白字符的短字符串（编号类字段），避免归一化产生歧义。 */
const codeArb = fc
  .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'.split('')), {
    minLength: 1,
    maxLength: 8,
  })
  .map((chars) => chars.join(''))
  .filter((s) => s.trim() !== '');

/** 单条 Lot List 关联的规格：自身 Lot Number / 引用 + 一组 Base 明细（字符串形态）。 */
const linkSpecArb = fc.record({
  lotNumber: codeArb,
  lotListRef: codeArb,
  bases: fc.array(codeArb, { maxLength: 4 }),
});

/** 单张工卡的规格：04（携带 base_number）或 05（携带若干 Lot List 关联）。 */
const cardSpecArb = fc.oneof(
  fc.record({
    type: fc.constant(IR_CARD_TYPE),
    taskNo: codeArb,
    taskTitle: codeArb,
    baseNumber: codeArb,
  }),
  fc.record({
    type: fc.constant(IR_LOT_CARD_TYPE),
    taskNo: codeArb,
    taskTitle: codeArb,
    links: fc.array(linkSpecArb, { maxLength: 3 }),
  }),
);

/** 工卡集合规格数组，最多 8 张，id 由数组下标 + 1 派生以保证唯一。 */
const cardSpecsArb = fc.array(cardSpecArb, { maxLength: 8 });

/** 将规格数组物化为 aggregateBomBase 的 `cards` / `lotLinks` 两个入参。 */
function materialize(specs) {
  const cards = specs.map((spec, index) => {
    const id = index + 1;
    if (spec.type === IR_CARD_TYPE) {
      return {
        id,
        task_no: spec.taskNo,
        title: spec.taskTitle,
        card_type: IR_CARD_TYPE,
        base_number: spec.baseNumber,
      };
    }
    return { id, task_no: spec.taskNo, title: spec.taskTitle, card_type: IR_LOT_CARD_TYPE };
  });

  const lotLinks = [];
  specs.forEach((spec, index) => {
    if (spec.type !== IR_LOT_CARD_TYPE) return;
    const cardId = index + 1;
    spec.links.forEach((link) => {
      lotLinks.push({
        card_id: cardId,
        lot_number: link.lotNumber,
        lot_list_ref: link.lotListRef,
        bases: [...link.bases],
      });
    });
  });

  return { cards, lotLinks };
}

/** 由规格数组独立构造「期望的两来源并集」（多重集，不去重），与 aggregateBomBase 的实现互不依赖。 */
function expectedRows(specs) {
  const rows = [];
  specs.forEach((spec, index) => {
    const cardId = index + 1;
    if (spec.type === IR_CARD_TYPE) {
      rows.push({
        cardId,
        taskNo: spec.taskNo,
        taskTitle: spec.taskTitle,
        baseNumber: spec.baseNumber,
        source: BOM_BASE_SOURCE.IR_CARD,
        lotNumber: null,
        lotListRef: null,
      });
      return;
    }
    spec.links.forEach((link) => {
      link.bases.forEach((baseNumber) => {
        rows.push({
          cardId,
          taskNo: spec.taskNo,
          taskTitle: spec.taskTitle,
          baseNumber,
          source: BOM_BASE_SOURCE.LOT_LIST,
          lotNumber: link.lotNumber,
          lotListRef: link.lotListRef,
        });
      });
    });
  });
  return rows;
}

/** 多重集比较：忽略顺序，但计数须一致（不去重，同内容行可重复出现）。 */
function asMultiset(rows) {
  return rows.map((r) => JSON.stringify(r)).sort();
}

// Feature: task-card-management, Property 30: For any 工卡集合，BOM List 输出的 Base Number 集合恒等于「类型 04 直接维护的 Base」与「类型 05 经 Lot List 带出的 Base」之并集；来源为 Lot List 的每个 Base 均携带其 Lot Number；Lot List 的 Base 集合变更后输出集合同步更新。
describe('Property 30: BOM Base 输出完整性', () => {
  it('输出恒等于「04 直接维护」∪「05 经 Lot List 带出」两来源并集（多重集，不去重，需求 48.1–48.5）', () => {
    fc.assert(
      fc.property(cardSpecsArb, (specs) => {
        const { cards, lotLinks } = materialize(specs);
        const actual = aggregateBomBase(cards, lotLinks);
        expect(asMultiset(actual)).toEqual(asMultiset(expectedRows(specs)));
      }),
      { numRuns: 100 },
    );
  });

  it('source==="lot_list" 恒携带非空 Lot Number；source==="ir_card" 恒不携带 Lot 信息（需求 48.6）', () => {
    fc.assert(
      fc.property(cardSpecsArb, (specs) => {
        const { cards, lotLinks } = materialize(specs);
        const rows = aggregateBomBase(cards, lotLinks);
        rows.forEach((row) => {
          if (row.source === BOM_BASE_SOURCE.LOT_LIST) {
            expect(row.lotNumber).not.toBeNull();
            expect(typeof row.lotNumber).toBe('string');
          } else {
            expect(row.source).toBe(BOM_BASE_SOURCE.IR_CARD);
            expect(row.lotNumber).toBeNull();
            expect(row.lotListRef).toBeNull();
          }
        });
      }),
      { numRuns: 100 },
    );
  });

  it('同一 05 卡的 Lot List Base 集合发生增删后，输出同步更新（纯投影、零缓存，需求 48.8）', () => {
    fc.assert(
      fc.property(
        codeArb,
        fc.array(codeArb, { minLength: 1, maxLength: 6 }),
        codeArb,
        codeArb,
        (newBase, bases, lotNumber, lotListRef) => {
          fc.pre(!bases.includes(newBase));

          const card = { id: 1, task_no: 'T', title: 'Title', card_type: IR_LOT_CARD_TYPE };
          const link = { card_id: 1, lot_number: lotNumber, lot_list_ref: lotListRef, bases };

          const before = aggregateBomBase([card], [link]);
          expect(before.map((r) => r.baseNumber)).toEqual(bases);

          // 新增一个此前不存在的 Base：输出同步纳入该 Base，其余不变
          const added = aggregateBomBase([card], [{ ...link, bases: [...bases, newBase] }]);
          expect(added.map((r) => r.baseNumber)).toEqual([...bases, newBase]);

          // 移除首个 Base：输出同步移除该 Base，其余不变
          const removed = aggregateBomBase([card], [{ ...link, bases: bases.slice(1) }]);
          expect(removed.map((r) => r.baseNumber)).toEqual(bases.slice(1));

          // 无状态性：同一入参重复调用得同一结果，不受此前调用（不同入参）影响
          expect(aggregateBomBase([card], [link])).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
