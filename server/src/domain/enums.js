/**
 * 领域枚举模块 —— 全系统枚举的**唯一事实来源**（Single Source of Truth）。
 *
 * - `schema.sql` 的 `CHECK` 约束由本模块 `renderCheckConstraint()` 渲染生成，禁止在 DDL 中二次手写。
 * - 属于《临时设计说明》待澄清项的枚举（`SIGNATURE_ROLE`/A3、`STAGE_CROSSCUT`/A4、
 *   `DERIVATION_PRIORITY`/A1）**同时**落配置表，运行时以配置表为权威，本模块仅提供种子默认值。
 * - Ctrl Code 与 Skill 为**相互独立值域**（需求 6.10）：同码（AS、CL）不同义，不合并、不共用字典。
 *
 * 需求：6.3–6.10, 16.1, 16.2, 16.4, 16.5, 29.1, 29.3, 45.2, 47.1, 4.5
 */

/** 机型 A/C Type（需求 6.3） */
export const AC_TYPE = Object.freeze([
  '190', '195', '320', '32E', '330', '350', '737', '73C', '741', '744',
  '747', '748', '757', '767', '777', '787', '909', '919', '999', 'A21',
]);

/** 起落架类型 Gear Type（需求 6.4） */
export const GEAR_TYPE = Object.freeze(['BLG', 'LDG', 'MLG', 'N/A', 'NLG', 'WLG']);

/** 阶段 Stage（需求 6.5） */
export const STAGE = Object.freeze(['CUS', 'DMY', 'MOD', 'NRC', 'RTN', 'SPC', 'WCC', 'WFD']);

/** 专业 Skill（需求 6.6）——与 CTRL_CODE 为独立值域，不共用字典 */
export const SKILL = Object.freeze([
  'AS', 'BH', 'CL', 'DI', 'EL', 'GR', 'IR', 'LA', 'LT', 'ML',
  'NC', 'NT', 'PL', 'PP', 'PPC', 'QC', 'SC', 'SP', 'TS', 'TSC',
]);

/**
 * 控制代码 Ctrl Code（需求 6.7）
 * ⚠ 待业务方确认（《临时设计说明》前序遗留 2）：蓝图描述列错位。
 * 需求 6.10：与 Skill 为相互独立值域，同码（AS、CL）不同义，不合并、不共用字典。
 */
export const CTRL_CODE = Object.freeze(['AS', 'CL', 'DA', 'FAB', 'FT', 'IS', 'LD', 'MD', 'OHV']);

/**
 * 工卡类型编码 01–11（需求 16.1）。
 * 注：需求 6.8 明确 WBS 与工卡类型为同一字段的两种称法，系统内仅以 `task_card.card_type`
 * 单列存储，前端 WBS 下拉即绑定该列；需求 8 的 IR 卡判定为 `card_type === '04'`。
 */
export const CARD_TYPE = Object.freeze({
  '01': '收货检查工卡 / Receiving inspection card',
  '02': '拆分卡 / Disassembly card',
  '03': '预处理卡 / Pre-treatment card',
  '04': 'IR卡 / IR Inspection card',
  '05': 'IR Lot卡 / Lot card',
  '06': '组装/测试卡 / Assembly card',
  '07': '电线卡 / Electrical card',
  '08': 'LRU Subcontract卡 / LRU Subcontract card',
  '09': '单独件维修卡 / Individual repair card',
  '10': 'AD/SB/SL卡 / AD/SB/SL card',
  '11': '客户特殊要求卡 / Customer special card',
});

/**
 * 工卡类型编码集（供校验与 DDL 渲染使用）。
 *
 * ⚠ 显式字面量而非 `Object.keys(CARD_TYPE)`：`'10'`、`'11'` 属 JS 的整数索引键，
 * 会被引擎提前至 `'01'` 之前，导致 DDL 渲染顺序不确定。此处固定 01–11 的自然顺序，
 * 并在下方以断言保证与 `CARD_TYPE` 的键集合一致（缺漏即模块加载期失败）。
 */
export const CARD_TYPE_CODES = Object.freeze([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11',
]);

{
  const keys = Object.keys(CARD_TYPE);
  const missing = keys.filter((k) => !CARD_TYPE_CODES.includes(k));
  const extra = CARD_TYPE_CODES.filter((k) => !keys.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `CARD_TYPE 与 CARD_TYPE_CODES 不一致：CARD_TYPE 多出 [${missing}]，CARD_TYPE_CODES 多出 [${extra}]`,
    );
  }
}

