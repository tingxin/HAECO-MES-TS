export const COLUMN_STORAGE_KEY = 'haeco_tc_list_columns';

export const DEFAULT_COLUMNS = Object.freeze([
  { key: 'isFai', label: 'FAI', visible: true, fixed: 'left', width: 76 },
  { key: 'acType', label: 'A/C Type', visible: true, fixed: false, width: 110 },
  { key: 'gearType', label: 'Gear Type', visible: true, fixed: false, width: 110 },
  { key: 'configuration', label: '构型', visible: true, fixed: false, width: 110 },
  { key: 'templateType', label: '模板类型', visible: true, fixed: false, width: 110 },
  { key: 'cardType', label: '工卡类型', visible: true, fixed: false, width: 110 },
  { key: 'taskNo', label: '编号', visible: true, fixed: 'left', width: 160 },
  { key: 'title', label: '标题', visible: true, fixed: false, minWidth: 220 },
  { key: 'status', label: '状态', visible: true, fixed: false, width: 120 },
  { key: 'stage', label: 'Stage', visible: true, fixed: false, width: 100 },
  { key: 'revision', label: 'Revision', visible: true, fixed: false, width: 90 },
  { key: 'revisionDate', label: 'Revision Date', visible: false, fixed: false, width: 120 },
  { key: 'documentType', label: 'Document Type', visible: false, fixed: false, width: 130 },
  { key: 'referenceNo', label: 'Reference No', visible: false, fixed: false, width: 150 },
  { key: 'cmmRevision', label: 'CMM & Revision', visible: false, fixed: false, width: 170 },
]);

export const cloneDefaultColumns = () => DEFAULT_COLUMNS.map((column) => ({ ...column }));

function isValidColumn(item, known, found) {
  return item && typeof item === 'object' && known.has(item.key) && !found.has(item.key)
    && typeof item.visible === 'boolean' && [false, 'left', 'right'].includes(item.fixed);
}

function migrateColumns(value) {
  if (!Array.isArray(value)) return null;
  const known = new Set(DEFAULT_COLUMNS.map(({ key }) => key));
  const found = new Set(); const migrated = [];
  for (const item of value) {
    if (!isValidColumn(item, known, found)) return null;
    found.add(item.key); migrated.push(item);
  }
  if (!migrated.length) return null;
  for (const column of DEFAULT_COLUMNS) if (!found.has(column.key)) migrated.push({ key: column.key, visible: column.visible, fixed: column.fixed });
  return migrated;
}

function isValidColumns(value) {
  return migrateColumns(value)?.length === DEFAULT_COLUMNS.length;
}

export function loadColumns(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return cloneDefaultColumns();
    const parsed = migrateColumns(JSON.parse(raw));
    if (!parsed) return cloneDefaultColumns();
    const defaults = new Map(DEFAULT_COLUMNS.map((column) => [column.key, column]));
    return parsed.map(({ key, visible, fixed }) => ({ ...defaults.get(key), visible, fixed }));
  } catch {
    return cloneDefaultColumns();
  }
}

export function saveColumns(columns, storage = globalThis.localStorage) {
  if (!isValidColumns(columns)) return false;
  try {
    storage?.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns.map(({ key, visible, fixed }) => ({ key, visible, fixed }))));
    return true;
  } catch {
    return false;
  }
}