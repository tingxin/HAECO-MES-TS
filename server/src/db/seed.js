/**
 * 种子数据脚本（任务 3.6）——配置默认值、主数据、集成 mock 与少量演示数据。
 *
 * ## 两种用法
 *
 * 1. **CLI**：`npm run seed`（等价 `node src/db/seed.js`）——先建表（幂等）再写种子。
 * 2. **可导入函数**：`seed(connection)`——在调用方给定的连接上写入。属性/接口测试每次迭代
 *    `openDatabase(':memory:')` → `migrate(conn)` → `seed(conn)`（design.md「测试策略」）。
 *
 * ## 幂等策略（全表统一：**先查后插**）
 *
 * 每张表声明其**自然键**，写入前按自然键查存在性，存在则跳过。选它而非
 * `INSERT OR IGNORE` 的原因：集成 mock 表（`tpc_document`/`ppc_schedule`/`process_data`/
 * `lot_list_base`/`ppc_process_data`）与 `reference_document` 等**没有** UNIQUE 约束，
 * `OR IGNORE` 对其不去重，重复执行会不断堆行。也不采用「清表重灌」：`task_card` 等表已被
 * 审计表以外键引用，且业务方可能已在演示库上改过配置，清表会连带丢失。
 *
 * ⚠ 由此带来的取舍：**既有行不会被种子覆盖**。若需把配置改回默认值，删除对应行后重跑。
 *
 * ## 运行时权威 vs. 常量
 *
 * `stage_card_type_constraint` / `stage_crosscut` / `card_type_commercial_map` /
 * `derivation_priority_config` / `capability_list` 五组表是**运行时权威**（需求 29.8、43.5、
 * 46.14）；`enums.js` 的 `STAGE_CROSSCUT`、`DERIVATION_PRIORITY` 仅作本脚本的种子默认值。
 *
 * ## Hotfix 假定标注
 *
 * 涉及《临时设计说明-待澄清项与Hotfix-20260809.md》待澄清项的种子，均在数据定义处以
 * `⚠ Hotfix 假定（A1/A3/A4/A5/A6）` 标注，便于业务方澄清后定位替换。
 *
 * 需求：6.3–6.8, 16.1, 16.2, 16.4, 23.2, 25.1, 25.2, 26.4, 27.2, 29.8, 30.1, 35.1,
 *       39.1, 39.4, 40.4, 43.1, 43.2, 46.9, 46.13, 47.1–47.9, 48.3
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CARD_TYPE_CODES,
  DERIVATION_PRIORITY,
  EXEC_DOC_SIGN_RULE,
  EXEC_DOC_TYPE,
  PERMISSION_POINT,
  ROLE,
  STAGE_CROSSCUT,
} from '../domain/enums.js';
import { closeDb, getDb, openDatabase, resolveDbPath } from './connection.js';
import { migrate } from './migrate.js';

// =====================================================================
// 1. 用户主数据（需求 47.1、22.3、7.4）
// =====================================================================

/**
 * 演示账号：每角色至少一个；**TS_Engineer 与 TS_Manager 各两个**——需求 22.3 一编一审
 * 需要「编制人 ≠ 审核人」的用例，单账号角色无法构造该场景。
 */
export const SEED_USERS = Object.freeze([
  { staff_no: 'E10001', name: '张伟（TS 工程师）', role: 'TS_Engineer' },
  { staff_no: 'E10002', name: '陈静（TS 工程师）', role: 'TS_Engineer' },
  { staff_no: 'E20001', name: '李国强（TS 经理）', role: 'TS_Manager' },
  { staff_no: 'E20002', name: '王敏（TS 经理）', role: 'TS_Manager' },
  { staff_no: 'E30001', name: '刘宇（NDT 审核人）', role: 'NDT_Reviewer' },
  { staff_no: 'E40001', name: '赵倩（计划工程师）', role: 'Planning_Engineer' },
  { staff_no: 'E40002', name: '孙鹏（计划经理）', role: 'Planning_Manager' },
  { staff_no: 'E50001', name: '周涛（生产技师）', role: 'Production_Technician' },
  { staff_no: 'E50002', name: '吴磊（生产经理）', role: 'Production_Manager' },
  { staff_no: 'E60001', name: '郑丽（QA 工程师）', role: 'QA_Engineer' },
]);

// =====================================================================
// 2. 角色 × 权限点矩阵（需求 47.1–47.10、20.9）
// =====================================================================

