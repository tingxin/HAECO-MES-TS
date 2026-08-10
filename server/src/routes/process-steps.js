import { Router } from 'express';
import multer from 'multer';

import { CODE, sendOk } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import authorize from '../middleware/authorize.js';
import userContext from '../middleware/user-context.js';
import processStepService from '../services/processStepService.js';

const workbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

function route(handler) {
  return function processStepRoute(req, res, next) {
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
}

function uploadWorkbook(req, res, next) {
  workbookUpload.single('file')(req, res, (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'Excel 文件大小超限（上限 20MB）' : error.message;
      return next(new ServiceError(CODE.VALIDATION, message));
    }
    return next();
  });
}

function requireFile(req) {
  if (!req.file?.buffer) throw new ServiceError(CODE.VALIDATION, '请上传 file 字段');
  return req.file;
}

function reason(req) {
  return req.body?.reason ?? req.body?.changeReason ?? req.query?.reason;
}

export const createStep = route((req, res) =>
  sendOk(res, processStepService.createStep(req.params.id, req.body, req.user)));

export const saveStep = route((req, res) =>
  sendOk(res, processStepService.saveStep(req.params.id, req.params.stepId, req.body, req.user)));

export const deleteStep = route((req, res) =>
  sendOk(res, processStepService.deleteStep(
    req.params.id, req.params.stepId, req.user, reason(req),
  )));

export const reorderSteps = route((req, res) =>
  sendOk(res, processStepService.reorderSteps(
    req.params.id,
    req.body?.orderedStepIds ?? req.body?.stepIds,
    req.user,
    reason(req),
  )));
export const addSignature = route((req, res) =>
  sendOk(res, processStepService.addSignature(
    req.params.id, req.params.stepId, req.body, req.user,
  )));

export const deleteSignature = route((req, res) =>
  sendOk(res, processStepService.deleteSignature(
    req.params.id, req.params.stepId, req.params.reqId, req.user, reason(req),
  )));

export const listSignatures = route((req, res) =>
  sendOk(res, processStepService.listSignatures(req.params.id)));

export const updateSafety = route((req, res) =>
  sendOk(res, processStepService.updateSafety(
    req.params.id, req.params.stepId, req.body, req.user,
  )));

export const listTemplates = route((_req, res) =>
  sendOk(res, processStepService.listTemplates()));

export const createTemplate = route((req, res) =>
  sendOk(res, processStepService.createTemplate(req.body)));

export const applyTemplate = route((req, res) =>
  sendOk(res, processStepService.applyTemplate(
    req.params.id,
    req.params.stepId,
    req.body?.templateId ?? req.body?.id,
    req.user,
    reason(req),
  )));

export const downloadTemplate = route(async (req, res) => {
  const buffer = await processStepService.buildEmptyTemplateFile(req.params.id);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="process-steps-template.xlsx"',
    'Content-Length': String(buffer.length),
  });
  return res.send(buffer);
});

export const importSteps = route(async (req, res) => {
  const file = requireFile(req);
  const result = await processStepService.importSteps(req.params.id, file.buffer, req.user);
  return sendOk(res, result);
});

export const getProcessData = route((req, res) => {
  const data = processStepService.getProcessData(req.query);
  const view = data ?? {
    partNo: null,
    partSn: null,
    partDesc: null,
    operationType: null,
    operation: null,
  };
  return sendOk(res, view, data === null ? '集成数据缺失' : '演示数据');
});
export function createProcessStepsRouter({
  protect = userContext,
  authorizePermission = authorize,
} = {}) {
  const router = Router();
  const allowed = (permission, ...handlers) => [protect, authorizePermission(permission), ...handlers];

  router.get('/process-data', ...allowed('card_read', getProcessData));
  router.get('/step-templates', ...allowed('card_read', listTemplates));
  router.post('/step-templates', ...allowed('card_edit', createTemplate));

  router.get('/task-cards/:id/steps/template-file', ...allowed('card_read', downloadTemplate));
  router.post('/task-cards/:id/steps/import', ...allowed('card_edit', uploadWorkbook, importSteps));
  router.post('/task-cards/:id/steps/reorder', ...allowed('card_edit', reorderSteps));
  router.post('/task-cards/:id/steps', ...allowed('card_edit', createStep));
  router.put('/task-cards/:id/steps/:stepId', ...allowed('card_edit', saveStep));
  router.delete('/task-cards/:id/steps/:stepId', ...allowed('card_edit', deleteStep));
  router.put('/task-cards/:id/steps/:stepId/safety', ...allowed('card_edit', updateSafety));
  router.post(
    '/task-cards/:id/steps/:stepId/signature-requirements',
    ...allowed('card_edit', addSignature),
  );
  router.delete(
    '/task-cards/:id/steps/:stepId/signature-requirements/:reqId',
    ...allowed('card_edit', deleteSignature),
  );
  router.get(
    '/task-cards/:id/signature-requirements',
    ...allowed('card_read', listSignatures),
  );
  router.post(
    '/task-cards/:id/steps/:stepId/apply-template',
    ...allowed('card_edit', applyTemplate),
  );

  return router;
}

export const processStepsRouter = createProcessStepsRouter();
export default processStepsRouter;
