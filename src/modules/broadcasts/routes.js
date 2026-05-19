'use strict';

/**
 * Broadcast routes — CRUD + lifecycle actions for broadcasts.
 *
 * Mounted at /broadcasts in the main Express app.
 *
 * Routes:
 *   GET  /broadcasts              → list broadcasts
 *   GET  /broadcasts/new          → form to create a new broadcast
 *   POST /broadcasts              → create a broadcast
 *   GET  /broadcasts/:id          → broadcast detail (real-time progress)
 *   GET  /broadcasts/:id/progress → JSON progress endpoint (polling)
 *   POST /broadcasts/:id/pause    → pause a running broadcast
 *   POST /broadcasts/:id/resume   → resume a paused broadcast
 *   POST /broadcasts/:id/cancel   → cancel a broadcast
 *
 * All routes require authentication. Write operations require 'write' action.
 *
 * References:
 *   - requirements.md §9.1 — create broadcast
 *   - requirements.md §9.4 — real-time progress
 *   - requirements.md §9.5 — pause/cancel
 *   - design.md "Broadcast Engine" — UI routes
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const broadcastService = require('./broadcast-service');
const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');
const segmentService = require('../subscribers/segment-service');

const router = Router();

// ---------------------------------------------------------------------------
// GET /broadcasts — list broadcasts
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { page, status } = req.query;
    const result = await broadcastService.list(req.tenant.id, {
      page,
      pageSize: 25,
      status,
    });

    return res.render('broadcasts/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('broadcasts.list.title') : 'Broadcasts',
      broadcasts: result.data,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: Math.ceil(result.total / result.pageSize),
      query: req.query,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /broadcasts/new — new broadcast form
// ---------------------------------------------------------------------------

router.get('/new', requireAuth(), requireAction('write'), async (req, res, next) => {
  try {
    // Load connections for the dropdown
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    // Load segments for the audience picker
    const segments = await segmentService.list(req.tenant.id);

    return res.render('broadcasts/new', {
      layout: 'layouts/main',
      title: req.t ? req.t('broadcasts.new.title') : 'New Broadcast',
      connections,
      segments,
      error: null,
      formData: {},
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /broadcasts — create broadcast
// ---------------------------------------------------------------------------

router.post('/', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const {
    connection_id,
    audience_type,
    segment_id,
    subscriber_ids,
    message_text,
    parse_mode,
    media_ids,
  } = req.body;

  // Build audience object
  const audience = { type: audience_type };
  if (audience_type === 'segment') {
    audience.segmentId = segment_id;
  } else if (audience_type === 'subscribers') {
    audience.subscriberIds = subscriber_ids
      ? (Array.isArray(subscriber_ids) ? subscriber_ids : subscriber_ids.split(',').map((s) => s.trim())).filter(Boolean)
      : [];
  }

  // Build payload
  const payload = {
    text: message_text || '',
    media_ids: media_ids ? (Array.isArray(media_ids) ? media_ids : [media_ids]).filter(Boolean) : [],
    parse_mode: parse_mode || undefined,
  };

  const input = {
    connectionId: connection_id,
    audience,
    payload,
  };

  try {
    await broadcastService.create(req.tenant.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('broadcasts.created') : 'Broadcast created successfully');
    return res.redirect('/broadcasts');
  } catch (err) {
    log.warn({ err }, 'broadcasts: failed to create broadcast');

    // Re-render form with error
    try {
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');
      const segments = await segmentService.list(req.tenant.id);

      return res.status(err.httpStatus || 400).render('broadcasts/new', {
        layout: 'layouts/main',
        title: req.t ? req.t('broadcasts.new.title') : 'New Broadcast',
        connections,
        segments,
        error: err.message || 'Failed to create broadcast',
        formData: req.body,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /broadcasts/:id — broadcast detail
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const broadcast = await broadcastService.getById(req.tenant.id, req.params.id);

    return res.render('broadcasts/detail', {
      layout: 'layouts/main',
      title: req.t ? req.t('broadcasts.detail.title') : 'Broadcast Detail',
      broadcast,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).render('broadcasts/detail', {
        layout: 'layouts/main',
        title: 'Broadcast Not Found',
        broadcast: null,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /broadcasts/:id/progress — JSON progress endpoint (polling)
// ---------------------------------------------------------------------------

router.get('/:id/progress', requireAuth(), async (req, res, next) => {
  try {
    const progress = await broadcastService.getProgress(req.tenant.id, req.params.id);
    return res.json(progress);
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /broadcasts/:id/pause — pause broadcast
// ---------------------------------------------------------------------------

router.post('/:id/pause', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await broadcastService.pause(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('broadcasts.paused') : 'Broadcast paused');
    return res.redirect(`/broadcasts/${req.params.id}`);
  } catch (err) {
    log.warn({ err, broadcastId: req.params.id }, 'broadcasts: failed to pause');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /broadcasts/:id/resume — resume broadcast
// ---------------------------------------------------------------------------

router.post('/:id/resume', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await broadcastService.resume(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('broadcasts.resumed') : 'Broadcast resumed');
    return res.redirect(`/broadcasts/${req.params.id}`);
  } catch (err) {
    log.warn({ err, broadcastId: req.params.id }, 'broadcasts: failed to resume');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /broadcasts/:id/cancel — cancel broadcast
// ---------------------------------------------------------------------------

router.post('/:id/cancel', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await broadcastService.cancel(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('broadcasts.cancelled') : 'Broadcast cancelled');
    return res.redirect(`/broadcasts/${req.params.id}`);
  } catch (err) {
    log.warn({ err, broadcastId: req.params.id }, 'broadcasts: failed to cancel');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
