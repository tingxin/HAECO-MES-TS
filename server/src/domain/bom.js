/**
 * BOM Base 输出汇总领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 单一职责：把「工卡集合 + IR Lot 卡的 Lot List 关联（已补齐 Base 值）」投影为 BOM List 的
 * Base Number 输出行集合（需求 48.4、48.5）。输出行与 `bom_base_output` 表逐列对应，服务层
 * 可直接落库，亦可经 `GET /api/task-cards/:id/bom-bases` 直出。
 *
 * ── 两来源并集（需求 48.4，Property 30）──────────────────────────
 * (a) **类型 04（IR 卡）** 在需求 8.1 直接维护的 `task_card.base_number` → `source='ir_card'`；
 * (b) **类型 05（IR Lot 卡）** 经关联 Lot List 带出的 Base（需求 48.3）→ `source='lot_list'`，
 *     并携带该 Lot 的 `lotNumber` 以区别于 (a)（需求 48.6）。
 * 每行同时携带 Task Card No 与 Task Title（需求 48.5，蓝图 2.3.6 BOM List 字段）。
 *
 * ── ⚠ 当前**不去重**（《临时设计说明》A6 待澄清项 3）───────────────
 * 同一 Base Number 由 04 与 05 两来源同时产出时，**保留两行并各自标识 `source`**，不合并、
 * 不排重；同一 Base 由两个 Lot List 带出亦保留两行。这**不是遗漏**：A6 待澄清项 3 明确
 * 「同一 Base Number 由 04 与 05 两来源重复输出时的去重规则待业务方确认，当前 Hotfix 未去重」。
 * 在业务方裁定前擅自去重，会丢掉「该 Base 出自哪几个来源 / 哪几个 Lot」这一信息——去重可由
 * 汇总层再加一层归并恢复，被丢掉的来源信息却无从恢复。故此处刻意保留全部来源行。
 * 业务方裁定需去重后，改动点是本函数末尾追加一次按 `baseNumber` 的归并（A6「澄清后影响面」
 * 已评估为低），届时 Property 30 的断言需同步由「并集（多重集）」改为「集合」。
 *
 * ── 需求 48.8 的实现方式：纯投影、零缓存 ────────────────────────
 * 「所关联 Lot List 的 Base 集合发生变更时输出同步更新」在本模块的落实方式是**本函数不持有
 * 任何状态**：输出完全由本次入参决定，模块内无缓存、无记忆、无 memo。因此同一 `cards` 配以
 * 变更后的 `lotLinks` 再次调用，即得到变更后的输出——「同步更新」由无状态性自动成立，而非靠
 * 某个失效通知机制。在本模块内引入任何缓存都会直接破坏需求 48.8。
 *
 * ── 不承担的职责 ───────────────────────────────────────────────
 * - **不读库**：`lotLinks` 的 Base 值须由服务层经 `GET /api/lot-lists/:lotListRef/bases`
 *   契约（数据源 `lot_list_base` mock 表）预先补齐后传入；Lot List（LT 单据）主数据归独立
 *   模块（A6 待澄清项 1），本模块只读其投影。
 * - **不产出上级件名称与 LRU 标记**：需求 48.7 的维护界面归属 Work Package List 模块
 *   （A6 待澄清项 2）。本函数无从得知这两项，故输出行**不含** `upperPartName` / `isLru`：
 *   落库时 `bom_base_output` 的列默认值（`upper_part_name` NULL、`is_lru` 0）生效，
 *   WPL 模块后续更新该行即可。凭空补 `null` / `0` 会让「未维护」与「维护为空」不可区分。
 * - **不校验 04 卡是否必须有 Base**：需求 8.1、8.3 的条件必填由 `card-rules.js`
 *   的 `requiresBomFields(card)` 与提交审核校验负责；此处 Base 缺失即该卡不贡献输出行。
 *
 * 需求：48.1–48.6、48.8
 */

/** IR 卡：直接维护 Base Number 的工卡类型（需求 8.1、48.4(a)） */
export const IR_CARD_TYPE = '04';

/** IR Lot 卡：经 Lot List 带出 Base Number 的工卡类型（需求 48.1、48.4(b)） */
export const IR_LOT_CARD_TYPE = '05';

/** Base Number 来源标识，与 `bom_base_output.source` 的 CHECK 取值集一致（需求 48.6） */
export const BOM_BASE_SOURCE = Object.freeze({
  /** 类型 04 直接维护（需求 48.4(a)） */
  IR_CARD: 'ir_card',
  /** 类型 05 经 Lot List 带出（需求 48.3、48.4(b)） */
  LOT_LIST: 'lot_list',
});

