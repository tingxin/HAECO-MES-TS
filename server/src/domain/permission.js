/**
 * 角色权限边界领域模块（纯函数，无 I/O、无 DB 依赖）。
 *
 * 承载任务 8.4 的两项判定：
 * - `checkPermission(role, permissionPoint, cfg)`  `(角色, 权限点)` 是否被 `role_permission` 允许
 * - `isWritableField(field)`                      字段是否可经**本模块编制界面**人工写入
 *
 * 两者共同构成 Property 29「角色权限边界不可越权」的实现面：
 * 前者是**可配置**的授权判定（读 `role_permission` 表内容），
 * 后者是**不可配置**的写入闸门（只读带出字段恒不可人工写入，任何角色皆然）。
 *
 * 需求：11.3, 11.4, 20.9, 26.5, 27.3, 30.2, 47.1–47.10
 */

import { ROLE, PERMISSION_POINT } from './enums.js';

// =====================================================================
// 1. 判定结论码（需求 47.10）
// =====================================================================

/**
 * 判定结论码。**未知权限点与「已知但被拒」必须可区分**：前者是调用方拼错权限点的
 * 编码错误（应 500 / 告警），后者是正常的授权决策（应 403 并写 `access_denial_log`）。
 * 若两者同码，路由声明写错权限点会被静默降级为「越权尝试」，永久不被发现。
 */
export const PERMISSION_RESULT = Object.freeze({
  GRANTED: 'granted',                             // 配置允许
  DENIED_BY_CONFIG: 'denied_by_config',           // 配置存在且 allowed = 0
  NO_CONFIG_ROW: 'no_config_row',                 // 矩阵缺行（种子矩阵恒为 8×13 满行，缺行即数据异常）
  CONFLICTING_CONFIG_ROWS: 'conflicting_config_rows', // 同组合多行且结论不一致
  UNKNOWN_ROLE: 'unknown_role',                   // 角色不属 ROLE 词表
  UNKNOWN_PERMISSION_POINT: 'unknown_permission_point', // 权限点不属 PERMISSION_POINT 词表 —— 编码错误
  INVALID_CONFIG: 'invalid_config',               // cfg 缺失或形态无法识别
});

/** 结论码是否代表授权决策（而非调用方 / 数据的编码错误），供服务层区分 403 与 500 */
const AUTHORIZATION_DECISIONS = Object.freeze([
  PERMISSION_RESULT.GRANTED,
  PERMISSION_RESULT.DENIED_BY_CONFIG,
  PERMISSION_RESULT.NO_CONFIG_ROW,
  PERMISSION_RESULT.CONFLICTING_CONFIG_ROWS,
]);

/** 权限点是否属封闭词表（需求 47.2–47.9） */
export function isKnownPermissionPoint(permissionPoint) {
  return typeof permissionPoint === 'string' && PERMISSION_POINT.includes(permissionPoint);
}

/** 角色是否属封闭词表（需求 47.1） */
export function isKnownRole(role) {
  return typeof role === 'string' && ROLE.includes(role);
}

// =====================================================================
// 2. 权限判定（需求 47.1–47.10、20.9）
// =====================================================================

/** `allowed` 列的真值判定：SQLite 存 0/1，兼容布尔与字符串写法；其余一律取假 */
function isAllowedFlag(value) {
  return value === 1 || value === true || value === '1';
}

/** 取行上的权限点（兼容 DB 的 snake_case 与服务层的 camelCase） */
function pointOfRow(row) {
  return row.permission_point ?? row.permissionPoint ?? null;
}

