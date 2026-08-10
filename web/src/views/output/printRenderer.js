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

export function renderPrintTriple(triple) {
  if (!triple || typeof triple !== 'object' || !triple.model || typeof triple.model !== 'object') {
    throw new TypeError('打印接口须返回 {templateId, templateBody, model} 三元组');
  }
  const { cardType: _cardType, card_type: _cardTypeSnake, ...printModel } = triple.model;
  const template = safeTemplate(triple.templateBody) || fallbackTemplate();
  return `<article class="print-sheet" data-template-id="${escapePrintValue(triple.templateId)}">${renderBlock(template, printModel, printModel)}</article>`;
}

export function createPrintDocument(triples) {
  const list = Array.isArray(triples) ? triples : [triples];
  const sheets = list.map(renderPrintTriple).join('');
  return `<!doctype html><html><head><meta charset="UTF-8"><title>工卡打印</title><style>
    @page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;color:#111;font:12px Arial,"Microsoft YaHei",sans-serif}
    .print-sheet{min-height:270mm;break-after:page}.print-sheet:last-child{break-after:auto}header{text-align:center}h1{font-size:18px}h2{font-size:15px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #222;padding:5px;text-align:left}.steps>li{margin:10px 0}
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
