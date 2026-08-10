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
  { key: 'revision', label: '版本', visible: true, fixed: false, width: 80 },
]);

export const cloneDefaultColumns = () => DEFAULT_COLUMNS.map((column) => ({ ...column }));

function isValidColumns(value) {
  if (!Array.isArray(value) || value.length !== DEFAULT_COLUMNS.length) return false;
  const known = new Set(DEFAULT_COLUMNS.map(({ key }) => key));
  const found = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || !known.has(item.key) || found.has(item.key)) return false;
    if (typeof item.visible !== 'boolean' || ![false, 'left', 'right'].includes(item.fixed)) return false;
    found.add(item.key);
  }
  return found.size === known.size;
}

export function loadColumns(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return cloneDefaultColumns();
    const parsed = JSON.parse(raw);
    if (!isValidColumns(parsed)) return cloneDefaultColumns();
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