/**
 * 附件服务（Attachment Service，任务 13.10）—— 上传校验、落盘、落库与取回解析。
 *
 * 组合 `storage/attachmentStorage.js`（磁盘落盘/取回，不知道 MIME 白名单与大小上限）与
 * `repositories/attachmentRepo.js`（`attachment` 表读写，不做校验）——本服务是二者之间
 * 唯一持有「MIME 白名单」「大小上限」「文件名生成规则」业务知识的一层，与
 * `taskCardService.js` 头注的服务层错误约定同一口径：校验失败一律
 * `throw new ServiceError(code, message, data)`。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `isEditable` 编辑态闸门决策（任务 13.10 施工说明；需求 49.1、49.2、49.4）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 本服务的 {@link store}/{@link remove} **不**直接调用 `card-rules.js` 的
 * `passesEditableGate`。理由（非遗漏，经核对 design.md 的 `attachment` 表结构后确认）：
 *
 * 1. **`attachment` 表结构上与工卡无关联**——`attachment` 无 `card_id`/`step_id` 外键
 *    （design.md「表：attachment」列清单：`id`/`kind`/`original_name`/`stored_path`/
 *    `mime_type`/`byte_size`/`sha256`/`uploaded_by`/`uploaded_at`），{@link store} 的
 *    签名亦不接受 `cardId`。它是一个**内容寻址的通用二进制对象池**（`sha256` 去重），
 *    脱离任何工卡上下文也可存在——概念上更接近「先传素材，再引用」的素材库，而不是
 *    「工卡内容的一部分」。
 * 2. **真正的「附件成为工卡内容」的时刻，是它被 `payload.attachmentId` 引用进某个
 *    `image`/`video`/`audio` 类插入组件的那一刻**——这正是 `card-rules.js` 登记的
 *    `CONTENT_EDIT_OPERATIONS` 里的 `componentWrite`，`taskCardService.js` 的
 *    `addComponent`/`updateComponent` 已对其调用 `assertEditable(card, 'componentWrite')`
 *    （非 New 态一律 `422`）。维修草图（需求 13.2）同理——上传后须经 `image` 组件的
 *    `componentWrite` 关联至工序，同一闸门覆盖。
 * 3. 因此，在 `attachmentService` 这一层重复施加 `isEditable` 校验既**做不到**（拿不到
 *    `cardId` 判定「这次上传是对哪张工卡的编辑」——同一素材可被多张工卡的多个组件复用，
 *    `findBySha256` 的去重语义正说明了这点），也**没必要**（下游 `componentWrite` 已挡住
 *    非 New 态工卡把新素材写进其组件配置）。
 * 4. 需求 49.4「全部编辑入口一致执行」的「入口」应理解为「使内容进入工卡编制域的入口」，
 *    即 `componentWrite`，而非「素材上传」这个更底层、与工卡状态无关的基础设施操作。
 *
 * 结论：**不在本服务施加 `isEditable` 闸门**；闸门已在 `componentWrite` 路径生效，覆盖
 * 附件经组件关联进入工卡内容的唯一入口。若未来 schema 演进为附件直接归属工卡
 * （新增 `attachment.card_id`），则需重新评估本决策。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 存储文件名与路径穿越防护（需求 13.2、13.3、18.1、31.2；design.md「存储约定」）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 存储文件名 = `randomUUID()` + 依 MIME 类型推得的扩展名（{@link EXTENSION_BY_MIME}），
 * **不使用**客户端提交的 `originalName` 的任何片段——`originalName` 只经
 * {@link stripToDisplayName} 之外的处理，直接原样存入 `attachment.original_name`
 * 供界面展示，从不传给 `storage/attachmentStorage.js` 参与路径拼接（该模块的
 * `saveFile` 本身也拒绝含路径分隔符的文件名，形成双重防线）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * MIME 白名单与大小上限（design.md「表：attachment」，需求 13.2、13.3、31.2）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * | 类别（`kind`） | MIME | 大小上限 |
 * |---|---|---|
 * | `image` | image/png, image/jpeg, image/webp | 10 MB |
 * | `audio` | audio/mpeg, audio/wav | 20 MB |
 * | `video` | video/mp4 | 100 MB |
 *
 * 不在白名单内的 MIME、或超出对应类别大小上限，一律 `throw new ServiceError(CODE.VALIDATION, ...)`
 * （400），不落盘、不落库（校验先于任何 I/O）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 内容摘要与去重（需求场景：`attachmentRepo.findBySha256`）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 上传时计算 `sha256`（`node:crypto`）。**已存在同摘要的记录时不重复落盘**——直接返回既有
 * 记录（幂等去重，同一文件重复上传不会在磁盘上产生多份副本），符合 `attachment.sha256`
 * 列头注「内容摘要，去重与完整性核对」。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 取回（需求 13.2、13.3：不暴露文件系统路径）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * {@link retrieve} 只返回 `{ filePath, originalName, mimeType }` 供**路由层**
 * （任务 18.4）据此自行决定如何流式响应——本服务不持有 `res`/HTTP 语义，`filePath` 是
 * 服务端解析出的绝对路径，路由层将其用于 `fs.createReadStream` 等操作，不应将该值
 * 原样透出给 HTTP 响应体或客户端可见的字段。
 *
 * 需求：3.6, 3.7（不适用，导出与附件无关）；直接相关：5.3, 13.2, 13.3, 18.1, 31.2, 33.9（不适用）
 * 精确需求：13.2、13.3、18.1、31.2、5.3
 */

