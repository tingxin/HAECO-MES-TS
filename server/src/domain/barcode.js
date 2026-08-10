/**
 * JOB 工序条码生成模块 —— 纯函数，无 I/O。
 *
 * 编码规则（《临时设计说明》D-03，需求 15.1、15.2）：条码内容 = `` `${jobNo}-${processId}` ``，
 * 以 **Code128** 承载；二维码承载**同一字符串**，两者内容一致，仅呈现载体不同。
 *
 * ⚠ **调用位置约束（需求 15.3）**：条码属**执行域**产物，只在「工卡释放生成 JOB」这条
 * 路径上被调用，落位于 `job_process.barcode_value`（`UNIQUE(barcode_value)`）。
 * 编制域的 `process_step` **没有条码列**，编制态（模板态）**不得**调用本函数 ——
 * 否则同一张工卡的多次维修会复用同一条码，条码将无法唯一定位「某次维修的某道工序」。
 *
 * **唯一性与可定位性（需求 15.2、15.4）**：本函数在 `(jobNo, processId)` 上是**单射**，
 * 即不同的 `(jobNo, processId)` 必产出不同条码，其中包括「processId 相同而 jobNo 不同 ⇒
 * 条码不同」（跨 JOB 不复用）。单射性由以下两点共同保证，故 Property 11 可直接在纯函数
 * 上断言，无需集成测试：
 *   1. `processId` 受 `PROCESS_ID_PATTERN`（`/^[A-Z]+$/`）约束，**不含分隔符 `-`**；
 *   2. 因此条码中**最后一个 `-`** 即唯一的分割点，`jobNo` 与 `processId` 可无歧义还原
 *      （`parseBarcode` 即为其逆映射），`jobNo` 自身含 `-` 也不产生歧义。
 *
 * 需求：15.1, 15.2, 15.3, 15.4
 */

import { PROCESS_ID_PATTERN } from './process-id.js';

/** JOB No 与 Process ID 之间的分隔符 */
export const BARCODE_SEPARATOR = '-';

/** 条码的符号集类型（Code128；二维码承载同一字符串） */
export const BARCODE_SYMBOLOGY = 'Code128';

/**
 * 生成某个 JOB 工序的条码内容。
 *
 * @param {string} jobNo JOB No（工程释放后生成的执行实例标识），非空字符串
 * @param {string} processId 工序编号，须匹配 `/^[A-Z]+$/`（见 `process-id.js`）
 * @returns {string} 条码内容 `` `${jobNo}-${processId}` ``（Code128 与二维码共用）
 * @throws {TypeError} `jobNo` 非字符串或为空白时抛出
 * @throws {TypeError} `processId` 非字符串或不匹配大写字母序时抛出 —— 允许非法
 *   `processId` 会破坏单射性，进而使 `UNIQUE(barcode_value)` 不再等价于
 *   `(JOB No, Process ID)` 唯一，故不做容错。
 */
export function generateBarcode(jobNo, processId) {
  if (typeof jobNo !== 'string' || jobNo.trim() === '') {
    throw new TypeError(`JOB No 须为非空字符串，实际收到：${String(jobNo)}`);
  }
  if (typeof processId !== 'string' || !PROCESS_ID_PATTERN.test(processId)) {
    throw new TypeError(`Process ID 须为大写字母序（A–Z、AA…），实际收到：${String(processId)}`);
  }
  return `${jobNo}${BARCODE_SEPARATOR}${processId}`;
}

/**
 * 条码内容的逆映射：还原 `(jobNo, processId)`。
 *
 * 以**最后一个分隔符**切分 —— `processId` 不含 `-`，故切分点唯一。此函数是
 * `generateBarcode` 单射性的构造性证明，也供扫码定位「某次维修的某道工序」使用（需求 15.4）。
 *
 * @param {string} barcodeValue 条码内容
 * @returns {{jobNo: string, processId: string}} 还原出的 JOB No 与 Process ID
 * @throws {TypeError} 内容不符合 `` `${jobNo}-${processId}` `` 形态时抛出
 */
export function parseBarcode(barcodeValue) {
  if (typeof barcodeValue !== 'string') {
    throw new TypeError(`条码内容须为字符串，实际收到：${String(barcodeValue)}`);
  }
  const at = barcodeValue.lastIndexOf(BARCODE_SEPARATOR);
  const jobNo = at > 0 ? barcodeValue.slice(0, at) : '';
  const processId = at >= 0 ? barcodeValue.slice(at + 1) : '';
  if (jobNo.trim() === '' || !PROCESS_ID_PATTERN.test(processId)) {
    throw new TypeError(`条码内容不符合「JOB No-Process ID」形态：${barcodeValue}`);
  }
  return { jobNo, processId };
}
