import express from 'express';

import { CODE, sendFail } from './lib/response.js';
import { ServiceError, translateSqliteError } from './lib/service-error.js';
import userContext from './middleware/user-context.js';
import { createAccessDenialsRouter } from './routes/access-denials.js';
import { createSessionRouter } from './routes/session.js';
import { createTask20Router } from './routes/task-20.js';
import { createTaskCardsRouter } from './routes/task-cards.js';
import { createProcessStepsRouter } from './routes/process-steps.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createJobsRouter } from './routes/jobs.js';

const alreadyProtected = (_req, _res, next) => next();

/**
 * Current routers declare authorization policy themselves. Identity is applied once, globally, so
 * router factories receive a pass-through `protect` middleware to avoid duplicate database lookups.
 */
export function createCurrentApiRouters() {
  return [
    createSessionRouter({ protect: alreadyProtected }),
    createAccessDenialsRouter({ protect: alreadyProtected }),
    createTask20Router({ protect: alreadyProtected }),
    createTaskCardsRouter({ protect: alreadyProtected }),
    createProcessStepsRouter({ protect: alreadyProtected }),
    createAttachmentsRouter({ protect: alreadyProtected }),
    createJobsRouter({ protect: alreadyProtected }),
  ];
}

export function createErrorHandler({ logger = console } = {}) {
  return function errorHandler(error, _req, res, next) {
    if (res.headersSent) return next(error);

    const translated = translateSqliteError(error);
    if (translated instanceof ServiceError) {
      return sendFail(res, translated.code, translated.message, translated.data);
    }

    logger.error('[http] 未捕获异常', error);
    return sendFail(res, CODE.INTERNAL);
  };
}

/**
 * Build the Express application without opening a database connection or network listener.
 * Repositories remain lazy; the startup entrypoint owns migration, seeding, and `listen()`.
 */
export function createApp({
  identity = userContext,
  apiRouters = createCurrentApiRouters(),
  additionalApiRouters = [],
  logger = console,
} = {}) {
  const application = express();

  application.use(express.json());
  application.use(identity);

  for (const router of [...apiRouters, ...additionalApiRouters]) {
    application.use('/api', router);
  }

  application.use((_req, res) => sendFail(res, CODE.NOT_FOUND));
  application.use(createErrorHandler({ logger }));

  return application;
}

export const app = createApp();
export default app;
