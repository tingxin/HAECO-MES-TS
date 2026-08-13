import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';

import { CODE, sendOk } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import { ENUMS, CARD_TYPE_CODES } from '../domain/enums.js';
import { defaultStageFor, selectableStages } from '../domain/stage-constraint.js';
import authorize from '../middleware/authorize.js';
import userContext from '../middleware/user-context.js';
import configService from '../services/configService.js';
import classificationService from '../services/classificationService.js';
import integrationService from '../services/integrationService.js';
import execDocumentService from '../services/execDocumentService.js';
import exportService from '../services/exportService.js';
import printService from '../services/printService.js';
import migrationService, { SOURCE_CHANNEL } from '../services/migrationService.js';
import bomService from '../services/bomService.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

function route(handler) {
  return function task20Route(req, res, next) {
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
}

function uploadFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? '迁移文件大小超限（上限 20MB）' : error.message;
    return next(new ServiceError(CODE.VALIDATION, message));
  });
}

function requireFile(req) {
  if (!req.file?.buffer) throw new ServiceError(CODE.VALIDATION, '请上传 file 字段');
  return req.file;
}

function collection(body, ...keys) {
  for (const key of keys) if (Array.isArray(body?.[key])) return body[key];
  return body;
}
function stageConstraintView() {
  const config = configService.getStageConstraintConfig();
  const stageOptions = CARD_TYPE_CODES.map((cardType) => ({
    cardType,
    defaultStage: defaultStageFor(cardType, config),
    selectableStages: [...selectableStages(cardType, config)],
  }));
  return {
    ...config,
    stageOptions,
    byCardType: Object.fromEntries(stageOptions.map((entry) => [entry.cardType, {
      defaultStage: entry.defaultStage,
      selectableStages: entry.selectableStages,
    }])),
  };
}

