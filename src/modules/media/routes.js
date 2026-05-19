'use strict';

/**
 * Media routes — upload, list, download, delete media files.
 *
 * Mounted at /media in the main Express app.
 *
 * Uses multer for multipart/form-data file upload handling.
 *
 * References:
 *   - requirements.md §17.1 — Upload media via dashboard.
 *   - requirements.md §17.6 — Delete media from dashboard.
 *   - design.md "Media Storage" — MediaService interface.
 */

const { Router } = require('express');
const multer = require('multer');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const mediaService = require('./media-service');
const { getLogger } = require('../../infra/logger');
const { ValidationError } = require('../../shared/errors');

const router = Router();

// ---------------------------------------------------------------------------
// Multer configuration — memory storage, 50MB limit
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB (Bot API default limit)
  },
});

// ---------------------------------------------------------------------------
// GET /media — list media files
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { page, kind } = req.query;
    const result = await mediaService.list(req.tenant.id, {
      page,
      pageSize: 25,
      kind,
    });

    return res.render('media/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('media.title') : 'Media Library',
      media: result.data,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: Math.ceil(result.total / result.pageSize),
      query: req.query,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /media/upload — upload a media file
// ---------------------------------------------------------------------------

router.post(
  '/upload',
  requireAuth(),
  requireAction('write'),
  upload.single('file'),
  async (req, res, next) => {
    const log = getLogger();

    try {
      if (!req.file || !req.file.buffer) {
        throw new ValidationError('No file provided. Please select a file to upload.');
      }

      const userId = req.session.userId || (req.user && req.user.id);
      const maxSize = req.body.maxSize ? parseInt(req.body.maxSize, 10) : undefined;

      await mediaService.uploadFromRequest(req.tenant.id, req.file.buffer, {
        originalName: req.file.originalname || 'upload',
        size: req.file.size || req.file.buffer.length,
        userId,
        maxSize,
      });

      if (req.flash) req.flash('success', req.t ? req.t('media.uploaded') : 'File uploaded successfully');
      return res.redirect('/media');
    } catch (err) {
      log.warn({ err }, 'media: upload failed');

      // Re-render the media page with error
      try {
        const result = await mediaService.list(req.tenant.id, { page: 1, pageSize: 25 });
        return res.status(err.httpStatus || 400).render('media/index', {
          layout: 'layouts/main',
          title: req.t ? req.t('media.title') : 'Media Library',
          media: result.data,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: Math.ceil(result.total / result.pageSize),
          query: req.query || {},
          error: err.message || 'Upload failed',
          csrfToken: req.csrfToken ? req.csrfToken() : '',
        });
      } catch (innerErr) {
        return next(innerErr);
      }
    }
  }
);

// ---------------------------------------------------------------------------
// GET /media/:id/download — get presigned download URL
// ---------------------------------------------------------------------------

router.get('/:id/download', requireAuth(), async (req, res, next) => {
  try {
    const url = await mediaService.getDownloadUrl(req.tenant.id, req.params.id);
    return res.redirect(url);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /media/:id/delete — delete a media file
// ---------------------------------------------------------------------------

router.post('/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await mediaService.deleteMedia(req.tenant.id, req.params.id);
    if (req.flash) req.flash('success', req.t ? req.t('media.deleted') : 'File deleted successfully');
    return res.redirect('/media');
  } catch (err) {
    log.warn({ err, mediaId: req.params.id }, 'media: delete failed');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
