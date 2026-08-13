const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const text = (value) => value == null ? '' : String(value);
const first = (source, keys) => keys.map((key) => source?.[key]).find((value) => value !== undefined);

function point(value) {
  if (Array.isArray(value)) return [Number(value[0]), Number(value[1])];
  return [Number(value?.x), Number(value?.y)];
}
function normalizedPoint(value) {
  const [x, y] = point(value);
  return [Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)), Math.max(0, Math.min(1, Number.isFinite(y) ? y : 0))];
}

export function normalizeAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const type = ({ rectangle: 'rect', freehand: 'pen' })[item?.type] || item?.type;
    const points = (item?.points || item?.path || []).map(normalizedPoint);
    return {
      id: item?.id || `annotation-${index + 1}`,
      type: ['rect', 'pen', 'arrow', 'text'].includes(type) ? type : 'pen',
      points,
      color: text(item?.color || '#f56c6c'),
      ...(type === 'text' ? { text: text(item?.text) } : {}),
    };
  }).filter(({ points }) => points.length > 0);
}

function legacyRow(type, source) {
  if (type === 'tool') {
    const partNo = first(source, ['partNo', 'toolPn', 'part_no', 'code', 'name']);
    const description = first(source, ['description', 'toolDesc', 'desc', 'details']);
    return partNo === undefined && description === undefined ? null : { partNo: text(partNo), description: text(description) };
  }
  const partNo = first(source, ['partNo', 'materialNo', 'part_no', 'name']);
  const description = first(source, ['description', 'desc', 'details']);
  const qty = first(source, ['qty', 'quantity']);
  const category = first(source, ['category', 'unit']);
  return [partNo, description, qty, category].every((value) => value === undefined) ? null : {
    partNo: text(partNo), description: text(description), qty: text(qty), category: text(category),
  };
}

export function structuredPayload(type, payload = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? clone(payload) : {};
  if (type === 'image') {
    const result = {};
    for (const key of ['attachmentId', 'url', 'mimeType', 'name']) {
      const value = source[key] ?? (key === 'attachmentId' ? source.attachment_id : undefined);
      if (value !== undefined && !(/^data:image\/[^;]+;base64,/i.test(String(value)))) result[key] = value;
    }
    result.annotations = normalizeAnnotations(source.annotations);
    return result;
  }
  if (!['tool', 'consumable'].includes(type)) return source;
  const fields = type === 'tool' ? ['partNo', 'description'] : ['partNo', 'description', 'qty', 'category'];
  const sourceRows = Array.isArray(source.rows) ? source.rows : [legacyRow(type, source)].filter(Boolean);
  return { rows: sourceRows.map((row) => Object.fromEntries(fields.map((field) => [field, text(row?.[field])])) ) };
}

export function normalizeComponent(component) {
  return { ...clone(component), payload: structuredPayload(component?.type, component?.payload) };
}

export function hasStructuredTable(components, type) {
  return (components || []).some((component) => component?.type === type);
}
