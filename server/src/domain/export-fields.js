/**
 * 导出字段划分领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 需求 3.6「关键信息导出」与 3.7「全量导出」未列明字段范围，字段划分依《临时设计说明》D-05：
 * - `key`：需求 2.1 的清单展示字段（是否 FAI、Gear Type、模板类型、工卡类型、工卡编号、
 *   工卡标题）+ 工卡状态（需求 2.2）+ 版本；
 * - `all`：`task_card` 全部列 + 参考文件（`reference_document`）与工序（`process_step`）的
 *   **展开行**——一张工卡在产物中占 1 行卡头 + N 行参考文件 + M 行工序，各分节自带表头，
 *   首列 `row_type` 标明行类别，子行以 `task_no` + `revision` 回指所属工卡。
 *
 * 职责边界：**本模块只给出字段划分与单元格取值格式**，不拼 CSV。
 * CSV 信封（UTF-8 带 BOM、逗号分隔、CRLF 换行、`Content-Disposition`）是服务层的事
 * （design.md「导出产物格式」、任务 13.10）。
 *
 * ⚠ `revision` 在库内为 INTEGER（初始 1），导出一律输出**两位补零文本**（`01`、`02`…）
 * 以与打印/界面口径一致（design.md）。见 {@link formatRevision}。
 *
 * ⚠ 需求 5.2「打印输出不展示工卡分类」**只约束打印**：需求 2.1 明确要求清单展示工卡类型，
 * 故 `card_type` 是关键导出的字段之一，不得在此剔除。
 *
 * 需求：3.6、3.7（字段范围依 D-05；关键字段清单依 2.1、2.2）
 */

/** 导出模式（`GET /api/task-cards/export?mode=`） */
export const EXPORT_MODES = Object.freeze(['key', 'all']);

/** 展开行的行类别标识（`all` 模式首列取值） */
export const EXPORT_ROW_TYPE = Object.freeze({
  CARD: 'task_card',
  REFERENCE_DOC: 'reference_document',
  PROCESS_STEP: 'process_step',
});

/**
 * 单元格取值格式：
 * - `text`    原样文本（`null` / `undefined` → 空串）
 * - `integer` 整数
 * - `number`  实数（工时等）
 * - `revision` 两位补零文本（见 {@link formatRevision}）
 * - `flag`    SQLite 的 0/1 布尔列，输出 `1` / `0`
 */
export const FIELD_FORMAT = Object.freeze({
  TEXT: 'text',
  INTEGER: 'integer',
  NUMBER: 'number',
  REVISION: 'revision',
  FLAG: 'flag',
});

const field = (key, header, format = FIELD_FORMAT.TEXT) => Object.freeze({ key, header, format });

/** 展开行首列：行类别（仅 `all` 模式） */
export const ROW_TYPE_FIELD = field('row_type', 'Row Type');

/**
 * 关键信息导出字段（需求 3.6、D-05）：需求 2.1 六项按其列举顺序 + 状态（2.2）+ 版本。
 */
export const KEY_EXPORT_FIELDS = Object.freeze([
  field('is_fai', 'FAI', FIELD_FORMAT.FLAG),
  field('gear_type', 'Gear Type'),
  field('template_type', 'Template Type'),
  field('card_type', 'Card Type'),
  field('task_no', 'Task No'),
  field('title', 'Title'),
  field('status', 'Status'),
  field('revision', 'Revision', FIELD_FORMAT.REVISION),
]);

/**
 * `task_card` 全部列（需求 3.7、D-05），顺序与 schema.sql 的 DDL 一致。
 * 表新增列时须同步在此登记——全量导出「全部字段」的口径以本清单为准。
 */