function parseIds(value) {
  const ids = String(value ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new ServiceError(CODE.VALIDATION, '请先选择至少一条工卡后再执行导出');
  return ids;
}

function migrationChannel(req) {
  const requested = req.body?.sourceChannel?.toLowerCase();
  if (Object.values(SOURCE_CHANNEL).includes(requested)) return requested;
  const extension = path.extname(req.file?.originalname ?? '').toLowerCase();
  const byExtension = { '.xlsx': SOURCE_CHANNEL.EXCEL, '.xls': SOURCE_CHANNEL.EXCEL, '.csv': SOURCE_CHANNEL.CSV, '.docx': SOURCE_CHANNEL.WORD, '.rtf': SOURCE_CHANNEL.RTF };
  const channel = byExtension[extension];
  if (!channel) throw new ServiceError(CODE.VALIDATION, `不支持的迁移文件类型：${extension || '未知'}`);
  return channel;
}

function confirmationChannel(body) {
  const sourceChannel = typeof body?.sourceChannel === 'string'
    ? body.sourceChannel.toLowerCase()
    : '';
  if (![SOURCE_CHANNEL.WORD, SOURCE_CHANNEL.RTF].includes(sourceChannel)) {
    throw new ServiceError(CODE.VALIDATION, '人工确认迁移的 sourceChannel 须为 word 或 rtf');
  }
  return sourceChannel;
}

export function createTask20Router({
  protect = userContext,
  authorizePermission = authorize,
} = {}) {
  const router = Router();
  const allowed = (permission, ...handlers) => [protect, authorizePermission(permission), ...handlers];

  router.get('/enums', ...allowed('card_read', route((_req, res) => sendOk(res, ENUMS))));
  router.get('/stage-constraints', ...allowed('card_read', route((_req, res) => sendOk(res, stageConstraintView()))));
  router.get('/card-type-commercial-map', ...allowed('card_read', route((_req, res) => sendOk(res, configService.getCommercialMap()))));
  router.get('/derivation-priority', ...allowed('card_read', route((_req, res) => sendOk(res, configService.getDerivationPriorityConfig()))));
  router.get('/capabilities', ...allowed('card_read', route((_req, res) => sendOk(res, configService.getCapabilityList()))));
  router.get('/print-templates', ...allowed('card_read', route((_req, res) => sendOk(res, configService.getPrintTemplates()))));
  router.get('/system-parameters', ...allowed('card_read', route((_req, res) => sendOk(res, configService.getSystemParameters()))));
  router.put('/stage-constraints', ...allowed('config_write', route((req, res) => {
    configService.replaceStageConstraintConfigAuthorized(req.body);
    return sendOk(res, stageConstraintView());
  })));
  router.put('/card-type-commercial-map', ...allowed('config_write', route((req, res) => sendOk(
    res,
    configService.replaceCommercialMapAuthorized(collection(req.body, 'mappings', 'entries')),
  ))));
  router.put('/derivation-priority', ...allowed('config_write', route((req, res) => sendOk(
    res,
    configService.replaceDerivationPriorityAuthorized(collection(req.body, 'tiers', 'entries')),
  ))));
  router.put('/capabilities', ...allowed('capability_write', route((req, res) => sendOk(
    res,
    configService.replaceCapabilitiesAuthorized(collection(req.body, 'capabilities', 'entries')),
  ))));
  router.put('/print-templates/:id', ...allowed('config_write', route((req, res) => sendOk(
    res,
    configService.updatePrintTemplateAuthorized(req.params.id, req.body),
  ))));

  router.get('/task-cards/:id/classification/latest', ...allowed('card_read', route((req, res) => sendOk(
    res,
    classificationService.getLatestClassification(req.params.id),
  ))));
  router.get('/task-cards/:id/classification/history', ...allowed('card_read', route((req, res) => sendOk(
    res,
    classificationService.listClassificationHistory(req.params.id),
  ))));
  router.post('/task-cards/:id/classification/derive', ...allowed('card_edit', route((req, res) => sendOk(
    res,
    classificationService.deriveClassification(req.params.id),
  ))));
  router.post('/task-cards/:id/classification/confirm', ...allowed('card_edit', route((req, res) => {
    const choice = req.body?.choice ?? (req.body?.classification === undefined ? req.body : {
      classification: req.body.classification,
      outsourceSubtype: req.body.outsourceSubtype,
      derivationResultId: req.body.derivationResultId,
    });
    return sendOk(res, classificationService.confirmClassification(req.params.id, choice, {
      ...req.user,
      confirmedAt: req.body?.confirmedAt,
    }));
  })));

  router.get('/tpc/documents', ...allowed('card_read', route((req, res) => {
    const result = integrationService.listTpcDocuments(req.query);
    return sendOk(res, result.data, result.message);
  })));
  router.get('/ppc/process-data', ...allowed('card_read', route((req, res) => {
    const result = integrationService.listPpcProcessData(req.query);
    return sendOk(res, result.data, result.message);
  })));
  router.get('/pid/:pid/scope', ...allowed('card_read', route((req, res) => {
    const result = integrationService.getPidScope(req.params.pid);
    return sendOk(res, result.data, result.message);
  })));
  router.get('/ppc/schedule', ...allowed('card_read', route((req, res) => {
    const result = integrationService.getSchedule(req.query);
    return sendOk(res, result.data, result.message);
  })));
  router.get('/lot-lists/:lotListRef/bases', ...allowed('card_read', route((req, res) => {
    const result = integrationService.listLotListBases(req.params.lotListRef);
    return sendOk(res, result.data, result.message);
  })));
  router.get('/classification-sources', ...allowed('card_read', route((req, res) => {
    const result = integrationService.getClassificationSources(req.query.cardId);
    return sendOk(res, result.data, result.message);
  })));
  router.get('/work-packages/in-progress-refs', ...allowed('card_read', route((req, res) => {
    const result = integrationService.listWorkPackageInProgressRefs(req.query.cardId);
    return sendOk(res, result.data, result.message);
  })));

  router.post('/exec-documents/copy', ...allowed('card_edit', route((req, res) => sendOk(
    res,
    execDocumentService.copy(req.body, req.user),
  ))));
  router.get('/exec-documents', ...allowed('card_read', route((req, res) => sendOk(res, execDocumentService.list(req.query)))));
  router.get('/exec-documents/:id', ...allowed('card_read', route((req, res) => sendOk(res, execDocumentService.getById(req.params.id)))));

  // This static path must be mounted before the task-cards /:id router.
  router.get('/task-cards/export', ...allowed('card_print_export', route((req, res) => {
    const csv = exportService.exportCsv(parseIds(req.query.ids), req.query.mode);
    const buffer = Buffer.from(csv, 'utf8');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="task-cards.csv"; filename*=UTF-8''task-cards.csv`,
      'Content-Length': String(buffer.length),
    });
    return res.send(buffer);
  })));
  router.post('/task-cards/print', ...allowed('card_print_export', route((req, res) => sendOk(
    res,
    printService.getBatchPrintModels(req.body?.ids),
  ))));
  router.get('/task-cards/:id/print', ...allowed('card_print_export', route((req, res) => sendOk(
    res,
    printService.getPrintModel(req.params.id, { jobNo: req.query.jobNo }),
  ))));
  router.post('/migrations', ...allowed('migration_run', uploadFile, route(async (req, res) => {
    const file = requireFile(req);
    const sourceChannel = migrationChannel(req);
    let data;
    if (sourceChannel === SOURCE_CHANNEL.WORD) data = await migrationService.previewFromWord(file.buffer);
    else if (sourceChannel === SOURCE_CHANNEL.RTF) data = migrationService.previewFromRtf(file.buffer);
    else data = migrationService.importFromExcel(file.buffer, {
      ...req.user,
      sourceChannel,
      sourceName: file.originalname,
    });
    return sendOk(res, data);
  })));
  router.post('/migrations/confirm', ...allowed('migration_run', route((req, res) => sendOk(
    res,
    migrationService.importRows(req.body?.rows, {
      ...req.user,
      sourceChannel: confirmationChannel(req.body),
      sourceName: req.body?.sourceName ?? null,
    }),
  ))));
  router.get('/migrations/:id/report', ...allowed('migration_run', route((req, res) => sendOk(
    res,
    migrationService.getBatchReport(req.params.id),
  ))));

  router.get('/task-cards/:id/lot-links', ...allowed('card_read', route((req, res) => sendOk(
    res,
    bomService.listLotLinks(req.params.id),
  ))));
  router.post('/task-cards/:id/lot-links', ...allowed('card_edit', route((req, res) => sendOk(
    res,
    bomService.addLotLink(req.params.id, req.body),
  ))));
  router.delete('/task-cards/:id/lot-links/:linkId', ...allowed('card_edit', route((req, res) => sendOk(
    res,
    bomService.removeLotLink(req.params.id, req.params.linkId),
  ))));
  router.get('/task-cards/:id/bom-bases', ...allowed('card_read', route((req, res) => sendOk(
    res,
    bomService.listBomBases(req.params.id),
  ))));

  return router;
}

export const task20Router = createTask20Router();
export default task20Router;
