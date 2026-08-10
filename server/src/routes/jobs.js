import { Router } from 'express';

import { sendOk } from '../lib/response.js';
import authorize from '../middleware/authorize.js';
import userContext from '../middleware/user-context.js';
import releaseService from '../services/releaseService.js';
import executionService from '../services/executionService.js';

function route(handler) {
  return function jobRoute(req, res, next) {
    try {
      return handler(req, res);
    } catch (error) {
      return next(error);
    }
  };
}

export const getJob = route((req, res) =>
  sendOk(res, releaseService.getJobDetail(req.params.jobNo)));

export const getJobProcesses = route((req, res) =>
  sendOk(res, releaseService.listJobProcesses(req.params.jobNo)));

export const startJobProcess = route((req, res) =>
  sendOk(res, executionService.startJobProcess(req.params.id, req.user)));

export const finishJobProcess = route((req, res) =>
  sendOk(res, executionService.finishJobProcess(req.params.id, req.user)));

export const writeManHours = route((req, res) =>
  sendOk(res, executionService.writeManHours(req.params.id, req.body, {
    ...req.user,
    method: req.method,
    path: req.originalUrl,
  })));

export const acknowledgeSafety = route((req, res) =>
  sendOk(res, executionService.acknowledgeSafetyWarning(req.params.id, req.user.staffNo)));

export function createJobsRouter({ protect = userContext, authorizePermission = authorize } = {}) {
  const router = Router();
  const allowed = (permission, handler) => [protect, authorizePermission(permission), handler];
  router.get('/jobs/:jobNo/processes', ...allowed('card_read', getJobProcesses));
  router.get('/jobs/:jobNo', ...allowed('card_read', getJob));
  router.post('/job-processes/:id/start', ...allowed('job_exec_write', startJobProcess));
  router.post('/job-processes/:id/finish', ...allowed('job_exec_write', finishJobProcess));
  router.put('/job-processes/:id/manhours', ...allowed('job_exec_write', writeManHours));
  router.post('/job-processes/:id/safety-ack', ...allowed('job_exec_write', acknowledgeSafety));
  return router;
}

export const jobsRouter = createJobsRouter();
export default jobsRouter;