/** 读取字段，兼容 DB 行 snake_case 与服务层 camelCase 两种形态。 */
function pick(row, camel, snake) {
  const value = row[camel] !== undefined ? row[camel] : row[snake];
  return value === undefined ? null : value;
}

/**
 * 文本归一化：去首尾空白后为空串（含 `null` / 纯空白 / 非字符串）一律返回 `null`。
 * 有限数字与 bigint 转字符串——编号类字段在 JSON 往返中可能退化为数字。
 */
function text(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/** 工卡 / 关联行的 id 归一化：有限整数或非空字符串，否则 `null`（尚未落库的对象）。 */
function identity(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return text(value);
}

/**
 * 取一条 `lot_list_link` 的 Base 明细数组。
 *
 * **显式约定入参形态**：Base 值由服务层调用 `GET /api/lot-lists/:lotListRef/bases`
 * （返回 `[{ baseNumber, lotNumber }]`）补齐后挂在关联行上，键名接受
 * `bases` / `baseNumbers` / `base_numbers` 三种写法；元素接受两种形态：
 * - **字符串**：即 Base Number 本身，Lot Number 取所属关联行的 `lotNumber`；
 * - **对象**：`{ baseNumber | base_number, lotNumber | lot_number }`，`lotNumber` 缺省时
 *   回落至所属关联行的 `lotNumber`（`lot_list_base.lot_number` 可为空，`lot_list_link.lot_number`
 *   为 NOT NULL，故回落链恒能取到值）。
 *
 * 未挂 Base 明细（键缺失）与空数组等价：该关联不贡献输出行。这与「Lot List 尚无 Base」
 * 同义，不视为错误——需求 48.3 只要求把带出的集合输出，空集合的输出即为空。
 */
function basesOf(link, index) {
  const raw = link.bases ?? link.baseNumbers ?? link.base_numbers;
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError(`aggregateBomBase: lotLinks[${index}].bases 须为数组（Base 明细集合）`);
  }
  return raw;
}

/**
 * BOM Base 输出汇总（需求 48.3–48.6、48.8）——BOM List 的 Base Number 输出集合。
 *
 * 输出顺序**确定且可复现**：按 `cards` 给定顺序逐卡产出，卡内先 `ir_card` 行、再按
 * `lotLinks` 给定顺序及各关联内 Base 明细顺序产出 `lot_list` 行。确定性使 Property 30
 * 可做逐行比对，也让 BOM List 呈现按工卡自然分组。
 *
 * **被忽略（不产出行且不报错）的入参情形**，均属「该来源本就无 Base 可输出」：
 * - 类型既非 04 也非 05 的工卡（需求 48.4 只定义这两个来源）；
 * - 类型 04 但 `base_number` 为空（需求 8.1 的条件必填由 `card-rules.js` 与提交审核校验拦截）；
 * - 类型 05 但无任何 Lot List 关联，或关联未带出 Base；
 * - Base Number 为空/纯空白的明细项（`bom_base_output.base_number` 为 NOT NULL，空值无法落库）；
 * - `card_id` 在 `cards` 中无对应工卡的关联行，以及挂在**非** 05 类型工卡上的关联行：
 *   前者取不到需求 48.5 要求的 Task Card No / Task Title，后者不属需求 48.4(b) 定义的来源。
 *   两者均为上游选取入参时的口径问题（`lot_list_link.card_id` 有外键、业务上仅 05 卡建关联），
 *   在此静默跳过而非抛错，避免一条越界关联导致整份 BOM 输出不可用。
 *
 * @param {ReadonlyArray<object>|null|undefined} cards 工卡集合（`task_card` 行或等价对象）。
 *   读取 `id`、`task_no`/`taskNo`、`title`/`taskTitle`、`card_type`/`cardType`、
 *   `base_number`/`baseNumber`。`null` / `undefined` 等同空集合。
 * @param {ReadonlyArray<object>|null|undefined} lotLinks IR Lot 卡的 Lot List 关联集合
 *   （`lot_list_link` 行 + 已补齐的 Base 明细）。读取 `card_id`/`cardId`、
 *   `lot_number`/`lotNumber`、`lot_list_ref`/`lotListRef` 与 `bases`（见 {@link basesOf}）。
 * @returns {ReadonlyArray<{cardId: number|string|null, taskNo: string|null, taskTitle: string|null,
 *   baseNumber: string, source: 'ir_card'|'lot_list', lotNumber: string|null,
 *   lotListRef: string|null}>}
 *   冻结的输出行数组（行对象亦冻结）：`source==='ir_card'` 时 `lotNumber` 与 `lotListRef`
 *   恒为 `null`（需求 48.6 以此区别两类来源）；`source==='lot_list'` 时 `lotNumber` 恒非空。
 *   **不去重**，见模块头注。
 * @throws {TypeError} `cards` / `lotLinks` 非数组，元素非对象，`bases` 非数组，
 *   或某条 `lot_list` 明细取不到任何 Lot Number（关联行与明细项均缺 → 需求 48.2、48.6
 *   无法满足；`lot_list_link.lot_number` 为 NOT NULL，正常数据不会走到此分支）
 */