/**
 * 每角色**被允许**的权限点集合；未列出者一律显式落 `allowed = 0`，
 * 故本表恒为 8 角色 × 13 权限点 = 104 行的完整矩阵（`GET /api/me/permissions`
 * 与后端越权判定读同一张表，前端禁用与后端拦截口径一致）。
 *
 * 边界依据（需求 47.2–47.9）：
 * - TS_Engineer 编制但**不审核**；TS_Manager 审核/作废但**不编制**。
 * - `ppc_manhours_write` 仅 Planning_*：TS 对 Work Category / Estimated ManHours 只读（47.4、47.5）。
 * - `job_exec_write` 仅 Production_*：不得修改编制域内容（47.7）。
 * - `capability_write` 仅 QA_Engineer：不得编制或审核（47.8）。
 * - `batch_replace` **独立权限点**，TS_Engineer 虽有 `card_edit` 亦为 0——需求 20.9、47.9
 *   要求「具备编卡权限不自动获得批量替换权限」，默认只授予 TS_Manager，须显式配置方可下放。
 * - `config_write` / `capability_write` 同样不由 `card_edit` 继承。
 *
 * ⚠ Hotfix 假定（A5 跨部门角色与权限边界）：需求 47 未指明 `config_write` 与
 * `migration_run` 的归属角色。此处按「配置维护属管理动作、存量迁移属编制动作」取默认：
 * `config_write` → TS_Manager；`migration_run` → TS_Engineer + TS_Manager（需求 41 迁移
 * 由 TS_Engineer 发起）。澄清后调整本表即可，无需改代码。
 */
export const ROLE_PERMISSION_MATRIX = Object.freeze({
  TS_Engineer: ['card_read', 'card_edit', 'card_submit_review', 'card_release', 'card_print_export', 'migration_run'],
  TS_Manager: ['card_read', 'card_review', 'card_void', 'card_print_export', 'batch_replace', 'migration_run', 'config_write'],
  NDT_Reviewer: ['card_read', 'card_print_export'],
  Planning_Engineer: ['card_read', 'card_print_export', 'ppc_manhours_write'],
  Planning_Manager: ['card_read', 'card_print_export', 'ppc_manhours_write'],
  Production_Technician: ['card_read', 'card_print_export', 'job_exec_write'],
  Production_Manager: ['card_read', 'card_print_export', 'job_exec_write'],
  QA_Engineer: ['card_read', 'card_print_export', 'capability_write'],
});

/** 展开为 8×13 完整矩阵行 */
export function buildRolePermissionRows() {
  const rows = [];
  for (const role of ROLE) {
    const allowedPoints = ROLE_PERMISSION_MATRIX[role] ?? [];
    for (const point of PERMISSION_POINT) {
      rows.push({ role, permission_point: point, allowed: allowedPoints.includes(point) ? 1 : 0 });
    }
  }
  return rows;
}

// =====================================================================
// 3. 执行单据类型字典（需求 16.2、16.4、16.5）
// =====================================================================

/**
 * 中文/英文名称：蓝图仅给出 SC、SW、LT 的全称，其余代码的名称待业务方提供，
 * 故 `name` 留空（`exec_doc_type.name` 可空），不臆造译名。
 * `sign_rule` 取自 `enums.js` 的 `EXEC_DOC_SIGN_RULE`——SC 为
 * 「单据不签署，所发工卡步骤需签署」（需求 16.5），其余为「签署」。
 */
export const EXEC_DOC_TYPE_NAMES = Object.freeze({
  LT: 'Lot List / Lot 检查记录清单',
  SC: 'Subcontract Work Order / 外包工作指令',
  SW: 'Supplementary Work Sheet (SWS) / 补充工作单',
});

// =====================================================================
// 4. Stage × 类型约束与横切取值（需求 46.9–46.13）
// =====================================================================

/**
 * 默认约束数据 ⚠ Hotfix 假定（A4 Stage 与工卡类型、工卡状态的维度关系）：
 * 01–09 → RTN（自动填入）、10 → SPC（自动填入）、11 → CUS / MOD（**不**自动填入，
 * 两值并存需人工选择）。`is_auto_fill` 仅表示默认值，Stage 字段不置只读（需求 46.12）。
 * 校验时的合法范围为「本表该类型的允许组合 ∪ stage_crosscut」（需求 46.13）。
 */
