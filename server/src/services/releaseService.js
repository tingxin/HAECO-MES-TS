/**
 * 发布服务（Release Service）—— 【发布】至工包：JOB + 工序快照 + 条码 + 集成带出（任务 13.5）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 前置条件（Property 15 / 需求 24.1、24.2）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 复用 `domain/card-rules.js` 的 {@link canRelease}（`status === 'Effective'`），**不重新
 * 实现**发布前置判定。非生效工卡的发布请求 `throw new ServiceError(CODE.UNPROCESSABLE, ...)`
 * （422），且**无论成功与否均记录一次 `work_package_release` 结果**（需求 24.3、Property 15）
 * ——本服务在前置校验失败分支与事务内部失败分支均各自落一条 `result: 'failed'` 记录，
 * 成功路径的记录则与 JOB 数据在同一事务内一并落库（同生共死）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 单事务边界（tasks.md 关键实现约束 4 / Property 34）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `release` 的核心写路径——生成 `job_no` 并写 `job` → 调 `domain/snapshot.js` 的
 * `buildStepSnapshots` 建立本次释放的工序内容不可变副本 → 逐工序写 `job_process`（条码经
 * `domain/barcode.js` 的 `generateBarcode(jobNo, processId)` 生成）→ 写对应
 * `job_step_snapshot` → 写 `work_package_release` 成功记录——包在**同一个**
 * `getDb().transaction(fn)()` 调用内：任一步失败则整批回滚，不产生「JOB 已建、快照/条码
 * 缺失」的半态孤儿数据。事务失败时在事务**外**补记一条 `result: 'failed'` 的发布结果
 * （最佳努力，其自身失败不掩盖原始错误），因为失败的事务本身不会持久化任何行，
 * 包括「本想在事务内记的失败结果」——若把失败记录也放进会被回滚的同一事务，则该记录
 * 同样消失，Property 15「无论成功与否均记录一次」就会落空。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 工序快照的输入组装（需求 49.5–49.7）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `buildStepSnapshots` 需要**完整的**工序内容（含采集项、组件、签署项，以及参考文件解析源），
 * 不是仅工序行本身——本服务按工卡取全部工序（`processStepRepo.listByCardId`），逐工序取其
 * 采集项/组件/签署项（`captureItemRepo`/`componentRepo`/`signatureRequirementRepo` 的
 * `listByStepId`）拼成扁平集合，并取该工卡的全部参考文件（`referenceDocRepo.listByCardId`）
 * 作为 `options.referenceDocuments` 供 `ref_doc_id` 解析——与 `buildStepSnapshots` 的
 * `groupByStepId` 内部按 `step_id` 归组的约定一致，缺失来源不报错、按快照模块自身的「真实
 * 反映未提供」语义留空。
 *
 * 每个快照落 `job_step_snapshot` 时复用 `domain/snapshot.js` 的 {@link serializeStepSnapshot}
 * 产出行形状（`snake_case` 键），**不在本服务重新拼装快照行**——与 `jobStepSnapshotRepo` 的
 * `pickColumns` 对 `snake_case` 键幂等这一事实相容，二者共同保证快照落库形态只有一处定义。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 集成带出（两域分离，Property 31 / 需求 26.4、27.2、27.5）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 经只读仓储 `ppcScheduleRepo.findJobTargetDate(pidNo, cardId)` 取 `job_target_date`；经
 * `processDataRepo.findOne(pidNo, cardId, null)` 取卡级 Process Card 四字段，并逐工序调用
 * `processDataRepo.findOne(pidNo, cardId, processId)` 取 `operation` 写入不可变工序快照。
 * 任一集成值取不到时对应 JOB 列或快照字段留 `null`，**不阻断释放**（需求 26.4），仅在
 * 成功响应的 `message` 中追加「集成数据缺失」提示与 `integrationDataMissing: true` 标记，
 * 供前端提示、不占用错误码——**只写执行域 `job` / `job_step_snapshot`，绝不回写
 * `task_card` / `process_step`**（Property 31 两域分离，本文件任何写路径都不触及编制域写方法）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `job_no` 生成（需求 37.1、37.3）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `job.job_no` 只有 `UNIQUE` 约束，库内无配套的编号序列表（不同于 `task_no_sequence`），
 * 领域层亦未提供专属生成器（`domain/barcode.js` 只消费 `jobNo`，不生成）——故编号生成
 * 落在服务层：取该工卡既有释放次数 + 1 作为序号，形如 `` `JOB-${taskNo}-${序号三位补零}` ``，
 * 保证**同一 Task Card 的多次释放各自独立**（需求 37.3）。序号来自本次调用前
 * `jobRepo.listByCardId` 的行数，属乐观取号；真正的唯一性由 `UNIQUE(job_no)` 约束兜底
 * （高并发下的竞争重试超出本任务范围，与仓储层其它编号生成的既有取舍一致）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 错误约定（与 `taskCardService.js` / `relationService.js` 同一口径）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 校验失败或前置条件不满足时一律 `throw new ServiceError(code, message, data)`；成功路径
 * 返回纯业务数据，不做信封包装。数据库约束冲突经 `translateSqliteError` 转译，不放任
 * `SqliteError` 泄漏到路由层。
 *
 * 需求：15.1–15.4, 24.1–24.3, 26.1–26.5, 27.1–27.5, 37.1–37.5, 49.5–49.7
 */

