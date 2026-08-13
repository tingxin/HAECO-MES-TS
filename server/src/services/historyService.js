import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import { immutableVersionSnapshot, diffVersionSnapshots } from '../domain/version-history.js';
import taskCardRepo from '../repositories/taskCardRepo.js';
import reviewRecordRepo from '../repositories/reviewRecordRepo.js';
import changeRecordRepo from '../repositories/changeRecordRepo.js';
import taskCardService from './taskCardService.js';
import printService from './printService.js';

function baseCard(id) {
  const card = taskCardRepo.findById(id);
  if (card === null) throw new ServiceError(CODE.NOT_FOUND, `工卡不存在：${String(id)}`);
  return card;
}
function versions(id) {
  return taskCardRepo.listVersionsByTaskNo(baseCard(id).taskNo);
}
function selectedVersion(id, versionId) {
  const allVersions = versions(id);
  const byId = allVersions.find((entry) => String(entry.id) === String(versionId));
  if (byId !== undefined) return byId;

  // Revision fallback preserves compatibility with the earlier route shape while
  // the documented contract identifies a version by its task_card row id.
  const numeric = Number(versionId);
  const byRevision = allVersions.find((entry) => entry.revision === numeric);
  if (byRevision === undefined) {
    throw new ServiceError(CODE.NOT_FOUND, `历史版本不存在：${String(versionId)}`);
  }
  return byRevision;
}
function revisionReason(allVersions, index) {
  if (index === 0) return null;
  const predecessor = allVersions[index - 1];
  const record = changeRecordRepo.listByCardRevision(predecessor.id, predecessor.revision)
    .find((entry) => entry.changeType === 'revise');
  return record?.reason ?? null;
}

export function listVersionSummaries(id) {
  const allVersions = versions(id);
  return allVersions.map((card, index) => ({
    id: card.id, taskNo: card.taskNo, revision: card.revision,
    revisionDate: card.date, status: card.status,
    changeReason: revisionReason(allVersions, index), createdBy: card.createdBy,
    reviews: reviewRecordRepo.listByCardRevision(card.id, card.revision),
  })).reverse();
}

export function getVersionSnapshot(id, versionId) {
  const card = selectedVersion(id, versionId);
  return immutableVersionSnapshot({
    ...taskCardService.getCardDetail(card.id),
    reviews: reviewRecordRepo.listByCardRevision(card.id, card.revision),
  });
}

export function getVersionDiff(id, versionId) {
  const allVersions = versions(id);
  const selectedCard = selectedVersion(id, versionId);
  const selectedIndex = allVersions.findIndex((entry) => String(entry.id) === String(selectedCard.id));
  const selected = getVersionSnapshot(id, selectedCard.id);
  const previous = selectedIndex === 0 ? null : getVersionSnapshot(id, allVersions[selectedIndex - 1].id);
  return { revision: selected.revision, previousRevision: previous?.revision ?? null,
    diff: diffVersionSnapshots(previous, selected) };
}

export function getVersionPrintModel(id, versionId) {
  const card = selectedVersion(id, versionId);
  return printService.getPrintModel(card.id);
}

export default { listVersionSummaries, getVersionSnapshot, getVersionDiff, getVersionPrintModel };