export function buildStageConstraintRows() {
  const rows = [];
  for (const cardType of CARD_TYPE_CODES) {
    if (cardType === '10') {
      rows.push({ card_type: '10', allowed_stage: 'SPC', is_auto_fill: 1 });
    } else if (cardType === '11') {
      rows.push({ card_type: '11', allowed_stage: 'CUS', is_auto_fill: 0 });
      rows.push({ card_type: '11', allowed_stage: 'MOD', is_auto_fill: 0 });
    } else {
      rows.push({ card_type: cardType, allowed_stage: 'RTN', is_auto_fill: 1 });
    }
  }
  return rows;
}

// =====================================================================
// 5. 类型 → 商务分类映射（需求 43.1、43.2，仅作 P6 兜底）
// =====================================================================

/**
 * 需求 43.2 的全部条目：
 * - 01 → Gear Inspection / Routine（双值，判定顺序见需求 29.2）
 * - 02–09 → Routine
 * - 10 → SB/AD/SL
 * - 11 → Material Special Replacement / Configuration(MOD)（双值）
 * 同一类型多行属合法（需求 43.4）：多命中不自动裁决，由人工确认（需求 29.6）。
 */
export function buildCardTypeCommercialMapRows() {
  const rows = [
    { card_type: '01', commercial_classification: 'Gear Inspection' },
    { card_type: '01', commercial_classification: 'Routine' },
  ];
  for (const cardType of ['02', '03', '04', '05', '06', '07', '08', '09']) {
    rows.push({ card_type: cardType, commercial_classification: 'Routine' });
  }
  rows.push({ card_type: '10', commercial_classification: 'SB/AD/SL' });
  rows.push({ card_type: '11', commercial_classification: 'Material Special Replacement' });
  rows.push({ card_type: '11', commercial_classification: 'Configuration(MOD)' });
  return rows;
}

// =====================================================================
// 6. 能力清单样例（需求 39.1、39.4）
// =====================================================================

/**
 * 覆盖需求 39.4「取当前生效版本」的三条分支：
 * ① 同一 (机型, 起落架, 专业) 多 revision；② 已过期版本（`effective_to` 早于今日）；
 * ③ 尚未生效版本（`effective_from` 晚于今日）；④ 同期多条时取 revision 最大者。
 * 生效期刻意取宽区间（2010/2020 起、2999 起），使判定不依赖运行日期。
 */
export const SEED_CAPABILITY_LIST = Object.freeze([
  // ① 已过期：2010–2019
  { ac_type: '320', gear_type: 'MLG', skill: 'GR', revision: 1, effective_from: '2010-01-01', effective_to: '2019-12-31' },
  // ② 当前生效（无限期）
  { ac_type: '320', gear_type: 'MLG', skill: 'GR', revision: 2, effective_from: '2020-01-01', effective_to: null },
  // ③ 与 ②同期并存，revision 更大 → 当前生效版本应取本行
  { ac_type: '320', gear_type: 'MLG', skill: 'GR', revision: 3, effective_from: '2020-01-01', effective_to: null },
  { ac_type: '747', gear_type: 'NLG', skill: 'IR', revision: 1, effective_from: '2020-01-01', effective_to: null },
  { ac_type: '737', gear_type: 'BLG', skill: 'NT', revision: 1, effective_from: '2020-01-01', effective_to: '2900-12-31' },
  // ④ 尚未生效：范围校验时不得命中
  { ac_type: '350', gear_type: 'WLG', skill: 'AS', revision: 1, effective_from: '2999-01-01', effective_to: null },
]);

// =====================================================================
// 7. 打印模板（需求 40.1、40.2、40.4）
// =====================================================================

/**
 * 默认模板一条。`template_body` 为 HTML 模板字符串（Handlebars 语法子集），由前端渲染后
 * 经浏览器打印；**不含工卡类型**（需求 5.2 打印输出不展示工卡分类）。
 * 11 类工卡 + 11 类单据的模板初值待业务方提供纸质样张后逐类回填
 * （《临时设计说明》前序遗留第 4 项）。
 */
