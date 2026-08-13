import { serializePayload, parsePayload } from './collections.js';

function stable(value) { return serializePayload(value) ?? 'null'; }
function clone(value) { return parsePayload(stable(value)); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
export function immutableVersionSnapshot(value) { return freeze(clone(value)); }

function withoutIdentity(value) {
  const copy = clone(value);
  if (copy && typeof copy === 'object') {
    delete copy.id; delete copy.cardId; delete copy.stepId;
  }
  return copy;
}
function collectionDiff(before = [], after = [], keyOf) {
  const oldMap = new Map(before.map((item) => [keyOf(item), item]));
  const newMap = new Map(after.map((item) => [keyOf(item), item]));
  const keys = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  const added = [], removed = [], changed = [];
  keys.forEach((key) => {
    const oldValue = oldMap.get(key); const newValue = newMap.get(key);
    if (oldValue === undefined) added.push(clone(newValue));
    else if (newValue === undefined) removed.push(clone(oldValue));
    else if (stable(withoutIdentity(oldValue)) !== stable(withoutIdentity(newValue))) {
      changed.push({ key, before: clone(oldValue), after: clone(newValue) });
    }
  });
  return { added, removed, changed };
}

export function diffVersionSnapshots(previous, selected) {
  if (previous === null || previous === undefined) {
    return freeze({ headerChanges: [], referenceDocuments: { added: [], removed: [], changed: [] },
      steps: { added: [], removed: [], changed: [] } });
  }
  const excluded = new Set(['referenceDocuments', 'steps', 'signatureRequirements', 'relations',
    'changeRecords', 'reviews']);
  const fields = [...new Set([...Object.keys(previous), ...Object.keys(selected)])]
    .filter((key) => !excluded.has(key)).sort();
  const headerChanges = fields.filter((field) => stable(previous[field]) !== stable(selected[field]))
    .map((field) => ({ field, before: clone(previous[field]), after: clone(selected[field]) }));
  const referenceDocuments = collectionDiff(previous.referenceDocuments, selected.referenceDocuments,
    (doc) => `${doc.docType ?? ''}|${doc.refNo ?? ''}`);
  const steps = collectionDiff(previous.steps, selected.steps,
    (step) => String(step.processId ?? step.seq ?? ''));
  return freeze({ headerChanges, referenceDocuments, steps });
}
