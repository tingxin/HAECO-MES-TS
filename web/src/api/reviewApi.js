import http from './http.js';
import { segment } from './path.js';

const path = (id) => `/task-cards/${segment(id)}`;

export const reviewApi = {
  submit: (id, data = {}) => http.post(`${path(id)}/submit-review`, data),
  approve: (id, reviewComment) => http.post(`${path(id)}/approve`, { reviewComment }),
  reject: (id, reviewComment) => http.post(`${path(id)}/reject`, { reviewComment }),
  list: (id) => http.get(`${path(id)}/reviews`),
};
