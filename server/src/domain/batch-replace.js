/**
 * 批量替换管控规则领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 10.2：`batchReplace(cards, spec, reason, operatorId, options?)`——
 * 批量替换所选工卡某字段/文本的**判定与留痕构造**单点（服务层据本函数结果落库/写事务，
 * 整批回滚的事务边界见任务 13.3、14.2，本模块不触库）。
 *
 * ## 组合关系（本模块是组合模块，不重新实现底层规则）
 *
 * - **New-only 闸门**：直接复用 `card-rules.js` 的 {@link isEditable}（需求 20.3、49.1、49.4）。
 * - **变更留痕**：每张被实际修改的工卡经 `change-record.js` 的 `buildChangeRecords` 产出
 *   恰好 1 条 `change_type='batch_replace'` 记录（需求 19.1、20.8）——本模块不自行拼装记录行。
 * - 权限点校验（`batch_replace` 独立权限点，需求 20.9）**不是本模块职责**，归
 *   `permission.js` 与服务层；本模块只处理"给定已通过权限校验的一批工卡，应如何逐卡判定"。
 *
 * ## 三态判定：拒绝 / 替换 / 无影响（需求 20.1–20.4）
 *
 * 逐卡判定互斥的三种结果：
 * 1. `rejected_not_editable`——`status !== 'New'`（需求 20.3、20.4）：逐条列明拒绝原因，
 *    **不阻断其余工卡**（任务描述"任何非新增版本逐条拒绝并列明原因"，与需求 20.4"逐条列出
 *    被拒绝的工卡及原因"一致，非整批失败）。
 * 2. `replaced`——`status === 'New'` 且当前字段值与 `spec.from` **落库形态等价**（复用
 *    `change-record.js` 的 {@link serializeChangeValue} 判等，与最终留痕的"是否算变更"口径
 *    保持一致）且替换后值**确有变化**：产出 1 条变更记录与更新后的工卡副本。
 * 3. `unaffected`——`status === 'New'` 但当前字段值与 `from` 不匹配，**或** `from === to`
 *    导致替换后值与替换前落库形态相同（degenerate spec，无实质变更）：不产出记录、不产出
 *    副本，也**不计入拒绝**——这不是权限/态错误，只是这张卡本来就不受本次替换影响。
 *    与 `rejected_not_editable` 分开报告，避免把"未命中"误判为"被拒绝"。
 *
 * ## 幂等性如何"自然成立"（需求 20.10，Property 13）
 *
 * 不需要额外的幂等追踪状态：同一 `spec` 第二次执行时，已被第一次替换过的工卡字段值已变为
 * `to`（假定 `to !== from`），其"当前字段值与 `from` 是否匹配"的判定自然落空 → 归入
 * `unaffected`，`affectedCount` 自然为 0。`to === from` 的退化场景亦同理收敛为
 * `unaffected`（见上文判定 3），两次执行结果恒等。
 *
 * ## 整批成功 / 整批拒绝的两态含义（需求 20.6、20.7）
 *
 * `ok === false` **仅**由"替换原因为空/纯空白"或"操作人缺失"触发——这两项是本次批量替换
 * 操作能否**发起**的前置闸门，一票否决、零产出（不逐卡判定，`items` 为空数组）。
 * `ok === true` 表示批量替换**已发起并逐卡判定完毕**，其内部允许出现被拒绝的个卡
 * （`rejected_not_editable`）——需求 20.4 明确非新增版本按卡拒绝，不因此使整批失败。
 * 本模块产出的 `updatedCards` / `changeRecords` 是服务层事务的**写入候选集**：
 * 服务层按需求 20.10 以事务方式落库这些候选，任一落库语句失败即整批回滚（任务 14.2），
 * 该回滚发生在本函数返回**之后**，不影响本函数自身的两态语义。
 *
 * 需求：19.1、20.1–20.10、49.4
 */

import { isEditable, statusOf, revisionOf } from './card-rules.js';
import { buildChangeRecords, serializeChangeValue } from './change-record.js';

/** 变更类型：本模块产出的变更记录一律为 `batch_replace`（需求 20.8）。 */
const CHANGE_TYPE_BATCH_REPLACE = 'batch_replace';

/** 逐卡判定结果三态（需求 20.1–20.4）。 */
export const BATCH_REPLACE_OUTCOME = Object.freeze({
  /** 实际替换并产出 1 条变更记录 */
  REPLACED: 'replaced',
  /** 非新增(New)版本，逐条拒绝（需求 20.3、20.4） */
  REJECTED_NOT_EDITABLE: 'rejected_not_editable',
  /** 新增版本但字段当前值与 `from` 不匹配（或替换前后落库形态相同），未受影响 */
  UNAFFECTED: 'unaffected',
});