import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError, translateSqliteError } from '../lib/service-error.js';

import { canRelease, statusOf } from '../domain/card-rules.js';
import { buildStepSnapshots, parseSnapshotContent, serializeStepSnapshot } from '../domain/snapshot.js';
import { generateBarcode } from '../domain/barcode.js';

import taskCardRepo from '../repositories/taskCardRepo.js';
import processStepRepo from '../repositories/processStepRepo.js';
import captureItemRepo from '../repositories/captureItemRepo.js';
import componentRepo from '../repositories/componentRepo.js';
import signatureRequirementRepo from '../repositories/signatureRequirementRepo.js';
import referenceDocRepo from '../repositories/referenceDocRepo.js';
import jobRepo from '../repositories/jobRepo.js';
import jobProcessRepo from '../repositories/jobProcessRepo.js';
import jobStepSnapshotRepo from '../repositories/jobStepSnapshotRepo.js';
import workPackageReleaseRepo from '../repositories/workPackageReleaseRepo.js';
import ppcScheduleRepo from '../repositories/ppcScheduleRepo.js';
import processDataRepo from '../repositories/processDataRepo.js';

// =====================================================================
// 一、内部辅助（不导出）
// =====================================================================

/** JOB 默认所有者（design.md「OWNER 所有者，默认 HAECO」，需求 26.1）。 */
const DEFAULT_OWNER = 'HAECO';

/** 新建 JOB 的初始执行状态：尚无工序开始执行（需求 42.1 作废前置校验判定依据之一）。 */
const INITIAL_EXEC_STATUS = 'Pending';

/** 条码承载类型缺省取 Code128（`domain/barcode.js` 头注），二维码为可选的另一种呈现载体。 */
const DEFAULT_BARCODE_TYPE = 'barcode';

/** 当前时刻的 ISO 字符串（释放时间 / 快照时间共用同一时刻，便于同批数据可比对）。 */
function nowISO() {
  return new Date().toISOString();
}

/** 取调用上下文中的操作人标识；缺失一律拒绝（发布须可追溯到人）。 */
function operatorIdOf(ctx) {
  const raw = ctx && typeof ctx === 'object' ? ctx.operatorId ?? ctx.staffNo ?? ctx.userId : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new ServiceError(CODE.VALIDATION, '缺少操作人标识（ctx.operatorId）');
  }
  return String(raw);
}

/** 文本归一：空白/缺失 → `null`，其余保留原貌（不 trim 业务内容，仅判空）。 */
function normalizeOptionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() === '' ? null : text;
}

/** 按主键取工卡，取不到即 `404`。 */
function loadCardOrThrow(id) {
  const card = taskCardRepo.findById(id);
  if (card === null) {
    throw new ServiceError(CODE.NOT_FOUND, `工卡不存在：${String(id)}`);
  }
  return card;
}

/**
 * 生成本次释放的 `job_no`（需求 37.1、37.3）：取该工卡既有释放次数 + 1 作为序号，
 * 形如 `JOB-{taskNo}-{序号三位补零}`。同一工卡的多次释放各自独立取号，互不相同。
 * @param {object} card camelCase 工卡（须含 `taskNo`）
 * @param {number} existingReleaseCount 该工卡此前已生成的 JOB 数量
 * @returns {string}
 */
function generateJobNo(card, existingReleaseCount) {
  const seq = existingReleaseCount + 1;
  return `JOB-${card.taskNo}-${String(seq).padStart(3, '0')}`;
}

/** 在一个 better-sqlite3 事务内执行 `fn` 并返回其结果。 */
function withTransaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * 最佳努力记录一条失败的发布结果——用于「前置校验未通过」与「事务内部失败已回滚」两个分支，
 * 其自身若失败（如 `cardId` 已不存在等极端情形）不得掩盖原始错误，故吞掉二次异常。
 */
