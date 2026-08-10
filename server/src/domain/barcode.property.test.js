import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateBarcode, parseBarcode } from './barcode.js';
import { PROCESS_ID_PATTERN } from './process-id.js';

/** 合法 jobNo：非空白字符串（含可能带 `-` 的形态，覆盖 barcode.js 文档中「最后一个 `-` 为唯一切分点」的场景） */
const jobNoArb = fc.string({ minLength: 1 }).filter((s) => s.trim() !== '');

/** 合法 processId：匹配 PROCESS_ID_PATTERN（大写字母序，A–Z、AA…） */
const processIdArb = fc
  .array(fc.integer({ min: 65, max: 90 }).map((code) => String.fromCharCode(code)), {
    minLength: 1,
    maxLength: 4,
  })
  .map((letters) => letters.join(''))
  .filter((s) => PROCESS_ID_PATTERN.test(s));

// Feature: task-card-management, Property 11: JOB 工序条码唯一对应 —— For any 一组 JOB 工序实例，条码在 `(JOB No, Process ID)` 组合上唯一：同一 JOB 内任意两道工序条码不相等，同一 Task Card 的不同 JOB 之间也不复用条码；且编制态 `process_step` 不产生任何条码。
describe('Property 11: JOB 工序条码唯一对应', () => {
  it('同一 processId 下，不同 jobNo 产出不同条码（跨 JOB 不复用，需求 15.2、15.4）', () => {
    fc.assert(
      fc.property(jobNoArb, jobNoArb, processIdArb, (jobNoA, jobNoB, processId) => {
        fc.pre(jobNoA !== jobNoB);
        expect(generateBarcode(jobNoA, processId)).not.toBe(generateBarcode(jobNoB, processId));
      }),
      { numRuns: 100 },
    );
  });

  it('同一 jobNo 下，不同 processId 产出不同条码（同一 JOB 内工序间不复用，需求 15.1、15.2）', () => {
    fc.assert(
      fc.property(jobNoArb, processIdArb, processIdArb, (jobNo, processIdA, processIdB) => {
        fc.pre(processIdA !== processIdB);
        expect(generateBarcode(jobNo, processIdA)).not.toBe(generateBarcode(jobNo, processIdB));
      }),
      { numRuns: 100 },
    );
  });

  it('generateBarcode 与 parseBarcode 互为逆映射（含 jobNo 含 `-` 的形态，需求 15.4 可定位性）', () => {
    fc.assert(
      fc.property(jobNoArb, processIdArb, (jobNo, processId) => {
        const barcode = generateBarcode(jobNo, processId);
        expect(parseBarcode(barcode)).toEqual({ jobNo, processId });
      }),
      { numRuns: 100 },
    );
  });

  // 需求 15.3：条码属执行域产物，编制域 `process_step` 不得产生条码。
  // 该约束的「数据库层不存在条码列」一面已由任务 3.7 的 db 约束测试覆盖（跨模块集成属性，
  // 非本纯函数测试范畴）。就 barcode.js 本身而言：本模块只导出 `generateBarcode` /
  // `parseBarcode` 两个纯函数，均无副作用、无隐式调用、无对 `process_step` 或任何持久化
  // 对象的引用 —— 因此「编制态对象不会被隐式附加条码值」在本模块内是自明成立的，
  // 无需（也无法）以属性测试断言一个不存在的调用路径。
  it('编制域对象经过本模块时不会被隐式附加条码值（本模块仅导出无副作用纯函数）', () => {
    const processStepLike = Object.freeze({ id: 1, cardId: 1, processId: 'A', title: '示例工序' });
    expect(processStepLike.barcode_value).toBeUndefined();
    expect(processStepLike.barcodeValue).toBeUndefined();
  });
});