/** 执行过程单据类型（需求 16.2） */
export const EXEC_DOC_TYPE = Object.freeze([
  'CR', 'PC', 'LT', 'BH', 'TS', 'SC', 'NR', 'PR', 'EN', 'SW', 'TA',
]);

/** 执行过程单据的签署要求属性（需求 16.4、16.5） */
export const EXEC_DOC_SIGN_RULE = Object.freeze({
  CR: '签署',
  PC: '签署',
  LT: '签署',
  BH: '签署',
  TS: '签署',
  SC: '单据不签署，所发工卡步骤需签署',
  NR: '签署',
  PR: '签署',
  EN: '签署',
  SW: '签署',
  TA: '签署',
});

/** 工卡状态：新增 / 审核中 / 生效 / 已被取代 / 作废（需求 4、34、44） */
export const CARD_STATUS = Object.freeze(['New', 'UnderReview', 'Effective', 'Superseded', 'Void']);

/** 允许的状态迁移（需求 4.5–4.7）；Superseded / Void 为终态，无出边 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  New: Object.freeze(['UnderReview', 'Void']),        // 提交审核 / 作废
  UnderReview: Object.freeze(['Effective', 'New']),   // 批准 / 驳回
  Effective: Object.freeze(['Superseded', 'Void']),   // 被更高版本取代（系统自动）/ 作废
  Superseded: Object.freeze([]),                      // 终态
  Void: Object.freeze([]),                            // 终态
});

/**
 * 组件插入类型（需求 13.1）：前 12 类为蓝图明列，`signature` 承载 I.8。
 * 采集项 `capture_item.type` 与本集合**共用类型定义**（需求 12.2）。
 */
export const COMPONENT_TYPE = Object.freeze([
  'measurement', 'table', 'text', 'tool', 'image', 'video',
  'audio', 'range', 'consumable', 'time', 'dataGroup', 'custom',
  'signature',
]);

/** 签署角色（需求 45.2）⚠ Hotfix 假定（《临时设计说明》A3），运行时以配置表为权威 */
export const SIGNATURE_ROLE = Object.freeze(['Operator', 'QC', 'NDT', 'CertifyingStaff']);

/** 商务执行工卡分类（需求 29.1） */
export const COMMERCIAL_CLASSIFICATION = Object.freeze([
  'Gear Inspection', 'Routine', 'Material Special Replacement',
  'SB/AD/SL', 'NRC', 'LLP', 'Configuration(MOD)', 'Outsource', 'Dummy Job',
]);

/** 外包二级细分（需求 29.3） */
export const OUTSOURCE_SUBTYPE = Object.freeze(['L sub', '工序外委']);

/**
 * 商务分类派生优先级链（需求 29.2）⚠ 顺序为 Hotfix 假定（《临时设计说明》A1）。
 * 运行时权威为 `derivation_priority_config` 表，本常量仅作种子默认值。
 */
export const DERIVATION_PRIORITY = Object.freeze([
  'P1_PlanSetting',      // Dummy Job
  'P2_OriginatingDoc',   // NRC
  'P3_OutsourceList',    // Outsource（L sub / 工序外委）
  'P4_PartNature',       // LLP
  'P5_PackageDivision',  // Routine / Material Special Replacement / Configuration(MOD)
  'P6_CardTypeFallback', // 依 card_type_commercial_map 兜底，永不覆盖 P1–P5
]);

/** 系统角色（需求 47.1） */
export const ROLE = Object.freeze([
  'TS_Engineer', 'TS_Manager', 'NDT_Reviewer',
  'Planning_Engineer', 'Planning_Manager',
  'Production_Technician', 'Production_Manager', 'QA_Engineer',
]);

/** 权限点值域（需求 47.2–47.9）——`role_permission.permission_point` 的封闭取值集 */
export const PERMISSION_POINT = Object.freeze([
  'card_read',            // 清单查询与详情查看（TS / Planning / Production / QA 均可）
  'card_edit',            // 新增 / 编辑 / 复制 / 升版（TS_Engineer）
  'card_submit_review',   // 提交审核（TS_Engineer）
  'card_review',          // 批准 / 驳回（TS_Manager，受一编一审约束）
  'card_void',            // 作废（TS_Manager）
  'card_release',         // 发布至工包（TS_Engineer）
  'card_print_export',    // 打印与导出
  'batch_replace',        // 批量替换（独立权限点，需求 20.9、47.9，不由 card_edit 继承）
  'migration_run',        // 存量迁移执行
  'ppc_manhours_write',   // 工序 Work Category / Estimated ManHours 写入（Planning_*）
  'job_exec_write',       // JOB 执行数据写入（Production_*）
  'capability_write',     // 能力清单维护（QA_Engineer）
  'config_write',         // 约束表 / 映射 / 优先级链 / 打印模板等配置维护
]);