/**
 * 判定详情。返回 `{ allowed, reason, isAuthorizationDecision }`。
 *
 * `cfg` 接受两种形态：
 * 1. **`role_permission` 表行数组**（权威形态）：`[{ role, permission_point, allowed }, …]`，
 *    由 `buildRolePermissionRows()` 生成的 8 角色 × 13 权限点 = 104 行完整矩阵。
 *    判定读 `allowed` 列，**不以行存在与否代表授权**——矩阵对未授予者显式落 `allowed = 0`，
 *    若按「有行即有权」解读会把 104 行读成全角色全权限。
 * 2. **角色 → 已授权权限点数组**的映射对象（`ROLE_PERMISSION_MATRIX` 形态，便于测试与种子期使用）：
 *    该形态下角色键存在即视为矩阵已覆盖该角色，点不在数组内即为 `DENIED_BY_CONFIG`。
 *
 * 一律 fail-closed：未知角色、未知权限点、cfg 缺失、缺行、同组合多行结论冲突，全部拒绝。
 *
 * @param {unknown} role 角色（须 ∈ `ROLE`）
 * @param {unknown} permissionPoint 权限点（须 ∈ `PERMISSION_POINT`）
 * @param {unknown} cfg `role_permission` 表内容
 * @returns {{ allowed: boolean, reason: string, isAuthorizationDecision: boolean }}
 */
export function explainPermission(role, permissionPoint, cfg) {
  // 未知权限点优先判定：调用方拼错权限点属编码错误，不应被误报为越权尝试
  if (!isKnownPermissionPoint(permissionPoint)) {
    return decision(false, PERMISSION_RESULT.UNKNOWN_PERMISSION_POINT);
  }
  if (!isKnownRole(role)) {
    return decision(false, PERMISSION_RESULT.UNKNOWN_ROLE);
  }

  if (Array.isArray(cfg)) {
    const matched = cfg.filter(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        row.role === role &&
        pointOfRow(row) === permissionPoint,
    );
    if (matched.length === 0) {
      return decision(false, PERMISSION_RESULT.NO_CONFIG_ROW);
    }
    const flags = matched.map((row) => isAllowedFlag(row.allowed));
    if (flags.some((f) => f !== flags[0])) {
      // 同组合的重复行结论不一致：不猜测意图，从严取拒绝
      return decision(false, PERMISSION_RESULT.CONFLICTING_CONFIG_ROWS);
    }
    return flags[0]
      ? decision(true, PERMISSION_RESULT.GRANTED)
      : decision(false, PERMISSION_RESULT.DENIED_BY_CONFIG);
  }

  if (cfg !== null && typeof cfg === 'object') {
    if (!Object.prototype.hasOwnProperty.call(cfg, role)) {
      return decision(false, PERMISSION_RESULT.NO_CONFIG_ROW);
    }
    const granted = cfg[role];
    if (!Array.isArray(granted)) {
      return decision(false, PERMISSION_RESULT.INVALID_CONFIG);
    }
    return granted.includes(permissionPoint)
      ? decision(true, PERMISSION_RESULT.GRANTED)
      : decision(false, PERMISSION_RESULT.DENIED_BY_CONFIG);
  }

  return decision(false, PERMISSION_RESULT.INVALID_CONFIG);
}

function decision(allowed, reason) {
  return Object.freeze({
    allowed,
    reason,
    isAuthorizationDecision: AUTHORIZATION_DECISIONS.includes(reason),
  });
}

/**
 * 角色权限边界判定（需求 47.1–47.10）——布尔谓词，服务层与中间件的调用点。
 *
 * 为真当且仅当 `(role, permissionPoint)` 在 `role_permission` 中 `allowed = 1`。
 * 需求 47.2–47.9 的各条边界（TS_Engineer 不审核、TS_Manager 不编制、
 * `ppc_manhours_write` 仅 Planning、`job_exec_write` 仅 Production、
 * `capability_write` 仅 QA）与需求 20.9、47.9 的「`batch_replace` 不由 `card_edit` 继承」
 * 全部由矩阵数据表达——本函数不硬编码任何继承或蕴含关系，逐点查表。
 *
 * 需区分拒绝原因（如中间件要分流 403 与 500）时用 {@link explainPermission}。
 *
 * @param {unknown} role 角色
 * @param {unknown} permissionPoint 权限点
 * @param {unknown} cfg `role_permission` 表内容
 * @returns {boolean}
 */