/** 整批级拒绝原因（需求 20.6、20.7，及变更记录留痕对操作人的硬性要求）。 */
export const BATCH_REPLACE_REJECTION = Object.freeze({
  /** 替换原因为空或纯空白（需求 20.6、20.7） */
  REASON_REQUIRED: 'REASON_REQUIRED',
  /** 操作人缺失——留痕不具追溯价值，与 `change-record.js` 的 `OPERATOR_REQUIRED` 同义 */
  OPERATOR_REQUIRED: 'OPERATOR_REQUIRED',
  /** `spec` 结构非法（缺少合法的 `field`） */
  INVALID_SPEC: 'INVALID_SPEC',
});

const REJECTION_MESSAGES = Object.freeze({
  [BATCH_REPLACE_REJECTION.REASON_REQUIRED]: '替换原因（Replace Reason）为必填项，不得为空或纯空白',
  [BATCH_REPLACE_REJECTION.OPERATOR_REQUIRED]: '操作人缺失，变更记录须可追溯到人',
  [BATCH_REPLACE_REJECTION.INVALID_SPEC]: '批量替换规格非法，须提供 field（字段名，非空字符串）',
});

/** 空白判定——与 `change-record.js` / `void-rules.js` 的同名内部判定逐字一致。 */
function isBlank(value) {
  if (typeof value === 'string') {
    return value.trim().length === 0 || /^[\s\u3000]*$/.test(value);
  }
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'bigint') return false;
  return true;
}

/** 深克隆（JSON 形态取值 + `Date`）——与 `card-rules.js` / `exec-doc.js` 内同名实现逐字一致。 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = deepClone(value[key]);
  }
  return out;
}

/** 取行上第一个存在的字段，兼容 camelCase / snake_case 两种写法。 */
function pickField(row, keys) {
  if (row === null || typeof row !== 'object') return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** 归一化为可读文本；取不到时返回 `null`。 */
function asLabel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim().length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** 工卡识别信息（供逐卡结果回显定位，需求 20.4 的"逐条列出被拒绝的工卡"）。 */
function identityOf(card) {
  return Object.freeze({
    id: pickField(card, ['id', 'cardId', 'card_id']) ?? null,
    taskNo: asLabel(pickField(card, ['task_no', 'taskNo'])),
    revision: revisionOf(card),
    status: statusOf(card),
  });
}

/** 归一化时间戳——与 `change-record.js` 的同名内部实现同义（Date / ISO 字符串 / 毫秒数）。 */
function normalizeTimestamp(timestamp) {
  if (timestamp === null || timestamp === undefined) return new Date().toISOString();
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString();
  }
  if (typeof timestamp === 'number') {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  return String(timestamp);
}

function rejectBatch(rejection, extra = {}) {
  return Object.freeze({
    ok: false,
    rejection,
    message: REJECTION_MESSAGES[rejection],
    spec: extra.spec ?? null,
    reason: null,
    operatorId: null,
    items: Object.freeze([]),
    updatedCards: Object.freeze([]),
    changeRecords: Object.freeze([]),
    totalCount: extra.totalCount ?? 0,
    affectedCount: 0,
    rejectedCount: 0,
    unaffectedCount: 0,
  });
}

/**
 * `spec` 规格归一化（需求 20.1：`{ field, from, to }`）。
 * 仅校验 `field` 为非空字符串——`from`/`to` 可为任意可序列化取值（含 `null`/`undefined`）。
 * @throws {TypeError} `spec` 非对象，或 `field` 非法
 */
function normalizeSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('batchReplace：spec 须为 { field, from, to } 形态的对象');
  }
  if (typeof spec.field !== 'string' || spec.field.trim().length === 0) {
    throw new TypeError('batchReplace：spec.field 须为非空字符串（待替换字段名）');
  }
  return { field: spec.field, from: spec.from, to: spec.to };
}

/**
 * 批量替换管控规则（需求 19.1、20.1–20.10、49.4，Property 13 纯函数部分）。
 *
 * 处理顺序：
 * 1. **整批级闸门**（一票否决，零产出）：`reason` 为空/纯空白 → `REASON_REQUIRED`；
 *    `operatorId` 缺失 → `OPERATOR_REQUIRED`（需求 20.6、20.7）。
 * 2. 逐卡判定（互斥三态，见模块头）：非 New → 拒绝；New 且命中 `from` 且替换后确有变化
 *    → 替换并经 `buildChangeRecords` 产出恰好 1 条 `batch_replace` 记录；其余 → 未受影响。
 *
 * 本函数**不修改入参 `cards`**：`updatedCards` 中的每个元素均为深克隆副本。
 *
 * @param {ReadonlyArray<object>} cards 待处理工卡集合（服务层已按所选 `ids` 取出的全量行；
 *   本函数不触库，漏取即漏判）
 * @param {{field: string, from?: unknown, to?: unknown}} spec 替换规格（需求 20.1）
 * @param {unknown} reason 替换原因（需求 20.6：必填，为空/纯空白整批拒绝）
 * @param {unknown} operatorId 操作人工号，供变更记录留痕（需求 19.1、19.3）
 * @param {{timestamp?: Date|string|number}} [options] `timestamp` 可注入，
 *   同一次批量替换产出的全部记录共享该时间戳；缺省取当前时刻
 * @returns {{
 *   ok: boolean, rejection: string|null, message: string,
 *   spec: {field: string, from: unknown, to: unknown} | null,
 *   reason: string | null, operatorId: string | null,
 *   items: ReadonlyArray<{
 *     outcome: string, card: object, field: string,
 *     before: unknown, after: unknown,
 *     rejectionMessage: string | null,
 *     changeRecord: object | null, updatedCard: object | null,
 *   }>,
 *   updatedCards: ReadonlyArray<object>, changeRecords: ReadonlyArray<object>,
 *   totalCount: number, affectedCount: number, rejectedCount: number, unaffectedCount: number,
 * }}
 * @throws {TypeError} `cards` 非数组，或 `spec` 结构非法（`field` 缺失/非字符串）
 */
