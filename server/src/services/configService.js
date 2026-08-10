/**
 * 配置维护服务（任务 13.8）——四组「改配置不改代码」配置表的读写入口：
 *
 * 1. `stage_card_type_constraint` + `stage_crosscut`（Stage × 工卡类型约束，需求 46.9、46.13、46.14）
 * 2. `card_type_commercial_map`（商务分类派生 P6 兜底层，需求 43.1、43.5）
 * 3. `derivation_priority_config`（商务分类派生优先级链，需求 29.8）
 * 4. `capability_list`（QA 能力清单，需求 39.1、39.4）
 *
 * ## 权限闸门（需求 47.8、47.10）
 * 前三组写入一律经 `config_write` 权限点校验；能力清单写入经**独立**的 `capability_write`
 * 权限点校验（不与 `config_write` 互相蕴含）。越权时 `throw ServiceError(CODE.FORBIDDEN, ...)`
 * 并写 `access_denial_log`（经 {@link accessDenialLogRepo}）。判定本身出现编码/数据错误
 * （未知角色、未知权限点、`role_permission` 矩阵缺行等——见 `domain/permission.js` 的
 * `isAuthorizationDecision`）属服务缺陷而非越权尝试，`throw ServiceError(CODE.INTERNAL, ...)`
 * 且**不**写审计日志，避免把编码错误污染为「越权尝试」统计。
 *
 * ## 枚举闭包校验（需求 6.9）
 * 全部写入的枚举取值一律经 `domain/enums.js` 的 `isValidEnumValue` 校验，非法值
 * `throw ServiceError(CODE.VALIDATION, ...)`，不落库。
 *
 * ## 服务层错误约定（`lib/service-error.js`，与 `taskCardService.js` 同一口径）
 * 本文件的全部函数在校验失败或前置条件不满足时一律 `throw new ServiceError(code, message,
 * data)`（`code` ∈ `lib/response.js` 的 `CODE`）。成功路径返回**纯业务数据**，不做
 * `{ ok, code, rejection, message, data }` 信封包装——信封包装是路由层与统一错误处理中间件
 * （任务 16.3）的职责。`data` 上附带 {@link CONFIG_SERVICE_REJECTION} 中的原始拒绝原因码
 * （挂在 `error.data.rejection`），供调用方/测试需要区分具体拒绝场景时读取。
 *
 * ## 无缓存（需求 46.14、29.8）
 * 全部读取函数（`getStageConstraintConfig` / `loadStageConstraintCfg` / `getCommercialMap` /
 * `getDerivationPriorityConfig` / `loadDerivationPriorityCfg` / `getCapabilityList`）不持有
 * 任何进程内缓存，每次调用都直达仓储 `list()`/`listCrosscut()`/`listEnabled()`。写入函数
 * 返回后立即再次调用同一读取函数（或消费方自行调用 `domain/stage-constraint.js` /
 * `domain/classification.js` 的纯函数）即可观察到判定结果随配置同步变化——这是本任务
 * 「配置驱动、禁止硬编码分支」硬约束的服务层落地方式：本文件不包含任何依据配置内容
 * 分支改变行为的 `if`，只做「权限 → 枚举校验 → 仓储读写」。
 *
 * 需求：29.8, 39.1, 39.4, 43.1, 43.5, 46.9, 46.13, 46.14, 47.8, 47.10
 */

import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import { getDb } from '../db/connection.js';
import { isValidEnumValue } from '../domain/enums.js';
import { explainPermission } from '../domain/permission.js';
import * as stageConstraintRepo from '../repositories/stageConstraintRepo.js';
import * as commercialMapRepo from '../repositories/commercialMapRepo.js';
import * as derivationPriorityRepo from '../repositories/derivationPriorityRepo.js';
import * as capabilityRepo from '../repositories/capabilityRepo.js';
import * as rolePermissionRepo from '../repositories/rolePermissionRepo.js';
import * as accessDenialLogRepo from '../repositories/accessDenialLogRepo.js';
import * as printTemplateRepo from '../repositories/printTemplateRepo.js';
import * as systemParameterRepo from '../repositories/systemParameterRepo.js';

