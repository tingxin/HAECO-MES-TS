import http from './http.js';
import { segment } from './path.js';

export const configApi = {
  getEnums: () => http.get('/enums'),
  getStageConstraints: () => http.get('/stage-constraints'),
  updateStageConstraints: (data) => http.put('/stage-constraints', data),
  getCommercialMap: () => http.get('/card-type-commercial-map'),
  updateCommercialMap: (data) => http.put('/card-type-commercial-map', data),
  getDerivationPriority: () => http.get('/derivation-priority'),
  updateDerivationPriority: (data) => http.put('/derivation-priority', data),
  getCapabilities: () => http.get('/capabilities'),
  updateCapabilities: (data) => http.put('/capabilities', data),
  getPrintTemplates: () => http.get('/print-templates'),
  updatePrintTemplate: (id, data) => http.put(`/print-templates/${segment(id)}`, data),
  getSystemParameters: () => http.get('/system-parameters'),
};
