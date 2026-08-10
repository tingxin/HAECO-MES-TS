export const COMPONENT_LABELS = Object.freeze({
  measurement: '测量值', table: '表格', text: '文本', tool: '设备/工具',
  image: '图片', video: '视频', audio: '音频', range: '测量范围',
  consumable: '耗材', time: '时间', dataGroup: '数据组', custom: '自定义选项',
  signature: '签署栏',
});

export function componentLabel(type) {
  return COMPONENT_LABELS[type] ?? type;
}

export function newComponent(type, sortOrder = 1) {
  const payloads = {
    measurement: { label: '', unit: '' }, table: { columns: [], rows: [] },
    text: { content: '' }, tool: { name: '', details: '' }, image: {}, video: {}, audio: {},
    range: { min: null, max: null, unit: '' }, consumable: { name: '', details: '' },
    time: { label: '', format: 'HH:mm' }, dataGroup: { name: '' },
    custom: { label: '', options: [] }, signature: { label: 'Staff Signature / Stamp / Date' },
  };
  return { type, payload: structuredClone(payloads[type] ?? {}), sortOrder };
}
