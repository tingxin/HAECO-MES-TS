/**
 * 现有文字格式工卡迁移服务（Migration Service，任务 13.9）—— 文件解析 + 落库两大通道。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 两条通道（design.md「迁移解析层」）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - **主通道**（{@link importFromExcel}）：Excel/CSV → `xlsx` 解析为结构化 `rows` →
 *   `domain/migrate-card.js` 的 `migrateRecords`（纯函数，逐条校验并产出报告）→
 *   成功行单事务落库（`task_card` + 逐行 `migration_record`），批次头落 `migration_batch`。
 * - **辅通道**（{@link previewFromWord}）：Word(.docx)/RTF → `mammoth` 转 HTML → 启发式
 *   按标题/表格边界切分为工序候选段落 → 返回**预览结构**供前端人工确认/编辑，**不落库、
 *   不产生工卡**。人工确认后应转换为 `rows` 交由 {@link importFromExcel} 走主通道——
 *   本模块刻意不提供「Word 直接生成工卡」的全自动路径（需求 17.1、17.2 仅要求「可迁移」，
 *   design.md 明确辅通道为 best-effort 预览，非硬解析器）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 逐行校验与落库权威来源——不重新实现
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 逐条必填/枚举/Stage×类型/查重校验与失败原因分类**唯一权威来源**是
 * `domain/migrate-card.js` 的 `migrateRecords`（任务 10.4，Property 32）。本服务只做：
 * 1. 文件解析（`xlsx.read` / `xlsx.utils.sheet_to_json`）产出 `migrateRecords` 期望的 `rows`；
 * 2. 调用 `migrateRecords` 取报告（`successCount`/`failureCount`/`totalCount`/`records`/`byCategory`）；
 * 3. 按报告落库——不重新计算成功/失败、不重新分类原因，`byCategory` 原样转交批次报告输出。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 失败隔离语义（需求 41.1、41.3–41.6；`migrate-card.unit.test.js`「批次内部重复」用例佐证）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `migrateRecords` 已在**纯函数层**完成「一行失败不影响其余行」的判定（必填/枚举/Stage×类型/
 * 批次内查重）。本服务的落库阶段面对的是**领域层判定为成功、但落库时仍可能撞库**的边界情形
 * （如并发场景下 `existingCards` 快照与实际落库之间出现新增行、或 `UNIQUE(task_no, revision)`
 * 的最后防线兜底）——这类**真实数据库错误**须被捕获并记为该行失败，**不得让整批事务回滚**。
 * 实现手段：批次整体在**一个外层事务**内执行（批次头 + 全部逐行记录同生共死，需求「按批次
 * 记录报告」的完整性），但每一行的「写 `task_card`」操作包在**独立的 `db.transaction()`
 * 调用**（better-sqlite3 对嵌套 `transaction()` 使用 `SAVEPOINT`，捕获异常后仅回滚该
 * SAVOEPOINT，外层事务与其余行不受影响）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 服务层错误约定（`lib/service-error.js`，与 `taskCardService.js` 同一口径）
 * ══════════════════════════════════════════════════════════════════════════════
 * 全部导出函数在前置条件不满足时一律 `throw new ServiceError(code, message, data)`；
 * 成功路径返回纯业务数据，不做 `{ok, data}` 信封包装。「批次内逐行失败」不属前置条件不满足
 * ——那是本函数的**正常产出**（`code:0` + `data` 内明细承载，与系统「部分失败但整批成功」
 * 的统一约定一致，见 `lib/response.js` 头注），故不 `throw`。
 *
 * 需求：17.1、17.2、41.1–41.6
 */

import XLSX from 'xlsx';
import mammoth from 'mammoth';

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import { migrateRecords, RECORD_STATUS } from '../domain/migrate-card.js';

import taskCardRepo from '../repositories/taskCardRepo.js';
import migrationRepo from '../repositories/migrationRepo.js';
import stageConstraintRepo from '../repositories/stageConstraintRepo.js';
import { toCamelCase } from '../repositories/case-convert.js';

// =====================================================================
// 一、内部辅助（不导出）
// =====================================================================

/** 迁移批次的来源通道词表——对应 `migration_batch.source_channel` 的 `CHECK` 取值集。 */
export const SOURCE_CHANNEL = Object.freeze({
  EXCEL: 'excel',
  CSV: 'csv',
  WORD: 'word',
  RTF: 'rtf',
});

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果（服务层事务边界的统一入口）。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * 取调用上下文中的操作人标识，与 `taskCardService.js` 的 `operatorIdOf` 同规则：
 * 兼容 `operatorId` / `staffNo` / `userId` 三种写法；缺失一律拒绝——批次须可追溯到执行人。
 * @param {unknown} ctx
 * @returns {string}
 */