/** 权限点常量（避免字符串散落各处拼错） */
const PERMISSION_CONFIG_WRITE = 'config_write';
const PERMISSION_CAPABILITY_WRITE = 'capability_write';

/** 拒绝原因码——挂在对应 `ServiceError.data.rejection` 上，供调用方/测试区分具体拒绝场景。 */
export const CONFIG_SERVICE_REJECTION = Object.freeze({
  FORBIDDEN_CONFIG_WRITE: 'forbiddenConfigWrite',
  FORBIDDEN_CAPABILITY_WRITE: 'forbiddenCapabilityWrite',
  PERMISSION_CHECK_ERROR: 'permissionCheckError',
  INVALID_ENUM_VALUE: 'invalidEnumValue',
  NOT_FOUND: 'notFound',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE]: CODE.FORBIDDEN,
  [CONFIG_SERVICE_REJECTION.FORBIDDEN_CAPABILITY_WRITE]: CODE.FORBIDDEN,
  [CONFIG_SERVICE_REJECTION.PERMISSION_CHECK_ERROR]: CODE.INTERNAL,
  [CONFIG_SERVICE_REJECTION.INVALID_ENUM_VALUE]: CODE.VALIDATION,
  [CONFIG_SERVICE_REJECTION.NOT_FOUND]: CODE.NOT_FOUND,
});

function throwRejection(rejection, message, data) {
  throw new ServiceError(REJECTION_CODE[rejection], message, { rejection, ...data });
}

function throwInvalidEnum(label, value) {
  throwRejection(CONFIG_SERVICE_REJECTION.INVALID_ENUM_VALUE, `${label} 取值非法：${String(value)}`);
}

function throwNotFound(label, id) {
  throwRejection(CONFIG_SERVICE_REJECTION.NOT_FOUND, `未找到${label}：${String(id)}`);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 权限闸门。`actor` 形态：`{ staffNo, role, method?, path?, now? }`
 * （`method`/`path` 供审计日志记录调用来源，缺省落 `'SERVICE'` / `configService:<权限点>`；
 * `now` 供测试注入固定时间戳，缺省取当前时间）。
 *
 * 授权通过直接返回；越权 `throw ServiceError(CODE.FORBIDDEN, ...)` 并已写入
 * `access_denial_log`；权限判定本身异常（未知角色 / 未知权限点 / `role_permission` 矩阵
 * 缺行等编码或数据错误）`throw ServiceError(CODE.INTERNAL, ...)` 且不写审计日志——该分支
 * 不代表一次真实的越权尝试。
 *
 * @param {{staffNo?: string, role?: string, method?: string, path?: string, now?: string}} actor
 * @param {string} permissionPoint `'config_write'` 或 `'capability_write'`
 * @param {string} rejectionCode {@link CONFIG_SERVICE_REJECTION} 中对应的 403 拒绝原因码
 */
function authorize(actor, permissionPoint, rejectionCode) {
  const role = actor?.role ?? null;
  const cfg = rolePermissionRepo.list();
  const { allowed, reason, isAuthorizationDecision } = explainPermission(role, permissionPoint, cfg);

  if (allowed) return;

  if (!isAuthorizationDecision) {
    // 未知角色 / 未知权限点 / 矩阵缺行：调用方或数据的编码错误，非正常越权尝试
    throwRejection(
      CONFIG_SERVICE_REJECTION.PERMISSION_CHECK_ERROR,
      `权限判定异常（${reason}）：角色=${String(role)}，权限点=${permissionPoint}`,
    );
  }

  accessDenialLogRepo.create({
    staffNo: actor?.staffNo ?? null,
    role,
    permissionPoint,
    method: actor?.method ?? 'SERVICE',
    path: actor?.path ?? `configService:${permissionPoint}`,
    deniedAt: actor?.now ?? nowIso(),
  });

  throwRejection(
    rejectionCode,
    `越权：角色 ${String(role)} 无 ${permissionPoint} 权限维护该配置`,
  );
}

// =====================================================================
// 1. stage_card_type_constraint + stage_crosscut（需求 46.9、46.13、46.14）
// =====================================================================

/**
 * 读取 Stage × 工卡类型约束配置（全量约束行 + 横切取值集合）。不缓存，每次调用直达仓储。
 * @returns {{ constraints: object[], crosscut: string[] }}
 */
export function getStageConstraintConfig() {
  return {
    constraints: stageConstraintRepo.list(),
    crosscut: stageConstraintRepo.listCrosscut(),
  };
}

/**
 * 组装 `domain/stage-constraint.js` 的 `validateStageCardType`/`defaultStageFor`/
 * `selectableStages` 可直接消费的 `cfg` 形态（`{ constraints, crosscut }`）。
 * 写入配置后立即调用本函数即可观察到判定结果随之改变（需求 46.14，不缓存）。
 * @returns {{ constraints: object[], crosscut: string[] }}
 */
export function loadStageConstraintCfg() {
  return {
    constraints: stageConstraintRepo.list(),
    crosscut: stageConstraintRepo.listCrosscut(),
  };
}

/**
 * 新增一条 Stage × 工卡类型约束行（`config_write`，需求 46.14）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {{cardType: string, allowedStage: string, isAutoFill?: boolean}} entry
 * @returns {object} 新增行
 * @throws {ServiceError} 越权（403）、枚举非法（400）、权限判定异常（500）
 */
export function createStageConstraint(actor, entry) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  if (!isValidEnumValue('cardType', entry?.cardType)) throwInvalidEnum('cardType', entry?.cardType);
  if (!isValidEnumValue('stage', entry?.allowedStage)) throwInvalidEnum('allowedStage', entry?.allowedStage);

  const id = stageConstraintRepo.create({
    cardType: entry.cardType,
    allowedStage: entry.allowedStage,
    isAutoFill: entry.isAutoFill,
  });
  return stageConstraintRepo.findById(id);
}

