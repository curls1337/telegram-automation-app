'use strict';

/**
 * Backup routes — export, import, list, and download backups.
 *
 * Mounted at /backup in the main Express app.
 *
 * Routes:
 *   GET  /backup           → list backups + export/import forms
 *   POST /backup/export    → request export (passphrase required)
 *   POST /backup/import    → upload + import (file + passphrase)
 *   GET  /backup/:id       → backup detail + download link
 *
 * All routes require authentication. Write operations require 'write' action.
 *
 * References:
 *   - requirements.md §16.1 — tenant owner requests export with passphrase
 *   - requirements.md §16.4 — import pipeline
 */

const { Router } = require('express');
const multer = require('multer');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const backupService = require('./backup-service');
const { putObject } = require('../../infra/object-storage');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');

const router = Router();

// Multer config for file upload (import)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1.1 * 1024 * 1024 * 1024, // 1.1 GB max (slightly over limit for overhead)
  },
});

// ---------------------------------------------------------------------------
// GET /backup — list backups + forms
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const backups = await backupService.list(req.tenant.id);

    return res.render('backup/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('backup.title') : 'Backup & Restore',
      backups,
      error: null,
      success: null,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /backup/export — request export
// ---------------------------------------------------------------------------

router.post('/export', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { passphrase, skip_media } = req.body;

  try {
    await backupService.requestExport(req.tenant.id, passphrase, {
      userId: req.user.id,
      skipMedia: skip_media === 'on' || skip_media === 'true' || skip_media === '1',
    });

    if (req.flash) req.flash('success', req.t ? req.t('backup.export_requested') : 'Export requested. You will be notified when it is ready.');
    return res.redirect('/backup');
  } catch (err) {
    log.warn({ err }, 'backup: failed to request export');

    try {
      const backups = await backupService.list(req.tenant.id);
      return res.status(err.httpStatus || 400).render('backup/index', {
        layout: 'layouts/main',
        title: req.t ? req.t('backup.title') : 'Backup & Restore',
        backups,
        error: err.message || 'Failed to request export',
        success: null,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /backup/import — upload + import
// ---------------------------------------------------------------------------

router.post('/import', requireAuth(), requireAction('write'), upload.single('backup_file'), async (req, res, next) => {
  const log = getLogger();
  const { passphrase } = req.body;

  try {
    if (!req.file) {
      throw Object.assign(new Error('Backup file is required'), { httpStatus: 400 });
    }

    // Upload the file to Object Storage first
    const objectKey = `tenants/${req.tenant.id}/backups/import-${newId()}.enc`;
    await putObject({
      key: objectKey,
      body: req.file.buffer,
      contentType: 'application/octet-stream',
      contentLength: req.file.size,
    });

    // Request import
    await backupService.requestImport(req.tenant.id, objectKey, passphrase, {
      userId: req.user.id,
    });

    if (req.flash) req.flash('success', req.t ? req.t('backup.import_requested') : 'Import requested. Data will be restored shortly.');
    return res.redirect('/backup');
  } catch (err) {
    log.warn({ err }, 'backup: failed to request import');

    try {
      const backups = await backupService.list(req.tenant.id);
      return res.status(err.httpStatus || 400).render('backup/index', {
        layout: 'layouts/main',
        title: req.t ? req.t('backup.title') : 'Backup & Restore',
        backups,
        error: err.message || 'Failed to request import',
        success: null,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /backup/:id — backup detail + download
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const backup = await backupService.getById(req.tenant.id, req.params.id);

    let downloadUrl = null;
    if (backup.status === 'completed' && backup.object_key) {
      downloadUrl = await backupService.getDownloadUrl(req.tenant.id, req.params.id);
    }

    return res.json({
      backup,
      downloadUrl,
    });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).json({ error: 'Backup not found' });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
