import { getDb } from '../db/connection.js';
import { CODE } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import { passesEditableGate, statusOf } from '../domain/card-rules.js';
import { aggregateSignatureRequirements } from '../domain/signature.js';
import taskCardService from './taskCardService.js';
import taskCardRepo from '../repositories/taskCardRepo.js';
import processStepRepo from '../repositories/processStepRepo.js';
import referenceDocRepo from '../repositories/referenceDocRepo.js';
import captureItemRepo from '../repositories/captureItemRepo.js';
import componentRepo from '../repositories/componentRepo.js';
import signatureRequirementRepo from '../repositories/signatureRequirementRepo.js';
import stepTemplateRepo from '../repositories/stepTemplateRepo.js';
import processDataRepo from '../repositories/processDataRepo.js';

const NESTED_KEYS = Object.freeze(['captureItems', 'components', 'signatureRequirements']);
const SAFETY_KEYS = Object.freeze(['safetyWarning', 'visualCue', 'repairTips', 'isCritical']);
const TEMPLATE_COLUMNS = Object.freeze([
  'seq', 'skill', 'ref_doc_id', 'description_zh', 'description_en', 'safety_warning',
  'visual_cue', 'repair_tips', 'is_critical', 'capture_items', 'components',
  'signature_requirements',
]);

function withTransaction(fn) {
  return getDb().transaction(fn)();
}

function loadCard(cardId) {
  const card = taskCardRepo.findById(cardId);
  if (card === null) throw new ServiceError(CODE.NOT_FOUND, `工卡不存在：${String(cardId)}`);
  return card;
}

function assertEditableCard(cardId, operation = 'stepUpdate') {
  const card = loadCard(cardId);
  if (passesEditableGate(card, operation)) return card;
  const status = statusOf(card);
  throw new ServiceError(
    CODE.UNPROCESSABLE,
    status === 'Effective' ? '该工卡已生效，变更请先执行升版' : '当前工卡状态不可编辑',
    { status, operation },
  );
}

function loadOwnedStep(cardId, stepId) {
  const step = processStepRepo.findById(stepId);
  if (step === null || String(step.cardId) !== String(cardId)) {
    throw new ServiceError(CODE.NOT_FOUND, `工序不存在或不属于该工卡：${String(stepId)}`);
  }
  return step;
}

function assertReferenceDocument(cardId, value) {
  if (value === undefined || value === null || value === '') return;
  const doc = referenceDocRepo.findById(value);
  if (doc === null || String(doc.cardId) !== String(cardId)) {
    throw new ServiceError(CODE.VALIDATION, `参考文件不属于该工卡：${String(value)}`);
  }
}

function reasonOf(input) {
  return input?.reason ?? input?.changeReason;
}

function withoutNested(input) {
  if (input === null || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input).filter(([key]) => !NESTED_KEYS.includes(key)));
}
function aggregateForStep(stepId) {
  const step = processStepRepo.findById(stepId);
  if (step === null) throw new ServiceError(CODE.NOT_FOUND, `工序不存在：${String(stepId)}`);
  return {
    ...step,
    captureItems: captureItemRepo.listByStepId(stepId),
    components: componentRepo.listByStepId(stepId),
    signatureRequirements: signatureRequirementRepo.listByStepId(stepId),
  };
}

function syncChildren({ stepId, supplied, existing, add, update, remove, ctx, reason, label }) {
  if (supplied === undefined) return;
  if (!Array.isArray(supplied)) {
    throw new ServiceError(CODE.VALIDATION, `${label} 必须为数组`);
  }
  const byId = new Map(existing.map((entry) => [String(entry.id), entry]));
  const retained = new Set();
  for (const entry of supplied) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ServiceError(CODE.VALIDATION, `${label} 中存在非法记录`);
    }
    if (entry.id === undefined || entry.id === null) {
      add(stepId, entry, ctx);
      continue;
    }
    const id = String(entry.id);
    if (!byId.has(id)) {
      throw new ServiceError(CODE.NOT_FOUND, `${label}不存在或不属于该工序：${id}`);
    }
    retained.add(id);
    update(entry.id, entry, ctx, reason);
  }
  for (const oldEntry of existing) {
    if (!retained.has(String(oldEntry.id))) remove(oldEntry.id, ctx, reason);
  }
}

