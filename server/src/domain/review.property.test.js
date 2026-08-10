import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { submitReviewChecklist, canApprove } from './review.js';
import { AC_TYPE } from './enums.js';

/**
 * 一张各校验项均能通过的"黄金"工卡 + ctx（与 review.unit.test.js 的黄金路径一致），
 * 供 Property 19 的各分支增量破坏单项校验。
 */
function goldenCard() {
  return {
    id: 1,
    task_no: 'TN-0001',
    revision: 1,
    title: 'Test Card',
    date: '2024-06-01',
    ac_type: '320',
    gear_type: 'MLG',
    stage: 'RTN',
    skill: 'GR',
    ctrl_code: 'AS',
    card_type: '01',
    status: 'New',
    created_by: 'E001',
  };
}

function goldenCtx() {
  return {
    cards: [],
    orgName: 'HAECO',
    referenceDocuments: [{ id: 1, doc_type: 'DWG', ref_no: 'REF-1' }],
    steps: [
      {
        id: 10,
        process_id: 'A',
        signatureRequirements: [{ id: 100, signature_role: 'Operator' }],
      },
    ],
    capabilityList: [
      { ac_type: '320', gear_type: 'MLG', skill: 'GR', revision: 1, effective_from: '2020-01-01', effective_to: null },
    ],
    onDate: '2024-06-01',
    changeReason: '首次编制',
    relations: [],
    signRuleCfg: undefined,
    stageConstraintCfg: {
      constraints: [{ card_type: '01', allowed_stage: 'RTN', is_auto_fill: 1 }],
    },
  };
}

// ---------------------------------------------------------------------------
// (a)-(g) 各自的"破坏一项、保持其余六项黄金"生成器
// ---------------------------------------------------------------------------

/** (a) 查重：ctx.cards 中放入一个不同 id 但相同 task_no/revision 的工卡。 */
const breakA = fc.integer({ min: 2, max: 100000 }).map((otherId) => {
  const card = goldenCard();
  const ctx = goldenCtx();
  ctx.cards = [{ id: otherId, task_no: card.task_no, revision: card.revision }];
  return { letter: 'a', card, ctx };
});

/**
 * (b) 枚举：将 6 个绑定于黄金卡自身的枚举字段之一置为非法取值。
 * `ZZ_` 前缀保证不与任一枚举值域（AC_TYPE/GEAR_TYPE/STAGE/SKILL/CTRL_CODE/CARD_TYPE_CODES）
 * 的既有取值重合，从而稳定触发 INVALID_ENUM_VALUE。
 */
const enumFieldArb = fc.constantFrom('ac_type', 'gear_type', 'stage', 'skill', 'ctrl_code', 'card_type');
const breakB = fc.tuple(enumFieldArb, fc.string({ minLength: 1, maxLength: 8 })).map(([field, suffix]) => {
  const card = goldenCard();
  const ctx = goldenCtx();
  card[field] = `ZZ_${suffix}`;
  return { letter: 'b', card, ctx };
});

/**
 * (c) 必填：随机选择一个必填项分支破坏之——组织名称/标题为空白，或参考文件/工序集合为空。
 */
const breakC = fc.oneof(
  fc.constantFrom('', '   ', '\u3000').map((blank) => {
    const card = goldenCard();
    const ctx = goldenCtx();
    ctx.orgName = blank;
    return { letter: 'c', card, ctx };
  }),
  fc.constantFrom('', '   ', '\u3000').map((blank) => {
    const card = goldenCard();
    const ctx = goldenCtx();
    card.title = blank;
    return { letter: 'c', card, ctx };
  }),
  fc.constant(null).map(() => {
    const card = goldenCard();
    const ctx = goldenCtx();
    ctx.referenceDocuments = [];
    return { letter: 'c', card, ctx };
  }),
);

/**
 * (d) 能力清单：清单为空（NO_EFFECTIVE_REVISION）或存在但机型与黄金卡不匹配。
 */
const breakD = fc.oneof(
  fc.constant([]).map((capabilityList) => {
    const card = goldenCard();
    const ctx = goldenCtx();
    ctx.capabilityList = capabilityList;
    return { letter: 'd', card, ctx };
  }),
  fc.constantFrom(...AC_TYPE.filter((v) => v !== '320')).map((mismatchAcType) => {
    const card = goldenCard();
    const ctx = goldenCtx();
    ctx.capabilityList = [
      {
        ac_type: mismatchAcType,
        gear_type: card.gear_type,
        skill: card.skill,
        revision: 1,
        effective_from: '2020-01-01',
        effective_to: null,
      },
    ];
    return { letter: 'd', card, ctx };
  }),
);

/** (e) 变更原因：为空或纯空白。 */
const breakE = fc.constantFrom('', '   ', '\u3000').map((blank) => {
  const card = goldenCard();
  const ctx = goldenCtx();
  ctx.changeReason = blank;
  return { letter: 'e', card, ctx };
});

