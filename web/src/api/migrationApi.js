import http from './http.js';
import { segment, uploadForm } from './path.js';

export const migrationApi = {
  run: (file, sourceChannel) => http.post('/migrations', uploadForm(file, { sourceChannel })),
  confirm: (data) => http.post('/migrations/confirm', data),
  getReport: (id) => http.get(`/migrations/${segment(id)}/report`),
};
