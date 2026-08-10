import { Router } from 'express';

import { CODE, sendOk } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import authorize from '../middleware/authorize.js';
import userContext from '../middleware/user-context.js';
import taskCardService from '../services/taskCardService.js';
import reviewService from '../services/reviewService.js';
import versionService from '../services/versionService.js';
import voidService from '../services/voidService.js';
import * as relationService from '../services/relationService.js';
import releaseService from '../services/releaseService.js';
import executionService from '../services/executionService.js';
import reviewRecordRepo from '../repositories/reviewRecordRepo.js';
import changeRecordRepo from '../repositories/changeRecordRepo.js';

const FILTER_NAMES = Object.freeze([
  'acType', 'taskNo', 'gearType', 'title', 'status', 'stage', 'cardType',
]);

function route(handler) {
  return function taskCardRoute(req, res, next) {
    try {
      return handler(req, res);
    } catch (error) {
      return next(error);
    }
  };
}

function positiveInt(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ServiceError(CODE.VALIDATION, `${label} 必须为正整数`);
  }
  return parsed;
}

function assertIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ServiceError(CODE.VALIDATION, '须先选择工卡', { rejection: 'EMPTY_IDS' });
  }
  return ids;
}

function reviewComment(body) {
  return body?.reviewComment ?? body?.comment;
}
export const getTaskCards = route((req, res) => {
  const filters = Object.fromEntries(
    FILTER_NAMES.filter((name) => req.query[name] !== undefined).map((name) => [name, req.query[name]]),
  );
  return sendOk(res, taskCardService.listCards({
    filters,
    page: positiveInt(req.query.page, 1, 'page'),
    pageSize: positiveInt(req.query.pageSize, 20, 'pageSize'),
  }));
});

export const getTaskCard = route((req, res) =>
  sendOk(res, taskCardService.getCardDetail(req.params.id, req.query.jobNo)));

export const getTaskCardVersions = route((req, res) =>
  sendOk(res, taskCardService.listCardVersions(req.params.id)));

export const checkTaskCardDuplicate = route((req, res) =>
  sendOk(res, taskCardService.checkCardDuplicate(
    req.query.taskNo,
    req.query.revision,
    req.query.excludeId,
  )));

export const createTaskCard = route((req, res) =>
  sendOk(res, taskCardService.createCard(req.body, req.user)));

export const updateTaskCard = route((req, res) =>
  sendOk(res, taskCardService.updateCard(
    req.params.id,
    req.body,
    req.user,
    req.body?.reason ?? req.body?.changeReason,
  )));

export const addReferenceDocument = route((req, res) =>
  sendOk(res, taskCardService.addReferenceDocument(req.params.id, req.body, req.user)));

export const deleteReferenceDocument = route((req, res) =>
  sendOk(res, taskCardService.removeReferenceDocument(
    req.params.id,
    req.params.docId,
    req.user,
    req.body?.reason ?? req.query.reason,
  )));

export const bindAttachmentReference = route((req, res) =>
  sendOk(res, taskCardService.bindAttachmentReference(req.params.id, req.body, req.user)));

export const submitReview = route((req, res) =>
  sendOk(res, reviewService.submitForReview(req.params.id, {
    ...req.user,
    changeReason: req.body?.changeReason ?? req.body?.reason,
  })));

export const approveTaskCard = route((req, res) =>
  sendOk(res, reviewService.approve(req.params.id, req.user, reviewComment(req.body))));

export const rejectTaskCard = route((req, res) =>
  sendOk(res, reviewService.reject(req.params.id, req.user, reviewComment(req.body))));

export const getReviews = route((req, res) => {
  const card = taskCardService.getCard(req.params.id);
  return sendOk(res, reviewRecordRepo.listByCardRevision(card.id, card.revision));
});
export const copyTaskCards = route((req, res) =>
  sendOk(res, versionService.copyCardsBatch(assertIds(req.body?.ids), req.body?.numbering, req.user)));

export const adjustCopiedTaskNo = route((req, res) =>
  sendOk(res, versionService.adjustCopiedTaskNo(req.params.id, req.body?.taskNo)));

export const reviseTaskCards = route((req, res) => {
  const ids = assertIds(req.body?.ids);
  const data = ids.length === 1 && req.body?.revision !== undefined
    ? [versionService.reviseCard(ids[0], req.body?.reason, req.user, { revision: req.body.revision })]
    : versionService.reviseCardsBatch(ids, req.body?.reason, req.user);
  return sendOk(res, data);
});

export const voidTaskCard = route((req, res) =>
  sendOk(res, voidService.voidCard(req.params.id, req.body?.reason, req.user, {
    inProgressPackageRefs: req.body?.inProgressPackageRefs,
  })));

export const voidPrecheck = route((req, res) => {
  const result = voidService.checkVoidPrecondition(req.params.id, req.query.reason ?? 'precheck', {
    inProgressPackageRefs: req.body?.inProgressPackageRefs,
  });
  const byType = (type) => result.blockingRefs.filter((entry) => entry.type === type);
  return sendOk(res, {
    ...result,
    referenceHits: {
      jobInProgress: byType('JOB_IN_PROGRESS'),
      jobNotStarted: byType('JOB_NOT_STARTED'),
      inProgressPackage: byType('IN_PROGRESS_PACKAGE'),
    },
  });
});

