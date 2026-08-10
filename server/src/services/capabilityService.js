/**
 * 能力清单范围校验服务（任务 13.7 之二，需求 39.1–39.4）。
 *
 * 薄封装：取 `capabilityRepo` 全表 → 复用 `domain/capability.js` 的
 * `currentCapabilityRevision`/`checkCapability`（唯一权威判定，见其模块头注
 * 「判定口径……作用域取三元组」），本服务**不重新实现**版本选取或范围校验逻辑，只负责
 * 取数与把领域纯函数的判别式结果对象转译为服务层 `ServiceError` 约定（或按需直接返回，
 * 见下）。
 *
 * ## 两种消费形态
 *
 * - {@link getCurrentCapability}：任务描述中要求的「返回当前有效版本，或 null/throw」形态。
 *   对齐 `capabilityRepo.currentByScope` 的只读查询便捷方法语义，但**权威实现走
 *   `domain/capability.js`**（该仓储方法的 SQL 直译版本必须与之口径一致，见其模块头注），
 *   不合规范（无当前有效版本）时按 `strict` 选项决定 `throw` 还是返回 `null`。
 * - {@link checkCapability}：直通转发领域纯函数的判别式结果对象（`{ ok, rejection, message,
 *   revision, scope, onDate }`），供 `review.js` 的提交审核校验项 (d) 等纯校验场景消费，
 *   不 `throw`——该场景需要的是「未通过原因」而非异常控制流，与 `domain/review.js` 中
 *   `checkCapabilityItem` 直接调用 `capability.js` 的既有用法保持同一形态，本服务只是把
 *   「取全表」这一步骤封装掉，便于服务层其它调用点（如提交审核服务、future 路由层）无需
 *   各自 `import capabilityRepo`。
 *
 * ## 不经编辑态闸门
 *
 * 能力清单校验是**只读判定**，不修改工卡或任何配置数据，天然不涉及 `isEditable` 闸门。
 *
 * 需求：39.1、39.2、39.3、39.4
 */

import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import { checkCapability as checkCapabilityDomain, currentCapabilityRevision } from '../domain/capability.js';
import * as capabilityRepo from '../repositories/capabilityRepo.js';

/** 拒绝原因码——与 `domain/capability.js` 的 `CAPABILITY_REJECTION` 同一取值集，直通复用。 */
export const CAPABILITY_REJECTION = Object.freeze({
  /** 整张清单无任何覆盖校验当日的记录（需求 39.1、39.4） → `CODE.UNPROCESSABLE`（422） */
  NO_EFFECTIVE_REVISION: 'NO_EFFECTIVE_REVISION',
  /** 三元组不在当前有效版本的能力范围内（需求 39.2、39.3） → `CODE.UNPROCESSABLE`（422） */
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  /** 校验日期格式非法 → `CODE.VALIDATION`（400） */
  INVALID_ON_DATE: 'INVALID_ON_DATE',
});

/** 拒绝原因码 → `ServiceError.code`（`lib/response.js` 的 `CODE`）。 */
const REJECTION_CODE = Object.freeze({
  [CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION]: CODE.UNPROCESSABLE,
  [CAPABILITY_REJECTION.OUT_OF_SCOPE]: CODE.UNPROCESSABLE,
  [CAPABILITY_REJECTION.INVALID_ON_DATE]: CODE.VALIDATION,
});

/**
 * 按需求 39.4 规则选取（机型, 起落架类型, Skill）三元组的当前有效能力版本。
 *
 * 取 `capability_list` 全表 → 按三元组过滤 → `currentCapabilityRevision` 取「生效期覆盖
 * `onDate` ∧ revision 最大」的那一行。无覆盖当日的记录时：`strict`（缺省 `true`）下
 * `throw new ServiceError(CODE.UNPROCESSABLE, ...)`；`strict: false` 时返回 `null`
 * （供只需要「有没有」而不需要异常控制流的调用点使用，如批量预检）。
 *
 * @param {string} acType 机型
 * @param {string} gearType 起落架类型
 * @param {string} skill 专业
 * @param {{onDate?: string|Date, strict?: boolean}} [options] `onDate` 缺省取当日；
 *   `strict` 缺省 `true`
 * @returns {object | null} 当前有效版本行（camelCase，`capabilityRepo` 的返回形态），
 *   `strict: false` 且无有效版本时为 `null`
 * @throws {ServiceError} `strict !== false` 且无覆盖 `onDate` 的记录（422，
 *   `rejection: 'NO_EFFECTIVE_REVISION'`）
 */
export function getCurrentCapability(acType, gearType, skill, options = {}) {
  const { onDate, strict = true } = options;
  const scoped = capabilityRepo.listByScope(acType, gearType, skill);
  const revision = currentCapabilityRevision(scoped, onDate);

  if (revision === null) {
    if (strict === false) return null;
    throw new ServiceError(
      REJECTION_CODE[CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION],
      `能力清单缺失或已过期（机型=${String(acType)}，起落架类型=${String(gearType)}，专业=${String(skill)}），无当前有效版本`,
      { rejection: CAPABILITY_REJECTION.NO_EFFECTIVE_REVISION, acType, gearType, skill, onDate: onDate ?? null },
    );
  }

  return scoped.find((row) => row.revision === revision) ?? null;
}

/**
 * 能力清单范围校验（需求 39.1–39.4）——`domain/capability.js` 的 `checkCapability` 的
 * 直通转发，本函数只负责取 `capability_list` 全表，不重新实现判定逻辑，亦不 `throw`
 * （返回判别式结果对象，供提交审核校验等纯校验场景消费）。
 *
 * @param {object} card 工卡对象（读 `ac_type`/`acType`、`gear_type`/`gearType`、`skill`）
 * @param {string|Date} [onDate] 校验日期；缺省取当日
 * @returns {{ok: boolean, rejection: string|null, message: string, revision: number|null,
 *   scope: {acType: string|null, gearType: string|null, skill: string|null}, onDate: string|null}}
 */
export function checkCapability(card, onDate) {
  const capabilityList = capabilityRepo.list();
  return checkCapabilityDomain(card, capabilityList, onDate);
}

export default { getCurrentCapability, checkCapability };