/**
 * 更新一条 Stage × 工卡类型约束行（部分更新，`config_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @param {{cardType?: string, allowedStage?: string, isAutoFill?: boolean}} patch
 * @returns {object} 更新后的行
 * @throws {ServiceError} 越权（403）、不存在（404）、枚举非法（400）、权限判定异常（500）
 */
export function updateStageConstraint(actor, id, patch) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const existing = stageConstraintRepo.findById(id);
  if (existing === null) throwNotFound('Stage 约束行', id);

  if (patch?.cardType !== undefined && !isValidEnumValue('cardType', patch.cardType)) {
    throwInvalidEnum('cardType', patch.cardType);
  }
  if (patch?.allowedStage !== undefined && !isValidEnumValue('stage', patch.allowedStage)) {
    throwInvalidEnum('allowedStage', patch.allowedStage);
  }

  stageConstraintRepo.update(id, patch);
  return stageConstraintRepo.findById(id);
}

/**
 * 删除一条 Stage × 工卡类型约束行（`config_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @returns {{ removed: number }}
 * @throws {ServiceError} 越权（403）、不存在（404）、权限判定异常（500）
 */
export function removeStageConstraint(actor, id) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const existing = stageConstraintRepo.findById(id);
  if (existing === null) throwNotFound('Stage 约束行', id);

  const removed = stageConstraintRepo.remove(id);
  return { removed };
}

/**
 * 整表替换横切 Stage 取值集合（`config_write`，需求 46.13、46.14）。事务由
 * {@link stageConstraintRepo.setCrosscut} 内部承担（同一事务内清空重插）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {ReadonlyArray<string>} stages
 * @returns {string[]} 落库后的横切取值集合
 * @throws {ServiceError} 越权（403）、枚举非法（400）、权限判定异常（500）
 */
export function setStageCrosscut(actor, stages) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const list = Array.isArray(stages) ? stages : [];
  for (const stage of list) {
    if (!isValidEnumValue('stage', stage)) throwInvalidEnum('stage', stage);
  }

  return stageConstraintRepo.setCrosscut(list);
}

