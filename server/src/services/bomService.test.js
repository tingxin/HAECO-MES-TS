/**
 * `bomService.js` 单元测试（任务 13.11）。
 *
 * 每个测试用例在内存 SQLite 上重建 schema + 种子数据，验证服务层组合
 * `lotLinkRepo` / `lotListBaseRepo`（只读）/ `domain/bom.js` 的 `aggregateBomBase` /
 * `bomBaseRepo` 四者的行为：Lot 关联增删触发 BOM 输出同步刷新、编辑态闸门、事务性。
 *
 * 错误约定：写操作失败一律 `throw ServiceError`（`lib/service-error.js`），本文件用
 * try/catch 断言 `.code` / `.data.rejection`；成功路径直接断言返回值（不再有
 * `.ok`/`.data` 信封）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import * as taskCardRepo from '../repositories/taskCardRepo.js';
import * as lotLinkRepo from '../repositories/lotLinkRepo.js';
import * as bomBaseRepo from '../repositories/bomBaseRepo.js';
import {
  BOM_REJECTION,
  addLotLink,
  listBomBases,
  listLotLinks,
  refreshBomBase,
  removeLotLink,
} from './bomService.js';

let irLotCardId; // TC-2026-0003，card_type 05，status New
let irCardId; // TC-2026-0002，card_type 04，status New
let effectiveCardId; // TC-2026-0001，status Effective

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();

  irLotCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0003', 1).id;
  irCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0002', 1).id;
  effectiveCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0001', 1).id;
});

describe('addLotLink', () => {
  it('IR Lot 卡（New 态）可新增 Lot List 关联，并同步刷新 BOM 输出（需求 48.1、48.2、48.8）', () => {
    const data = addLotLink(irLotCardId, { lotNumber: 'LOT-2026-9001', lotListRef: 'LT-2026-002' });
    expect(data.lotNumber).toBe('LOT-2026-9001');

    // LT-2026-002 的种子 Base 集合含 BASE-777-NLG-201（见 seed.js）
    const bases = bomBaseRepo.listByCardId(irLotCardId);
    expect(bases.some((b) => b.baseNumber === 'BASE-777-NLG-201' && b.source === 'lot_list')).toBe(true);
  });

  it('非 05 类型工卡拒绝新增 Lot 关联（需求 48.1）', () => {
    try {
      addLotLink(irCardId, { lotNumber: 'LOT-X' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.UNPROCESSABLE);
      expect(error.data.rejection).toBe(BOM_REJECTION.NOT_IR_LOT_CARD);
    }
  });

  it('Effective 态工卡拒绝新增 Lot 关联（编辑态闸门）', () => {
    // 借道：把 05 类型工卡状态改为 Effective 以验证闸门（不影响类型判定顺序覆盖）
    taskCardRepo.update(irLotCardId, { status: 'Effective' });
    try {
      addLotLink(irLotCardId, { lotNumber: 'LOT-X' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.UNPROCESSABLE);
      expect(error.data.rejection).toBe(BOM_REJECTION.NOT_EDITABLE);
    }
  });

  it('Lot Number 为空时拒绝', () => {
    try {
      addLotLink(irLotCardId, { lotNumber: '   ' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.VALIDATION);
      expect(error.data.rejection).toBe(BOM_REJECTION.INVALID_INPUT);
    }
  });

  it('工卡不存在时抛 CARD_NOT_FOUND', () => {
    try {
      addLotLink(999999, { lotNumber: 'LOT-X' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.NOT_FOUND);
      expect(error.data.rejection).toBe(BOM_REJECTION.CARD_NOT_FOUND);
    }
  });
});

describe('removeLotLink', () => {
  it('删除 Lot 关联后同步刷新 BOM 输出，不再包含该 Lot List 带出的 Base（需求 48.8）', () => {
    const added = addLotLink(irLotCardId, { lotNumber: 'LOT-2026-9002', lotListRef: 'LT-2026-002' });
    expect(bomBaseRepo.listByCardId(irLotCardId).some((b) => b.baseNumber === 'BASE-777-NLG-201')).toBe(true);

    const result = removeLotLink(irLotCardId, added.id);
    expect(result.removed).toBe(true);
    expect(lotLinkRepo.findById(added.id)).toBeNull();

    // 该工卡原种子关联（LT-2026-001）已在种子数据中存在，故 BASE-777-NLG-201（仅 LT-2026-002 携带）应消失
    expect(bomBaseRepo.listByCardId(irLotCardId).some((b) => b.baseNumber === 'BASE-777-NLG-201')).toBe(false);
  });

  it('待删除关联不存在时抛 LOT_LINK_NOT_FOUND', () => {
    try {
      removeLotLink(irLotCardId, 999999);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.NOT_FOUND);
      expect(error.data.rejection).toBe(BOM_REJECTION.LOT_LINK_NOT_FOUND);
    }
  });

  it('Effective 态工卡拒绝删除 Lot 关联', () => {
    const added = addLotLink(irLotCardId, { lotNumber: 'LOT-2026-9003' });
    taskCardRepo.update(irLotCardId, { status: 'Effective' });

    try {
      removeLotLink(irLotCardId, added.id);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.UNPROCESSABLE);
      expect(error.data.rejection).toBe(BOM_REJECTION.NOT_EDITABLE);
    }
  });
});

describe('refreshBomBase', () => {
  it('IR 卡（类型 04）汇总仅含直接维护的 Base，source 为 ir_card（需求 48.4a）', () => {
    const data = refreshBomBase(irCardId);
    expect(data).toHaveLength(1);
    expect(data[0].source).toBe('ir_card');
    expect(data[0].baseNumber).toBe('BASE-320-MLG-001');
  });

  it('IR Lot 卡（类型 05）汇总含全部关联 Lot List 带出的 Base，source 为 lot_list（需求 48.4b）', () => {
    const data = refreshBomBase(irLotCardId);
    // 种子关联 LT-2026-001 带出 3 个 Base（见 seed.js 的 lot_list_base）
    expect(data.length).toBeGreaterThanOrEqual(3);
    expect(data.every((row) => row.source === 'lot_list')).toBe(true);
  });

  it('可重复调用（幂等汇总结果，不随重复调用累积重复行）', () => {
    const first = refreshBomBase(irLotCardId);
    const second = refreshBomBase(irLotCardId);
    expect(second).toHaveLength(first.length);
  });

  it('工卡不存在时抛 CARD_NOT_FOUND', () => {
    try {
      refreshBomBase(999999);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.NOT_FOUND);
      expect(error.data.rejection).toBe(BOM_REJECTION.CARD_NOT_FOUND);
    }
  });
});

describe('listLotLinks / listBomBases（查看，不受编辑态闸门约束）', () => {
  it('Effective 态工卡仍可查看 Lot 关联与 BOM 输出（需求 49.8）', () => {
    const links = listLotLinks(effectiveCardId);
    expect(Array.isArray(links)).toBe(true);

    const bases = listBomBases(effectiveCardId);
    expect(Array.isArray(bases)).toBe(true);
  });

  it('工卡不存在时抛 CARD_NOT_FOUND', () => {
    try {
      listLotLinks(999999);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error.data.rejection).toBe(BOM_REJECTION.CARD_NOT_FOUND);
    }
    try {
      listBomBases(999999);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error.data.rejection).toBe(BOM_REJECTION.CARD_NOT_FOUND);
    }
  });
});
