/**
 * 导出服务（Export Service，任务 13.10）—— 按 `exportFields(mode)` 生成 CSV 产物。
 *
 * 字段划分（关键字段集 vs 全部字段 + 展开行）**唯一**由 `domain/export-fields.js` 的
 * `exportFields(mode)` 给出，本服务只做「取数 → 按字段定义取值 → 拼 CSV 信封」，
 * 不重新决定字段范围（需求 3.6、3.7）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * CSV 信封（design.md「导出产物格式」，任务 13.10）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - **UTF-8 带 BOM**：产出文本以 `\uFEFF` 开头，供 Excel 等工具正确识别中文编码；
 * - **逗号分隔**：单元格含逗号 / 双引号 / 换行（`\r` 或 `\n`）时按 RFC 4180 用双引号包裹，
 *   内部双引号转义为两个双引号；
 * - **CRLF 换行**：行与行之间以 `\r\n` 连接，末行不追加多余换行；
 * - `revision` 两位补零文本由 `exportFields` 定义的 `FIELD_FORMAT.REVISION` 单元格格式
 *   经 `formatExportValue` 产出（`domain/export-fields.js` 头注：库内/仓储层恒 INTEGER，
 *   补零只在此展示层发生，全库唯一一处）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `all` 模式的三段式产物（需求 3.7，《临时设计说明》D-05）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `exportFields('all')` 给出三个分节（`task_card` / `reference_document` /
 * `process_step`），**各分节自带表头**——本服务按分节顺序依次输出「表头行 + 该分节全部
 * 数据行」，三段在同一 CSV 文本中先后排列（不逐卡交错），子行（参考文件/工序）以
 * `task_no` + `revision`（{@link PARENT_KEY_FIELDS}）回指所属工卡；首列为行类别
 * （`row_type`，{@link ROW_TYPE_FIELD}）。`key` 模式无分节交错、无行类别列，是单一平表。
 *
 * 需求：3.6、3.7、35.1（间接，组织名称不属导出字段范围，与打印服务不同）
 */

import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import { exportFields, formatExportValue } from '../domain/export-fields.js';
import { toCamelCase } from '../repositories/case-convert.js';

import taskCardRepo from '../repositories/taskCardRepo.js';
import referenceDocRepo from '../repositories/referenceDocRepo.js';
import processStepRepo from '../repositories/processStepRepo.js';

/** UTF-8 BOM（Excel 等工具正确识别中文编码所需）。 */
const BOM = '\uFEFF';

