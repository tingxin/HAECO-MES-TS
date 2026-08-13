function cellText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

export function mapSimplifiedRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Excel 行必须为数组');
  const mapped = [];
  rows.forEach((row, index) => {
    if (!Array.isArray(row)) throw new TypeError(`第 ${index + 1} 行不是双列记录`);
    const descriptionZh = cellText(row[0]);
    const inspectionItem = cellText(row[1]);
    const isHeader = mapped.length === 0
      && descriptionZh.trim().toLowerCase() === 'step'
      && inspectionItem.trim().toLowerCase() === 'inspection item';
    if (isHeader || (descriptionZh.trim() === '' && inspectionItem.trim() === '')) return;
    if (descriptionZh.trim() === '') throw new TypeError(`第 ${index + 1} 行缺少工序步骤`);
    mapped.push({
      rowNo: index + 1,
      descriptionZh,
      captureItems: inspectionItem.trim() === '' ? [] : [{
        type: 'text', itemKey: 'INSPECTION_ITEM', label: 'Inspection Item',
        config: { value: inspectionItem }, required: false, sortOrder: 1,
      }],
    });
  });
  if (mapped.length === 0) throw new TypeError('导入文件没有有效工序');
  return mapped;
}

export function applyImportMode(existing, imported, mode = 'append') {
  if (!['append', 'replace'].includes(mode)) throw new TypeError('导入模式须为 append 或 replace');
  if (!Array.isArray(imported) || imported.length === 0) throw new TypeError('导入文件没有有效工序');
  return mode === 'replace' ? [...imported] : [...existing, ...imported];
}