export const DEFAULT_PRINT_TEMPLATE_BODY = [
  '<section class="task-card-print">',
  '  <header><h1>{{organizationName}}</h1><h2>{{taskNo}} Rev.{{revisionLabel}}</h2></header>',
  '  <p class="title">{{title}}</p>',
  '  <table class="meta"><tbody>',
  '    <tr><th>A/C Type</th><td>{{acType}}</td><th>Gear Type</th><td>{{gearType}}</td></tr>',
  '    <tr><th>Skill</th><td>{{skill}}</td><th>Ctrl Code</th><td>{{ctrlCode}}</td></tr>',
  '    <tr><th>Revision Date</th><td>{{date}}</td><th>Stage</th><td>{{stage}}</td></tr>',
  '  </tbody></table>',
  '  <ol class="steps">',
  '  {{#each steps}}',
  '    <li><p>{{descriptionZh}}</p><p>{{descriptionEn}}</p>',
  '      <table class="record"><tbody>',
  '        <tr><th>Estimated Man Hours</th><td>{{manHours.estimated}}</td><th>Actual Man Hours</th><td>{{manHours.actual}}</td></tr>',
  '        <tr><th>Start</th><td>{{startTime}}</td><th>Finish</th><td>{{finishTime}}</td></tr>',
  '        {{#each signatures}}',
  '        <tr><th>{{signatureRole}}</th><td>{{signedBy}}</td><td>{{stampId}}</td><td>{{signedAt}}</td></tr>',
  '        {{/each}}',
  '      </tbody></table>',
  '    </li>',
  '  {{/each}}',
  '  </ol>',
  '</section>',
].join('\n');

// =====================================================================
// 8. 演示工卡与集成 mock（需求 25.1、25.2、26.4、27.2、30.1、48.3）
// =====================================================================

/** 演示工卡：覆盖 01（含生效态）、04（IR 卡带 Base）、05（IR Lot 卡）、11（多命中类型） */
const SEED_CARDS = Object.freeze([
  {
    task_no: 'TC-2026-0001', revision: 1, title: '主起落架收货检查 / MLG Receiving Inspection',
    date: '2026-01-05', ac_type: '320', gear_type: 'MLG', stage: 'RTN', skill: 'GR', ctrl_code: 'IS',
    card_type: '01', is_fai: 0, status: 'Effective',
    document_type: 'CMM', ref_no: '32-11-51', document_revision: 'Rev 12',
    document_desc: 'Main Landing Gear Component Maintenance Manual',
    created_by: 'E10001', reviewed_by: 'E20001', ata_chapter: '32-11',
    commercial_classification: 'Gear Inspection', last_update: '2026-01-06', operator_id: 'E10001',
  },
  {
    task_no: 'TC-2026-0002', revision: 1, title: 'IR 检查工卡 / IR Inspection',
    date: '2026-01-08', ac_type: '320', gear_type: 'MLG', stage: 'RTN', skill: 'IR', ctrl_code: 'OHV',
    card_type: '04', is_fai: 1, status: 'New',
    base_number: 'BASE-320-MLG-001', ipc_item_no: '32-11-01-010',
    created_by: 'E10001', ndt_reviewer: 'E30001', ata_chapter: '32-11', check_type: 'Overhaul',
    commercial_classification: 'Routine', last_update: '2026-01-08', operator_id: 'E10001',
  },
  {
    task_no: 'TC-2026-0003', revision: 1, title: 'IR Lot 检查工卡 / IR Lot Inspection',
    date: '2026-01-09', ac_type: '320', gear_type: 'MLG', stage: 'RTN', skill: 'IR', ctrl_code: 'OHV',
    card_type: '05', status: 'New', created_by: 'E10002',
    commercial_classification: 'Routine', last_update: '2026-01-09', operator_id: 'E10002',
  },
  {
    // 类型 11 → 商务分类多命中（Material Special Replacement / Configuration(MOD)），
    // 依需求 29.6、43.4 不自动裁决，故 commercial_classification 留空待人工确认
    task_no: 'TC-2026-0004', revision: 1, title: '客户特殊要求工卡 / Customer Special Request',
    date: '2026-01-10', ac_type: '777', gear_type: 'NLG', stage: 'CUS', skill: 'AS', ctrl_code: 'MD',
    card_type: '11', status: 'New', created_by: 'E10002',
    last_update: '2026-01-10', operator_id: 'E10002',
  },
]);

/** TPC 文档 mock（需求 7.3、25.1）：检索命中后回填工卡四个只读列 */
const SEED_TPC_DOCUMENTS = Object.freeze([
  { doc_type: 'CMM', ref_no: '32-11-51', doc_revision: 'Rev 12', doc_desc: 'Main Landing Gear CMM', keyword: 'MLG overhaul' },
  { doc_type: 'AMM', ref_no: '32-00-00', doc_revision: 'Rev 45', doc_desc: 'Aircraft Maintenance Manual - Landing Gear', keyword: 'landing gear' },
  { doc_type: 'SB', ref_no: 'SB-320-32-1234', doc_revision: 'Rev 2', doc_desc: 'Service Bulletin - NLG Actuator', keyword: 'NLG actuator' },
]);

// =====================================================================
// 幂等写入基础设施
// =====================================================================