// =====================================================================
// 2. card_type_commercial_map（P6 兜底层，需求 43.1、43.5）
// =====================================================================

/**
 * 读取工卡类型 → 商务分类映射全量（P6 兜底层）。不缓存。
 * @returns {object[]} 全量映射行
 */
export function getCommercialMap() {
  return commercialMapRepo.list();
}

/**
 * 新增一条工卡类型 → 商务分类映射行（`config_write`，需求 43.5）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {{cardType: string, commercialClassification: string}} entry
 * @returns {object} 新增行
 * @throws {ServiceError} 越权（403）、枚举非法（400）、权限判定异常（500）
 */
export function createCommercialMapEntry(actor, entry) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  if (!isValidEnumValue('cardType', entry?.cardType)) throwInvalidEnum('cardType', entry?.cardType);
  if (!isValidEnumValue('commercialClassification', entry?.commercialClassification)) {
    throwInvalidEnum('commercialClassification', entry?.commercialClassification);
  }

  const id = commercialMapRepo.create({
    cardType: entry.cardType,
    commercialClassification: entry.commercialClassification,
  });
  return commercialMapRepo.findById(id);
}

/**
 * 更新一条工卡类型 → 商务分类映射行（部分更新，`config_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @param {{cardType?: string, commercialClassification?: string}} patch
 * @returns {object} 更新后的行
 * @throws {ServiceError} 越权（403）、不存在（404）、枚举非法（400）、权限判定异常（500）
 */
export function updateCommercialMapEntry(actor, id, patch) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const existing = commercialMapRepo.findById(id);
  if (existing === null) throwNotFound('商务分类映射行', id);

  if (patch?.cardType !== undefined && !isValidEnumValue('cardType', patch.cardType)) {
    throwInvalidEnum('cardType', patch.cardType);
  }
  if (
    patch?.commercialClassification !== undefined
    && !isValidEnumValue('commercialClassification', patch.commercialClassification)
  ) {
    throwInvalidEnum('commercialClassification', patch.commercialClassification);
  }

  commercialMapRepo.update(id, patch);
  return commercialMapRepo.findById(id);
}

/**
 * 删除一条工卡类型 → 商务分类映射行（`config_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @returns {{ removed: number }}
 * @throws {ServiceError} 越权（403）、不存在（404）、权限判定异常（500）
 */
export function removeCommercialMapEntry(actor, id) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const existing = commercialMapRepo.findById(id);
  if (existing === null) throwNotFound('商务分类映射行', id);

  const removed = commercialMapRepo.remove(id);
  return { removed };
}

// =====================================================================
// 3. derivation_priority_config（派生优先级链，需求 29.8）
// =====================================================================

/**
 * 读取商务分类派生优先级链全量（含停用层级）。不缓存。
 * @returns {{ all: object[], enabled: object[] }} `enabled` 已按 `tier_order` 升序
 */
export function getDerivationPriorityConfig() {
  return {
    all: derivationPriorityRepo.list(),
    enabled: derivationPriorityRepo.listEnabled(),
  };
}

/**
 * 组装 `domain/classification.js` 的 `deriveCommercialClassification` 可直接消费的
 * `priorityCfg` 形态（`{ tiers, cardTypeMap }`）。写入 `tier_order`/`enabled` 后立即调用
 * 本函数即可观察到派生结果随之改变（需求 29.8，不缓存）。
 * @returns {{ tiers: object[], cardTypeMap: object[] }}
 */
export function loadDerivationPriorityCfg() {
  return {
    tiers: derivationPriorityRepo.list(),
    cardTypeMap: commercialMapRepo.list(),
  };
}

/**
 * 新增一个派生优先级层级配置行（`config_write`，需求 29.8）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {{tierCode: string, tierOrder: number, enabled?: boolean}} entry
 * @returns {object} 新增行
 * @throws {ServiceError} 越权（403）、枚举非法（400）、权限判定异常（500）
 */
