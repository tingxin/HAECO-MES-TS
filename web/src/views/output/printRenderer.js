const HTML_ESCAPE = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

export function escapePrintValue(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

function valueAt(context, root, path) {
  const key = String(path || '').trim();
  if (key === 'this') return context;
  const read = (source) => key.split('.').reduce((value, part) => value?.[part], source);
  const local = read(context);
  return local === undefined ? read(root) : local;
}

function matchingEachEnd(template, startIndex) {
  const token = /{{#each\s+[\w.]+}}|{{\/each}}/g;
  token.lastIndex = startIndex;
  let depth = 1;
  let match;
  while ((match = token.exec(template))) {
    if (match[0].startsWith('{{#each')) depth += 1;
    else depth -= 1;
    if (depth === 0) return { start: match.index, end: token.lastIndex };
  }
  return null;
}

function renderBlock(template, context, root) {
  const startPattern = /{{#each\s+([\w.]+)}}/g;
  let output = '';
  let cursor = 0;
  let match;
  while ((match = startPattern.exec(template))) {
    const closing = matchingEachEnd(template, startPattern.lastIndex);
    if (!closing) break;
    output += template.slice(cursor, match.index);
    const rows = valueAt(context, root, match[1]);
    const inner = template.slice(startPattern.lastIndex, closing.start);
    output += (Array.isArray(rows) ? rows : []).map((row) => renderBlock(inner, row, root)).join('');
    cursor = closing.end;
    startPattern.lastIndex = closing.end;
  }
  output += template.slice(cursor);
  return output.replace(/{{\s*([\w.]+)\s*}}/g, (_token, path) => escapePrintValue(valueAt(context, root, path)));
}

function safeTemplate(templateBody) {
  return String(templateBody || '')
    // Backward compatibility for the original seeded template: keep its layout while binding
    // execution-only values from the current print projection instead of rendering an object or labels.
    .replace(/{{\s*manHours\s*}}/g, '{{manHours.actual}}')
    .replace(/<td>Signature<\/td>\s*<td>Stamp<\/td>\s*<td>Date<\/td>/g, '<td>{{signedBy}}</td><td>{{stampId}}</td><td>{{signedAt}}</td>')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/javascript:/gi, '');
}

function fallbackTemplate() {
  return `<section class="task-card-print">
    <header><h1>{{organizationName}}</h1><h2>{{taskNo}} Rev.{{revisionLabel}}</h2></header>
    <p>{{title}}</p><table><tr><th>Estimated Man Hours</th><td>{{manHours.estimated}}</td><th>Actual Man Hours</th><td>{{manHours.actual}}</td><th>Start</th><td>{{startTime}}</td><th>Finish</th><td>{{finishTime}}</td></tr></table>
    <ol class="steps">{{#each steps}}<li><h3>{{processId}}</h3><p>{{descriptionZh}}</p><p>{{descriptionEn}}</p>
    <table><tr><th>Estimated Man Hours</th><td>{{manHours.estimated}}</td><th>Actual Man Hours</th><td>{{manHours.actual}}</td><th>Start</th><td>{{startTime}}</td><th>Finish</th><td>{{finishTime}}</td></tr>
    {{#each signatures}}<tr><th>{{signatureRole}}</th><td>{{signedBy}}</td><td>{{stampId}}</td><td>{{signedAt}}</td></tr>{{/each}}</table></li>{{/each}}</ol>
  </section>`;
}

function safeImageUrl(value) {
  const url = String(value ?? '').trim();
  return /^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(url) ? escapePrintValue(url) : '';
}
function annotationSvg(annotations) {
  const shapes = (Array.isArray(annotations) ? annotations : []).map((item) => {
    const points = (item.points || item.path || []).map((point) => Array.isArray(point) ? point : [point.x, point.y]);
    const at = (index) => ({ x: Number(points[index]?.[0] || 0) * 100, y: Number(points[index]?.[1] || 0) * 100 });
    const a = at(0); const b = at(points.length - 1); const color = escapePrintValue(item.color || '#f56c6c');
    if (['rect', 'rectangle'].includes(item.type)) return `<rect x="${Math.min(a.x,b.x)}" y="${Math.min(a.y,b.y)}" width="${Math.abs(b.x-a.x)}" height="${Math.abs(b.y-a.y)}" fill="none" stroke="${color}"/>`;
    if (item.type === 'arrow') return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" marker-end="url(#print-arrow)"/>`;
    if (item.type === 'text') return `<text x="${a.x}" y="${a.y}" fill="${color}" font-size="4">${escapePrintValue(item.text)}</text>`;
    return `<polyline points="${points.map(([x,y]) => `${Number(x)*100},${Number(y)*100}`).join(' ')}" fill="none" stroke="${color}"/>`;
  }).join('');
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><defs><marker id="print-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 z"/></marker></defs>${shapes}</svg>`;
}
function rowsTable(title, items, fields) {
  const rows = items.flatMap((item) => Array.isArray(item.rows) ? item.rows : []);
  if (!rows.length) return '';
  return `<section><h4>${title}</h4><table><thead><tr>${fields.map(([,label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${fields.map(([key]) => `<td>${escapePrintValue(row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`;
}
function componentSupplement(model) {
  const sections = (model.steps || []).map((step) => {
    const tools = rowsTable('Tools / 工具', step.tools || [], [['partNo','Part No.'],['description','Description']]);
    const consumables = rowsTable('Consumables / 耗材', step.consumables || [], [['partNo','Part No.'],['description','Description'],['qty','Qty'],['category','Category']]);
    const sketches = (step.sketches || []).map((image) => {
      const url = safeImageUrl(image.url); if (!url) return '';
      return `<figure class="annotated-image"><img src="${url}" alt="${escapePrintValue(image.name || 'Process image')}"/>${annotationSvg(image.annotations)}</figure>`;
    }).join('');
    return tools || consumables || sketches ? `<section class="component-supplement"><h3>${escapePrintValue(step.processId)}</h3>${tools}${consumables}${sketches}</section>` : '';
  }).join('');
  return sections;
}

export function renderPrintTriple(triple) {
  if (!triple || typeof triple !== 'object' || !triple.model || typeof triple.model !== 'object') {
    throw new TypeError('打印接口须返回 {templateId, templateBody, model} 三元组');
  }
  const { cardType: _cardType, card_type: _cardTypeSnake, ...printModel } = triple.model;
  const template = safeTemplate(triple.templateBody) || fallbackTemplate();
  return `<article class="print-sheet" data-template-id="${escapePrintValue(triple.templateId)}">${renderBlock(template, printModel, printModel)}${componentSupplement(printModel)}</article>`;
}

export function createPrintDocument(triples) {
  const list = Array.isArray(triples) ? triples : [triples];
  const sheets = list.map(renderPrintTriple).join('');
  return `<!doctype html><html><head><meta charset="UTF-8"><title>工卡打印</title><style>
    @page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;color:#111;font:12px Arial,"Microsoft YaHei",sans-serif}
    .print-sheet{min-height:270mm;break-after:page}.print-sheet:last-child{break-after:auto}header{text-align:center}h1{font-size:18px}h2{font-size:15px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #222;padding:5px;text-align:left}.steps>li{margin:10px 0}
    .component-supplement{break-inside:avoid}.annotated-image{position:relative;display:inline-block;max-width:100%;margin:8px 0}.annotated-image img{display:block;max-width:100%;max-height:120mm}.annotated-image svg{position:absolute;inset:0;width:100%;height:100%}.annotated-image rect,.annotated-image line,.annotated-image polyline{stroke-width:1.5;vector-effect:non-scaling-stroke}
  </style></head><body>${sheets}</body></html>`;
}

export function printTriples(triples, openWindow = globalThis.open) {
  const popup = openWindow?.('', '_blank');
  if (!popup) throw new Error('浏览器阻止了打印窗口，请允许弹窗后重试');
  popup.document.open();
  popup.document.write(createPrintDocument(triples));
  popup.document.close();
  popup.document.title = '工卡打印';
  popup.focus?.();
  popup.print?.();
  return popup;
}
