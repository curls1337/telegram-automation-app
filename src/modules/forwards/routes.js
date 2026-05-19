'use strict';

/**
 * Forward Rules routes — CRUD + toggle for auto-forwarding rules.
 *
 * Mounted at /forwards in the main Express app.
 *
 * Routes:
 *   GET  /forwards              → list forward rules
 *   GET  /forwards/new          → form to create a new forward rule
 *   POST /forwards              → create a forward rule
 *   GET  /forwards/:id          → forward rule detail (view/edit)
 *   POST /forwards/:id          → update a forward rule
 *   POST /forwards/:id/toggle   → toggle is_active
 *   POST /forwards/:id/delete   → delete a forward rule
 *
 * All routes require authentication. Write operations require 'write' action.
 *
 * References:
 *   - requirements.md §12.1 — forward rule CRUD
 *   - design.md "Forward Engine" — UI routes
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const forwardService = require('./forward-service');
const { publishInvalidation } = require('./forward-listener');
const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /forwards — list forward rules
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { page } = req.query;
    const result = await forwardService.list(req.tenant.id, {
      page,
      pageSize: 25,
    });

    return res.render('forwards/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('forwards.list.title') : 'Auto-Forwarding Rules',
      rules: result.data,
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
// GET /forwards/new — new forward rule form
// ---------------------------------------------------------------------------

router.get('/new', requireAuth(), requireAction('write'), async (req, res, next) => {
  try {
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    return res.render('forwards/new', {
      layout: 'layouts/main',
      title: req.t ? req.t('forwards.new.title') : 'New Forward Rule',
      connections,
      error: null,
      formData: {},
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /forwards — create forward rule
// ---------------------------------------------------------------------------

router.post('/', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const {
    connection_id,
    source_chat,
    destinations,
    filters,
    remove_header,
  } = req.body;

  // Parse destinations (comma-separated string → array)
  const destinationsArray = destinations
    ? (typeof destinations === 'string'
      ? destinations.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(destinations) ? destinations : [destinations])
    : [];

  // Parse filters (JSON string or empty)
  let parsedFilters = null;
  if (filters && typeof filters === 'string' && filters.trim()) {
    try {
      parsedFilters = JSON.parse(filters);
    } catch (e) {
      // Invalid JSON — will be caught by validation
      parsedFilters = null;
    }
  } else if (filters && typeof filters === 'object') {
    parsedFilters = filters;
  }

  const input = {
    connection_id,
    source_chat,
    destinations: destinationsArray,
    filters: parsedFilters,
    remove_header: remove_header === 'on' || remove_header === 'true' || remove_header === true,
    is_active: true,
  };

  try {
    const rule = await forwardService.create(req.tenant.id, input);

    // Invalidate cache for this connection
    if (connection_id) {
      await publishInvalidation(connection_id);
    }

    if (req.flash) req.flash('success', req.t ? req.t('forwards.created') : 'Forward rule created successfully');
    return res.redirect('/forwards');
  } catch (err) {
    log.warn({ err }, 'forwards: failed to create rule');

    try {
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');

      return res.status(err.httpStatus || 400).render('forwards/new', {
        layout: 'layouts/main',
        title: req.t ? req.t('forwards.new.title') : 'New Forward Rule',
        connections,
        error: err.message || 'Failed to create forward rule',
        formData: req.body,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /forwards/:id — forward rule detail
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const rule = await forwardService.getById(req.tenant.id, req.params.id);
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    return res.render('forwards/detail', {
      layout: 'layouts/main',
      title: req.t ? req.t('forwards.detail.title') : 'Forward Rule Detail',
      rule,
      connections,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).render('forwards/detail', {
        layout: 'layouts/main',
        title: 'Forward Rule Not Found',
        rule: null,
        connections: [],
        error: 'Forward rule not found',
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /forwards/:id — update forward rule
// ---------------------------------------------------------------------------

router.post('/:id', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const {
    connection_id,
    source_chat,
    destinations,
    filters,
    remove_header,
  } = req.body;

  const input = {};
  if (connection_id !== undefined) input.connection_id = connection_id;
  if (source_chat !== undefined) input.source_chat = source_chat;

  if (destinations !== undefined) {
    input.destinations = typeof destinations === 'string'
      ? destinations.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(destinations) ? destinations : [destinations];
  }

  if (filters !== undefined) {
    if (typeof filters === 'string' && filters.trim()) {
      try {
        input.filters = JSON.parse(filters);
      } catch (e) {
        input.filters = null;
      }
    } else if (typeof filters === 'object') {
      input.filters = filters;
    } else {
      input.filters = null;
    }
  }

  if (remove_header !== undefined) {
    input.remove_header = remove_header === 'on' || remove_header === 'true' || remove_header === true;
  }

  try {
    const updated = await forwardService.update(req.tenant.id, req.params.id, input);

    // Invalidate cache for the connection
    if (updated.connection_id) {
      await publishInvalidation(updated.connection_id);
    }

    if (req.flash) req.flash('success', req.t ? req.t('forwards.updated') : 'Forward rule updated');
    return res.redirect(`/forwards/${req.params.id}`);
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'forwards: failed to update rule');

    try {
      const rule = await forwardService.getById(req.tenant.id, req.params.id);
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');

      return res.status(err.httpStatus || 400).render('forwards/detail', {
        layout: 'layouts/main',
        title: req.t ? req.t('forwards.detail.title') : 'Forward Rule Detail',
        rule,
        connections,
        error: err.message || 'Failed to update forward rule',
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /forwards/:id/toggle — toggle is_active
// ---------------------------------------------------------------------------

router.post('/:id/toggle', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    const updated = await forwardService.toggleActive(req.tenant.id, req.params.id);

    // Invalidate cache for the connection
    if (updated.connection_id) {
      await publishInvalidation(updated.connection_id);
    }

    if (req.flash) {
      const msg = updated.is_active
        ? (req.t ? req.t('forwards.activated') : 'Forward rule activated')
        : (req.t ? req.t('forwards.deactivated') : 'Forward rule deactivated');
      req.flash('success', msg);
    }
    return res.redirect(`/forwards/${req.params.id}`);
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'forwards: failed to toggle rule');
    if (req.flash) req.flash('error', err.message || 'Failed to toggle forward rule');
    return res.redirect(`/forwards/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /forwards/:id/delete — delete forward rule
// ---------------------------------------------------------------------------

router.post('/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    // Get rule first to know the connection_id for cache invalidation
    const rule = await forwardService.getById(req.tenant.id, req.params.id);
    await forwardService.remove(req.tenant.id, req.params.id);

    // Invalidate cache for the connection
    if (rule.connection_id) {
      await publishInvalidation(rule.connection_id);
    }

    if (req.flash) req.flash('success', req.t ? req.t('forwards.deleted') : 'Forward rule deleted');
    return res.redirect('/forwards');
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'forwards: failed to delete rule');
    if (req.flash) req.flash('error', err.message || 'Failed to delete forward rule');
    return res.redirect('/forwards');
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
