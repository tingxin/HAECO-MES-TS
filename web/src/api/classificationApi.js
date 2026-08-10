import http from './http.js';
import { segment } from './path.js';

const path = (cardId) => `/task-cards/${segment(cardId)}/classification`;

export const classificationApi = {
  latest: (cardId) => http.get(`${path(cardId)}/latest`),
  history: (cardId) => http.get(`${path(cardId)}/history`),
  derive: (cardId, data = {}) => http.post(`${path(cardId)}/derive`, data),
  confirm: (cardId, data) => http.post(`${path(cardId)}/confirm`, data),
};