export function checkPermission(role, permissionPoint, cfg) {
  return explainPermission(role, permissionPoint, cfg).allowed;
}

// =====================================================================
// 3. 只读带出字段（需求 11.3、11.4、26.5、27.3、30.2）
// =====================================================================

/**
 * 只读带出字段登记表：`'<表>.<列>'` → 来源与需求出处。
 *
 * **按表限定**是必要的：`check_type` 同名于两处不同语义的列——`job.check_type`
 * 是需求 26.1 由 PID 带出的本次维修检查类型（只读），`task_card.check_type` 是
 * 需求 28.4 编制态标注的工卡适用检查类型（**可写**）。不带表限定即无法区分。
 *
 * 「只读」的准确含义：不可经**本模块编制界面**人工写入。这些列的值只能来自
 * 各自的集成读取契约（PPC 排产、Process Data、PPC 工时维护界面）或执行期采集
 * （报工写入）。Planning 角色持 `ppc_manhours_write` 亦不例外——该权限点作用于
 * PPC 专属维护界面（需求 47.4），不开放本模块编制界面的写入路径。
 */
export const READONLY_DERIVED_FIELD_SOURCE = Object.freeze({
  // 需求 26.1 工卡执行相关字段（只落 job 表，两域分离见 Property 31）
  'job.owner': Object.freeze({ source: 'JOB 执行上下文', requirement: '26.1, 26.5' }),
  'job.job_target_date': Object.freeze({ source: 'PPC 排产结果', requirement: '26.1, 26.4, 26.5' }),
  'job.check_type': Object.freeze({ source: 'PID 带出', requirement: '26.1, 26.5' }),
  'job.inbound_gear_pn': Object.freeze({ source: 'JOB 执行上下文', requirement: '26.1, 26.5' }),
  'job.inbound_sn': Object.freeze({ source: 'JOB 执行上下文', requirement: '26.1, 26.5' }),
  'job.cs_no': Object.freeze({ source: 'JOB 执行上下文', requirement: '26.1, 26.5' }),
  'job.work_order': Object.freeze({ source: 'JOB 执行上下文', requirement: '26.1, 26.5' }),
  'job.outbound_gear_pn': Object.freeze({ source: 'JOB 执行上下文', requirement: '26.1, 26.5' }),

  // 需求 27.1 Process Card 四字段（存执行域，需求 27.5）
  'job.part_no': Object.freeze({ source: 'Process Data', requirement: '27.1, 27.2, 27.3' }),
  'job.part_sn': Object.freeze({ source: 'Process Data', requirement: '27.1, 27.2, 27.3' }),
  'job.part_desc': Object.freeze({ source: 'Process Data', requirement: '27.1, 27.2, 27.3' }),
  'job.operation_type': Object.freeze({ source: 'Process Data', requirement: '27.1, 27.2, 27.3' }),

  // 需求 30.1 工序 Operation（编制域列，但由 Process Data 带出）
  'process_step.operation': Object.freeze({ source: 'Process Data', requirement: '30.1, 30.2' }),

  // 需求 11.3 PPC 维护的工序工时属性（编制域列，PPC 专属界面写入）
  'process_step.work_category': Object.freeze({ source: 'PPC 维护界面', requirement: '11.3, 47.4, 47.5' }),
  'process_step.estimated_man_hours': Object.freeze({ source: 'PPC 维护界面', requirement: '11.3, 47.4, 47.5' }),

  // 需求 11.4 执行期收集的工时（执行域，Production 报工写入）
  'job_process.effective_man_hours': Object.freeze({ source: '执行期报工', requirement: '11.4, 47.7' }),
  'job_process.actual_man_hours': Object.freeze({ source: '执行期报工', requirement: '11.4, 47.7' }),
});