function syncAggregateChildren(stepId, input, ctx, reason) {
  syncChildren({
    stepId,
    supplied: input.captureItems,
    existing: captureItemRepo.listByStepId(stepId),
    add: taskCardService.addCaptureItem,
    update: taskCardService.updateCaptureItem,
    remove: taskCardService.removeCaptureItem,
    ctx,
    reason,
    label: '采集项',
  });
  syncChildren({
    stepId,
    supplied: input.components,
    existing: componentRepo.listByStepId(stepId),
    add: taskCardService.addComponent,
    update: taskCardService.updateComponent,
    remove: taskCardService.removeComponent,
    ctx,
    reason,
    label: '组件',
  });
  syncChildren({
    stepId,
    supplied: input.signatureRequirements,
    existing: signatureRequirementRepo.listByStepId(stepId),
    add: taskCardService.addSignatureRequirement,
    update: taskCardService.updateSignatureRequirement,
    remove: taskCardService.removeSignatureRequirement,
    ctx,
    reason,
    label: '签署项',
  });
}

export function createStep(cardId, input, ctx) {
  assertEditableCard(cardId, 'stepCreate');
  assertReferenceDocument(cardId, input?.refDocId ?? input?.ref_doc_id);
  return withTransaction(() => {
    const step = taskCardService.addProcessStep(cardId, withoutNested(input), ctx);
    syncAggregateChildren(step.id, input ?? {}, ctx, undefined);
    return aggregateForStep(step.id);
  });
}

export function saveStep(cardId, stepId, input, ctx) {
  assertEditableCard(cardId, 'stepUpdate');
  loadOwnedStep(cardId, stepId);
  assertReferenceDocument(cardId, input?.refDocId ?? input?.ref_doc_id);
  const reason = reasonOf(input);
  return withTransaction(() => {
    taskCardService.updateProcessStep(stepId, withoutNested(input), ctx, reason);
    syncAggregateChildren(stepId, input ?? {}, ctx, reason);
    return aggregateForStep(stepId);
  });
}

export function deleteStep(cardId, stepId, ctx, reason) {
  loadOwnedStep(cardId, stepId);
  return taskCardService.removeProcessStep(stepId, ctx, reason);
}

export function reorderSteps(cardId, orderedStepIds, ctx, reason) {
  return taskCardService.reorderProcessSteps(cardId, orderedStepIds, ctx, reason);
}
export function addSignature(cardId, stepId, input, ctx) {
  loadOwnedStep(cardId, stepId);
  return taskCardService.addSignatureRequirement(stepId, input, ctx);
}

export function deleteSignature(cardId, stepId, requirementId, ctx, reason) {
  loadOwnedStep(cardId, stepId);
  const requirement = signatureRequirementRepo.findById(requirementId);
  if (requirement === null || String(requirement.stepId) !== String(stepId)) {
    throw new ServiceError(CODE.NOT_FOUND, `签署项不存在或不属于该工序：${String(requirementId)}`);
  }
  return taskCardService.removeSignatureRequirement(requirementId, ctx, reason);
}

export function listSignatures(cardId) {
  loadCard(cardId);
  const steps = processStepRepo.listByCardId(cardId).map((step) => ({
    ...step,
    signatureRequirements: signatureRequirementRepo.listByStepId(step.id),
  }));
  return aggregateSignatureRequirements(steps).requirements;
}

export function updateSafety(cardId, stepId, input, ctx) {
  loadOwnedStep(cardId, stepId);
  const patch = Object.fromEntries(
    SAFETY_KEYS.filter((key) => input?.[key] !== undefined).map((key) => [key, input[key]]),
  );
  return taskCardService.updateProcessStep(stepId, patch, ctx, reasonOf(input));
}

function parsePayload(payload) {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  if (typeof payload !== 'string' || payload.trim() === '') {
    throw new ServiceError(CODE.VALIDATION, '工序模板 payload 必须为对象');
  }
  try {
    const parsed = JSON.parse(payload);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // The validation error below intentionally avoids leaking parser details.
  }
  throw new ServiceError(CODE.VALIDATION, '工序模板 payload 不是合法 JSON 对象');
}

function stripIdentity(entry) {
  if (entry === null || typeof entry !== 'object') return entry;
  const { id, stepId, step_id, cardId, card_id, processId, process_id, seq, operation,
    workCategory, work_category, estimatedManHours, estimated_man_hours, ...content } = entry;
  return content;
}

