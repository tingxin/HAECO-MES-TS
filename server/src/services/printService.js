/**
 * 打印服务（Print Service，任务 13.10）—— 模板选用 + 字段投影的服务层组合点。
 *
 * 本服务**不重新实现**任何判定/投影逻辑，只做「取数 → 组装 → 转调两个既有领域纯函数」：
 * - `domain/print-template.js` 的 `selectPrintTemplate(card, templates)`（模板回退链 L1–L4）；
 * - `domain/card-rules.js` 的 `printProjection(card, template, jobContext?)`（字段投影，
 *   剔除 `card_type`，逐工序签署栏见其模块头注，需求 45.7）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 编制态 / 执行态的取数分野（Property 34，需求 33.9）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `jobNo` 缺省 → **编制态投影**：工序取自**当前**的 `process_step`（及其嵌套的
 * `signature_requirement` / `inserted_component`），工时实际值、起止时间、签署记录均无
 * 从谈起（`printProjection` 在 `jobContext` 缺省时自动输出为空白待填栏位）。
 *
 * `jobNo` 携带 → **执行态投影**：工序内容一律取自 `job_step_snapshot.content`
 * （**不**反查 `process_step` 当前内容——`job_process.step_id` 仅作溯源，Property 34），
 * 工时实际值/起止时间取自 `job_process`，签署记录取自 `electronic_signature`
 * （按 `job_id` 收敛，`signatureRequirementId` 与快照内签署项的 `id` 一一对应，二者
 * 均回溯到同一份 `signature_requirement.id`，故无需额外映射）。`jobNo` 不存在或不属于
 * 该工卡一律 `404`。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 参考文件不受 Property 34 约束
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 卡级参考文件（`reference_document`，需求 5.3「参考文件与版本」）不属于 `process_step`
 * 快照内容的范畴（快照按工序存 `refDoc` 是工序自身引用的参考文件，用于工序描述，与卡级
 * 参考文件列表是两件事），编制态/执行态均直读 `reference_document` 表当前内容。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 组织名称（需求 35.1、35.2）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 打印抬头的组织名称经 `systemParameterRepo.get('organizationName')` 取得后合并进
 * `printProjection` 的 `card` 入参（其 `organizationName` 字段），不在模板选用环节处理。
 *
 * 需求：3.6（间接，导出与打印同源字段口径）、5.1–5.3、16.3、33.9、35.1、35.2、
 *       40.1–40.5、45.7
 */

import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import { selectPrintTemplate } from '../domain/print-template.js';
import { printProjection } from '../domain/card-rules.js';
import { parseSnapshotContent } from '../domain/snapshot.js';

import taskCardRepo from '../repositories/taskCardRepo.js';
import referenceDocRepo from '../repositories/referenceDocRepo.js';
import processStepRepo from '../repositories/processStepRepo.js';
import componentRepo from '../repositories/componentRepo.js';
import signatureRequirementRepo from '../repositories/signatureRequirementRepo.js';
import printTemplateRepo from '../repositories/printTemplateRepo.js';
import jobRepo from '../repositories/jobRepo.js';
import jobProcessRepo from '../repositories/jobProcessRepo.js';
import jobStepSnapshotRepo from '../repositories/jobStepSnapshotRepo.js';
import signatureRepo from '../repositories/signatureRepo.js';
import systemParameterRepo from '../repositories/systemParameterRepo.js';

/** 按主键取工卡，取不到即 `404`。 */
function loadCardOrThrow(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) {
    throw new ServiceError(CODE.NOT_FOUND, `工卡不存在：${String(cardId)}`);
  }
  return card;
}

/** `jobNo` 归一化：`undefined`/`null`/空白串一律视为「未提供」（编制态）。 */
function normalizeJobNo(jobNo) {
  if (jobNo === undefined || jobNo === null) return null;
  const text = String(jobNo).trim();
  return text === '' ? null : text;
}

/**
 * 按主键 + `jobNo` 取一次释放的 JOB，且须属于该工卡；取不到或不属于该工卡一律 `404`
 * （不区分「JOB 不存在」与「JOB 属于别的工卡」两种情形——对调用方而言均是「按此工卡与此
 * jobNo 查不到打印所需的执行态数据」）。
 * @param {number | string} cardId
 * @param {string} jobNo
 * @returns {object} camelCase JOB 行
 */
function loadJobOrThrow(cardId, jobNo) {
  const job = jobRepo.findByJobNo(jobNo);
  if (job === null || String(job.cardId) !== String(cardId)) {
    throw new ServiceError(CODE.NOT_FOUND, `JOB 不存在或不属于该工卡：${jobNo}`, { jobNo, cardId });
  }
  return job;
}

/**
 * 编制态工序集合（需求 5.3、45.7）：取当前 `process_step` 并嵌套挂载其签署项配置
 * （`aggregateSignatureRequirements` 的唯一来源，需求 45.6）与插入组件（工具/耗材/
 * 维修草图的来源，见 `printProjection` 对 `steps[].components` 的消费）。
 * @param {number | string} cardId
 * @returns {object[]}
 */