/**
 * 只读带出字段的限定名清单（17 项）——任何角色皆不可经编制界面人工写入。
 * 顺序与 {@link READONLY_DERIVED_FIELD_SOURCE} 一致：26.1 八项、27.1 四项、
 * 30.1 一项、11.3 两项、11.4 两项。
 */
export const READONLY_DERIVED_FIELDS = Object.freeze(Object.keys(READONLY_DERIVED_FIELD_SOURCE));

/** 字段名归一化：忽略大小写、下划线、点、斜杠与空格，使列名与蓝图标签等价 */
function normalizeFieldKey(field) {
  return String(field).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}

/**
 * 蓝图标签 → 限定名补充别名。多数标签归一化后已与列名一致
 * （`JOB TARGET DATE` → `jobtargetdate`、`CSNo.` → `csno`、`PART No` → `partno` 等），
 * 此处仅登记归一化后仍不一致者。
 */
const FIELD_LABEL_ALIAS = Object.freeze({
  Check: ['job.check_type'],                            // 需求 26.1 标签为 Check，列名 check_type
  'S/N': ['job.inbound_sn', 'job.part_sn'],             // 标签在两处出现，均为只读
  'PART DES.': ['job.part_desc'],
});

/** 归一化键 → 命中的只读限定名数组 */
const READONLY_FIELD_INDEX = (() => {
  const index = new Map();
  const register = (key, qualified) => {
    const normalized = normalizeFieldKey(key);
    if (normalized === '') return;
    const bucket = index.get(normalized);
    if (bucket === undefined) {
      index.set(normalized, [qualified]);
    } else if (!bucket.includes(qualified)) {
      bucket.push(qualified);
    }
  };
  for (const qualified of READONLY_DERIVED_FIELDS) {
    register(qualified, qualified);                                  // 限定名：job.check_type
    register(qualified.slice(qualified.indexOf('.') + 1), qualified); // 裸列名：check_type
  }
  for (const [label, targets] of Object.entries(FIELD_LABEL_ALIAS)) {
    for (const qualified of targets) register(label, qualified);
  }
  return index;
})();

/**
 * 字段是否可经本模块编制界面人工写入（需求 11.3、11.4、26.5、27.3、30.2）。
 *
 * 为假当且仅当该字段解析到 {@link READONLY_DERIVED_FIELDS} 中的某一项；
 * **与角色无关**——不存在任何角色可经编制界面改写这些字段的路径，故本函数不取
 * 角色参数（Property 29 的「恒不可写」正是靠此签名保证：无入参可用于放行）。
 *
 * 接受写法：限定名 `job.check_type` / `job.checkType`、裸列名 `check_type` /
 * `checkType`、蓝图标签 `Check` / `PART No` / `Estimated ManHours`。
 *
 * ⚠ 裸列名歧义时从严取拒绝：`check_type` 同时命中只读的 `job.check_type` 与可写的
 * `task_card.check_type`，本函数返回 `false`。要写编制域的 `check_type` 必须传限定名
 * `task_card.check_type`。漏拦只读字段会污染适航记录，代价高于误拦。
 *
 * @param {unknown} field 字段名（限定名、列名或蓝图标签）
 * @returns {boolean} 可人工写入为真；只读带出字段、空值与非字符串为假
 */
export function isWritableField(field) {
  if (typeof field !== 'string') return false;
  const key = normalizeFieldKey(field);
  if (key === '') return false;
  return !READONLY_FIELD_INDEX.has(key);
}

/**
 * 字段解析到的只读限定名清单（诊断用）：可写字段返回空数组，
 * 歧义裸列名返回全部命中项（如 `S/N` → `['job.inbound_sn', 'job.part_sn']`）。
 * @param {unknown} field
 * @returns {readonly string[]}
 */
export function resolveReadOnlyFields(field) {
  if (typeof field !== 'string') return Object.freeze([]);
  const hits = READONLY_FIELD_INDEX.get(normalizeFieldKey(field));
  return Object.freeze(hits === undefined ? [] : [...hits]);
}