function templatePayloadFromAggregate(aggregate) {
  const payload = stripIdentity(aggregate);
  payload.captureItems = (aggregate.captureItems ?? []).map(stripIdentity);
  payload.components = (aggregate.components ?? []).map(stripIdentity);
  payload.signatureRequirements = (aggregate.signatureRequirements ?? []).map(stripIdentity);
  return payload;
}

function presentTemplate(template) {
  return { ...template, payload: parsePayload(template.payload) };
}

export function listTemplates() {
  return stepTemplateRepo.list().map(presentTemplate);
}

export function createTemplate(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name === '') throw new ServiceError(CODE.VALIDATION, '模板名称为必填项');
  let payload;
  if (input?.stepId !== undefined) {
    const step = processStepRepo.findById(input.stepId);
    if (step === null) throw new ServiceError(CODE.NOT_FOUND, `工序不存在：${String(input.stepId)}`);
    assertEditableCard(step.cardId, 'stepUpdate');
    payload = templatePayloadFromAggregate(aggregateForStep(step.id));
  } else {
    payload = templatePayloadFromAggregate(parsePayload(input?.payload));
  }
  const id = stepTemplateRepo.create({ name, payload });
  return presentTemplate(stepTemplateRepo.findById(id));
}

export function applyTemplate(cardId, stepId, templateId, ctx, reason) {
  loadOwnedStep(cardId, stepId);
  const template = stepTemplateRepo.findById(templateId);
  if (template === null) throw new ServiceError(CODE.NOT_FOUND, `工序模板不存在：${String(templateId)}`);
  const payload = parsePayload(template.payload);
  return saveStep(cardId, stepId, { ...payload, reason }, ctx);
}
export async function buildEmptyTemplateFile(cardId) {
  loadCard(cardId);
  const { default: XLSX } = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Process Steps');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function field(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function parseJsonColumn(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new ServiceError(CODE.VALIDATION, `${label} 不是合法 JSON`);
  }
}

function rowToStep(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new ServiceError(CODE.VALIDATION, '记录不是合法的结构化对象');
  }
  return {
    seq: field(row, 'seq', 'seq'),
    skill: field(row, 'skill', 'skill'),
    refDocId: field(row, 'ref_doc_id', 'refDocId'),
    descriptionZh: field(row, 'description_zh', 'descriptionZh'),
    descriptionEn: field(row, 'description_en', 'descriptionEn'),
    safetyWarning: field(row, 'safety_warning', 'safetyWarning'),
    visualCue: parseJsonColumn(field(row, 'visual_cue', 'visualCue'), 'visual_cue', null),
    repairTips: field(row, 'repair_tips', 'repairTips'),
    isCritical: field(row, 'is_critical', 'isCritical') ?? 0,
    captureItems: parseJsonColumn(field(row, 'capture_items', 'captureItems'), 'capture_items', []),
    components: parseJsonColumn(field(row, 'components', 'components'), 'components', []),
    signatureRequirements: parseJsonColumn(
      field(row, 'signature_requirements', 'signatureRequirements'),
      'signature_requirements',
      [],
    ),
  };
}

export async function importSteps(cardId, fileBuffer, ctx) {
  assertEditableCard(cardId, 'stepCreate');
  const { parseExcelRows } = await import('./migrationService.js');
  const rows = parseExcelRows(fileBuffer);
  const records = rows.map((row, index) => {
    try {
      const step = createStep(cardId, rowToStep(row), ctx);
      return { rowNo: index + 1, status: 'success', stepId: step.id, processId: step.processId,
        failureReason: null };
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      return { rowNo: index + 1, status: 'failed', stepId: null, processId: null,
        failureReason: error.message };
    }
  });
  const successCount = records.filter((record) => record.status === 'success').length;
  return {
    successCount,
    failureCount: records.length - successCount,
    totalCount: records.length,
    records,
  };
}

export function getProcessData(query) {
  const row = processDataRepo.findOne(query?.pid ?? null, query?.cardId ?? null, query?.stepId ?? null);
  if (row === null) return null;
  return {
    partNo: row.partNo,
    partSn: row.partSn,
    partDesc: row.partDesc,
    operationType: row.operationType,
    operation: row.operation,
  };
}

export default {
  createStep, saveStep, deleteStep, reorderSteps,
  addSignature, deleteSignature, listSignatures, updateSafety,
  listTemplates, createTemplate, applyTemplate,
  buildEmptyTemplateFile, importSteps, getProcessData,
};