function operatorIdOf(ctx) {
  const raw = ctx && typeof ctx === 'object' ? ctx.operatorId ?? ctx.staffNo ?? ctx.userId : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new ServiceError(CODE.VALIDATION, '缺少操作人标识（ctx.operatorId）');
  }
  return String(raw);
}

/** 取 Stage×工卡类型约束的运行时权威配置（与 `taskCardService.js` 的 `loadStageCfg` 同源）。 */
function loadStageCfg() {
  return {
    constraints: stageConstraintRepo.list(),
    crosscut: stageConstraintRepo.listCrosscut(),
  };
}

/**
 * 取现存工卡集合供 `migrateRecords` 查重比对（需求 41.3）。仅取 `(id, task_no, revision)`
 * 三列即足够——`checkDuplicate` 只读这三个字段，不必回表全量列。
 * @returns {{id: number, task_no: string, revision: number}[]}
 */
function listExistingCardsForDuplicateCheck() {
  const db = getDb();
  return db.prepare('SELECT id, task_no, revision FROM task_card').all();
}

/**
 * `migrateRecords` 产出的成功行（snake_case，含 `naming_rule_origin`）→ 交
 * `taskCardRepo.create` 的写入对象（camelCase，仅保留 `TASK_CARD_COLUMNS` 白名单列，
 * `taskCardRepo` 内部的 `pickColumns` 会再次按列名过滤，这里预先转换键名即可）。
 * @param {Record<string, unknown>} card `migrateRecords` 报告中某成功行的 `card` 字段
 * @returns {Record<string, unknown>}
 */
function toCardWriteInput(card) {
  const result = {};
  for (const key of Object.keys(card)) {
    result[toCamelCase(key)] = card[key];
  }
  return result;
}

/**
 * 判定某异常是否为 `better-sqlite3` 的约束冲突错误（`UNIQUE` / `CHECK` 等）。
 * 与 `service-error.js` 的 `isSqliteConstraintError` 同判定，此处内联以避免额外依赖。
 * @param {unknown} error
 * @returns {boolean}
 */
