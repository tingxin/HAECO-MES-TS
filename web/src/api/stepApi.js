import http from './http.js';
import { segment, uploadForm } from './path.js';

const card = (id) => `/task-cards/${segment(id)}`;
const step = (id, stepId) => `${card(id)}/steps/${segment(stepId)}`;

export const stepApi = {
  create: (cardId, data) => http.post(`${card(cardId)}/steps`, data),
  copy: (cardId, stepId, data) => http.post(`${step(cardId, stepId)}/copy`, data),
  update: (cardId, stepId, data) => http.put(step(cardId, stepId), data),
  remove: (cardId, stepId, data) => http.delete(step(cardId, stepId), { data }),
  reorder: (cardId, data) => http.post(`${card(cardId)}/steps/reorder`, data),
  updateSafety: (cardId, stepId, data) => http.put(`${step(cardId, stepId)}/safety`, data),
  addSignatureRequirement: (cardId, stepId, data) => http.post(`${step(cardId, stepId)}/signature-requirements`, data),
  deleteSignatureRequirement: (cardId, stepId, reqId, data) => http.delete(`${step(cardId, stepId)}/signature-requirements/${segment(reqId)}`, { data }),
  listSignatureRequirements: (cardId) => http.get(`${card(cardId)}/signature-requirements`),
  listTemplates: () => http.get('/step-templates'),
  createTemplate: (data) => http.post('/step-templates', data),
  applyTemplate: (cardId, stepId, data) => http.post(`${step(cardId, stepId)}/apply-template`, data),
  downloadImportTemplate: (cardId) => http.get(`${card(cardId)}/steps/template-file`, { responseType: 'blob' }),
  importSteps: (cardId, file, options = {}) => http.post(`${card(cardId)}/steps/import`, uploadForm(file, {
    mode: options.mode || 'append', ...(options.reason ? { reason: options.reason } : {}),
  })),
};