export function createDerivationPriorityTier(actor, entry) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  if (!isValidEnumValue('derivationPriority', entry?.tierCode)) {
    throwInvalidEnum('tierCode', entry?.tierCode);
  }

  const id = derivationPriorityRepo.create({
    tierCode: entry.tierCode,
    tierOrder: entry.tierOrder,
    enabled: entry.enabled,
  });
  return derivationPriorityRepo.findById(id);
}

/**
 * 更新一个派生优先级层级配置行（部分更新——常用于切换 `tier_order` / `enabled`，`config_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @param {{tierCode?: string, tierOrder?: number, enabled?: boolean}} patch
 * @returns {object} 更新后的行
 * @throws {ServiceError} 越权（403）、不存在（404）、枚举非法（400）、权限判定异常（500）
 */
export function updateDerivationPriorityTier(actor, id, patch) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const existing = derivationPriorityRepo.findById(id);
  if (existing === null) throwNotFound('派生优先级层级行', id);

  if (patch?.tierCode !== undefined && !isValidEnumValue('derivationPriority', patch.tierCode)) {
    throwInvalidEnum('tierCode', patch.tierCode);
  }

  derivationPriorityRepo.update(id, patch);
  return derivationPriorityRepo.findById(id);
}

/**
 * 删除一个派生优先级层级配置行（`config_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @returns {{ removed: number }}
 * @throws {ServiceError} 越权（403）、不存在（404）、权限判定异常（500）
 */
export function removeDerivationPriorityTier(actor, id) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const existing = derivationPriorityRepo.findById(id);
  if (existing === null) throwNotFound('派生优先级层级行', id);

  const removed = derivationPriorityRepo.remove(id);
  return { removed };
}

/**
 * 批量重排序派生优先级层级（`tier_order`，`config_write`）。事务由
 * {@link derivationPriorityRepo.reorder} 内部承担（两阶段平移，避免 `UNIQUE` 冲突）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {ReadonlyArray<{id: number | string, tierOrder: number}>} orderings
 * @returns {{ changed: number, all: object[] }}
 * @throws {ServiceError} 越权（403）、权限判定异常（500）
 */
export function reorderDerivationPriority(actor, orderings) {
  authorize(actor, PERMISSION_CONFIG_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CONFIG_WRITE);

  const changed = derivationPriorityRepo.reorder(Array.isArray(orderings) ? orderings : []);
  return { changed, all: derivationPriorityRepo.list() };
}

// =====================================================================
// 4. capability_list（QA 能力清单，需求 39.1、39.4，独立权限点 capability_write）
// =====================================================================

/**
 * 读取能力清单全量。不缓存。
 * @returns {object[]} 全量能力清单行
 */
export function getCapabilityList() {
  return capabilityRepo.list();
}

/**
 * 新增一条能力清单行（`capability_write`，需求 39.1——独立权限点，不与 `config_write` 互相蕴含）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {{acType: string, gearType: string, skill: string, revision: number,
 *          effectiveFrom: string, effectiveTo?: string | null}} entry
 * @returns {object} 新增行
 * @throws {ServiceError} 越权（403）、枚举非法（400）、权限判定异常（500）
 */
export function createCapabilityEntry(actor, entry) {
  authorize(actor, PERMISSION_CAPABILITY_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CAPABILITY_WRITE);

  if (!isValidEnumValue('acType', entry?.acType)) throwInvalidEnum('acType', entry?.acType);
  if (!isValidEnumValue('gearType', entry?.gearType)) throwInvalidEnum('gearType', entry?.gearType);
  if (!isValidEnumValue('skill', entry?.skill)) throwInvalidEnum('skill', entry?.skill);

  const id = capabilityRepo.create({
    acType: entry.acType,
    gearType: entry.gearType,
    skill: entry.skill,
    revision: entry.revision,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo,
  });
  return capabilityRepo.findById(id);
}

/**
 * 更新一条能力清单行（部分更新，`capability_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @param {{acType?: string, gearType?: string, skill?: string, revision?: number,
 *          effectiveFrom?: string, effectiveTo?: string | null}} patch
 * @returns {object} 更新后的行
 * @throws {ServiceError} 越权（403）、不存在（404）、枚举非法（400）、权限判定异常（500）
 */
