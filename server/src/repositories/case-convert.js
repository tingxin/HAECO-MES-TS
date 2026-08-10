/**
 * 仓储层 snake_case ↔ camelCase 转换辅助（纯函数，无 I/O、无业务逻辑）。
 *
 * 仓储层是**纯 SQL 读写封装**：不做校验、不带默认值、不调用领域函数。本模块只承担
 * schema.sql「列名 snake_case；API 出入参转 camelCase（由仓储层负责）」这一约定的
 * 落地——供 `task_card` / `reference_document` / `process_step` / `signature_requirement` /
 * `card_relation` / `attachment` / `lot_list_link` / `bom_base_output` / `exec_document`
 * 等无专属序列化领域函数的表统一复用，避免每个仓储文件各自手写大同小异的转换逻辑。
 *
 * `capture_item` 与 `inserted_component` 的 `payload`/`config` 列改用
 * `domain/collections.js` 的 `serializeComponent`/`parseComponent`、
 * `serializeCaptureItem`/`parseCaptureItem`——那两个函数已完整覆盖整行的 camelCase 转换，
 * 不经本模块。
 *
 * ⚠ `toSnakeCase` 的正则与 `domain/enums.js` 的同名内部函数保持一致，确保全库列名推导规则
 * 只有一份心智模型（camelCase 列名 → snake_case 恒定推导，不因模块不同而结果不同）。
 */

/** camelCase → snake_case（列名推导），与 `domain/enums.js` 内部 `toSnakeCase` 同规则。 */
export function toSnakeCase(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** snake_case → camelCase（{@link toSnakeCase} 的逆，用于 DB 行 → JS 对象）。 */
export function toCamelCase(key) {
  return String(key).replace(/_([a-zA-Z0-9])/g, (_match, ch) => ch.toUpperCase());
}

/**
 * DB 行（snake_case 键）→ camelCase 对象。`row` 为 `null`/`undefined` 时返回 `null`
 * （SQLite `.get()` 未命中即返回 `undefined`，仓储层统一归一为 `null`）。
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {Record<string, unknown> | null}
 */
export function rowToCamel(row) {
  if (row === null || row === undefined) return null;
  const result = {};
  for (const key of Object.keys(row)) {
    result[toCamelCase(key)] = row[key];
  }
  return result;
}

/**
 * DB 行集合 → camelCase 对象集合。
 * @param {ReadonlyArray<Record<string, unknown>> | null | undefined} rows
 * @returns {Record<string, unknown>[]}
 */
export function rowsToCamel(rows) {
  return (rows ?? []).map(rowToCamel);
}

/**
 * 输入对象（camelCase / snake_case 键皆可）→ 仅保留 `allowedColumns` 中列出的 snake_case 列名
 * 的写入行；取值为 `undefined` 的键视为「未提供」而跳过（区分「未提供」与「显式置空 null」，
 * 后者需保留以支持 `UPDATE ... SET col = NULL`）。
 *
 * @param {unknown} input 待写入对象
 * @param {readonly string[]} allowedColumns 允许写入的 snake_case 列名集合
 * @returns {Record<string, unknown>} snake_case 键的写入行（可能为空对象）
 */
export function pickColumns(input, allowedColumns) {
  const allowed = new Set(allowedColumns);
  const result = {};
  if (input === null || typeof input !== 'object') return result;
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) continue;
    const snakeKey = toSnakeCase(key);
    if (!allowed.has(snakeKey)) continue;
    result[snakeKey] = input[key];
  }
  return result;
}

/** 数值归一（INTEGER 列，如 `revision`）：非数值/空串 → `null`；有限数取整。 */
export function toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/** 0/1 标记归一（`is_fai`/`is_critical`/`stamp_required` 等布尔 INTEGER 列）。 */
export function toFlag(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === 'number') return value !== 0 ? 1 : 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true' ? 1 : 0;
  return 0;
}

/**
 * 对写入行中**已提供**的若干标记列就地应用 {@link toFlag} 归一；未提供（`undefined`）的列
 * 不受影响，保持「未提供即不写入该列」的语义。
 * @param {Record<string, unknown>} snakeRow {@link pickColumns} 产出的写入行
 * @param {readonly string[]} flagColumns 待归一的 snake_case 列名
 * @returns {Record<string, unknown>} 原对象（就地修改后返回，便于链式调用）
 */
export function applyFlags(snakeRow, flagColumns) {
  for (const column of flagColumns) {
    if (snakeRow[column] !== undefined) snakeRow[column] = toFlag(snakeRow[column]);
  }
  return snakeRow;
}

/**
 * 依据写入行的**实际列集合**构造 `INSERT` 语句并执行，返回 `lastInsertRowid`。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {Record<string, unknown>} snakeRow {@link pickColumns} 产出的写入行（非空）
 * @returns {number | bigint} 新增行的自增主键
 */
export function insertRow(db, table, snakeRow) {
  const columns = Object.keys(snakeRow);
  const placeholders = columns.map(() => '?').join(', ');
  const info = db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...columns.map((column) => snakeRow[column]));
  return info.lastInsertRowid;
}

/**
 * 依据写入行的**实际列集合**构造 `UPDATE ... WHERE id = ?` 语句并执行。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {number | string} id
 * @param {Record<string, unknown>} snakeRow {@link pickColumns} 产出的写入行；为空对象时不执行
 * @returns {number} 受影响行数（写入行为空时恒为 0）
 */
export function updateRow(db, table, id, snakeRow) {
  const columns = Object.keys(snakeRow);
  if (columns.length === 0) return 0;
  const setClause = columns.map((column) => `${column} = ?`).join(', ');
  const info = db
    .prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`)
    .run(...columns.map((column) => snakeRow[column]), id);
  return info.changes;
}