/**
 * (f) 签署项配置：关联单据存在要求"签署"的类型（CR），而工卡下全部工序聚合签署项为空。
 *
 * ⚠ 范围说明：`checkSignatureConfigItem` 与 `checkRequiredItem`（(c) 的签署项≥1 项分支）
 * 共用同一份 `ctx.steps` 签署项聚合结果——在本实现下，触发 (f) 未通过（聚合数=0）必然同时
 * 使 (c) 的"签署项（至少 1 项）"分支未通过，这是 review.js 现有实现的固有耦合，非本测试的
 * 生成器缺陷。故本分支仅断言 'f' 出现在 failedChecks 中（核心断言），不要求其余 6 项独立通过。
 */
const breakF = fc.constant(null).map(() => {
  const card = goldenCard();
  const ctx = goldenCtx();
  ctx.relations = [{ card_id: card.id, exec_doc_type: 'CR', related_doc_no: 'CR-1' }];
  ctx.steps = [{ id: 10, process_id: 'A' }]; // 无签署项配置 → 聚合数为 0
  return { letter: 'f', card, ctx };
});

/**
 * (g) Stage×工卡类型组合：黄金 `stageConstraintCfg` 仅允许 `card_type='01'` 搭配 `RTN`；
 * 取既非 RTN、也非运行时横切取值（DMY/NRC/WCC/WFD）的 Stage，保证落在"组合不允许"分支
 * 而非被横切取值放行。
 */
const breakG = fc.constantFrom('CUS', 'MOD', 'SPC').map((stage) => {
  const card = goldenCard();
  const ctx = goldenCtx();
  card.stage = stage;
  return { letter: 'g', card, ctx };
});

const breakOneCheckArb = fc.oneof(breakA, breakB, breakC, breakD, breakE, breakF, breakG);

// Feature: task-card-management, Property 19: 提交审核校验完备性与审核记录归档 —— For any 工卡，其可进入「审核中」当且仅当校验清单 (a) 查重、(b) 枚举、(c) 必填、(d) 能力清单、(e) 变更原因、(f) 签署项配置、(g) Stage×工卡类型组合全部通过；任一未通过则状态保持「新增」并给出未通过项。
describe('Property 19: 提交审核校验完备性（纯函数层，submitReviewChecklist）', () => {
  it('黄金路径：(a)-(g) 全部通过时 ok===true 且 failedChecks 为空', () => {
    const result = submitReviewChecklist(goldenCard(), goldenCtx());
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
  });

  // 注：本属性在 design.md 中同时涵盖"每次被接受的审核动作使审核记录数 +1"与
  // "升版新版本审核记录数初始为 0"两条断言——这两条依赖 review_record 表的持久化行为，
  // 是数据库/仓储层关注点，超出 submitReviewChecklist 这一纯函数的职责范围。纯函数层
  // 无法在不引入 DB 依赖的前提下验证"记录数 +1"或"初始为 0"，故本测试仅覆盖可从纯函数
  // 断言的部分：校验清单的组合完备性（破坏 (a)-(g) 任一项均阻止提交）。记录数相关断言
  // 留待后续任务的服务层/仓储层集成测试（内存 SQLite）覆盖。
  it('(a)-(g) 任一项被破坏（其余六项保持黄金）时 ok===false 且该项出现在 failedChecks', () => {
    fc.assert(
      fc.property(breakOneCheckArb, ({ letter, card, ctx }) => {
        const result = submitReviewChecklist(card, ctx);
        expect(result.ok).toBe(false);
        const checks = result.failedChecks.map((item) => item.check);
        expect(checks).toContain(letter);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: 一编一审
// ---------------------------------------------------------------------------

/**
 * 身份归一化的测试侧镜像——与 `review.js` 内部 `normalizeIdentity` 语义逐字一致
 * （字符串去空白后非空即视为身份；有限数字转字符串；BigInt 转字符串；其余类型
 * 均判定为不可判定身份，返回 `null`）。用于独立计算期望值，而非直接复用实现细节。
 */
function normalizeIdentity(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/** 涵盖字符串（含空白/全角空白）、数字（含 NaN/Infinity）、BigInt、布尔、对象、null/undefined 的身份候选。 */
const identityLikeArb = fc.oneof(
  fc.string(),
  fc.constantFrom('', '   ', '\u3000', '\t\n', 'E001', 'M002'),
  fc.integer(),
  fc.double(),
  fc.bigInt(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
);

// Feature: task-card-management, Property 14: 一编一审 —— For any 工卡与任意用户，canApprove(card, userId) 为真当且仅当 userId 非空白且 userId !== card.created_by。
describe('Property 14: 一编一审（canApprove）', () => {
  it('canApprove(card, userId) 为真当且仅当 userId 非空白且与 card.created_by 不同', () => {
    fc.assert(
      fc.property(identityLikeArb, identityLikeArb, fc.boolean(), (createdBy, otherUserId, useSameAsCreator) => {
        const userId = useSameAsCreator ? createdBy : otherUserId;
        const card = { created_by: createdBy };

        const reviewer = normalizeIdentity(userId);
        const creator = normalizeIdentity(createdBy);
        const expected = reviewer !== null && reviewer !== creator;

        expect(canApprove(card, userId)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