/** RFC 4180 单元格转义：含逗号 / 双引号 / CR / LF 时加引号，内部双引号转义为两个双引号。 */
function escapeCsvCell(text) {
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 一行数据（字符串数组）→ CSV 行文本（不含结尾换行）。 */
function toCsvLine(cells) {
  return cells.map(escapeCsvCell).join(',');
}

/** 按字段定义（`{key, format}`，`key` 为 snake_case 逻辑字段名）取行上的对应值并格式化。 */
function cellValueOf(row, fieldDef) {
  const value = row === null || row === undefined ? undefined : row[toCamelCase(fieldDef.key)];
  return formatExportValue(fieldDef, value);
}

/**
 * 按主键批量取工卡，任一 id 不存在即 `404`（导出须对「选中了什么」给出确定结果，
 * 不静默跳过——与 `taskCardService.js` 的 `loadCardOrThrow` 同一失败即拒绝的约定）。
 * @param {ReadonlyArray<number|string>} cardIds
 * @returns {object[]} camelCase 工卡集合，与 `cardIds` 顺序一致
 */
function loadCardsOrThrow(cardIds) {
  return cardIds.map((id) => {
    const card = taskCardRepo.findById(id);
    if (card === null) {
      throw new ServiceError(CODE.NOT_FOUND, `工卡不存在：${String(id)}`, { cardId: id });
    }
    return card;
  });
}

/** 归一化 `cardIds` 入参：非数组或空数组一律拒绝（需求 3.8 同类「未选中」校验口径）。 */
function normalizeCardIds(cardIds) {
  const ids = Array.isArray(cardIds) ? cardIds : [];
  if (ids.length === 0) {
    throw new ServiceError(CODE.VALIDATION, '请先选择至少一条工卡后再执行导出');
  }
  return ids;
}

/** `key` 模式：单一分节，一卡一行，无行类别列（{@link exportFields} 的 `KEY_RESULT`）。 */
function buildKeySection(spec, cards) {
  const section = spec.sections[0];
  const lines = [toCsvLine(section.headers)];
  for (const card of cards) {
    lines.push(toCsvLine(section.fields.map((fieldDef) => cellValueOf(card, fieldDef))));
  }
  return lines;
}

/**
 * `all` 模式：三段式产物（{@link exportFields} 的 `ALL_RESULT`）。父行（工卡）与两类子行
 * （参考文件 / 工序）按分节分别输出，子行前缀为其所属工卡的 `parentKeys`（task_no +
 * revision，取自父行——不重新查父卡，保持与该次导出选中的父行一致）。
 */
function buildAllSections(spec, cards) {
  const lines = [];
  const [cardSection, refDocSection, stepSection] = spec.sections;
  const discriminatorHeader = spec.discriminator.header;

  // ── 分节一：task_card（一卡一行） ──
  lines.push(toCsvLine([discriminatorHeader, ...cardSection.headers]));
  for (const card of cards) {
    lines.push(toCsvLine([
      cardSection.rowType,
      ...cardSection.fields.map((fieldDef) => cellValueOf(card, fieldDef)),
    ]));
  }

  // ── 分节二：reference_document（跨全部选中工卡的展开行，按工卡顺序） ──
  lines.push(toCsvLine([discriminatorHeader, ...refDocSection.headers]));
  for (const card of cards) {
    const parentValues = refDocSection.parentKeys.map((fieldDef) => cellValueOf(card, fieldDef));
    for (const doc of referenceDocRepo.listByCardId(card.id)) {
      lines.push(toCsvLine([
        refDocSection.rowType,
        ...parentValues,
        ...refDocSection.fields.map((fieldDef) => cellValueOf(doc, fieldDef)),
      ]));
    }
  }

  // ── 分节三：process_step（跨全部选中工卡的展开行，按工卡顺序） ──
  lines.push(toCsvLine([discriminatorHeader, ...stepSection.headers]));
  for (const card of cards) {
    const parentValues = stepSection.parentKeys.map((fieldDef) => cellValueOf(card, fieldDef));
    for (const step of processStepRepo.listByCardId(card.id)) {
      lines.push(toCsvLine([
        stepSection.rowType,
        ...parentValues,
        ...stepSection.fields.map((fieldDef) => cellValueOf(step, fieldDef)),
      ]));
    }
  }

  return lines;
}

/**
 * 生成导出 CSV 文本（需求 3.6、3.7）：UTF-8 带 BOM、逗号分隔、CRLF 换行。
 *
 * @param {ReadonlyArray<number|string>} cardIds 待导出工卡主键集合（非空）
 * @param {'key'|'all'} mode `'key'`（关键信息导出）或 `'all'`（全量导出）
 * @returns {string} CSV 文本（含起始 BOM），供路由层原样写入响应体
 * @throws {ServiceError} `cardIds` 为空（400）；`mode` 非法（400，`exportFields` 抛出的
 *   `TypeError` 在此转译）；任一 `cardIds` 元素对应工卡不存在（404）
 */
export function exportCsv(cardIds, mode) {
  const ids = normalizeCardIds(cardIds);

  let spec;
  try {
    spec = exportFields(mode);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ServiceError(CODE.VALIDATION, error.message, { mode });
    }
    throw error;
  }

  const cards = loadCardsOrThrow(ids);
  const lines = spec.mode === 'key' ? buildKeySection(spec, cards) : buildAllSections(spec, cards);

  return `${BOM}${lines.join('\r\n')}`;
}

export default { exportCsv };