/**
 * 先查后插：按自然键判定存在性，存在则跳过。
 * 用 `IS` 而非 `=` 比较，使 NULL 键值（如 `ppc_schedule.pid_no` 故意缺失的行）也能正确匹配。
 * @returns {number} 实际插入行数（0 或 1）
 */
function insertIfAbsent(connection, table, row, keyColumns) {
  const where = keyColumns.map((col) => `${col} IS ?`).join(' AND ');
  const keyValues = keyColumns.map((col) => row[col] ?? null);
  const exists = connection.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get(...keyValues);
  if (exists !== undefined) return 0;

  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  connection
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...columns.map((col) => row[col] ?? null));
  return 1;
}

/** 批量幂等写入，返回插入行数合计 */
function insertAllIfAbsent(connection, table, rows, keyColumns) {
  return rows.reduce((sum, row) => sum + insertIfAbsent(connection, table, row, keyColumns), 0);
}

/** 取工卡 id（种子内部按 task_no + revision 定位） */
function cardId(connection, taskNo, revision = 1) {
  const row = connection
    .prepare('SELECT id FROM task_card WHERE task_no = ? AND revision = ?')
    .get(taskNo, revision);
  return row === undefined ? null : row.id;
}

/** 取工序 id */
function stepId(connection, cardIdValue, processId) {
  const row = connection
    .prepare('SELECT id FROM process_step WHERE card_id = ? AND process_id = ?')
    .get(cardIdValue, processId);
  return row === undefined ? null : row.id;
}

/** schema 是否已建立（缺表时给出可执行的提示而非底层 SQL 错误） */
export function hasSchema(connection) {
  const row = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_user'")
    .get();
  return row !== undefined;
}

// =====================================================================
// 主流程
// =====================================================================

/**
 * 写入全部种子数据（单事务、幂等）。
 * @param {import('better-sqlite3').Database} [connection] 目标连接；缺省用进程级单例
 * @returns {Record<string, number>} 各表实际插入行数（重复执行时全为 0）
 */