export const getChangeRecords = route((req, res) => {
  const card = taskCardService.getCard(req.params.id);
  return sendOk(res, changeRecordRepo.listByCardRevision(card.id, card.revision));
});

export const batchReplaceTaskCards = route((req, res) =>
  sendOk(res, versionService.batchReplaceCards(
    assertIds(req.body?.ids),
    { field: req.body?.field, from: req.body?.from, to: req.body?.to },
    req.body?.reason,
    { ...req.user, method: req.method, path: req.originalUrl },
  )));

export const listRelations = route((req, res) =>
  sendOk(res, relationService.listRelations(req.params.id)));

export const addRelation = route((req, res) =>
  sendOk(res, relationService.addRelation(req.params.id, req.body, {
    ...(req.body?.options ?? {}),
    createdBy: req.user.staffNo,
  })));

export const deleteRelation = route((req, res) =>
  sendOk(res, relationService.removeRelation(req.params.id, req.params.relId)));

export const autoRelation = route((req, res) =>
  sendOk(res, relationService.autoLinkFromExecDocument(req.params.id, req.body, {
    ...(req.body?.options ?? {}),
    createdBy: req.user.staffNo,
    origin: 'auto',
  })));

export const syncRelations = route((req, res) =>
  sendOk(res, relationService.syncKeyInfoForCard(
    req.params.id,
    req.body?.keyInfo ?? req.body?.keyInfoSource ?? req.body,
  )));

export const releaseTaskCard = route((req, res) => {
  const result = releaseService.release(req.params.id, { ...req.body, ...req.user });
  return sendOk(res, result, result.message);
});

export const signTaskCard = route((req, res) =>
  sendOk(res, executionService.signDocument({ ...req.body, cardId: req.params.id }, req.user)));

export const getArchiveStatus = route((req, res) =>
  sendOk(res, executionService.checkCardArchiveReadiness(req.params.id, {
    jobId: req.query.jobId,
    jobNo: req.query.jobNo,
  })));

export function createTaskCardsRouter({
  protect = userContext,
  authorizePermission = authorize,
} = {}) {
  const router = Router();
  const allowed = (permission, handler) => [protect, authorizePermission(permission), handler];

  router.get('/task-cards', ...allowed('card_read', getTaskCards));
  router.get('/task-cards/check-duplicate', ...allowed('card_read', checkTaskCardDuplicate));
  router.post('/task-cards/copy', ...allowed('card_edit', copyTaskCards));
  router.patch('/task-cards/:id/copied-task-no', ...allowed('card_edit', adjustCopiedTaskNo));
  router.post('/task-cards/revise', ...allowed('card_edit', reviseTaskCards));
  router.post('/task-cards/batch-replace', ...allowed('batch_replace', batchReplaceTaskCards));

  router.post('/task-cards/:id/release', ...allowed('card_release', releaseTaskCard));
  router.post('/task-cards/:id/signatures', ...allowed('job_exec_write', signTaskCard));
  router.get('/task-cards/:id/archive-status', ...allowed('card_read', getArchiveStatus));

  router.get('/task-cards/:id', ...allowed('card_read', getTaskCard));
  router.get('/task-cards/:id/versions', ...allowed('card_read', getTaskCardVersions));
  router.post('/task-cards', ...allowed('card_edit', createTaskCard));
  router.put('/task-cards/:id', ...allowed('card_edit', updateTaskCard));
  router.post('/task-cards/:id/reference-docs', ...allowed('card_edit', addReferenceDocument));
  router.delete('/task-cards/:id/reference-docs/:docId', ...allowed('card_edit', deleteReferenceDocument));
  router.post('/task-cards/:id/attachment-references', ...allowed('card_edit', bindAttachmentReference));

  router.post('/task-cards/:id/submit-review', ...allowed('card_submit_review', submitReview));
  router.post('/task-cards/:id/approve', ...allowed('card_review', approveTaskCard));
  router.post('/task-cards/:id/reject', ...allowed('card_review', rejectTaskCard));
  router.get('/task-cards/:id/reviews', ...allowed('card_read', getReviews));

  router.post('/task-cards/:id/void', ...allowed('card_void', voidTaskCard));
  router.get('/task-cards/:id/void-precheck', ...allowed('card_void', voidPrecheck));
  router.get('/task-cards/:id/change-records', ...allowed('card_read', getChangeRecords));

  router.get('/task-cards/:id/relations', ...allowed('card_read', listRelations));
  router.post('/task-cards/:id/relations', ...allowed('card_edit', addRelation));
  router.delete('/task-cards/:id/relations/:relId', ...allowed('card_edit', deleteRelation));
  router.post('/task-cards/:id/relations/auto', ...allowed('job_exec_write', autoRelation));
  router.post('/task-cards/:id/relations/sync', ...allowed('card_edit', syncRelations));

  return router;
}

export const taskCardsRouter = createTaskCardsRouter();
export default taskCardsRouter;
