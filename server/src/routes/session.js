/**
 * DEMO AUTHENTICATION SUBSTITUTE ONLY.
 * This identity mechanism has no passwords, session expiry, or transport encryption. Replacing it
 * with enterprise authentication affects only user-context middleware and POST /api/session;
 * service-layer and domain functions remain unchanged.
 */

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { CODE, sendFail, sendOk } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import userContext, {
  registerSession,
  revokeSession,
  tokenToStaffNo,
} from '../middleware/user-context.js';
import appUserRepo from '../repositories/appUserRepo.js';
import rolePermissionRepo from '../repositories/rolePermissionRepo.js';

const TOKEN_BYTES = 32;

function publicUser(user) {
  return { staffNo: user.staffNo, name: user.name, role: user.role };
}

function active(user) {
  return user?.isActive === 1 || user?.isActive === true;
}

/** Generate a cryptographically random, URL-safe opaque token (256 bits). */
export function generateSessionToken() {
  let token;
  do {
    token = randomBytes(TOKEN_BYTES).toString('base64url');
  } while (tokenToStaffNo.has(token));
  return token;
}

function respondToRouteError(error, res, next) {
  if (error instanceof ServiceError) {
    return sendFail(res, error.code, error.message, error.data);
  }
  return next(error);
}
export function postSession(req, res, next) {
  try {
    const staffNo = typeof req.body?.staffNo === 'string' ? req.body.staffNo.trim() : '';
    if (staffNo === '') {
      throw new ServiceError(CODE.VALIDATION, 'staffNo 为必填项');
    }

    const user = appUserRepo.findByStaffNo(staffNo);
    if (!active(user)) {
      throw new ServiceError(CODE.UNAUTHENTICATED, '用户不存在或已停用');
    }

    const token = generateSessionToken();
    registerSession(token, user.staffNo);
    return sendOk(res, { token, user: publicUser(user) });
  } catch (error) {
    return respondToRouteError(error, res, next);
  }
}

export function deleteSession(req, res, next) {
  try {
    if (!req.authToken) {
      throw new ServiceError(CODE.UNAUTHENTICATED, '缺少或无效的身份令牌');
    }
    revokeSession(req.authToken);
    return sendOk(res, null);
  } catch (error) {
    return respondToRouteError(error, res, next);
  }
}

export function getMe(req, res) {
  return sendOk(res, publicUser(req.user));
}

export function getMyPermissions(req, res) {
  const permissions = rolePermissionRepo
    .listByRole(req.user.role)
    .filter((entry) => entry.allowed === 1 || entry.allowed === true)
    .map((entry) => entry.permissionPoint);
  return sendOk(res, permissions);
}

/** Router paths are relative to `/api`; protected handlers include the context middleware. */
export function createSessionRouter({ protect = userContext } = {}) {
  const router = Router();
  router.post('/session', postSession);
  router.delete('/session', protect, deleteSession);
  router.get('/me', protect, getMe);
  router.get('/me/permissions', protect, getMyPermissions);
  return router;
}

export const sessionRouter = createSessionRouter();
export default sessionRouter;