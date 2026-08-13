import http from './http.js';
import { segment } from './path.js';

const cardPath = (id) => `/task-cards/${segment(id)}`;

export const taskCardApi = {
  list: (params) => http.get('/task-cards', { params }),
  get: (id, params) => http.get(cardPath(id), { params }),
  listVersions: (id) => http.get(`${cardPath(id)}/versions`),
  getVersionSnapshot: (id, versionId) => http.get(`${cardPath(id)}/versions/${segment(versionId)}/snapshot`),
  getVersionDiff: (id, versionId) => http.get(`${cardPath(id)}/versions/${segment(versionId)}/diff`),
  printVersion: (id, versionId) => http.get(`${cardPath(id)}/versions/${segment(versionId)}/print`),
  checkDuplicate: (params) => http.get('/task-cards/check-duplicate', { params }),
  create: (data) => http.post('/task-cards', data),
  update: (id, data) => http.put(cardPath(id), data),
  addReferenceDocument: (id, data) => http.post(`${cardPath(id)}/reference-docs`, data),
  deleteReferenceDocument: (id, docId, data) => http.delete(`${cardPath(id)}/reference-docs/${segment(docId)}`, { data }),
  bindAttachmentReference: (id, data) => http.post(`${cardPath(id)}/attachment-references`, data),
  copy: (data) => http.post('/task-cards/copy', data),
  adjustCopiedTaskNo: (id, taskNo) => http.patch(`${cardPath(id)}/copied-task-no`, { taskNo }),
  revise: (data) => http.post('/task-cards/revise', data),
  batchReplace: (data) => http.post('/task-cards/batch-replace', data),
  voidCard: (id, data) => http.post(`${cardPath(id)}/void`, data),
  getVoidPrecheck: (id, params) => http.get(`${cardPath(id)}/void-precheck`, { params }),
  listChangeRecords: (id) => http.get(`${cardPath(id)}/change-records`),
  listRelations: (id) => http.get(`${cardPath(id)}/relations`),
  addRelation: (id, data) => http.post(`${cardPath(id)}/relations`, data),
  deleteRelation: (id, relationId) => http.delete(`${cardPath(id)}/relations/${segment(relationId)}`),
  autoLinkRelation: (id, data) => http.post(`${cardPath(id)}/relations/auto`, data),
  syncRelations: (id, data) => http.post(`${cardPath(id)}/relations/sync`, data),
  release: (id, data = {}) => http.post(`${cardPath(id)}/release`, data),
  sign: (id, data) => http.post(`${cardPath(id)}/signatures`, data),
  getArchiveStatus: (id, params) => http.get(`${cardPath(id)}/archive-status`, { params }),
  exportCsv: (ids, mode = 'key') => http.get('/task-cards/export', {
    params: { ids: Array.isArray(ids) ? ids.join(',') : ids, mode }, responseType: 'blob',
  }),
  getPrintModel: (id, params) => http.get(`${cardPath(id)}/print`, { params }),
  getBatchPrintModels: (ids) => http.post('/task-cards/print', { ids }),
};
