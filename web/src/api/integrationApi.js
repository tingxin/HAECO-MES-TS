import http from './http.js';
import { segment } from './path.js';

export const integrationApi = {
  searchTpcDocuments: (params) => http.get('/tpc/documents', { params }),
  getPpcProcessData: (params) => http.get('/ppc/process-data', { params }),
  getPpcSchedule: (params) => http.get('/ppc/schedule', { params }),
  getProcessData: (params) => http.get('/process-data', { params }),
  listLotListBases: (lotListRef) => http.get(`/lot-lists/${segment(lotListRef)}/bases`),
  getPidScope: (pid) => http.get(`/pid/${segment(pid)}/scope`),
  getClassificationSources: (cardId) => http.get('/classification-sources', { params: { cardId } }),
  listInProgressPackageRefs: (cardId) => http.get('/work-packages/in-progress-refs', { params: { cardId } }),
};