export function updateCapabilityEntry(actor, id, patch) {
  authorize(actor, PERMISSION_CAPABILITY_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CAPABILITY_WRITE);

  const existing = capabilityRepo.findById(id);
  if (existing === null) throwNotFound('能力清单行', id);

  if (patch?.acType !== undefined && !isValidEnumValue('acType', patch.acType)) {
    throwInvalidEnum('acType', patch.acType);
  }
  if (patch?.gearType !== undefined && !isValidEnumValue('gearType', patch.gearType)) {
    throwInvalidEnum('gearType', patch.gearType);
  }
  if (patch?.skill !== undefined && !isValidEnumValue('skill', patch.skill)) {
    throwInvalidEnum('skill', patch.skill);
  }

  capabilityRepo.update(id, patch);
  return capabilityRepo.findById(id);
}

/**
 * 删除一条能力清单行（`capability_write`）。
 * @param {{staffNo?: string, role?: string}} actor
 * @param {number | string} id
 * @returns {{ removed: number }}
 * @throws {ServiceError} 越权（403）、不存在（404）、权限判定异常（500）
 */
export function removeCapabilityEntry(actor, id) {
  authorize(actor, PERMISSION_CAPABILITY_WRITE, CONFIG_SERVICE_REJECTION.FORBIDDEN_CAPABILITY_WRITE);

  const existing = capabilityRepo.findById(id);
  if (existing === null) throwNotFound('能力清单行', id);

  const removed = capabilityRepo.remove(id);
  return { removed };
}

// Route-safe entry points. Authorization is performed once by the route middleware; these
// functions deliberately do not call the service-local authorization gate.
function requireArray(value, label) {
  if (!Array.isArray(value)) throw new ServiceError(CODE.VALIDATION, `${label} 必须为数组`);
  return value;
}

function assertUnique(rows, keyOf, label) {
  const keys = rows.map(keyOf);
  if (new Set(keys).size !== keys.length) {
    throw new ServiceError(CODE.VALIDATION, `${label} 不可重复`);
  }
}

export function replaceStageConstraintConfigAuthorized(input) {
  const constraints = requireArray(input?.constraints, 'constraints');
  const crosscut = requireArray(input?.crosscut, 'crosscut');
  for (const row of constraints) {
    if (!isValidEnumValue('cardType', row?.cardType)) throwInvalidEnum('cardType', row?.cardType);
    if (!isValidEnumValue('stage', row?.allowedStage)) throwInvalidEnum('allowedStage', row?.allowedStage);
  }
  for (const stage of crosscut) {
    if (!isValidEnumValue('stage', stage)) throwInvalidEnum('crosscut', stage);
  }
  assertUnique(constraints, (row) => `${row.cardType}|${row.allowedStage}`, 'Stage 约束组合');
  assertUnique(crosscut, String, '横切 Stage');

  getDb().transaction(() => {
    getDb().prepare('DELETE FROM stage_card_type_constraint').run();
    getDb().prepare('DELETE FROM stage_crosscut').run();
    for (const row of constraints) stageConstraintRepo.create(row);
    const insertCrosscut = getDb().prepare('INSERT INTO stage_crosscut (stage) VALUES (?)');
    for (const stage of crosscut) insertCrosscut.run(stage);
  })();
  return getStageConstraintConfig();
}

export function replaceCommercialMapAuthorized(entries) {
  const rows = requireArray(entries, 'mappings');
  for (const row of rows) {
    if (!isValidEnumValue('cardType', row?.cardType)) throwInvalidEnum('cardType', row?.cardType);
    if (!isValidEnumValue('commercialClassification', row?.commercialClassification)) {
      throwInvalidEnum('commercialClassification', row?.commercialClassification);
    }
  }
  assertUnique(rows, (row) => `${row.cardType}|${row.commercialClassification}`, '商务分类映射');
  getDb().transaction(() => {
    getDb().prepare('DELETE FROM card_type_commercial_map').run();
    for (const row of rows) commercialMapRepo.create(row);
  })();
  return getCommercialMap();
}