function recordFailedRelease(cardId, packageRef, releasedAt) {
  try {
    workPackageReleaseRepo.create({
      cardId,
      jobNo: null,
      packageRef,
      releasedAt,
      result: 'failed',
    });
  } catch {
    // 最佳努力：记录失败结果本身出错时不掩盖原始错误。
  }
}

/**
 * 汇总某工卡全部工序的采集项 / 组件 / 签署项（`buildStepSnapshots` 所需的扁平集合），
 * 以及参考文件集合（供 `ref_doc_id` 解析）。
 * @param {ReadonlyArray<object>} steps `processStepRepo.listByCardId` 的结果
 * @param {number | string} cardId
 * @returns {{captureItems: object[], components: object[], sigReqs: object[], referenceDocuments: object[]}}
 */
function gatherStepContent(steps, cardId) {
  const captureItems = [];
  const components = [];
  const sigReqs = [];
  for (const step of steps) {
    captureItems.push(...captureItemRepo.listByStepId(step.id));
    components.push(...componentRepo.listByStepId(step.id));
    sigReqs.push(...signatureRequirementRepo.listByStepId(step.id));
  }
  const referenceDocuments = referenceDocRepo.listByCardId(cardId);
  return { captureItems, components, sigReqs, referenceDocuments };
}

// =====================================================================
// 二、发布（release）
// =====================================================================

/**
 * 【发布】至工包：生成 JOB + 工序内容快照 + 条码，并带出 PPC 排产 JOB TARGET DATE、
 * Process Data 的 Process Card 四字段及逐工序 Operation（需求 15.1–15.4、24.1–24.3、
 * 26.1–26.5、27.1–27.5、30.1、37.1–37.5、49.5–49.7）。
 *
 * 同一张 Task Card 可多次释放，各自生成独立的 `job_no` 与独立的 `job_process` /
 * `job_step_snapshot` 行（不复用、不共享，需求 37.3）。
 *
 * @param {number | string} cardId 待发布工卡主键
 * @param {{operatorId?: string, staffNo?: string, userId?: string,
 *          pidNo?: string, packageRef?: string}} ctx 调用上下文：`operatorId` 必填，
 *   `pidNo`（所属 PID，供 `job.pid_no` 与集成带出取数）与 `packageRef`（目标工包引用标识）
 *   均可选，缺省按 `null` 处理
 * @returns {{jobNo: string, packageRef: string|null, job: object, jobProcesses: object[],
 *            release: object, message: string, integrationDataMissing: boolean}}
 * @throws {ServiceError} 工卡不存在（404）；状态非 `Effective`（422，仍记录一次失败发布结果）
 */
