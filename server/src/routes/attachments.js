import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';

import { CODE, sendOk } from '../lib/response.js';
import { ServiceError } from '../lib/service-error.js';
import authorize from '../middleware/authorize.js';
import userContext from '../middleware/user-context.js';
import attachmentService from '../services/attachmentService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

function route(handler) {
  return function attachmentRoute(req, res, next) {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

function uploadFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? '文件大小超限（最大允许 100MB）'
        : error.message;
      return next(new ServiceError(CODE.VALIDATION, message));
    }
    return next();
  });
}

function requireFile(req) {
  if (!req.file?.buffer) throw new ServiceError(CODE.VALIDATION, '请上传 file 字段');
  return req.file;
}

function safeDisplayName(value, fallback) {
  const base = path.basename(typeof value === 'string' && value.trim() !== '' ? value : fallback);
  return base.replace(/[\u0000-\u001f\u007f"\\/]/g, '_');
}

export const storeAttachment = route((req, res) => {
  const file = requireFile(req);
  const stored = attachmentService.store(file.buffer, {
    originalName: file.originalname,
    mimeType: file.mimetype,
  }, req.user);
  return sendOk(res, { id: stored.id, url: `/api/attachments/${stored.id}` });
});
export const getAttachment = route((req, res, next) => {
  const attachment = attachmentService.retrieve(req.params.id);
  const filename = safeDisplayName(attachment.originalName, `attachment-${req.params.id}`);
  const encoded = encodeURIComponent(filename).replace(/'/g, '%27');
  res.set({
    'Content-Type': attachment.mimeType,
    'Content-Disposition': `inline; filename="${filename}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff',
  });

  const stream = fs.createReadStream(attachment.filePath);
  stream.on('error', (error) => {
    if (res.headersSent) return res.destroy(error);
    return next(new ServiceError(CODE.NOT_FOUND, '附件文件不存在'));
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

export const deleteAttachment = route((req, res) =>
  sendOk(res, attachmentService.remove(req.params.id)));

export function createAttachmentsRouter({
  protect = userContext,
  authorizePermission = authorize,
} = {}) {
  const router = Router();
  const allowed = (permission, ...handlers) => [protect, authorizePermission(permission), ...handlers];

  router.post('/attachments', ...allowed('card_edit', uploadFile, storeAttachment));
  router.get('/attachments/:id', ...allowed('card_read', getAttachment));
  router.delete('/attachments/:id', ...allowed('card_edit', deleteAttachment));

  return router;
}

export const attachmentsRouter = createAttachmentsRouter();
export default attachmentsRouter;