import { randomUUID, createHash } from 'node:crypto';

import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';

import attachmentRepo from '../repositories/attachmentRepo.js';
import * as attachmentStorage from '../storage/attachmentStorage.js';

/** 附件类别（`attachment.kind` 的 CHECK 约束取值，design.md「表：attachment」）。 */
export const ATTACHMENT_KIND = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
});

/** MIME 白名单 → 类别 + 大小上限（字节）+ 存储扩展名（design.md「表：attachment」）。 */
const MIME_RULES = Object.freeze({
  'image/png': Object.freeze({ kind: ATTACHMENT_KIND.IMAGE, maxBytes: 10 * 1024 * 1024, extension: 'png' }),
  'image/jpeg': Object.freeze({ kind: ATTACHMENT_KIND.IMAGE, maxBytes: 10 * 1024 * 1024, extension: 'jpg' }),
  'image/webp': Object.freeze({ kind: ATTACHMENT_KIND.IMAGE, maxBytes: 10 * 1024 * 1024, extension: 'webp' }),
  'video/mp4': Object.freeze({ kind: ATTACHMENT_KIND.VIDEO, maxBytes: 100 * 1024 * 1024, extension: 'mp4' }),
  'audio/mpeg': Object.freeze({ kind: ATTACHMENT_KIND.AUDIO, maxBytes: 20 * 1024 * 1024, extension: 'mp3' }),
  'audio/wav': Object.freeze({ kind: ATTACHMENT_KIND.AUDIO, maxBytes: 20 * 1024 * 1024, extension: 'wav' }),
});

