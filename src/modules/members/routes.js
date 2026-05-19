'use strict';

/**
 * Member Rules routes — CRUD + toggle for member management rules.
 *
 * Mounted at /members in the main Express app.
 *
 * Routes:
 *   GET  /members/rules              → list all member rules
 *   GET  /members/rules/new          → form to create a new rule
 *   POST /members/rules              → create a rule
 *   GET  /members/rules/:id          → rule detail/edit
 *   POST /members/rules/:id          → update a rule
 *   POST /members/rules/:id/toggle   → toggle is_active
 *   POST /members/rules/:id/delete   → delete a rule
 *
 * All routes require authentication. Write operations require 'write' action.
 *
 * References:
 *   - requirements.md §10.4, §10.5, §10.6 — member management
 *   - design.md "Member Management" — UI routes
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const memberRuleService = require('./member-rule-service');
const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /members/rules — list all member rules
// ---------------------------------------------------------------------------

router.get('/rules', requireAuth(), async (req, res, next) => {
  try {
    const { page, kind } = req.query;
    const result = await memberRuleService.list(req.tenant.id, {
      page,
      pageSize: 25,
      kind,
    });

    return res.render('members/rules', {
      layout: 'layouts/main',
      title: req.t ? req.t('members.rules.title') : 'Member Rules',
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
// GET /members/rules/new — new rule form
// ---------------------------------------------------------------------------

router.get('/rules/new', requireAuth(), requireAction('write'), async (req, res, next) => {
  try {
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    return res.render('members/rules-form', {
      layout: 'layouts/main',
      title: req.t ? req.t('members.rules.new') : 'New Member Rule',
      connections,
      rule: null,
      error: null,
      formData: {},
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /members/rules — create rule
// ---------------------------------------------------------------------------

router.post('/rules', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { connection_id, kind, is_active } = req.body;

  // Build config from form fields based on kind
  let config = {};
  if (kind === 'welcome') {
    config = {
      template: req.body.config_template || '',
      delay_seconds: req.body.config_delay_seconds
        ? parseInt(req.body.config_delay_seconds, 10)
        : undefined,
    };
    // Remove undefined fields
    if (config.delay_seconds === undefined || isNaN(config.delay_seconds)) {
      delete config.delay_seconds;
    }
  } else if (kind === 'auto_kick_inactive') {
    config = {
      threshold_days: parseInt(req.body.config_threshold_days, 10) || 30,
      dry_run: req.body.config_dry_run === 'on' || req.body.config_dry_run === 'true',
    };
  } else if (kind === 'anti_spam') {
    const patternsRaw = req.body.config_patterns || '';
    config = {
      patterns: typeof patternsRaw === 'string'
        ? patternsRaw.split('\n').map((s) => s.trim()).filter(Boolean)
        : Array.isArray(patternsRaw) ? patternsRaw : [patternsRaw],
      action: req.body.config_action || 'delete',
      mute_duration_seconds: req.body.config_mute_duration_seconds
        ? parseInt(req.body.config_mute_duration_seconds, 10)
        : undefined,
    };
    if (config.mute_duration_seconds === undefined || isNaN(config.mute_duration_seconds)) {
      delete config.mute_duration_seconds;
    }
  }

  const input = {
    connection_id,
    kind,
    config,
    is_active: is_active === 'on' || is_active === 'true' || is_active === true,
  };

  try {
    await memberRuleService.create(req.tenant.id, input, {
      userId: req.user && req.user.id,
    });

    if (req.flash) req.flash('success', req.t ? req.t('members.rules.created') : 'Member rule created successfully');
    return res.redirect('/members/rules');
  } catch (err) {
    log.warn({ err }, 'members: failed to create rule');

    try {
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');

      return res.status(err.httpStatus || 400).render('members/rules-form', {
        layout: 'layouts/main',
        title: req.t ? req.t('members.rules.new') : 'New Member Rule',
        connections,
        rule: null,
        error: err.message || 'Failed to create member rule',
        formData: req.body,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /members/rules/:id — rule detail/edit
// ---------------------------------------------------------------------------

router.get('/rules/:id', requireAuth(), async (req, res, next) => {
  try {
    const rule = await memberRuleService.getById(req.tenant.id, req.params.id);
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    return res.render('members/rules-form', {
      layout: 'layouts/main',
      title: req.t ? req.t('members.rules.edit') : 'Edit Member Rule',
      connections,
      rule,
      error: null,
      formData: {},
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).render('members/rules-form', {
        layout: 'layouts/main',
        title: 'Member Rule Not Found',
        connections: [],
        rule: null,
        error: 'Member rule not found',
        formData: {},
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /members/rules/:id — update rule
// ---------------------------------------------------------------------------

router.post('/rules/:id', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { connection_id, kind } = req.body;

  const input = {};
  if (connection_id !== undefined) input.connection_id = connection_id;
  if (kind !== undefined) input.kind = kind;

  // Build config from form fields based on kind
  const effectiveKind = kind || req.body._existing_kind;
  if (effectiveKind === 'welcome') {
    input.config = {
      template: req.body.config_template || '',
      delay_seconds: req.body.config_delay_seconds
        ? parseInt(req.body.config_delay_seconds, 10)
        : undefined,
    };
    if (input.config.delay_seconds === undefined || isNaN(input.config.delay_seconds)) {
      delete input.config.delay_seconds;
    }
  } else if (effectiveKind === 'auto_kick_inactive') {
    input.config = {
      threshold_days: parseInt(req.body.config_threshold_days, 10) || 30,
      dry_run: req.body.config_dry_run === 'on' || req.body.config_dry_run === 'true',
    };
  } else if (effectiveKind === 'anti_spam') {
    const patternsRaw = req.body.config_patterns || '';
    input.config = {
      patterns: typeof patternsRaw === 'string'
        ? patternsRaw.split('\n').map((s) => s.trim()).filter(Boolean)
        : Array.isArray(patternsRaw) ? patternsRaw : [patternsRaw],
      action: req.body.config_action || 'delete',
      mute_duration_seconds: req.body.config_mute_duration_seconds
        ? parseInt(req.body.config_mute_duration_seconds, 10)
        : undefined,
    };
    if (input.config.mute_duration_seconds === undefined || isNaN(input.config.mute_duration_seconds)) {
      delete input.config.mute_duration_seconds;
    }
  }

  try {
    await memberRuleService.update(req.tenant.id, req.params.id, input, {
      userId: req.user && req.user.id,
    });

    if (req.flash) req.flash('success', req.t ? req.t('members.rules.updated') : 'Member rule updated');
    return res.redirect(`/members/rules/${req.params.id}`);
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'members: failed to update rule');

    try {
      const rule = await memberRuleService.getById(req.tenant.id, req.params.id);
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');

      return res.status(err.httpStatus || 400).render('members/rules-form', {
        layout: 'layouts/main',
        title: req.t ? req.t('members.rules.edit') : 'Edit Member Rule',
        connections,
        rule,
        error: err.message || 'Failed to update member rule',
        formData: req.body,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /members/rules/:id/toggle — toggle is_active
// ---------------------------------------------------------------------------

router.post('/rules/:id/toggle', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    const updated = await memberRuleService.toggleActive(req.tenant.id, req.params.id, {
      userId: req.user && req.user.id,
    });

    if (req.flash) {
      const msg = updated.is_active
        ? (req.t ? req.t('members.rules.activated') : 'Member rule activated')
        : (req.t ? req.t('members.rules.deactivated') : 'Member rule deactivated');
      req.flash('success', msg);
    }
    return res.redirect(`/members/rules/${req.params.id}`);
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'members: failed to toggle rule');
    if (req.flash) req.flash('error', err.message || 'Failed to toggle member rule');
    return res.redirect(`/members/rules/${req.params.id}`);
  }
});

// ---------------------------------------------------------------------------
// POST /members/rules/:id/delete — delete rule
// ---------------------------------------------------------------------------

router.post('/rules/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await memberRuleService.remove(req.tenant.id, req.params.id, {
      userId: req.user && req.user.id,
    });

    if (req.flash) req.flash('success', req.t ? req.t('members.rules.deleted') : 'Member rule deleted');
    return res.redirect('/members/rules');
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'members: failed to delete rule');
    if (req.flash) req.flash('error', err.message || 'Failed to delete member rule');
    return res.redirect('/members/rules');
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