export function batchReplace(cards, spec, reason, operatorId, options = {}) {
  if (!Array.isArray(cards)) {
    throw new TypeError('batchReplace：cards 须为数组（服务层已按所选 ids 取出的工卡集合）');
  }
  const normalizedSpec = normalizeSpec(spec);

  // ① 整批级闸门一：替换原因必填（需求 20.6、20.7）
  if (isBlank(reason)) {
    return rejectBatch(BATCH_REPLACE_REJECTION.REASON_REQUIRED, {
      spec: normalizedSpec,
      totalCount: cards.length,
    });
  }

  // ② 整批级闸门二：操作人必填（留痕可追溯到人，需求 19.1、19.3）
  if (isBlank(operatorId)) {
    return rejectBatch(BATCH_REPLACE_REJECTION.OPERATOR_REQUIRED, {
      spec: normalizedSpec,
      totalCount: cards.length,
    });
  }

  const { field } = normalizedSpec;
  const timestamp = normalizeTimestamp(options.timestamp);

  const items = [];
  const updatedCards = [];
  const changeRecords = [];
  let affectedCount = 0;
  let rejectedCount = 0;
  let unaffectedCount = 0;

  for (const card of cards) {
    const identity = identityOf(card);

    // 非新增版本：逐条拒绝并列明原因，不阻断其余工卡（需求 20.3、20.4）
    if (!isEditable(card)) {
      rejectedCount += 1;
      items.push(
        Object.freeze({
          outcome: BATCH_REPLACE_OUTCOME.REJECTED_NOT_EDITABLE,
          card: identity,
          field,
          before: undefined,
          after: undefined,
          rejectionMessage: `工卡当前状态为「${identity.status ?? '未知'}」，仅新增(New)版本可执行批量替换`,
          changeRecord: null,
          updatedCard: null,
        }),
      );
      continue;
    }

    const currentValue = card === null || typeof card !== 'object' ? undefined : card[field];
    const matchesFrom = serializeChangeValue(currentValue) === serializeChangeValue(normalizedSpec.from);

    if (!matchesFrom) {
      unaffectedCount += 1;
      items.push(
        Object.freeze({
          outcome: BATCH_REPLACE_OUTCOME.UNAFFECTED,
          card: identity,
          field,
          before: currentValue,
          after: undefined,
          rejectionMessage: null,
          changeRecord: null,
          updatedCard: null,
        }),
      );
      continue;
    }

    // 命中 from：构造留痕（每张被修改工卡恰好 1 条记录，需求 20.8）
    const before = { [field]: currentValue };
    const after = { [field]: normalizedSpec.to };
    const recordResult = buildChangeRecords(
      before,
      after,
      CHANGE_TYPE_BATCH_REPLACE,
      reason,
      operatorId,
      { timestamp, cardId: identity.id, cardRevision: identity.revision },
    );

    // from === to（退化规格）：落库形态无变化，buildChangeRecords 产出空集 → 归入未受影响，
    // 不计入替换、不产出副本（"替换"须确有内容变化，否则不构成"被修改的工卡"）
    if (!recordResult.ok || recordResult.records.length === 0) {
      unaffectedCount += 1;
      items.push(
        Object.freeze({
          outcome: BATCH_REPLACE_OUTCOME.UNAFFECTED,
          card: identity,
          field,
          before: currentValue,
          after: normalizedSpec.to,
          rejectionMessage: null,
          changeRecord: null,
          updatedCard: null,
        }),
      );
      continue;
    }

    const changeRecord = recordResult.records[0];
    const updatedCard = deepClone(card);
    updatedCard[field] = normalizedSpec.to;

    affectedCount += 1;
    updatedCards.push(updatedCard);
    changeRecords.push(changeRecord);
    items.push(
      Object.freeze({
        outcome: BATCH_REPLACE_OUTCOME.REPLACED,
        card: identity,
        field,
        before: currentValue,
        after: normalizedSpec.to,
        rejectionMessage: null,
        changeRecord,
        updatedCard,
      }),
    );
  }

  return Object.freeze({
    ok: true,
    rejection: null,
    message: 'ok',
    spec: normalizedSpec,
    reason,
    operatorId,
    items: Object.freeze(items),
    updatedCards: Object.freeze(updatedCards),
    changeRecords: Object.freeze(changeRecords),
    totalCount: cards.length,
    affectedCount,
    rejectedCount,
    unaffectedCount,
  });
}
