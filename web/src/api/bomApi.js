import http from './http.js';
import { segment } from './path.js';

const path = (cardId) => `/task-cards/${segment(cardId)}`;

export const bomApi = {
  listLotLinks: (cardId) => http.get(`${path(cardId)}/lot-links`),
  addLotLink: (cardId, data) => http.post(`${path(cardId)}/lot-links`, data),
  deleteLotLink: (cardId, linkId) => http.delete(`${path(cardId)}/lot-links/${segment(linkId)}`),
  listBases: (cardId) => http.get(`${path(cardId)}/bom-bases`),
};
