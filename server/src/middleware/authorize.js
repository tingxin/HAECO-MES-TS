import { checkPermission, explainPermission, isKnownPermissionPoint } from '../domain/permission.js';
import { CODE, sendFail } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import accessDenialLogRepo from '../repositories/accessDenialLogRepo.js';
import rolePermissionRepo from '../repositories/rolePermissionRepo.js';

function requestPath(req) {
  return (req.originalUrl || req.url || '').split('?')[0];
}

function permissionConfigurationError(role, permissionPoint, reason) {
  return new ServiceError(
    CODE.INTERNAL,
    `权限判定异常（${reason}）：角色=${String(role)}，权限点=${permissionPoint}`,
    { role, permissionPoint, reason },
  );
}

/**
 * Build the route authorization factory with injectable synchronous repositories for focused tests.
 * Runtime authorization always reads the current role_permission table; no permission result is cached.
 */
export function createAuthorize({
  listRolePermissions = rolePermissionRepo.list,
  appendAccessDenial = accessDenialLogRepo.create,
  now = () => new Date().toISOString(),
} = {}) {
  return function authorize(permissionPoint) {
    if (!isKnownPermissionPoint(permissionPoint)) {
      throw new ServiceError(
        CODE.INTERNAL,
        `路由声明了未知权限点：${String(permissionPoint)}`,
        { permissionPoint },
      );
    }

    return function authorizationMiddleware(req, res, next) {
      try {
        const role = req.user?.role ?? null;
        const runtimeConfig = listRolePermissions();

        if (checkPermission(role, permissionPoint, runtimeConfig)) {
          return next();
        }

        const decision = explainPermission(role, permissionPoint, runtimeConfig);
        if (!decision.isAuthorizationDecision) {
          return next(permissionConfigurationError(role, permissionPoint, decision.reason));
        }

        appendAccessDenial({
          staffNo: req.user?.staffNo ?? null,
          role,
          permissionPoint,
          method: req.method,
          path: requestPath(req),
          deniedAt: now(),
        });

        return sendFail(
          res,
          CODE.FORBIDDEN,
          `越权：角色 ${String(role)} 无 ${permissionPoint} 权限`,
        );
      } catch (error) {
        return next(error);
      }
    };
  };
}

export const authorize = createAuthorize();
export default authorize;
