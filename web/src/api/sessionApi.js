import http from './http.js';

export const sessionApi = {
  create: (staffNo) => http.post('/session', { staffNo }),
  remove: () => http.delete('/session'),
  getMe: () => http.get('/me'),
  getPermissions: () => http.get('/me/permissions'),
  listAccessDenials: (params) => http.get('/access-denials', { params }),
};