/**
 * 横切 Stage 取值（需求 46.13）⚠ Hotfix 假定（《临时设计说明》A4）。
 * 不受工卡类型约束，可与任意类型共存；需求 46.12 修正后 Stage 不置只读，故本集合对全部类型可达。
 */
export const STAGE_CROSSCUT = Object.freeze(['DMY', 'NRC', 'WCC', 'WFD']);

/**
 * 字段 → 值域映射。键为**逻辑字段名**（camelCase）；`isValidEnumValue` 与
 * `renderCheckConstraint` 均接受 camelCase / snake_case / SCREAMING_SNAKE 三种写法。
 *
 * ⚠ `ctrlCode` 与 `skill` 是两个**独立条目**，不得合并或互相引用。
 */
export const ENUMS = Object.freeze({
  acType: AC_TYPE,
  gearType: GEAR_TYPE,
  stage: STAGE,
  skill: SKILL,
  ctrlCode: CTRL_CODE,
  cardType: CARD_TYPE_CODES,
  execDocType: EXEC_DOC_TYPE,
  cardStatus: CARD_STATUS,
  componentType: COMPONENT_TYPE,
  signatureRole: SIGNATURE_ROLE,
  commercialClassification: COMMERCIAL_CLASSIFICATION,
  outsourceSubtype: OUTSOURCE_SUBTYPE,
  derivationPriority: DERIVATION_PRIORITY,
  role: ROLE,
  permissionPoint: PERMISSION_POINT,
  stageCrosscut: STAGE_CROSSCUT,
});

/** 字段名归一化：忽略大小写与分隔符，使 `ctrl_code` / `ctrlCode` / `CTRL_CODE` 等价 */
function normalizeFieldKey(field) {
  if (typeof field !== 'string') return null;
  return field.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}

/** 归一化键 → 规范字段名（`ENUMS` 的键） */
const FIELD_ALIAS = Object.freeze(
  Object.keys(ENUMS).reduce((acc, key) => {
    acc[normalizeFieldKey(key)] = key;
    return acc;
  }, Object.create(null)),
);

/**
 * 取字段对应的值域数组；字段未知时返回 `null`（不抛异常，便于调用方分支处理）。
 * @param {string} field 逻辑字段名或数据库列名
 * @returns {readonly string[] | null}
 */
export function enumValues(field) {
  const key = normalizeFieldKey(field);
  if (key === null) return null;
  const canonical = FIELD_ALIAS[key];
  return canonical ? ENUMS[canonical] : null;
}

/**
 * 枚举封闭性判定：`value` 属于 `field` 的值域时为真，否则为假（需求 6.9）。
 * Ctrl Code 与 Skill 各自独立判定，互不影响（需求 6.10）。
 * 未知字段、非字符串取值一律为假。
 * @param {string} field 逻辑字段名或数据库列名
 * @param {unknown} value 候选值
 * @returns {boolean}
 */
export function isValidEnumValue(field, value) {
  const values = enumValues(field);
  if (values === null) return false;
  if (typeof value !== 'string') return false;
  return values.includes(value);
}

/** SQLite 字符串字面量转义：单引号成对重复 */
function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** camelCase → snake_case（默认列名推导） */
function toSnakeCase(field) {
  return String(field)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * 渲染 SQLite `CHECK` 约束子句，供 `schema.sql` 生成时使用——确保枚举不在 DDL 中二次手写。
 *
 * @param {string} field 逻辑字段名（如 `cardType`）或数据库列名（如 `card_type`）
 * @param {string} [columnName] 列名覆盖。同一值域可绑定不同列名
 *   （如 `stage_card_type_constraint.allowed_stage` 用 `STAGE`、`capture_item.type` 用 `COMPONENT_TYPE`），
 *   缺省时由 `field` 推导为 snake_case。
 * @returns {string} 形如 `CHECK (card_type IN ('01','02',…))`
 * @throws {Error} 字段未知时抛出——DDL 生成期失败优于生成出无约束的表
 */
export function renderCheckConstraint(field, columnName) {
  const values = enumValues(field);
  if (values === null) {
    throw new Error(`未知枚举字段：${String(field)}`);
  }
  const column = columnName ? String(columnName) : toSnakeCase(field);
  const list = values.map(quoteSqlLiteral).join(',');
  return `CHECK (${column} IN (${list}))`;
}