export function seed(connection) {
  const conn = connection ?? getDb();
  if (!hasSchema(conn)) {
    throw new Error('种子写入前须先建表：请执行 npm run migrate 或调用 migrate(connection)');
  }

  const inserted = Object.create(null);
  const record = (table, count) => {
    inserted[table] = (inserted[table] ?? 0) + count;
  };

  conn.transaction(() => {
    // --- 用户与权限（需求 47.1–47.9、22.3） ---
    record(
      'app_user',
      insertAllIfAbsent(conn, 'app_user', SEED_USERS.map((u) => ({ ...u, is_active: 1 })), ['staff_no']),
    );
    record(
      'role_permission',
      insertAllIfAbsent(conn, 'role_permission', buildRolePermissionRows(), ['role', 'permission_point']),
    );

    // --- 系统参数（需求 35.1） ---
    record(
      'system_parameter',
      insertAllIfAbsent(
        conn,
        'system_parameter',
        [{ key: 'organizationName', value: 'HAECO Landing Gear Services Limited' }],
        ['key'],
      ),
    );

    // --- 执行单据类型字典（需求 16.2、16.4、16.5） ---
    record(
      'exec_doc_type',
      insertAllIfAbsent(
        conn,
        'exec_doc_type',
        EXEC_DOC_TYPE.map((code) => ({
          code,
          name: EXEC_DOC_TYPE_NAMES[code] ?? null,
          sign_rule: EXEC_DOC_SIGN_RULE[code],
        })),
        ['code'],
      ),
    );

    // --- Stage × 类型约束与横切取值 ⚠ Hotfix 假定（A4，需求 46.9–46.13） ---
    record(
      'stage_card_type_constraint',
      insertAllIfAbsent(conn, 'stage_card_type_constraint', buildStageConstraintRows(), [
        'card_type',
        'allowed_stage',
      ]),
    );
    record(
      'stage_crosscut',
      insertAllIfAbsent(conn, 'stage_crosscut', STAGE_CROSSCUT.map((stage) => ({ stage })), ['stage']),
    );

    // --- 类型 → 商务分类映射（需求 43.1、43.2；仅 P6 兜底） ---
    record(
      'card_type_commercial_map',
      insertAllIfAbsent(conn, 'card_type_commercial_map', buildCardTypeCommercialMapRows(), [
        'card_type',
        'commercial_classification',
      ]),
    );

    // --- 派生优先级链 ⚠ Hotfix 假定（A1 优先级顺序，需求 29.2、29.8） ---
    record(
      'derivation_priority_config',
      insertAllIfAbsent(
        conn,
        'derivation_priority_config',
        DERIVATION_PRIORITY.map((tierCode, index) => ({
          tier_code: tierCode,
          tier_order: index + 1,
          enabled: 1,
        })),
        ['tier_code'],
      ),
    );

    // --- 能力清单（需求 39.1、39.4） ---
    record(
      'capability_list',
      insertAllIfAbsent(conn, 'capability_list', SEED_CAPABILITY_LIST, [
        'ac_type',
        'gear_type',
        'skill',
        'revision',
      ]),
    );

    // --- 打印模板（需求 40.1、40.2、40.4） ---
    record(
      'print_template',
      insertAllIfAbsent(
        conn,
        'print_template',
        [
          {
            target_kind: 'card_type',
            target_code: '01',
            template_body: DEFAULT_PRINT_TEMPLATE_BODY,
            is_default: 1,
          },
        ],
        ['target_kind', 'target_code'],
      ),
    );

    // --- 批量复制编号流水（需求 38.8、38.9） ---
    record(
      'task_no_sequence',
      insertAllIfAbsent(
        conn,
        'task_no_sequence',
        [{ prefix: 'TC-2026-', suffix: '', next_seq: 5, step: 1 }],
        ['prefix', 'suffix'],
      ),
    );

    // --- 演示工卡（需求 6.3–6.8、16.1） ---
    record('task_card', insertAllIfAbsent(conn, 'task_card', SEED_CARDS, ['task_no', 'revision']));

    const card1 = cardId(conn, 'TC-2026-0001');
    const card2 = cardId(conn, 'TC-2026-0002');
    const card3 = cardId(conn, 'TC-2026-0003');

    // --- 参考文件（需求 9.1–9.3） ---
    record(
      'reference_document',
      insertAllIfAbsent(
        conn,
        'reference_document',
        [
          { card_id: card1, doc_type: 'CMM', ref_no: '32-11-51', doc_revision: 'Rev 12', ata_chapter: '32-11' },
          { card_id: card2, doc_type: 'CMM', ref_no: '32-11-51', doc_revision: 'Rev 12', ata_chapter: '32-11' },
        ],
        ['card_id', 'ref_no'],
      ),
    );
    const refDocId = conn
      .prepare('SELECT id FROM reference_document WHERE card_id = ? AND ref_no = ?')
      .get(card1, '32-11-51')?.id ?? null;

    // --- 演示工序（需求 10.1、11.1、12.1、30.1、31.1–31.4） ---
    // ⚠ operation / work_category / estimated_man_hours 为只读带出列：此处的值代表
    //   Process Data 与 PPC 已回填的结果，编制界面不接受人工写入（需求 30.2、47.4）。
    record(
      'process_step',
      insertAllIfAbsent(
        conn,
        'process_step',
        [
          {
            card_id: card1, process_id: 'A', seq: 1, skill: 'GR', ref_doc_id: refDocId,
            operation: 'RECEIVING INSPECTION', work_category: 'Inspection', estimated_man_hours: 2.5,
            description_zh: '目视检查起落架外观并记录进厂件号与序号。',
            description_en: 'Visually inspect the landing gear and record inbound P/N and S/N.',
            safety_warning: '起落架吊装作业区域严禁站人。/ Keep clear of the hoisting area.',
            repair_tips: '外观损伤先拍照留存再判定。', is_critical: 1,
          },
          {
            card_id: card1, process_id: 'B', seq: 2, skill: 'QC', ref_doc_id: refDocId,
            operation: 'DIMENSION CHECK', work_category: 'Inspection', estimated_man_hours: 4,
            description_zh: '测量活塞杆直径并记录实测值。',
            description_en: 'Measure the piston rod diameter and record the actual value.',
            is_critical: 0,
          },
          {
            card_id: card2, process_id: 'A', seq: 1, skill: 'IR', ref_doc_id: null,
            operation: 'IR INSPECTION', description_zh: '按 IPC 项号核对基础件号。',
            description_en: 'Verify the base part number against the IPC item number.', is_critical: 0,
          },
        ],
        ['card_id', 'process_id'],
      ),
    );

    // --- 工序签署项 ⚠ Hotfix 假定（A3 编制域签署项定义，需求 45.1–45.6） ---
    const step1A = stepId(conn, card1, 'A');
    record(
      'signature_requirement',
      insertAllIfAbsent(
        conn,
        'signature_requirement',
        [
          { step_id: step1A, signature_role: 'Operator', stamp_required: 0, date_required: 1, sort_order: 1 },
          { step_id: step1A, signature_role: 'QC', stamp_required: 1, date_required: 1, sort_order: 2 },
        ],
        ['step_id', 'signature_role'],
      ),
    );

    // --- IR Lot 卡关联与 BOM Base 输出 ⚠ Hotfix 假定（A6，需求 48.1–48.6） ---
    record(
      'lot_list_link',
      insertAllIfAbsent(
        conn,
        'lot_list_link',
        [{ card_id: card3, lot_number: 'LOT-2026-0001', lot_list_ref: 'LT-2026-001' }],
        ['card_id', 'lot_list_ref'],
      ),
    );
    record(
      'bom_base_output',
      insertAllIfAbsent(
        conn,
        'bom_base_output',
        [
          // (a) 类型 04 直接维护的 Base（需求 48.4a）
          { card_id: card2, base_number: 'BASE-320-MLG-001', source: 'ir_card', lot_number: null, upper_part_name: 'MLG Shock Strut', is_lru: 0 },
          // (b) 类型 05 经 Lot List 带出的 Base，携带 Lot Number 以区别来源（需求 48.4b、48.6）
          { card_id: card3, base_number: 'BASE-320-MLG-101', source: 'lot_list', lot_number: 'LOT-2026-0001', upper_part_name: 'MLG Side Stay', is_lru: 1 },
          { card_id: card3, base_number: 'BASE-320-MLG-102', source: 'lot_list', lot_number: 'LOT-2026-0001', upper_part_name: 'MLG Drag Stay', is_lru: 0 },
        ],
        ['card_id', 'base_number', 'source'],
      ),
    );

    // --- 执行过程单据实例：SWS 复制用例取数（需求 23.1、23.2） ---
    record(
      'exec_document',
      insertAllIfAbsent(
        conn,
        'exec_document',
        [
          {
            exec_doc_type: 'SW', doc_no: 'SWS-2026-0001', revision: 1, status: 'New',
            title: '补充工作单 / Supplementary Work Sheet',
            content: JSON.stringify({
              acType: '320',
              partNo: 'BASE-320-MLG-001',
              serialNo: 'SN-0001',
              findings: '活塞杆表面轻微腐蚀 / Minor corrosion on piston rod',
              steps: [
                { seq: 1, descriptionZh: '打磨腐蚀区域', descriptionEn: 'Blend out the corroded area' },
                { seq: 2, descriptionZh: '复检并记录尺寸', descriptionEn: 'Re-inspect and record dimensions' },
              ],
            }),
            source_card_id: card1, created_by: 'E10001', created_at: '2026-01-12T02:00:00Z',
          },
        ],
        ['exec_doc_type', 'doc_no', 'revision'],
      ),
    );

    // --- 集成 mock：TPC（需求 7.3、25.1） ---
    record(
      'tpc_document',
      insertAllIfAbsent(conn, 'tpc_document', SEED_TPC_DOCUMENTS, ['ref_no', 'doc_revision']),
    );

    // --- 集成 mock：PPC 工作分类与预计工时（需求 11.3、25.2；本模块只读） ---
    record(
      'ppc_process_data',
      insertAllIfAbsent(
        conn,
        'ppc_process_data',
        [
          { card_id: card1, step_ref: 'A', work_category: 'Inspection', estimated_man_hours: 2.5 },
          { card_id: card1, step_ref: 'B', work_category: 'Inspection', estimated_man_hours: 4 },
          { card_id: card2, step_ref: 'A', work_category: 'Inspection', estimated_man_hours: 1.5 },
        ],
        ['card_id', 'step_ref'],
      ),
    );

    // --- 集成 mock：PPC 排产（需求 26.4） ---
    // ⚠ 第二行**故意缺 PID 与目标日期**：需求 26.4 要求「取不到值则留空且不阻断释放」，
    //   该分支必须有可复现的数据样例，否则只能靠删数据构造。
    record(
      'ppc_schedule',
      insertAllIfAbsent(
        conn,
        'ppc_schedule',
        [
          { pid_no: 'PID-2026-0001', card_id: card1, job_target_date: '2026-09-30' },
          { pid_no: null, card_id: card2, job_target_date: null },
        ],
        ['pid_no', 'card_id'],
      ),
    );

    // --- 集成 mock：Process Data（需求 27.1、27.2、30.1；落 job 表，非 task_card） ---
    record(
      'process_data',
      insertAllIfAbsent(
        conn,
        'process_data',
        [
          {
            pid_no: 'PID-2026-0001', card_id: card1, step_ref: null,
            part_no: 'P/N-32-11-51-001', part_sn: 'SN-0001', part_desc: 'MLG SHOCK STRUT',
            operation_type: 'OVERHAUL', operation: null,
          },
          {
            pid_no: 'PID-2026-0001', card_id: card1, step_ref: 'A',
            part_no: 'P/N-32-11-51-001', part_sn: 'SN-0001', part_desc: 'MLG SHOCK STRUT',
            operation_type: 'OVERHAUL', operation: 'RECEIVING INSPECTION',
          },
          {
            pid_no: 'PID-2026-0001', card_id: card1, step_ref: 'B',
            part_no: 'P/N-32-11-51-001', part_sn: 'SN-0001', part_desc: 'MLG SHOCK STRUT',
            operation_type: 'OVERHAUL', operation: 'DIMENSION CHECK',
          },
        ],
        ['pid_no', 'card_id', 'step_ref'],
      ),
    );

    // --- 集成 mock：Lot List 的 Base 集合 ⚠ Hotfix 假定（A6，需求 48.3、48.8） ---
    // 同一 lot_list_ref 下多条 Base，且不去重（来源标识由 bom_base_output.source 承担）。
    record(
      'lot_list_base',
      insertAllIfAbsent(
        conn,
        'lot_list_base',
        [
          { lot_list_ref: 'LT-2026-001', lot_number: 'LOT-2026-0001', base_number: 'BASE-320-MLG-101' },
          { lot_list_ref: 'LT-2026-001', lot_number: 'LOT-2026-0001', base_number: 'BASE-320-MLG-102' },
          { lot_list_ref: 'LT-2026-001', lot_number: 'LOT-2026-0001', base_number: 'BASE-320-MLG-103' },
          { lot_list_ref: 'LT-2026-002', lot_number: 'LOT-2026-0002', base_number: 'BASE-777-NLG-201' },
        ],
        ['lot_list_ref', 'base_number'],
      ),
    );

    // --- Section 20 只读集成契约演示数据 ---
    record(
      'pid_scope',
      insertAllIfAbsent(
        conn,
        'pid_scope',
        [{ pid_no: 'PID-2026-0001', scope_json: JSON.stringify({ acType: '320', gearType: 'MLG', packageRef: 'WP-DEMO-001' }) }],
        ['pid_no'],
      ),
    );
    record(
      'classification_source',
      insertAllIfAbsent(
        conn,
        'classification_source',
        [{
          card_id: card1,
          plan_dummy_job: JSON.stringify({ isDummyJob: true, planRef: 'PLAN-DEMO-001' }),
          nrc_originating_doc: JSON.stringify({ docNo: 'NRC-DEMO-001' }),
          outsource_entry: null,
          part_nature: null,
          package_division: JSON.stringify({ classification: 'Routine', packageRef: 'WP-DEMO-001' }),
        }],
        ['card_id'],
      ),
    );
    record(
      'work_package_in_progress_ref',
      insertAllIfAbsent(
        conn,
        'work_package_in_progress_ref',
        [{ card_id: card1, package_ref: 'WP-IN-PROGRESS-001' }],
        ['card_id', 'package_ref'],
      ),
    );
  })();

  return inserted;
}

/**
 * 独立执行一次种子写入：按路径新开连接、建表（幂等）、写种子后关闭连接。
 * @param {{ dbPath?: string }} [options]
 * @returns {{ dbPath: string, inserted: Record<string, number>, total: number }}
 */
export function runSeed(options = {}) {
  const dbPath = resolveDbPath(options.dbPath);
  const connection = openDatabase(dbPath);
  try {
    migrate(connection);
    const inserted = seed(connection);
    const total = Object.values(inserted).reduce((sum, n) => sum + n, 0);
    return { dbPath, inserted, total };
  } finally {
    connection.close();
  }
}

/** 本模块是否作为 CLI 入口被直接执行 */
function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isCliEntry()) {
  try {
    const { dbPath, inserted, total } = runSeed();
    console.log(`[seed] 数据库：${dbPath}`);
    for (const [table, count] of Object.entries(inserted)) {
      console.log(`[seed] ${table}: 新增 ${count} 行`);
    }
    console.log(
      total === 0
        ? '[seed] 完成（无新增，种子已存在——先查后插保证幂等）'
        : `[seed] 完成（合计新增 ${total} 行）`,
    );
  } catch (error) {
    console.error(`[seed] 失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

export default seed;