export function aggregateBomBase(cards, lotLinks) {
  const cardRows = cards === null || cards === undefined ? [] : cards;
  const linkRows = lotLinks === null || lotLinks === undefined ? [] : lotLinks;
  if (!Array.isArray(cardRows)) throw new TypeError('aggregateBomBase: cards 须为数组');
  if (!Array.isArray(linkRows)) throw new TypeError('aggregateBomBase: lotLinks 须为数组');

  // ① 关联行按 card_id 归组，保留原始顺序（同一卡的多个 Lot List 依入参顺序输出，需求 48.1）
  const linksByCard = new Map();
  linkRows.forEach((link, index) => {
    if (link === null || typeof link !== 'object' || Array.isArray(link)) {
      throw new TypeError(`aggregateBomBase: lotLinks[${index}] 须为对象`);
    }
    const cardId = identity(pick(link, 'cardId', 'card_id'));
    if (cardId === null) return; // 无归属工卡的关联行取不到 Task No / Title（需求 48.5）
    const key = String(cardId);
    const bucket = linksByCard.get(key);
    if (bucket === undefined) linksByCard.set(key, [{ link, index }]);
    else bucket.push({ link, index });
  });

  const rows = [];
  cardRows.forEach((card, cardIndex) => {
    if (card === null || typeof card !== 'object' || Array.isArray(card)) {
      throw new TypeError(`aggregateBomBase: cards[${cardIndex}] 须为对象`);
    }
    const cardId = identity(card.id);
    const cardType = text(pick(card, 'cardType', 'card_type'));
    const taskNo = text(pick(card, 'taskNo', 'task_no'));
    const taskTitle = text(pick(card, 'taskTitle', 'title'));

    // ② 来源 (a)：类型 04 直接维护的 Base（需求 48.4(a)、8.1）
    if (cardType === IR_CARD_TYPE) {
      const baseNumber = text(pick(card, 'baseNumber', 'base_number'));
      if (baseNumber !== null) {
        rows.push({
          cardId,
          taskNo,
          taskTitle,
          baseNumber,
          source: BOM_BASE_SOURCE.IR_CARD,
          // 需求 48.6：直接维护的 Base 不带 Lot 信息，据此与 lot_list 来源区别
          lotNumber: null,
          lotListRef: null,
        });
      }
    }

    // ③ 来源 (b)：类型 05 经 Lot List 带出的 Base（需求 48.3、48.4(b)、48.6）
    if (cardType !== IR_LOT_CARD_TYPE || cardId === null) return;
    for (const { link, index } of linksByCard.get(String(cardId)) ?? []) {
      const linkLotNumber = text(pick(link, 'lotNumber', 'lot_number'));
      const lotListRef = text(pick(link, 'lotListRef', 'lot_list_ref'));
      basesOf(link, index).forEach((entry, entryIndex) => {
        const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
        const baseNumber = isObject ? text(pick(entry, 'baseNumber', 'base_number')) : text(entry);
        if (baseNumber === null) return; // 空 Base 无法落库（NOT NULL），视同该明细不存在
        const lotNumber = (isObject ? text(pick(entry, 'lotNumber', 'lot_number')) : null) ?? linkLotNumber;
        if (lotNumber === null) {
          throw new TypeError(
            `aggregateBomBase: lotLinks[${index}].bases[${entryIndex}]（Base ${baseNumber}）`
              + '取不到 Lot Number，无法按需求 48.2、48.6 标识来源',
          );
        }
        rows.push({
          cardId,
          taskNo,
          taskTitle,
          baseNumber,
          source: BOM_BASE_SOURCE.LOT_LIST,
          lotNumber,
          lotListRef,
        });
      });
    }
  });

  // ⚠ 此处**刻意不做**按 baseNumber 的归并（A6 待澄清项 3），见模块头注。
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}
