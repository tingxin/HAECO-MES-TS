import axios from 'axios';
import { getSessionToken } from '../auth/token.js';

const errorHandlers = {
  onUnauthorized: () => {},
  onForbidden: () => {},
};

export class ApiError extends Error {
  constructor(message, { code = null, status = 0, data = null, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export function configureHttpErrorHandlers(handlers = {}) {
  if (typeof handlers.onUnauthorized === 'function') errorHandlers.onUnauthorized = handlers.onUnauthorized;
  if (typeof handlers.onForbidden === 'function') errorHandlers.onForbidden = handlers.onForbidden;
}

function isBinaryResponse(response) {
  const responseType = response.config?.responseType;
  return responseType === 'blob'
    || responseType === 'arraybuffer'
    || response.data instanceof Blob
    || response.data instanceof ArrayBuffer;
}

function isEnvelope(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.prototype.hasOwnProperty.call(payload, 'code');
}

async function decodeErrorPayload(response) {
  const payload = response?.data;
  const contentType = String(response?.headers?.['content-type'] ?? '');
  if (payload instanceof Blob && contentType.includes('json')) {
    try { return JSON.parse(await payload.text()); } catch { return payload; }
  }
  if (payload instanceof ArrayBuffer && contentType.includes('json')) {
    try { return JSON.parse(new TextDecoder().decode(payload)); } catch { return payload; }
  }
  return payload;
}
async function notifyStatus(status, error) {
  if (status === 401) await errorHandlers.onUnauthorized(error);
  if (status === 403) await errorHandlers.onForbidden(error);
}

export const http = axios.create({
  baseURL: '/api',
  timeout: 30_000,
});

http.interceptors.request.use((config) => {
  const token = getSessionToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  async (response) => {
    if (isBinaryResponse(response)) return response.data;
    const payload = response.data;
    if (!isEnvelope(payload)) return payload;
    if (Number(payload.code) === 0) return payload.data;

    const status = response.status >= 400 ? response.status : Number(payload.code) || response.status;
    const error = new ApiError(payload.message || '请求失败', {
      code: payload.code,
      status,
      data: payload.data,
    });
    await notifyStatus(status, error);
    throw error;
  },
  async (cause) => {
    const response = cause.response;
    const payload = await decodeErrorPayload(response);
    const status = response?.status ?? 0;
    const code = isEnvelope(payload) ? payload.code : status || null;
    const error = new ApiError(
      (isEnvelope(payload) && payload.message) || cause.message || '网络请求失败',
      { code, status, data: isEnvelope(payload) ? payload.data : payload, cause },
    );
    await notifyStatus(status, error);
    throw error;
  },
);

export default http;
