import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ENUMS, SKILL, CTRL_CODE, isValidEnumValue } from './enums.js';

const FIELDS = Object.keys(ENUMS);

/** 全部值域取值的并集 —— 用于生成「属于别的值域但不属于本字段」的越界候选 */
const ALL_ENUM_VALUES = [...new Set(FIELDS.flatMap((field) => [...ENUMS[field]]))];

const toSnake = (field) => field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** 同一字段的三种等价写法（camelCase / snake_case / SCREAMING_SNAKE），归一化后判定须一致 */
const fieldAliases = (field) => [field, toSnake(field), toSnake(field).toUpperCase()];

/** 集合内候选 */
const inSetArb = (field) => fc.constantFrom(...ENUMS[field]);

/**
 * 集合外候选：其它值域取值（含 Skill × Ctrl Code 交叉）、大小写/空白/尾缀变形、
 * 任意字符串，以及非字符串取值；统一过滤掉落回本值域的取值。
 */
const outOfSetArb = (field) => {
  const values = ENUMS[field];
  const stringy = fc
    .oneof(
      fc.constantFrom(...ALL_ENUM_VALUES),
      fc.constantFrom(...values).map((v) => v.toLowerCase()),
      fc.constantFrom(...values).map((v) => v.toUpperCase()),
      fc.constantFrom(...values).map((v) => ` ${v} `),
      fc.constantFrom(...values).map((v) => `${v}X`),
      fc.string(),
    )
    .filter((v) => !values.includes(v));
  const nonString = fc.oneof(
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.constant({}),
    fc.array(fc.string()),
  );
  return fc.oneof(stringy, nonString);
};

/** 对称差：仅属于一侧的码 —— 两值域独立时，判定结果必然一真一假 */
const SYMMETRIC_DIFFERENCE = [
  ...SKILL.filter((v) => !CTRL_CODE.includes(v)),
  ...CTRL_CODE.filter((v) => !SKILL.includes(v)),
];

/** 交集：同码不同义（AS、CL），两侧各自为真 */
const INTERSECTION = SKILL.filter((v) => CTRL_CODE.includes(v));

// Feature: task-card-management, Property 5: 枚举封闭性与值域独立 —— For any 枚举字段（A/C Type、Gear Type、Stage、Skill、Ctrl Code、工卡类型、执行单据类型、商务分类、签署角色、角色）及任意候选值，`isValidEnumValue(field, value)` 为真当且仅当该值属于对应集合；且 Ctrl Code 与 Skill 判定互不影响（同码不同义，不共用字典）。
describe('Property 5: 枚举封闭性与值域独立', () => {
  it('判定为真当且仅当候选值属于该字段的值域（双向）', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIELDS).chain((field) =>
          fc.tuple(
            fc.constant(field),
            fc.constantFrom(...fieldAliases(field)),
            fc.oneof(inSetArb(field), outOfSetArb(field)),
          ),
        ),
        ([field, alias, value]) => {
          const expected = typeof value === 'string' && ENUMS[field].includes(value);
          expect(isValidEnumValue(alias, value)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Ctrl Code 与 Skill 判定互不影响（值域独立，不共用字典）', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SYMMETRIC_DIFFERENCE), (value) => {
        const asSkill = isValidEnumValue('skill', value);
        const asCtrlCode = isValidEnumValue('ctrlCode', value);
        expect(asSkill).toBe(SKILL.includes(value));
        expect(asCtrlCode).toBe(CTRL_CODE.includes(value));
        // 对称差中的码恰有一侧为真：任一侧扩张至另一侧即判定失败
        expect(asSkill !== asCtrlCode).toBe(true);
      }),
      { numRuns: 100 },
    );

    // 需求 6.10 的具体化：GR 属 Skill、不属 Ctrl Code
    expect(isValidEnumValue('ctrlCode', 'GR')).toBe(false);
    expect(isValidEnumValue('skill', 'GR')).toBe(true);

    // 交集（AS、CL）同码不同义：两侧各自为真，但不因此共享其余取值
    for (const value of INTERSECTION) {
      expect(isValidEnumValue('skill', value)).toBe(true);
      expect(isValidEnumValue('ctrlCode', value)).toBe(true);
    }
  });
});
