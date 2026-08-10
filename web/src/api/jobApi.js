import http from './http.js';
import { segment } from './path.js';

const processPath = (id) => `/job-processes/${segment(id)}`;

export const jobApi = {
  get: (jobNo) => http.get(`/jobs/${segment(jobNo)}`),
  listProcesses: (jobNo) => http.get(`/jobs/${segment(jobNo)}/processes`),
  startProcess: (id, data = {}) => http.post(`${processPath(id)}/start`, data),
  finishProcess: (id, data = {}) => http.post(`${processPath(id)}/finish`, data),
  updateManhours: (id, data) => http.put(`${processPath(id)}/manhours`, data),
  acknowledgeSafety: (id, data = {}) => http.post(`${processPath(id)}/safety-ack`, data),
};