export function release(cardId, ctx) {
  const operatorId = operatorIdOf(ctx);
  const card = loadCardOrThrow(cardId);
  const releasedAt = nowISO();
  const pidNo = normalizeOptionalText(ctx?.pidNo);
  const packageRef = normalizeOptionalText(ctx?.packageRef);

  if (!canRelease(card)) {
    recordFailedRelease(card.id, packageRef, releasedAt);
    throw new ServiceError(CODE.UNPROCESSABLE, '工卡尚未生效，不可发布至工包', {
      status: statusOf(card),
    });
  }

  try {
    return withTransaction(() => {
      const existingJobs = jobRepo.listByCardId(cardId);
      const jobNo = generateJobNo(card, existingJobs.length);

      // ── 集成带出（写 job 表，不回写 task_card；取不到值该列留空、不阻断释放） ──
      const jobTargetDate = ppcScheduleRepo.findJobTargetDate(pidNo, cardId);
      const processCardData = processDataRepo.findOne(pidNo, cardId, null);
      const missingIntegrations = [];
      if (jobTargetDate === null) missingIntegrations.push('JOB TARGET DATE（PPC 排产）');
      if (processCardData === null) missingIntegrations.push('Process Card 字段（Process Data）');

      const jobId = jobRepo.create({
        jobNo,
        cardId: card.id,
        cardRevision: card.revision,
        pidNo,
        releasedAt,
        releasedBy: operatorId,
        owner: DEFAULT_OWNER,
        jobTargetDate,
        partNo: processCardData?.partNo ?? null,
        partSn: processCardData?.partSn ?? null,
        partDesc: processCardData?.partDesc ?? null,
        operationType: processCardData?.operationType ?? null,
        execStatus: INITIAL_EXEC_STATUS,
      });

      // ── 工序内容快照（Property 34）：Operation 以 Process Data 为执行域来源 ──
      const missingStepOperations = [];
      const steps = processStepRepo.listByCardId(cardId).map((step) => {
        const processStepData = processDataRepo.findOne(pidNo, cardId, step.processId);
        const operation = normalizeOptionalText(processStepData?.operation);
        if (operation === null) missingStepOperations.push(step.processId);
        return { ...step, operation };
      });
      if (missingStepOperations.length > 0) {
        missingIntegrations.push(`工序 Operation（Process Data：${missingStepOperations.join('、')}）`);
      }
      const { captureItems, components, sigReqs, referenceDocuments } = gatherStepContent(steps, cardId);

      const snapshots = buildStepSnapshots(steps, captureItems, components, sigReqs, {
        sourceCardRevision: card.revision,
        timestamp: releasedAt,
        referenceDocuments,
      });

      // ── 逐工序写 job_process + 条码 + job_step_snapshot ──
      const jobProcesses = [];
      for (const snapshot of snapshots) {
        const processId = snapshot.content.processId;
        if (typeof processId !== 'string' || processId.trim() === '') {
          throw new ServiceError(
            CODE.UNPROCESSABLE,
            `工序缺少 Process ID，无法生成条码（sourceStepId=${String(snapshot.sourceStepId)}）`,
          );
        }
        const barcodeValue = generateBarcode(jobNo, processId);
        const jobProcessId = jobProcessRepo.create({
          jobId,
          stepId: snapshot.sourceStepId,
          processId,
          barcodeValue,
          barcodeType: DEFAULT_BARCODE_TYPE,
        });
        jobStepSnapshotRepo.create(serializeStepSnapshot(snapshot, jobProcessId));
        jobProcesses.push(jobProcessRepo.findById(jobProcessId));
      }

      // ── 发布结果记录（与 JOB 数据同一事务，同生共死；需求 24.3、Property 15） ──
      const releaseId = workPackageReleaseRepo.create({
        cardId: card.id,
        jobNo,
        packageRef,
        releasedAt,
        result: 'success',
      });

      const message = missingIntegrations.length > 0
        ? `发布成功；集成数据缺失：${missingIntegrations.join('、')}`
        : '发布成功';

      return {
        jobNo,
        packageRef,
        job: jobRepo.findById(jobId),
        jobProcesses,
        release: workPackageReleaseRepo.findById(releaseId),
        message,
        integrationDataMissing: missingIntegrations.length > 0,
      };
    });
  } catch (error) {
    // 事务已整体回滚：任何「本想在事务内记的失败结果」同样被回滚，故在事务外补记一条。
    recordFailedRelease(card.id, packageRef, releasedAt);
    throw translateSqliteError(error);
  }
}

// =====================================================================
// 三、只读查询（供 JOB 查看器使用；呈现一律读取不可变快照）
// =====================================================================

/**
 * 按 `job_no` 取 JOB 基础行。
 * @param {string} jobNo
 * @returns {object} camelCase JOB 行
 * @throws {ServiceError} JOB 不存在（404）
 */
export function getJobByJobNo(jobNo) {
  const job = jobRepo.findByJobNo(jobNo);
  if (job === null) {
    throw new ServiceError(CODE.NOT_FOUND, `JOB 不存在：${String(jobNo)}`);
  }
  return job;
}

/**
 * 查询某 JOB 的工序实例，并把每道工序的不可变内容快照附在 `snapshot` 字段。
 * 不读取 `process_step` 当前内容，避免编制域后续变化污染历史 JOB 呈现。
 * @param {string} jobNo
 * @returns {object[]}
 */
export function listJobProcesses(jobNo) {
  const job = getJobByJobNo(jobNo);
  return jobProcessRepo.listByJobId(job.id).map((jobProcess) => {
    const snapshot = jobStepSnapshotRepo.findByJobProcessId(jobProcess.id);
    if (snapshot === null) {
      throw new ServiceError(CODE.INTERNAL, `JOB 工序缺少内容快照：${String(jobProcess.id)}`);
    }
    return {
      ...jobProcess,
      snapshot: { ...snapshot, content: parseSnapshotContent(snapshot.content) },
    };
  });
}

/**
 * JOB 查看器聚合查询：执行期字段、卡级起止时间与快照工序一次返回。
 * @param {string} jobNo
 * @returns {object}
 */
export function getJobDetail(jobNo) {
  const job = getJobByJobNo(jobNo);
  return { ...job, processes: listJobProcesses(jobNo) };
}

/**
 * 取某工卡（跨全部释放次数）的全部 JOB。
 * @param {number | string} cardId
 * @returns {object[]}
 */
export function listJobsByCardId(cardId) {
  loadCardOrThrow(cardId);
  return jobRepo.listByCardId(cardId);
}

export default {
  release,
  getJobByJobNo,
  getJobDetail,
  listJobProcesses,
  listJobsByCardId,
};
