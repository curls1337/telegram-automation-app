'use strict';

/**
 * Drip Campaign routes — CRUD + lifecycle actions for drip campaigns.
 *
 * Mounted at /drip in the main Express app.
 *
 * Routes:
 *   GET  /drip                        → list campaigns
 *   GET  /drip/new                    → new campaign form
 *   POST /drip                        → create campaign
 *   GET  /drip/:id                    → campaign detail/editor (sequence builder)
 *   POST /drip/:id                    → update campaign
 *   POST /drip/:id/activate           → activate campaign
 *   POST /drip/:id/pause              → pause campaign
 *   POST /drip/:id/resume             → resume campaign
 *   POST /drip/:id/archive            → archive campaign
 *   DELETE /drip/:id                  → delete campaign
 *   POST /drip/:id/steps              → add step
 *   POST /drip/:id/steps/:stepId      → update step
 *   POST /drip/:id/steps/:stepId/delete → delete step
 *   GET  /drip/:id/enrollments        → view enrollments
 *   POST /drip/:id/enroll             → manual enrollment
 *
 * All routes require authentication. Write operations require 'write' action.
 *
 * References:
 *   - requirements.md §11.1 — campaign creation with trigger and steps
 *   - requirements.md §11.5 — pause campaign
 *   - requirements.md §11.6 — resume campaign
 *   - design.md "Drip Engine" — UI routes
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const dripService = require('./drip-service');
const enrollmentService = require('./enrollment-service');
const { tenantQuery } = require('../../infra/db');
const { getDb } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /drip — list campaigns
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { page, status } = req.query;
    const result = await dripService.list(req.tenant.id, {
      page,
      pageSize: 25,
      status,
    });

    // Enrich campaigns with step counts and enrollment counts
    const db = getDb();
    const enriched = [];
    for (const campaign of result.data) {
      const [{ count: stepsCount }] = await db('drip_steps')
        .where({ campaign_id: campaign.id })
        .count('* as count');
      const [{ count: enrollmentsCount }] = await db('drip_enrollments')
        .where({ campaign_id: campaign.id })
        .count('* as count');
      enriched.push({
        ...campaign,
        steps_count: parseInt(stepsCount, 10),
        enrollments_count: parseInt(enrollmentsCount, 10),
      });
    }

    return res.render('drip/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('drip.list.title') : 'Drip Campaigns',
      campaigns: enriched,
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
// GET /drip/new — new campaign form
// ---------------------------------------------------------------------------

router.get('/new', requireAuth(), requireAction('write'), async (req, res, next) => {
  try {
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    return res.render('drip/editor', {
      layout: 'layouts/main',
      title: req.t ? req.t('drip.new.title') : 'New Drip Campaign',
      campaign: null,
      steps: [],
      connections,
      error: null,
      formData: {},
      isNew: true,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /drip — create campaign
// ---------------------------------------------------------------------------

router.post('/', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { name, connection_id, trigger_kind, trigger_config, exit_conditions } = req.body;

  const input = {
    name,
    connection_id,
    trigger_kind,
    trigger_config: trigger_config ? (typeof trigger_config === 'string' ? JSON.parse(trigger_config) : trigger_config) : {},
    exit_conditions: exit_conditions ? (typeof exit_conditions === 'string' ? JSON.parse(exit_conditions) : exit_conditions) : null,
  };

  try {
    const campaign = await dripService.create(req.tenant.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('drip.created') : 'Drip campaign created successfully');
    return res.redirect(`/drip/${campaign.id}`);
  } catch (err) {
    log.warn({ err }, 'drip: failed to create campaign');

    try {
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');

      return res.status(err.httpStatus || 400).render('drip/editor', {
        layout: 'layouts/main',
        title: req.t ? req.t('drip.new.title') : 'New Drip Campaign',
        campaign: null,
        steps: [],
        connections,
        error: err.message || 'Failed to create campaign',
        formData: req.body,
        isNew: true,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /drip/:id — campaign detail/editor (sequence builder)
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const campaign = await dripService.getById(req.tenant.id, req.params.id);
    const steps = await dripService.listSteps(req.tenant.id, req.params.id);
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    return res.render('drip/editor', {
      layout: 'layouts/main',
      title: req.t ? req.t('drip.editor.title') : 'Campaign Editor',
      campaign,
      steps,
      connections,
      error: null,
      formData: {},
      isNew: false,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).render('drip/editor', {
        layout: 'layouts/main',
        title: 'Campaign Not Found',
        campaign: null,
        steps: [],
        connections: [],
        error: 'Campaign not found',
        formData: {},
        isNew: false,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id — update campaign
// ---------------------------------------------------------------------------

router.post('/:id', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { name, connection_id, trigger_kind, trigger_config, exit_conditions } = req.body;

  const input = {};
  if (name !== undefined) input.name = name;
  if (connection_id !== undefined) input.connection_id = connection_id;
  if (trigger_kind !== undefined) input.trigger_kind = trigger_kind;
  if (trigger_config !== undefined) {
    input.trigger_config = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : trigger_config;
  }
  if (exit_conditions !== undefined) {
    input.exit_conditions = exit_conditions
      ? (typeof exit_conditions === 'string' ? JSON.parse(exit_conditions) : exit_conditions)
      : null;
  }

  try {
    await dripService.update(req.tenant.id, req.params.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('drip.updated') : 'Campaign updated successfully');
    return res.redirect(`/drip/${req.params.id}`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to update campaign');

    try {
      const campaign = await dripService.getById(req.tenant.id, req.params.id);
      const steps = await dripService.listSteps(req.tenant.id, req.params.id);
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');

      return res.status(err.httpStatus || 400).render('drip/editor', {
        layout: 'layouts/main',
        title: req.t ? req.t('drip.editor.title') : 'Campaign Editor',
        campaign,
        steps,
        connections,
        error: err.message || 'Failed to update campaign',
        formData: req.body,
        isNew: false,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/activate — activate campaign
// ---------------------------------------------------------------------------

router.post('/:id/activate', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await dripService.activate(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('drip.activated') : 'Campaign activated');
    return res.redirect(`/drip/${req.params.id}`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to activate');
    if (req.flash) req.flash('error', err.message || 'Failed to activate campaign');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/pause — pause campaign
// ---------------------------------------------------------------------------

router.post('/:id/pause', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await dripService.pause(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('drip.paused') : 'Campaign paused');
    return res.redirect(`/drip/${req.params.id}`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to pause');
    if (req.flash) req.flash('error', err.message || 'Failed to pause campaign');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/resume — resume campaign
// ---------------------------------------------------------------------------

router.post('/:id/resume', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await dripService.resume(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('drip.resumed') : 'Campaign resumed');
    return res.redirect(`/drip/${req.params.id}`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to resume');
    if (req.flash) req.flash('error', err.message || 'Failed to resume campaign');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/archive — archive campaign
// ---------------------------------------------------------------------------

router.post('/:id/archive', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await dripService.archive(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('drip.archived') : 'Campaign archived');
    return res.redirect('/drip');
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to archive');
    if (req.flash) req.flash('error', err.message || 'Failed to archive campaign');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// DELETE /drip/:id — delete campaign
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await dripService.remove(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('drip.deleted') : 'Campaign deleted');
    return res.redirect('/drip');
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to delete');
    if (req.flash) req.flash('error', err.message || 'Failed to delete campaign');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/steps — add step
// ---------------------------------------------------------------------------

router.post('/:id/steps', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { delay_seconds, payload } = req.body;

  let parsedPayload;
  try {
    parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch (e) {
    // If payload is plain text, wrap it
    parsedPayload = { text: payload || '' };
  }

  const input = {
    delay_seconds: parseInt(delay_seconds, 10),
    payload: parsedPayload,
  };

  try {
    await dripService.addStep(req.tenant.id, req.params.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('drip.step_added') : 'Step added');
    return res.redirect(`/drip/${req.params.id}`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to add step');
    if (req.flash) req.flash('error', err.message || 'Failed to add step');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/steps/:stepId — update step
// ---------------------------------------------------------------------------

router.post('/:id/steps/:stepId', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { delay_seconds, payload } = req.body;

  const input = {};
  if (delay_seconds !== undefined) input.delay_seconds = parseInt(delay_seconds, 10);
  if (payload !== undefined) {
    try {
      input.payload = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      input.payload = { text: payload || '' };
    }
  }

  try {
    await dripService.updateStep(req.tenant.id, req.params.id, req.params.stepId, input);

    if (req.flash) req.flash('success', req.t ? req.t('drip.step_updated') : 'Step updated');
    return res.redirect(`/drip/${req.params.id}`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id, stepId: req.params.stepId }, 'drip: failed to update step');
    if (req.flash) req.flash('error', err.message || 'Failed to update step');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/steps/:stepId/delete — delete step
// ---------------------------------------------------------------------------

router.post('/:id/steps/:stepId/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await dripService.removeStep(req.tenant.id, req.params.id, req.params.stepId);

    if (req.flash) req.flash('success', req.t ? req.t('drip.step_deleted') : 'Step deleted');
    return res.redirect(`/drip/${req.params.id}`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id, stepId: req.params.stepId }, 'drip: failed to delete step');
    if (req.flash) req.flash('error', err.message || 'Failed to delete step');
    return res.redirect(`/drip/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// GET /drip/:id/enrollments — view enrollments for a campaign
// ---------------------------------------------------------------------------

router.get('/:id/enrollments', requireAuth(), async (req, res, next) => {
  try {
    const campaign = await dripService.getById(req.tenant.id, req.params.id);

    const db = getDb();
    const enrollments = await db('drip_enrollments')
      .where({ campaign_id: req.params.id })
      .orderBy('created_at', 'desc');

    return res.render('drip/enrollments', {
      layout: 'layouts/main',
      title: req.t ? req.t('drip.enrollments.title') : 'Campaign Enrollments',
      campaign,
      enrollments,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).render('drip/enrollments', {
        layout: 'layouts/main',
        title: 'Campaign Not Found',
        campaign: null,
        enrollments: [],
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /drip/:id/enroll — manual enrollment (subscriber_ids in body)
// ---------------------------------------------------------------------------

router.post('/:id/enroll', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { subscriber_ids } = req.body;

  // Parse subscriber IDs (comma-separated string or array)
  const ids = subscriber_ids
    ? (Array.isArray(subscriber_ids) ? subscriber_ids : subscriber_ids.split(',').map((s) => s.trim())).filter(Boolean)
    : [];

  if (ids.length === 0) {
    if (req.flash) req.flash('error', 'No subscriber IDs provided');
    return res.redirect(`/drip/${req.params.id}/enrollments`);
  }

  try {
    const results = await enrollmentService.enrollManual(req.tenant.id, req.params.id, ids);

    if (req.flash) {
      req.flash('success', req.t
        ? req.t('drip.enrolled', { count: results.length })
        : `Enrolled ${results.length} subscriber(s)`);
    }
    return res.redirect(`/drip/${req.params.id}/enrollments`);
  } catch (err) {
    log.warn({ err, campaignId: req.params.id }, 'drip: failed to enroll subscribers');
    if (req.flash) req.flash('error', err.message || 'Failed to enroll subscribers');
    return res.redirect(`/drip/${req.params.id}/enrollments`);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