function loadAuthoringSteps(cardId) {
  return processStepRepo.listByCardId(cardId).map((step) => ({
    ...step,
    signatureRequirements: signatureRequirementRepo.listByStepId(step.id),
    components: componentRepo.listByStepId(step.id),
  }));
}

/**
 * 执行态工序集合（Property 34）：逐个 `job_process` 取其 `job_step_snapshot.content`，
 * **不反查** `process_step` 当前内容。`id` 取 `job_process.stepId`（即快照的
 * `sourceStepId`，二者同值），与 `printProjection` 按 `id`/`processId` 匹配
 * `jobContext.processes` 的约定一致。快照缺失（理论上不应发生，释放与快照同事务写入）
 * 时该工序退化为仅含 `processId` 的空壳，不中断整体投影。
 * @param {ReadonlyArray<object>} jobProcesses `jobProcessRepo.listByJobId` 的结果
 * @returns {object[]}
 */
function loadExecutionSteps(jobProcesses) {
  return jobProcesses.map((jobProcess) => {
    const snapshot = jobStepSnapshotRepo.findByJobProcessId(jobProcess.id);
    const content = snapshot === null ? {} : parseSnapshotContent(snapshot.content);
    return {
      id: jobProcess.stepId,
      processId: content.processId ?? jobProcess.processId,
      skill: content.skill ?? null,
      descriptionZh: content.descriptionZh ?? null,
      descriptionEn: content.descriptionEn ?? null,
      safetyWarning: content.safetyWarning ?? null,
      repairTips: content.repairTips ?? null,
      isCritical: content.isCritical ?? 0,
      components: content.components ?? [],
      signatureRequirements: content.signatureRequirements ?? [],
    };
  });
}

/**
 * 组装 `printProjection` 的 `jobContext`（执行态，需求 33.9）：卡级起止时间/件号取自
 * `job`，工序级工时/起止时间取自 `job_process`，签署记录取自 `electronic_signature`
 * （按 `job_id` 收敛）。
 * @param {object} job camelCase JOB 行
 * @param {ReadonlyArray<object>} jobProcesses
 * @returns {object}
 */
function buildJobContext(job, jobProcesses) {
  const signatures = signatureRepo.listByJobId(job.id).map((signature) => ({
    signatureRequirementId: signature.signatureRequirementId,
    signedBy: signature.signedBy,
    stampId: signature.stampId,
    signedAt: signature.signedAt,
  }));

  return {
    startTime: job.startTime,
    finishTime: job.finishTime,
    partNo: job.partNo,
    processes: jobProcesses.map((jobProcess) => ({
      stepId: jobProcess.stepId,
      processId: jobProcess.processId,
      actualManHours: jobProcess.actualManHours,
      startTime: jobProcess.startTime,
      finishTime: jobProcess.finishTime,
    })),
    signatures,
  };
}

/**
 * 取一张工卡的打印三元组（需求 5.1–5.3、16.3、33.9、40.1–40.5、45.7）：
 * `{ templateId, templateBody, model }`。
 *
 * 模板选用（`selectPrintTemplate`）恒依据工卡当前的 `cardType` 判定，与 `jobNo` 是否
 * 提供无关——`model`（`printProjection` 的输出）本身不含 `cardType`（需求 5.2），
 * 但模板挑选发生在投影之前，须用未剔除字段前的原始工卡行。
 *
 * @param {number | string} cardId
 * @param {{jobNo?: string}} [options] `jobNo` 缺省为编制态投影，提供则为执行态投影
 * @returns {{ templateId: number|string|null, templateBody: string|null, model: object }}
 * @throws {ServiceError} 工卡不存在（404）；`jobNo` 提供但对应 JOB 不存在或不属于该工卡（404）
 */
export function getPrintModel(cardId, options = {}) {
  const card = loadCardOrThrow(cardId);
  const jobNo = normalizeJobNo(options?.jobNo);

  const organizationName = systemParameterRepo.get('organizationName');
  const referenceDocuments = referenceDocRepo.listByCardId(cardId);

  let steps;
  let jobContext;
  if (jobNo === null) {
    steps = loadAuthoringSteps(cardId);
    jobContext = undefined;
  } else {
    const job = loadJobOrThrow(cardId, jobNo);
    const jobProcesses = jobProcessRepo.listByJobId(job.id);
    steps = loadExecutionSteps(jobProcesses);
    jobContext = buildJobContext(job, jobProcesses);
  }

  const selection = selectPrintTemplate(card, printTemplateRepo.list());
  const projectionInput = { ...card, organizationName, referenceDocuments, steps };
  const model = printProjection(projectionInput, selection, jobContext);

  return {
    templateId: selection.templateId,
    templateBody: selection.templateBody,
    model,
  };
}

export default { getPrintModel };