export function replaceDerivationPriorityAuthorized(entries) {
  const rows = requireArray(entries, 'tiers');
  for (const row of rows) {
    if (!isValidEnumValue('derivationPriority', row?.tierCode)) throwInvalidEnum('tierCode', row?.tierCode);
    if (!Number.isInteger(Number(row?.tierOrder)) || Number(row.tierOrder) <= 0) {
      throw new ServiceError(CODE.VALIDATION, `tierOrder 取值非法：${String(row?.tierOrder)}`);
    }
  }
  assertUnique(rows, (row) => row.tierCode, 'tierCode');
  assertUnique(rows, (row) => String(row.tierOrder), 'tierOrder');
  getDb().transaction(() => {
    getDb().prepare('DELETE FROM derivation_priority_config').run();
    for (const row of rows) derivationPriorityRepo.create(row);
  })();
  return getDerivationPriorityConfig();
}

export function replaceCapabilitiesAuthorized(entries) {
  const rows = requireArray(entries, 'capabilities');
  for (const row of rows) {
    if (!isValidEnumValue('acType', row?.acType)) throwInvalidEnum('acType', row?.acType);
    if (!isValidEnumValue('gearType', row?.gearType)) throwInvalidEnum('gearType', row?.gearType);
    if (!isValidEnumValue('skill', row?.skill)) throwInvalidEnum('skill', row?.skill);
    if (!Number.isInteger(Number(row?.revision)) || Number(row.revision) <= 0) {
      throw new ServiceError(CODE.VALIDATION, `revision 取值非法：${String(row?.revision)}`);
    }
  }
  assertUnique(rows, (row) => `${row.acType}|${row.gearType}|${row.skill}|${row.revision}`, '能力版本');
  getDb().transaction(() => {
    getDb().prepare('DELETE FROM capability_list').run();
    for (const row of rows) capabilityRepo.create(row);
  })();
  return getCapabilityList();
}

export function getPrintTemplates() {
  return printTemplateRepo.list();
}

export function getSystemParameters() {
  return systemParameterRepo.list();
}

export function updatePrintTemplateAuthorized(id, patch) {
  const existing = printTemplateRepo.findById(id);
  if (existing === null) throwNotFound('打印模板', id);
  const targetKind = patch?.targetKind ?? existing.targetKind;
  const targetCode = patch?.targetCode ?? existing.targetCode;
  if (!['card_type', 'exec_doc_type'].includes(targetKind)) throwInvalidEnum('targetKind', targetKind);
  if (targetKind === 'card_type' && !isValidEnumValue('cardType', targetCode)) throwInvalidEnum('targetCode', targetCode);
  if (targetKind === 'exec_doc_type' && !isValidEnumValue('execDocType', targetCode)) throwInvalidEnum('targetCode', targetCode);
  printTemplateRepo.update(id, patch ?? {});
  return printTemplateRepo.findById(id);
}

export default {
  getStageConstraintConfig,
  loadStageConstraintCfg,
  createStageConstraint,
  updateStageConstraint,
  removeStageConstraint,
  setStageCrosscut,
  getCommercialMap,
  createCommercialMapEntry,
  updateCommercialMapEntry,
  removeCommercialMapEntry,
  getDerivationPriorityConfig,
  loadDerivationPriorityCfg,
  createDerivationPriorityTier,
  updateDerivationPriorityTier,
  removeDerivationPriorityTier,
  reorderDerivationPriority,
  getCapabilityList,
  createCapabilityEntry,
  updateCapabilityEntry,
  removeCapabilityEntry,
  replaceStageConstraintConfigAuthorized,
  replaceCommercialMapAuthorized,
  replaceDerivationPriorityAuthorized,
  replaceCapabilitiesAuthorized,
  getPrintTemplates,
  getSystemParameters,
  updatePrintTemplateAuthorized,
};