function isSqliteConstraintError(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 落库单条成功行：在**独立的嵌套事务（SAVEPOINT）**内插入 `task_card`。
 *
 * 捕获真实数据库错误并转为「失败」结果——不重新抛出，不影响外层批次事务与其余行
 * （见模块头注「失败隔离语义」）。领域层已判定为成功的行在正常情形下不会走到 catch 分支；
 * 该分支只兜底领域层快照与实际落库之间的数据竞争或未预见的约束冲突。
 *
 * @param {object} successRecord `migrateRecords` 报告中 `status === 'success'` 的一条记录
 * @returns {{status: string, cardId: number|null, failureCategory: string|null, failureReason: string|null}}
 */
function persistSuccessRow(successRecord) {
  const insertCard = getDb().transaction((cardInput) => taskCardRepo.create(cardInput));
  try {
    const cardId = insertCard(toCardWriteInput(successRecord.card));
    return {
      status: RECORD_STATUS.SUCCESS,
      cardId: Number(cardId),
      failureCategory: null,
      failureReason: null,
    };
  } catch (error) {
    if (!isSqliteConstraintError(error)) throw error; // 未预见的异常向上抛出，不伪装成迁移失败
    return {
      status: RECORD_STATUS.FAILED,
      cardId: null,
      failureCategory: 'duplicate_task_no',
      failureReason: `落库时触发数据库约束冲突：${error.message}`,
    };
  }
}

// =====================================================================
// 二、主通道：Excel/CSV 导入（需求 17.1、17.2、41.1–41.6）
// =====================================================================

/**
 * 解析 Excel/CSV 文件为 `migrateRecords` 期望的结构化行集合。
 *
 * 用 `xlsx.read` 读取整本工作簿，取**第一张工作表**（迁移模板固定单表，需求未提及多表场景），
 * 经 `xlsx.utils.sheet_to_json` 按表头行转为对象数组——表头即列名，须与 `migrateRecords`
 * 期望的字段名（`task_no`/`title`/`card_type`/... ，snake_case 或 camelCase 均可，见
 * `migrate-card.js` 模块头注「输入边界」）对齐，这是迁移模板设计的职责，本函数不做列名映射。
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} fileBuffer
 * @returns {Record<string, unknown>[]}
 * @throws {ServiceError} 文件内容无法解析为工作簿，或工作簿不含任何工作表（400）
 */
export function parseExcelRows(fileBuffer) {
  let workbook;
  try {
    workbook = XLSX.read(fileBuffer, { type: 'buffer', raw: true });
  } catch (error) {
    throw new ServiceError(CODE.VALIDATION, `Excel/CSV 文件解析失败：${error.message}`);
  }
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) {
    throw new ServiceError(CODE.VALIDATION, 'Excel/CSV 文件不含任何工作表');
  }
  const sheet = workbook.Sheets[sheetName];
  // defval: null 使空单元格显式为 null（而非该键缺失），与 migrateRecords 的
  // isBlank(null) === true 判定口径一致，避免「单元格留空」与「列不存在」被区别对待。
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

/**
 * 判定该来源通道值是否属于「主通道」（Excel/CSV，需求 17.1、17.2）。
 * @param {unknown} sourceChannel
 * @returns {boolean}
 */
function isMainChannel(sourceChannel) {
  return sourceChannel === SOURCE_CHANNEL.EXCEL || sourceChannel === SOURCE_CHANNEL.CSV;
}

/**
 * 主通道导入：Excel/CSV → 解析 → 逐条校验（`migrateRecords`）→ 成功行落库 → 批次报告
 * （需求 17.1、17.2、41.1–41.6）。
 *
 * 落库顺序：
 * 1. 解析文件为 `rows`；取现存工卡集合供查重（需求 41.3）；
 * 2. `migrateRecords(rows, existingCards, stageCfg)` 产出报告（纯函数，唯一校验权威）；
 * 3. **单个外层事务**内：写 `migration_batch`（批次头，含 `total/success/failure` 计数）；
 *    逐行落库——成功行经 {@link persistSuccessRow} 在**嵌套 SAVEPOINT** 内插入 `task_card`，
 *    真实 DB 错误只使该行失败（不影响其余行、不影响外层事务）；失败行（领域层已判定）直接
 *    记录，不触库；每行落一条 `migration_record`。
 * 4. 返回完整报告（`byCategory` 原样转交，不重新分类）+ 批次 id。
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} fileBuffer Excel/CSV 文件内容
 * @param {{
 *   operatorId?: string, staffNo?: string, userId?: string,
 *   sourceChannel?: 'excel' | 'csv', sourceName?: string,
 * }} ctx 调用上下文；`sourceChannel` 缺省取 `'excel'`
 * @returns {{
 *   batchId: number, successCount: number, failureCount: number, totalCount: number,
 *   byCategory: Record<string, number>,
 *   records: ReadonlyArray<{
 *     rowNo: number, sourceTaskNo: string|null, status: string,
 *     cardId: number|null, failureCategory: string|null, failureReason: string|null,
 *   }>,
 * }}
 * @throws {ServiceError} 缺少操作人标识（400）、文件解析失败（400）
 */
export function importRows(rows, ctx) {
  if (!Array.isArray(rows)) {
    throw new ServiceError(CODE.VALIDATION, '迁移确认数据 rows 须为数组');
  }

  const operatorId = operatorIdOf(ctx);
  const sourceChannel = ctx?.sourceChannel ?? SOURCE_CHANNEL.EXCEL;
  if (!Object.values(SOURCE_CHANNEL).includes(sourceChannel)) {
    throw new ServiceError(CODE.VALIDATION, `不支持的迁移来源通道：${String(sourceChannel)}`);
  }
  const sourceName = ctx && typeof ctx === 'object' ? ctx.sourceName ?? null : null;

  const existingCards = listExistingCardsForDuplicateCheck();
  const report = migrateRecords(rows, existingCards, loadStageCfg());

  return withTransaction(() => {
    // 先在嵌套 SAVEPOINT 中逐行落库（真实 DB 冲突只使该行失败，不影响其余行），
    // 取得**实际**落库结果后才写批次头——批次头的计数须反映实际落库结果，而非领域层
    // 判定为成功的 report.successCount/failureCount（正常情形下两者相等，见模块头注
    // 「失败隔离语义」；仅在数据竞争等边界情形下会出现分歧）。
    const outcomeRecords = report.records.map((record) => (
      record.status === RECORD_STATUS.SUCCESS
        ? { rowNo: record.rowNo, sourceTaskNo: record.sourceTaskNo, ...persistSuccessRow(record) }
        : {
          rowNo: record.rowNo,
          sourceTaskNo: record.sourceTaskNo,
          status: RECORD_STATUS.FAILED,
          cardId: null,
          failureCategory: record.failureCategory,
          failureReason: record.reason,
        }
    ));

    const actualSuccessCount = outcomeRecords.filter((r) => r.status === RECORD_STATUS.SUCCESS).length;
    const actualFailureCount = outcomeRecords.length - actualSuccessCount;

    const batchId = migrationRepo.createBatch({
      sourceChannel,
      sourceName,
      totalCount: report.totalCount,
      successCount: actualSuccessCount,
      failureCount: actualFailureCount,
      executedBy: operatorId,
      executedAt: new Date().toISOString(),
    });

    for (const outcome of outcomeRecords) {
      migrationRepo.createRecord({
        batchId,
        rowNo: outcome.rowNo,
        sourceTaskNo: outcome.sourceTaskNo,
        cardId: outcome.cardId,
        status: outcome.status,
        failureCategory: outcome.failureCategory,
        failureReason: outcome.failureReason,
      });
    }

    return {
      batchId: Number(batchId),
      successCount: actualSuccessCount,
      failureCount: actualFailureCount,
      totalCount: report.totalCount,
      byCategory: report.byCategory,
      records: Object.freeze(outcomeRecords),
    };
  });
}

export function importFromExcel(fileBuffer, ctx) {
  const sourceChannel = isMainChannel(ctx?.sourceChannel) ? ctx.sourceChannel : SOURCE_CHANNEL.EXCEL;
  return importRows(parseExcelRows(fileBuffer), { ...ctx, sourceChannel });
}

// =====================================================================
// 三、辅通道：Word/RTF 预览（需求 17.1、17.2 的人工确认前置步骤）
// =====================================================================

/** 启发式段落切分的候选标签——出现任一标签即视为新工序候选段的起点。 */
const SEGMENT_BOUNDARY_TAGS = Object.freeze(['h1', 'h2', 'h3', 'table']);

/**
 * 极简 HTML 段落切分：按 {@link SEGMENT_BOUNDARY_TAGS} 中任一标签的**起始标签**位置切分全文，
 * 每段起点标签本身的类型即该段的 `boundaryTag`。切分前的引言部分（无边界标签之前的内容，
 * 若非空白）作为 `rowNo: 0` 的前言段落一并返回，便于人工确认时不遗漏文档头部内容。
 *
 * ⚠ 本函数是**故意从简的启发式**（design.md「迁移解析层」辅通道定性为 best-effort 预览），
 * 不做完整 HTML 解析（不处理嵌套标签、不做 DOM 树构建），仅用正则定位边界标签位置——
 * 这与本函数的产出用途一致：切出的每段只是「候选段落」，供人工在预览界面里重新核对与编辑，
 * 而非可直接落库的结构化数据。
 *
 * @param {string} html `mammoth.convertToHtml` 产出的 HTML 字符串
 * @returns {{ boundaryTag: string | null, html: string }[]} 切分后的候选段落（保留原始 HTML 片段）
 */
function segmentHtmlByHeadingsAndTables(html) {
  const text = typeof html === 'string' ? html : '';
  const boundaryPattern = new RegExp(`<(${SEGMENT_BOUNDARY_TAGS.join('|')})[^>]*>`, 'gi');

  const boundaries = [];
  let match;
  while ((match = boundaryPattern.exec(text)) !== null) {
    boundaries.push({ index: match.index, tag: match[1].toLowerCase() });
  }

  if (boundaries.length === 0) {
    return text.trim().length > 0 ? [{ boundaryTag: null, html: text }] : [];
  }

  const segments = [];
  const preamble = text.slice(0, boundaries[0].index);
  if (preamble.trim().length > 0) {
    segments.push({ boundaryTag: null, html: preamble });
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i].index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : text.length;
    segments.push({ boundaryTag: boundaries[i].tag, html: text.slice(start, end) });
  }

  return segments;
}

