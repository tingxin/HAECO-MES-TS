import { Router } from 'express';
import { CODE, sendFail, sendOk } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import authorize from '../middleware/authorize.js';
import userContext from '../middleware/user-context.js';
import accessDenialLogRepo from '../repositories/accessDenialLogRepo.js';

/** Existing management permission used for cross-user/all-log audit reads. */
export const ACCESS_DENIAL_AUDIT_PERMISSION = 'config_write';

function textQuery(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ServiceError(CODE.VALIDATION, `${label} 必须为正整数`);
  }
  return number;
}

function queryRequestsAuditAccess(req) {
  const scope = textQuery(req.query.scope) || 'self';
  const staffNo = textQuery(req.query.staffNo);
  return scope === 'all' || (staffNo !== '' && staffNo !== req.user?.staffNo);
}

function respondToRouteError(error, res, next) {
  if (error instanceof ServiceError) {
    return sendFail(res, error.code, error.message, error.data);
  }
  return next(error);
}

/** GET /api/access-denials: own denials by default; config_write readers may query all/another user. */
export function getAccessDenials(req, res, next) {
  try {
    const scope = textQuery(req.query.scope) || 'self';
    const requestedStaffNo = textQuery(req.query.staffNo);
    if (!['self', 'all'].includes(scope)) {
      throw new ServiceError(CODE.VALIDATION, 'scope 仅支持 self 或 all');
    }
    if (scope === 'all' && requestedStaffNo !== '') {
      throw new ServiceError(CODE.VALIDATION, 'scope=all 时不可同时指定 staffNo');
    }

    const page = positiveInt(req.query.page, 1, 'page');
    const pageSize = positiveInt(req.query.pageSize, 20, 'pageSize');
    if (scope === 'all') {
      return sendOk(res, accessDenialLogRepo.listAll({ page, pageSize }));
    }

    const staffNo = requestedStaffNo || req.user.staffNo;
    const rows = accessDenialLogRepo.listByUserId(staffNo);
    const start = (page - 1) * pageSize;
    return sendOk(res, {
      list: rows.slice(start, start + pageSize),
      total: rows.length,
      page,
      pageSize,
      staffNo,
    });
  } catch (error) {
    return respondToRouteError(error, res, next);
  }
}

/**
 * Paths are relative to /api. Authentication permits self-query; cross-user/all-log query declares
 * ACCESS_DENIAL_AUDIT_PERMISSION so later app assembly need not duplicate authorization policy.
 */
export function createAccessDenialsRouter({
  protect = userContext,
  authorizePermission = authorize,
} = {}) {
  const router = Router();
  const authorizeAuditRead = authorizePermission(ACCESS_DENIAL_AUDIT_PERMISSION);
  const auditQueryGate = (req, res, next) =>
    queryRequestsAuditAccess(req) ? authorizeAuditRead(req, res, next) : next();

  router.get('/access-denials', protect, auditQueryGate, getAccessDenials);
  return router;
}

export const accessDenialsRouter = createAccessDenialsRouter();
export default accessDenialsRouter;
