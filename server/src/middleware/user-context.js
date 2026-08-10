/**
 * DEMO AUTHENTICATION SUBSTITUTE ONLY.
 * This identity mechanism has no passwords, session expiry, or transport encryption. Replacing it
 * with enterprise authentication affects only this middleware and POST /api/session; service-layer
 * and domain functions remain unchanged.
 */

import { CODE, sendFail } from '../lib/response.js';
import appUserRepo from '../repositories/appUserRepo.js';

/** Process-local opaque token -> staff number sessions. Restarting the server clears all sessions. */
export const tokenToStaffNo = new Map();

export function registerSession(token, staffNo) {
  tokenToStaffNo.set(token, staffNo);
}

export function revokeSession(token) {
  return tokenToStaffNo.delete(token);
}

export function clearSessions() {
  tokenToStaffNo.clear();
}

export function parseBearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization.trim());
  return match?.[1] ?? null;
}

function isActive(user) {
  return user?.isActive === 1 || user?.isActive === true;
}

function isPublicSessionCreation(req) {
  if (req.method !== 'POST') return false;
  const path = (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
  return path === '/api/session' || path === '/session';
}
/**
 * Build middleware with injectable dependencies for focused tests and later application assembly.
 * POST /api/session is the sole public identity endpoint; every other path requires a live session.
 */
export function createUserContext({ sessions = tokenToStaffNo, findByStaffNo = appUserRepo.findByStaffNo } = {}) {
  return function userContextMiddleware(req, res, next) {
    if (isPublicSessionCreation(req)) return next();

    const token = parseBearerToken(req.get('authorization'));
    const staffNo = token === null ? null : sessions.get(token);
    if (staffNo === null || staffNo === undefined) {
      return sendFail(res, CODE.UNAUTHENTICATED, '缺少或无效的身份令牌');
    }

    const user = findByStaffNo(staffNo);
    if (!isActive(user)) {
      sessions.delete(token);
      return sendFail(res, CODE.UNAUTHENTICATED, '身份不存在或已停用');
    }

    req.user = user;
    req.authToken = token;
    return next();
  };
}

export const userContext = createUserContext();
export default userContext;