/** 去除 HTML 标签，保留纯文本（供预览候选段的简要标题/摘要展示，不作为落库字段）。 */
function stripHtmlTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 从段落纯文本首行推断候选工序标题（截断至合理长度，仅作预览展示提示，不参与任何校验）。
 * @param {string} plainText
 * @returns {string}
 */
function guessCandidateTitle(plainText) {
  const firstLine = plainText.split(/[。.\n]/)[0] ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

/**
 * Word(.docx)/RTF 迁移辅通道：转 HTML → 启发式切分为工序候选段落 → 返回预览结构
 * （需求 17.1、17.2 的人工确认前置步骤，design.md「迁移解析层」辅通道）。
 *
 * ⚠ **只读、不落库**：本函数不写任何表，不产生工卡，不调用 `migrateRecords`。产出的
 * `candidateSteps` 仅供前端预览界面展示，人工确认/编辑后应由前端组装为 `rows` 并调用
 * {@link importFromExcel} 走主通道——本模块不提供绕开人工确认的直达路径。
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} fileBuffer .docx 文件内容
 *   （`mammoth` 仅支持 .docx；.rtf 若上游已转换为等价文本流亦可复用同一入口，本函数不区分）
 * @returns {Promise<{
 *   rawHtml: string,
 *   candidateSteps: ReadonlyArray<{
 *     rowNo: number, boundaryTag: string | null, suggestedTitle: string,
 *     plainText: string, html: string,
 *   }>,
 * }>}
 * @throws {ServiceError} 文档转换失败（400，如非合法 .docx 内容）
 */
export async function previewFromWord(fileBuffer) {
  let conversion;
  try {
    conversion = await mammoth.convertToHtml({ buffer: fileBuffer });
  } catch (error) {
    throw new ServiceError(CODE.VALIDATION, `Word/RTF 文档转换失败：${error.message}`);
  }

  const rawHtml = conversion.value ?? '';
  const segments = segmentHtmlByHeadingsAndTables(rawHtml);

  const candidateSteps = segments.map((segment, index) => {
    const plainText = stripHtmlTags(segment.html);
    return Object.freeze({
      rowNo: index + 1,
      boundaryTag: segment.boundaryTag,
      suggestedTitle: guessCandidateTitle(plainText),
      plainText,
      html: segment.html,
    });
  });

  return Object.freeze({ rawHtml, candidateSteps: Object.freeze(candidateSteps) });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** RTF is decoded as text only. It never enters mammoth or an HTML parser. */
export function previewFromRtf(fileBuffer) {
  const source = Buffer.from(fileBuffer ?? []).toString('utf8');
  const plainText = source
    .replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\par[d]?\s?/g, '\n')
    .replace(/\\tab\s?/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/\\([{}\\])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\r/g, '')
    .trim();
  const paragraphs = plainText.split(/\n+/).map((text) => text.trim()).filter(Boolean);
  const candidateSteps = paragraphs.map((text, index) => Object.freeze({
    rowNo: index + 1,
    boundaryTag: null,
    suggestedTitle: guessCandidateTitle(text),
    plainText: text,
    html: `<p>${escapeHtml(text)}</p>`,
  }));
  return Object.freeze({
    rawText: plainText,
    rawHtml: `<pre>${escapeHtml(plainText)}</pre>`,
    candidateSteps: Object.freeze(candidateSteps),
  });
}

// =====================================================================
// 四、批次报告只读查询（需求 41.4、41.5，直通 `migrationRepo`）
// =====================================================================

/**
 * 取某批次的完整报告：批次头 + 全部逐行结果（需求 41.4）。
 * @param {number | string} batchId
 * @returns {{ batch: object, records: object[] }}
 * @throws {ServiceError} 批次不存在（404）
 */
export function getBatchReport(batchId) {
  const batch = migrationRepo.findBatchById(batchId);
  if (batch === null) {
    throw new ServiceError(CODE.NOT_FOUND, `迁移批次不存在：${String(batchId)}`);
  }
  const records = migrationRepo.listRecordsByBatchId(batchId);
  const byCategory = records.reduce((counts, record) => {
    if (record.failureCategory) counts[record.failureCategory] = (counts[record.failureCategory] ?? 0) + 1;
    return counts;
  }, {});
  return { batch, records, byCategory };
}

/**
 * 分页列出迁移批次（需求 41.4：只读直通转发，不叠加业务逻辑）。
 * @param {{ page?: number, pageSize?: number }} [options]
 * @returns {{ list: object[], total: number, page: number, pageSize: number }}
 */
export function listBatches(options = {}) {
  return migrationRepo.listBatches(options);
}

export default {
  importRows,
  importFromExcel,
  previewFromWord,
  previewFromRtf,
  getBatchReport,
  listBatches,
  SOURCE_CHANNEL,
};