export const CARD_EXPORT_FIELDS = Object.freeze([
  field('id', 'ID', FIELD_FORMAT.INTEGER),
  field('task_no', 'Task No'),
  field('revision', 'Revision', FIELD_FORMAT.REVISION),
  field('title', 'Title'),
  field('date', 'Revision Date'),
  field('ac_type', 'A/C Type'),
  field('gear_type', 'Gear Type'),
  field('stage', 'Stage'),
  field('skill', 'Skill'),
  field('ctrl_code', 'Ctrl Code'),
  field('card_type', 'Card Type'),
  field('is_fai', 'FAI', FIELD_FORMAT.FLAG),
  field('template_type', 'Template Type'),
  field('status', 'Status'),
  field('document_type', 'Document Type'),
  field('ref_no', 'Ref No'),
  field('document_revision', 'Document Revision'),
  field('document_desc', 'Document Desc'),
  field('base_number', 'Base Number'),
  field('ipc_item_no', 'IPC Item No'),
  field('created_by', 'Created By'),
  field('reviewed_by', 'Reviewed By'),
  field('ndt_reviewer', 'NDT Reviewer'),
  field('ata_chapter', 'ATA Chapter'),
  field('check_type', 'Check Type'),
  field('commercial_classification', 'Commercial Classification'),
  field('outsource_subtype', 'Outsource Subtype'),
  field('last_update', 'Last Update'),
  field('operator_id', 'Operator ID'),
  field('naming_rule_origin', 'Naming Rule Origin'),
]);

/** 子行回指所属工卡的键（`task_card` 的业务唯一键 `UNIQUE(task_no, revision)`） */
export const PARENT_KEY_FIELDS = Object.freeze([
  field('task_no', 'Task No'),
  field('revision', 'Revision', FIELD_FORMAT.REVISION),
]);

/** 参考文件展开行字段（`reference_document` 全部业务列，需求 9.1–9.3） */
export const REFERENCE_DOC_EXPORT_FIELDS = Object.freeze([
  field('id', 'Reference ID', FIELD_FORMAT.INTEGER),
  field('doc_type', 'Doc Type'),
  field('ref_no', 'Ref No'),
  field('doc_revision', 'Doc Revision'),
  field('ata_chapter', 'ATA Chapter'),
]);

/** 工序展开行字段（`process_step` 全部业务列，需求 10–12、30、31） */
export const PROCESS_STEP_EXPORT_FIELDS = Object.freeze([
  field('id', 'Step ID', FIELD_FORMAT.INTEGER),
  field('process_id', 'Process ID'),
  field('seq', 'Seq', FIELD_FORMAT.INTEGER),
  field('skill', 'Skill'),
  field('ref_doc_id', 'Ref Doc ID', FIELD_FORMAT.INTEGER),
  field('operation', 'Operation'),
  field('work_category', 'Work Category'),
  field('estimated_man_hours', 'Estimated Man Hours', FIELD_FORMAT.NUMBER),
  field('description_zh', 'Description (ZH)'),
  field('description_en', 'Description (EN)'),
  field('safety_warning', 'Safety Warning'),
  field('visual_cue', 'Visual Cue'),
  field('repair_tips', 'Repair Tips'),
  field('is_critical', 'Critical', FIELD_FORMAT.FLAG),
]);

/** 模式合法性判定 */
export function isExportMode(mode) {
  return typeof mode === 'string' && EXPORT_MODES.includes(mode);
}

/**
 * 版本号展示格式：两位补零文本（design.md——库内 INTEGER，仅展示补零）。
 * 位数不足补零，超两位原样输出（`100` → `100`，不截断）；取不到有限数值时返回空串。
 * @param {unknown} value
 * @returns {string}
 */
export function formatRevision(value) {
  const num = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) return '';
  const int = Math.trunc(num);
  const abs = String(Math.abs(int)).padStart(2, '0');
  return int < 0 ? `-${abs}` : abs;
}

/**
 * 按字段格式取单元格文本（`null` / `undefined` 一律空串，不写 `"null"`）。
 * 不做 CSV 转义（引号/逗号/换行的处理属信封职责，见任务 13.10）。
 *
 * @param {{format: string}} fieldDef 字段描述（{@link KEY_EXPORT_FIELDS} 等的元素）
 * @param {unknown} value 行上该字段的原始值
 * @returns {string}
 */
