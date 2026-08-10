import http from './http.js';
import { segment } from './path.js';

export const execDocApi = {
  copy: (data) => http.post('/exec-documents/copy', data),
  list: (params) => http.get('/exec-documents', { params }),
  get: (id) => http.get(`/exec-documents/${segment(id)}`),
};
