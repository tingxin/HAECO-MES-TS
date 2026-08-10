import tpcRepo from '../repositories/tpcRepo.js';
import ppcRepo from '../repositories/ppcRepo.js';
import ppcScheduleRepo from '../repositories/ppcScheduleRepo.js';
import processDataRepo from '../repositories/processDataRepo.js';
import lotListBaseRepo from '../repositories/lotListBaseRepo.js';
import pidScopeRepo from '../repositories/pidScopeRepo.js';
import classificationSourceRepo from '../repositories/classificationSourceRepo.js';
import workPackageInProgressRefRepo from '../repositories/workPackageInProgressRefRepo.js';

export const INTEGRATION_MESSAGE = Object.freeze({
  MISSING: '集成数据缺失',
  DEMO: '演示数据',
});

function result(data, found) {
  return { data, message: found ? INTEGRATION_MESSAGE.DEMO : INTEGRATION_MESSAGE.MISSING };
}

export function listTpcDocuments(query = {}) {
  let rows;
  if (query.id !== undefined) {
    const row = tpcRepo.findById(query.id);
    rows = row === null ? [] : [row];
  } else if (query.refNo) rows = tpcRepo.findByRefNo(query.refNo);
  else if (query.keyword) rows = tpcRepo.searchByKeyword(query.keyword);
  else rows = tpcRepo.list();
  return result(rows, rows.length > 0);
}

export function listPpcProcessData(query = {}) {
  let rows;
  if (query.cardId !== undefined && query.stepId) {
    const row = ppcRepo.findByCardAndStep(query.cardId, query.stepId);
    rows = row === null ? [] : [row];
  } else if (query.cardId !== undefined) rows = ppcRepo.listByCardId(query.cardId);
  else rows = ppcRepo.list();
  return result(rows, rows.length > 0);
}

export function getPidScope(pid) {
  const row = pidScopeRepo.findByPid(pid);
  return result(row, row !== null);
}

export function getSchedule(query = {}) {
  const jobTargetDate = ppcScheduleRepo.findJobTargetDate(query.pid ?? null, query.cardId ?? null);
  return result({ jobTargetDate }, jobTargetDate !== null);
}

export function getProcessData(query = {}) {
  const row = processDataRepo.findOne(query.pid ?? null, query.cardId ?? null, query.stepId ?? null);
  if (row === null) return result({
    partNo: null,
    partSn: null,
    partDesc: null,
    operationType: null,
    operation: null,
  }, false);
  return result({
    partNo: row.partNo,
    partSn: row.partSn,
    partDesc: row.partDesc,
    operationType: row.operationType,
    operation: row.operation,
  }, true);
}

export function listLotListBases(lotListRef) {
  const rows = lotListBaseRepo.listBasesByLotListRef(lotListRef);
  return result(rows, rows.length > 0);
}

export function getClassificationSources(cardId) {
  const sources = classificationSourceRepo.findByCardId(cardId);
  if (sources === null) return result({
    planDummyJob: null,
    nrcOriginatingDoc: null,
    outsourceEntry: null,
    partNature: null,
    packageDivision: null,
  }, false);
  return result(sources, true);
}

export function listWorkPackageInProgressRefs(cardId) {
  const rows = workPackageInProgressRefRepo.listByCardId(cardId);
  return result(rows, rows.length > 0);
}

export default {
  listTpcDocuments,
  listPpcProcessData,
  getPidScope,
  getSchedule,
  getProcessData,
  listLotListBases,
  getClassificationSources,
  listWorkPackageInProgressRefs,
};
