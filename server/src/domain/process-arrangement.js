import { generateProcessId } from './process-id.js';

export function arrangedSteps(steps) {
  return steps.map((step, index) => ({
    ...step,
    seq: index + 1,
    processId: generateProcessId(null, index + 1),
  }));
}

export function insertAfter(steps, step, afterStepId) {
  const copy = [...steps];
  if (afterStepId === null || afterStepId === undefined || afterStepId === '') copy.push(step);
  else {
    const index = copy.findIndex((entry) => String(entry.id) === String(afterStepId));
    if (index < 0) throw new RangeError('指定的前置工序不存在');
    copy.splice(index + 1, 0, step);
  }
  return arrangedSteps(copy);
}

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

export function cloneStepAggregate(source) {
  const result = clone(source);
  for (const key of ['id', 'cardId', 'card_id', 'processId', 'process_id', 'seq']) delete result[key];
  for (const key of ['captureItems', 'components', 'signatureRequirements']) {
    result[key] = (result[key] ?? []).map((entry) => {
      const child = clone(entry);
      for (const identity of ['id', 'stepId', 'step_id', 'cardId', 'card_id']) delete child[identity];
      return child;
    });
  }
  return result;
}