export function formatExportValue(fieldDef, value) {
  const format = fieldDef?.format ?? FIELD_FORMAT.TEXT;
  if (format === FIELD_FORMAT.REVISION) return formatRevision(value);
  if (value === null || value === undefined) return '';
  switch (format) {
    case FIELD_FORMAT.FLAG: {
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (typeof value === 'number') return value !== 0 ? '1' : '0';
      if (typeof value === 'string') {
        const raw = value.trim().toLowerCase();
        if (raw === '') return '';
        return ['0', 'false', 'no'].includes(raw) ? '0' : '1';
      }
      return value ? '1' : '0';
    }
    case FIELD_FORMAT.INTEGER: {
      const num = Number(value);
      return Number.isFinite(num) ? String(Math.trunc(num)) : '';
    }
    case FIELD_FORMAT.NUMBER: {
      const num = Number(value);
      return Number.isFinite(num) ? String(num) : '';
    }
    default:
      return String(value);
  }
}

const section = (name, rowType, fields, parentKeys = []) => Object.freeze({
  name,
  rowType,
  parentKeys: Object.freeze([...parentKeys]),
  fields: Object.freeze([...fields]),
  headers: Object.freeze([...parentKeys, ...fields].map((item) => item.header)),
});

const KEY_RESULT = Object.freeze({
  mode: 'key',
  discriminator: null,
  fields: KEY_EXPORT_FIELDS,
  sections: Object.freeze([
    section(EXPORT_ROW_TYPE.CARD, EXPORT_ROW_TYPE.CARD, KEY_EXPORT_FIELDS),
  ]),
});

const ALL_RESULT = Object.freeze({
  mode: 'all',
  discriminator: ROW_TYPE_FIELD,
  fields: CARD_EXPORT_FIELDS,
  sections: Object.freeze([
    section(EXPORT_ROW_TYPE.CARD, EXPORT_ROW_TYPE.CARD, CARD_EXPORT_FIELDS),
    section(
      EXPORT_ROW_TYPE.REFERENCE_DOC, EXPORT_ROW_TYPE.REFERENCE_DOC,
      REFERENCE_DOC_EXPORT_FIELDS, PARENT_KEY_FIELDS,
    ),
    section(
      EXPORT_ROW_TYPE.PROCESS_STEP, EXPORT_ROW_TYPE.PROCESS_STEP,
      PROCESS_STEP_EXPORT_FIELDS, PARENT_KEY_FIELDS,
    ),
  ]),
});

/**
 * 导出字段划分（需求 3.6、3.7；字段范围依《临时设计说明》D-05）。
 *
 * - `key`：单一分节，字段即 {@link KEY_EXPORT_FIELDS}（需求 2.1 六项 + 状态 + 版本），
 *   无行类别列（产物为一张平表，一卡一行）。
 * - `all`：三个分节——`task_card` 全部列、参考文件展开行、工序展开行；后两者以
 *   `parentKeys`（`task_no` + `revision`）回指所属工卡，`discriminator` 为首列行类别字段。
 *
 * 返回值（含其中的字段数组）全部冻结，服务层不得就地改写。
 *
 * @param {string} mode `'key'` | `'all'`
 * @returns {{mode: string, discriminator: object|null, fields: ReadonlyArray<object>, sections: ReadonlyArray<object>}}
 * @throws {TypeError} `mode` 越出 {@link EXPORT_MODES}（服务层据此回 400）
 */
export function exportFields(mode) {
  if (!isExportMode(mode)) {
    throw new TypeError(`exportFields：导出模式须为 ${EXPORT_MODES.join(' | ')}，收到 ${String(mode)}`);
  }
  return mode === 'key' ? KEY_RESULT : ALL_RESULT;
}
