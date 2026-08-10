import http from './http.js';
import { segment, uploadForm } from './path.js';

export const attachmentApi = {
  upload: (file) => http.post('/attachments', uploadForm(file)),
  download: (id) => http.get(`/attachments/${segment(id)}`, { responseType: 'blob' }),
  remove: (id) => http.delete(`/attachments/${segment(id)}`),
};
