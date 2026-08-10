/**
 * `relationService.js` 单元测试（任务 13.11）。
 *
 * 每个测试用例在内存 SQLite 上重建 schema + 种子数据（`resetDb(':memory:')` +
 * `migrate` + `seed`），验证服务层组合 `domain/relation.js` 与 `relationRepo` 的行为：
 * 人工增删查、编辑态闸门、执行期自动关联（幂等）、关键信息同步、`requiredSignDocTypes` 转发。
 *
 * 错误约定：写操作失败一律 `throw ServiceError`（`lib/service-error.js`），本文件用
 * `expect(() => fn(...)).toThrow(ServiceError)` 断言，并读 `.code` / `.data.rejection`
 * 区分具体拒绝场景；成功路径直接断言返回值（不再有 `.ok`/`.data` 信封）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import * as taskCardRepo from '../repositories/taskCardRepo.js';
import * as relationRepo from '../repositories/relationRepo.js';
import {
  RELATION_REJECTION,
  addRelation,
  autoLinkFromExecDocument,
  getRequiredSignDocTypes,
  listRelations,
  removeRelation,
  syncKeyInfoForCard,
  syncKeyInfoForRelation,
} from './relationService.js';

let newCardId;
let effectiveCardId;

beforeEach(() => {
  resetDb(':memory:');
  migrate();
  seed();

  newCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0002', 1).id; // status New
  effectiveCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0001', 1).id; // status Effective
});

describe('addRelation', () => {
  it('New 态工卡可新增关联，落库后可读取到该记录', () => {
    const data = addRelation(newCardId, { execDocType: 'PC', relatedDocNo: 'PC-0001' }, { origin: 'manual' });
    expect(data.execDocType).toBe('PC');
    expect(data.relatedDocNo).toBe('PC-0001');
    expect(data.origin).toBe('manual');

    const stored = relationRepo.findById(data.id);
    expect(stored).not.toBeNull();
    expect(stored.cardId).toBe(newCardId);
  });

  it('Effective 态工卡拒绝新增关联（编辑态闸门，需求 49.1、49.2）', () => {
    try {
      addRelation(effectiveCardId, { execDocType: 'PC', relatedDocNo: 'PC-0002' }, { origin: 'manual' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.UNPROCESSABLE);
      expect(error.data.rejection).toBe(RELATION_REJECTION.NOT_EDITABLE);
    }
  });

  it('三元组重复时拒绝且不产生第二条记录（需求 21.1）', () => {
    const doc = { execDocType: 'CR', relatedDocNo: 'CR-0001' };
    const first = addRelation(newCardId, doc, { origin: 'manual' });
    expect(first.id).toBeDefined();

    try {
      addRelation(newCardId, doc, { origin: 'manual' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.CONFLICT);
      expect(error.data.rejection).toBe(RELATION_REJECTION.DUPLICATE_RELATION);
    }

    expect(relationRepo.listByCardId(newCardId)).toHaveLength(1);
  });

  it('单据类型越界时拒绝（需求 21.3，越界抛错经服务层转 VALIDATION）', () => {
    try {
      addRelation(newCardId, { execDocType: 'XX', relatedDocNo: 'X-0001' }, { origin: 'manual' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.VALIDATION);
      expect(error.data.rejection).toBe(RELATION_REJECTION.INVALID_INPUT);
    }
  });

  it('工卡不存在时抛 NOT_FOUND', () => {
    try {
      addRelation(999999, { execDocType: 'PC', relatedDocNo: 'PC-0003' }, { origin: 'manual' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.NOT_FOUND);
      expect(error.data.rejection).toBe(RELATION_REJECTION.CARD_NOT_FOUND);
    }
  });
});

describe('removeRelation', () => {
  it('New 态工卡可删除已存在的关联', () => {
    const added = addRelation(newCardId, { execDocType: 'TS', relatedDocNo: 'TS-0001' }, { origin: 'manual' });
    const result = removeRelation(newCardId, added.id);
    expect(result.removed).toBe(true);
    expect(relationRepo.findById(added.id)).toBeNull();
  });

  it('Effective 态工卡拒绝删除关联', () => {
    // 借用 New 态工卡新增一条，再手动切到 Effective 态验证闸门（不改变落库关联本身）
    const added = addRelation(newCardId, { execDocType: 'TS', relatedDocNo: 'TS-0002' }, { origin: 'manual' });
    taskCardRepo.update(newCardId, { status: 'Effective' });

    expect(() => removeRelation(newCardId, added.id)).toThrow(ServiceError);
    try {
      removeRelation(newCardId, added.id);
    } catch (error) {
      expect(error.data.rejection).toBe(RELATION_REJECTION.NOT_EDITABLE);
    }
  });

  it('待删除关联不存在时抛 RELATION_NOT_FOUND', () => {
    try {
      removeRelation(newCardId, 999999);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.NOT_FOUND);
      expect(error.data.rejection).toBe(RELATION_REJECTION.RELATION_NOT_FOUND);
    }
  });

  it('关联不属于该工卡时拒绝', () => {
    const other = addRelation(newCardId, { execDocType: 'TS', relatedDocNo: 'TS-0003' }, { origin: 'manual' });
    // 用另一张同为 New 态的工卡尝试删除，隔离编辑态闸门的影响，单独验证归属校验
    const anotherNewCardId = taskCardRepo.findByTaskNoAndRevision('TC-2026-0003', 1).id;
    try {
      removeRelation(anotherNewCardId, other.id);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error.data.rejection).toBe(RELATION_REJECTION.RELATION_NOT_FOUND);
    }
  });
});

describe('listRelations', () => {
  it('查看不受编辑态闸门约束（需求 49.8），Effective 态工卡亦可查看', () => {
    const data = listRelations(effectiveCardId);
    expect(Array.isArray(data)).toBe(true);
  });

  it('工卡不存在时抛 CARD_NOT_FOUND', () => {
    try {
      listRelations(999999);
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.NOT_FOUND);
      expect(error.data.rejection).toBe(RELATION_REJECTION.CARD_NOT_FOUND);
    }
  });
});

describe('autoLinkFromExecDocument', () => {
  it('无需编辑态即可对 Effective 态工卡自动建立关联（需求 21.4）', () => {
    const data = autoLinkFromExecDocument(effectiveCardId, { execDocType: 'PC', relatedDocNo: 'AUTO-PC-0001' });
    expect(data.origin).toBe('auto');
  });

  it('缺省 origin 时按单据类型推断为 auto（PC/CR/TS）', () => {
    const data = autoLinkFromExecDocument(newCardId, { execDocType: 'CR', relatedDocNo: 'AUTO-CR-0001' });
    expect(data.origin).toBe('auto');
  });

  it('重复调用同一三元组时幂等返回既有关联，不报错、不重复落库', () => {
    const doc = { execDocType: 'TS', relatedDocNo: 'AUTO-TS-0001' };
    const first = autoLinkFromExecDocument(effectiveCardId, doc);
    const second = autoLinkFromExecDocument(effectiveCardId, doc);

    expect(second.id).toBe(first.id);
    expect(relationRepo.listByCardId(effectiveCardId).filter((r) => r.relatedDocNo === 'AUTO-TS-0001')).toHaveLength(1);
  });
});

describe('syncKeyInfoForRelation / syncKeyInfoForCard', () => {
  it('同步单条关联的关键信息快照（需求 21.5）', () => {
    const added = addRelation(newCardId, { execDocType: 'PC', relatedDocNo: 'SYNC-0001' }, { origin: 'manual' });
    const data = syncKeyInfoForRelation(added.id, { acType: '350', serialNo: 'SN-9999' });
    expect(data.keyInfoSnapshot.acType).toBe('350');
    expect(data.keyInfoSnapshot.serialNo).toBe('SN-9999');
  });

  it('待同步关联不存在时抛 RELATION_NOT_FOUND', () => {
    try {
      syncKeyInfoForRelation(999999, { acType: '350' });
      expect.unreachable('应抛出 ServiceError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe(CODE.NOT_FOUND);
      expect(error.data.rejection).toBe(RELATION_REJECTION.RELATION_NOT_FOUND);
    }
  });

  it('同步某工卡下全部关联的关键信息', () => {
    addRelation(newCardId, { execDocType: 'PC', relatedDocNo: 'SYNC-A' }, { origin: 'manual' });
    addRelation(newCardId, { execDocType: 'CR', relatedDocNo: 'SYNC-B' }, { origin: 'manual' });

    const data = syncKeyInfoForCard(newCardId, { taskNo: 'TC-2026-0002' });
    expect(data).toHaveLength(2);
    for (const relation of data) {
      expect(relation.keyInfoSnapshot.taskNo).toBe('TC-2026-0002');
    }
  });
});

describe('getRequiredSignDocTypes', () => {
  it('转发 domain/relation.js 的 requiredSignDocTypes 判定结果（需求 16.4、45.8、45.9）', () => {
    // CR 的签署要求属性为「签署」（种子 exec_doc_type 表），关联后应出现在结果中
    autoLinkFromExecDocument(newCardId, { execDocType: 'CR', relatedDocNo: 'SIGN-CR-0001' });
    const result = getRequiredSignDocTypes(newCardId);
    expect(result).toContain('CR');
  });

  it('未关联任何单据时返回空数组', () => {
    const otherCard = taskCardRepo.findByTaskNoAndRevision('TC-2026-0004', 1);
    const result = getRequiredSignDocTypes(otherCard.id);
    expect(result).toEqual([]);
  });
});
