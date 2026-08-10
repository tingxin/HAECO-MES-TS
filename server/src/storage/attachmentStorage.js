/**
 * 附件本地磁盘存储（`server/src/storage/`，任务 13.10）—— 落盘、取回与内容摘要计算。
 *
 * 本模块**只做文件系统操作**，不校验 MIME/大小、不接触 `attachment` 表——那些是
 * `services/attachmentService.js` 的职责（服务层组合本模块 + `attachmentRepo`）。
 * design.md 头注「当前为本地磁盘方案，后续替换为对象存储时仅改 `server/src/storage`」——
 * 这正是本模块存在的理由：服务层只依赖下方几个函数的**签名**，不依赖磁盘细节，
 * 换成对象存储（S3 等）时只需替换本文件的实现。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 路径穿越防护（需求 13.2、13.3、18.1、31.2；design.md「存储约定」）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 存储文件名**恒由服务端生成**（`node:crypto` 的 `randomUUID()` + 原始扩展名），客户端
 * 提交的原始文件名（`originalName`）**只入库记录，从不参与路径拼接**——本模块的
 * {@link saveFile} 不接受 `originalName` 作为路径片段的任何形式的输入，仅接受「扩展名」
 * 这一个孤立、经过白名单校验（服务层职责）的短字符串，杜绝 `../../etc/passwd` 之类的
 * 穿越尝试从「文件名」这一入口生效。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 存储目录（`data/attachments/`）与幂等创建
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 复用 `db/connection.js` 已解析好的 `PROJECT_ROOT`，保证与 `data/haeco-mes-ts.db`
 * 同级（design.md 目录树「`data/attachments/`」），且不依赖 `process.cwd()`
 * （脚本从任意目录调用时行为一致）。目录创建用 `fs.mkdirSync(dir, { recursive: true })`
 * ——该调用本身即幂等（目录已存在时静默成功，不抛错），无需额外的「先判断是否存在」步骤。
 *
 * 需求：5.3, 13.2, 13.3, 18.1, 31.2, 33.9（间接，附件不涉及工时投影）、40.1–40.5（不适用）
 * 直接相关需求：13.2、13.3、18.1、31.2、5.3
 */

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../db/connection.js';

/** 附件落盘的默认根目录（`<project>/data/attachments`，design.md 目录树约定）。 */
export const DEFAULT_ATTACHMENT_DIR = path.join(PROJECT_ROOT, 'data', 'attachments');

/**
 * 解析实际使用的附件存储目录。
 * 优先级：显式入参 > 环境变量 `HAECO_ATTACHMENT_DIR` > 默认目录。相对路径以项目根目录
 * 为基准解析，与 `db/connection.js` 的 `resolveDbPath` 同一约定，保证测试可指向临时目录。
 * @param {string} [explicitDir]
 * @returns {string} 绝对路径
 */
export function resolveAttachmentDir(explicitDir) {
  const raw = explicitDir ?? process.env.HAECO_ATTACHMENT_DIR;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_ATTACHMENT_DIR;
  }
  const value = String(raw).trim();
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);
}

/**
 * 按需创建存储目录（幂等：已存在时静默成功）。
 * @param {string} [dir] 缺省取 {@link resolveAttachmentDir} 的解析结果
 * @returns {string} 已确保存在的绝对目录路径
 */
export function ensureAttachmentDir(dir) {
  const target = resolveAttachmentDir(dir);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * 落盘一个附件文件（需求 13.2、13.3、18.1、31.2；「文件名由服务端生成 UUID + 扩展名」）。
 *
 * 存储路径为 `<attachmentDir>/<storedName>`；返回值为**相对**存储根目录的路径
 * （即 `storedName` 本身，当前实现无子目录分层），与 `attachment.stored_path` 列
 * 「相对 `data/attachments` 的存储路径」的约定一致——本模块不落库，仅返回该相对路径
 * 供服务层写入 `attachment` 表。
 *
 * @param {Buffer} fileBuffer 文件内容
 * @param {string} storedName 服务端生成的存储文件名（UUID + 扩展名，**不含任何路径分隔符**）
 * @param {string} [dir] 缺省取 {@link resolveAttachmentDir} 的解析结果
 * @returns {{ storedPath: string, absolutePath: string }}
 * @throws {TypeError} `storedName` 含路径分隔符或穿越片段（防御性校验，正常调用路径下
 *   `storedName` 恒由 {@link generateStoredName} 产出，不会触发）
 */
export function saveFile(fileBuffer, storedName, dir) {
  assertSafeStoredName(storedName);
  const targetDir = ensureAttachmentDir(dir);
  const absolutePath = path.join(targetDir, storedName);
  fs.writeFileSync(absolutePath, fileBuffer);
  return { storedPath: storedName, absolutePath };
}

/**
 * 按 `attachment.stored_path`（相对路径）解析出可读取的绝对文件路径，供取回时使用
 * （需求 13.2、13.3：取回经 id 查表后由服务端读取，不暴露文件系统路径给调用方）。
 *
 * @param {string} storedPath `attachment.stored_path` 列值（相对存储根目录）
 * @param {string} [dir] 缺省取 {@link resolveAttachmentDir} 的解析结果
 * @returns {string} 绝对路径
 * @throws {TypeError} `storedPath` 含穿越片段（防止已入库的脏数据被用于逃出存储根目录）
 */
export function resolveFilePath(storedPath, dir) {
  assertSafeStoredName(storedPath);
  return path.join(resolveAttachmentDir(dir), storedPath);
}

/**
 * 删除一个已落盘的附件文件（幂等：文件不存在时静默成功，不抛错——与仓储层「按主键删除，
 * 影响行数可为 0」的宽松删除语义一致）。
 * @param {string} storedPath `attachment.stored_path` 列值
 * @param {string} [dir]
 * @returns {void}
 */
export function removeFile(storedPath, dir) {
  const absolutePath = resolveFilePath(storedPath, dir);
  try {
    fs.unlinkSync(absolutePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** `storedName`/`storedPath` 安全性校验：不接受路径分隔符或 `..` 穿越片段。 */
function assertSafeStoredName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('存储文件名不可为空');
  }
  if (value.includes('/') || value.includes('\\') || value.split(/[/\\]/).includes('..')) {
    throw new TypeError(`非法的存储文件名（疑似路径穿越）：${value}`);
  }
}

export default {
  DEFAULT_ATTACHMENT_DIR,
  resolveAttachmentDir,
  ensureAttachmentDir,
  saveFile,
  resolveFilePath,
  removeFile,
};