/** 大小上限的人类可读展示（校验失败提示用）。 */
function humanMb(bytes) {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * 校验 MIME 类型是否在白名单内，取不到即 `throw`（400）。
 * @param {string} mimeType
 * @returns {Readonly<{kind: string, maxBytes: number, extension: string}>}
 */
function assertMimeAllowed(mimeType) {
  const rule = MIME_RULES[mimeType];
  if (rule === undefined) {
    throw new ServiceError(
      CODE.VALIDATION,
      `不支持的文件类型：${String(mimeType)}（允许：${Object.keys(MIME_RULES).join('、')}）`,
      { mimeType },
    );
  }
  return rule;
}

/** 校验文件大小不超过其类别上限，超限即 `throw`（400）。 */
function assertSizeWithinLimit(byteSize, rule, mimeType) {
  if (byteSize > rule.maxBytes) {
    throw new ServiceError(
      CODE.VALIDATION,
      `文件大小超限：${rule.kind} 类别上限 ${humanMb(rule.maxBytes)}`,
      { mimeType, byteSize, maxBytes: rule.maxBytes },
    );
  }
}

/** 计算文件内容的 sha256 十六进制摘要。 */
function computeSha256(fileBuffer) {
  return createHash('sha256').update(fileBuffer).digest('hex');
}

/** 取调用上下文中的操作人标识；缺失时返回 `null`（上传人非强制字段，`attachment.uploaded_by` 可空）。 */
function operatorIdOf(ctx) {
  const raw = ctx && typeof ctx === 'object' ? ctx.operatorId ?? ctx.staffNo ?? ctx.userId : undefined;
  return raw === null || raw === undefined || String(raw).trim() === '' ? null : String(raw);
}

/**
 * 上传并落盘一个附件（需求 13.2、13.3、18.1、31.2、5.3）。
 *
 * 校验顺序：MIME 白名单 → 大小上限 → （均通过后）计算 `sha256` → 命中既有记录则直接
 * 返回（去重，不重复落盘）→ 否则生成 UUID 存储文件名落盘 → 落库。
 *
 * @param {Buffer} fileBuffer 文件内容
 * @param {{originalName?: string, mimeType: string}} meta `originalName` 仅入库记录，
 *   不参与路径拼接；`mimeType` 须在白名单内
 * @param {{operatorId?: string, staffNo?: string, userId?: string}} [ctx] 调用上下文
 *   （`operatorId` 落 `attachment.uploaded_by`，可空）
 * @returns {object} camelCase 附件记录（`attachmentRepo.findById` 的返回形状）
 * @throws {ServiceError} MIME 不在白名单（400）；大小超出对应类别上限（400）
 */
export function store(fileBuffer, meta, ctx) {
  const mimeType = meta?.mimeType;
  const rule = assertMimeAllowed(mimeType);

  const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer ?? []);
  assertSizeWithinLimit(buffer.length, rule, mimeType);

  const sha256 = computeSha256(buffer);
  const existing = attachmentRepo.findBySha256(sha256);
  if (existing !== null) return existing;

  const storedName = `${randomUUID()}.${rule.extension}`;
  const { storedPath } = attachmentStorage.saveFile(buffer, storedName);

  const id = attachmentRepo.create({
    kind: rule.kind,
    originalName: meta?.originalName ?? null,
    storedPath,
    mimeType,
    byteSize: buffer.length,
    sha256,
    uploadedBy: operatorIdOf(ctx),
    uploadedAt: new Date().toISOString(),
  });

  return attachmentRepo.findById(id);
}

/**
 * 取回一个附件的元数据与可读文件路径（需求 13.2、13.3：经 id 查表后返回，不暴露文件系统
 * 路径给调用方——`filePath` 供**路由层**自行流式响应，不应原样透出到 HTTP 响应体）。
 *
 * @param {number | string} id
 * @returns {{ filePath: string, originalName: string|null, mimeType: string }}
 * @throws {ServiceError} 附件不存在（404）
 */
export function retrieve(id) {
  const attachment = attachmentRepo.findById(id);
  if (attachment === null) {
    throw new ServiceError(CODE.NOT_FOUND, `附件不存在：${String(id)}`);
  }
  return {
    filePath: attachmentStorage.resolveFilePath(attachment.storedPath),
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
  };
}

/**
 * 删除一个附件（记录 + 磁盘文件），需求 18（附件生命周期管理的对称操作）。
 * @param {number | string} id
 * @returns {{ removed: true, id: number|string }}
 * @throws {ServiceError} 附件不存在（404）
 */
export function remove(id) {
  const attachment = attachmentRepo.findById(id);
  if (attachment === null) {
    throw new ServiceError(CODE.NOT_FOUND, `附件不存在：${String(id)}`);
  }
  attachmentRepo.remove(id);
  attachmentStorage.removeFile(attachment.storedPath);
  return { removed: true, id };
}

export default { store, retrieve, remove, ATTACHMENT_KIND };
