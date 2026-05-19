'use strict';

/**
 * Auto-Reply Routes — Express router for auto-reply rule management UI.
 *
 * Routes:
 *   GET  /auto-reply              → list rules
 *   GET  /auto-reply/new          → new rule form
 *   POST /auto-reply              → create rule
 *   GET  /auto-reply/ai-settings  → AI settings page
 *   POST /auto-reply/ai-settings  → save AI settings
 *   GET  /auto-reply/:id/edit     → edit rule form
 *   POST /auto-reply/:id          → update rule
 *   POST /auto-reply/:id/delete   → delete rule
 *   POST /auto-reply/:id/toggle   → toggle active status
 *
 * All routes require authentication. Write operations require 'write' action.
 *
 * References:
 *   - requirements.md §7.1 — CRUD auto-reply rules
 *   - requirements.md §8.1, §8.4 — AI settings management
 *   - design.md "Auto-Reply Engine" — UI routes
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const ruleService = require('./rule-service');
const aiSettingsService = require('./ai-settings-service');
const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /auto-reply — list rules
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const rules = await ruleService.list(req.tenant.id);

    // Load connections for display
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .select('id', 'display_name', 'kind')
      .orderBy('display_name');

    return res.render('auto-reply/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.title') : 'Auto-Reply Rules',
      rules,
      connections,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /auto-reply/new — new rule form
// ---------------------------------------------------------------------------

router.get('/new', requireAuth(), requireAction('write'), async (req, res, next) => {
  try {
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .select('id', 'display_name', 'kind')
      .where({ status: 'active' })
      .orderBy('display_name');

    return res.render('auto-reply/new', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.new.title') : 'New Auto-Reply Rule',
      connections,
      error: null,
      values: {},
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auto-reply — create rule
// ---------------------------------------------------------------------------

router.post('/', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  const input = {
    trigger_kind: req.body.trigger_kind,
    trigger_value: req.body.trigger_value,
    response: req.body.response,
    priority: parseInt(req.body.priority, 10) || 0,
    case_sensitive: req.body.case_sensitive === 'on' || req.body.case_sensitive === 'true',
    is_active: req.body.is_active !== 'off' && req.body.is_active !== 'false',
    connection_id: req.body.connection_id || null,
  };

  try {
    await ruleService.create(req.tenant.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('autoReply.created') : 'Auto-reply rule created successfully');
    return res.redirect('/auto-reply');
  } catch (err) {
    log.warn({ err }, 'auto-reply: failed to create rule');

    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .select('id', 'display_name', 'kind')
      .where({ status: 'active' })
      .orderBy('display_name');

    return res.render('auto-reply/new', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.new.title') : 'New Auto-Reply Rule',
      connections,
      error: err.message || 'Failed to create rule',
      values: input,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /auto-reply/ai-settings — AI settings page
// ---------------------------------------------------------------------------

router.get('/ai-settings', requireAuth(), async (req, res, next) => {
  try {
    const settings = await aiSettingsService.getSettings(req.tenant.id);
    let usage = null;

    if (settings) {
      try {
        usage = await aiSettingsService.getDailyUsage(req.tenant.id);
      } catch (_err) {
        // Non-critical — continue without usage data
      }
    }

    return res.render('auto-reply/ai-settings', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.aiSettings.title') : 'AI Auto-Reply Settings',
      settings,
      usage,
      error: null,
      success: null,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auto-reply/ai-settings — save AI settings
// ---------------------------------------------------------------------------

router.post('/ai-settings', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  const input = {
    apiKey: req.body.api_key || undefined,
    systemPrompt: req.body.system_prompt,
    dailyTokenLimit: req.body.daily_token_limit || null,
    isEnabled: req.body.is_enabled === 'on' || req.body.is_enabled === 'true',
  };

  try {
    await aiSettingsService.saveSettings(req.tenant.id, input);

    const settings = await aiSettingsService.getSettings(req.tenant.id);
    let usage = null;
    if (settings) {
      try {
        usage = await aiSettingsService.getDailyUsage(req.tenant.id);
      } catch (_err) {
        // Non-critical
      }
    }

    return res.render('auto-reply/ai-settings', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.aiSettings.title') : 'AI Auto-Reply Settings',
      settings,
      usage,
      error: null,
      success: req.t ? req.t('autoReply.aiSettings.saved') : 'AI settings saved successfully',
    });
  } catch (err) {
    log.warn({ err }, 'auto-reply: failed to save AI settings');

    const settings = await aiSettingsService.getSettings(req.tenant.id).catch(() => null);
    let usage = null;
    if (settings) {
      try {
        usage = await aiSettingsService.getDailyUsage(req.tenant.id);
      } catch (_usageErr) {
        // Non-critical
      }
    }

    return res.render('auto-reply/ai-settings', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.aiSettings.title') : 'AI Auto-Reply Settings',
      settings,
      usage,
      error: err.message || 'Failed to save AI settings',
      success: null,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /auto-reply/:id/edit — edit rule form
// ---------------------------------------------------------------------------

router.get('/:id/edit', requireAuth(), requireAction('write'), async (req, res, next) => {
  try {
    const rule = await ruleService.getById(req.tenant.id, req.params.id);

    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .select('id', 'display_name', 'kind')
      .where({ status: 'active' })
      .orderBy('display_name');

    // Parse response if stored as JSON string
    let responseValue = rule.response;
    if (typeof responseValue === 'string') {
      try {
        const parsed = JSON.parse(responseValue);
        responseValue = parsed.text || '';
      } catch (_e) {
        // Keep as-is
      }
    } else if (responseValue && typeof responseValue === 'object') {
      responseValue = responseValue.text || '';
    }

    return res.render('auto-reply/edit', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.edit.title') : 'Edit Auto-Reply Rule',
      rule,
      connections,
      responseValue,
      error: null,
    });
  } catch (err) {
    if (err.httpStatus === 404) {
      return res.status(404).render('auto-reply/index', {
        layout: 'layouts/main',
        title: req.t ? req.t('autoReply.title') : 'Auto-Reply Rules',
        rules: [],
        connections: [],
        error: err.message,
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auto-reply/:id — update rule
// ---------------------------------------------------------------------------

router.post('/:id', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  const input = {
    trigger_kind: req.body.trigger_kind,
    trigger_value: req.body.trigger_value,
    response: req.body.response,
    priority: parseInt(req.body.priority, 10) || 0,
    case_sensitive: req.body.case_sensitive === 'on' || req.body.case_sensitive === 'true',
    is_active: req.body.is_active !== 'off' && req.body.is_active !== 'false',
    connection_id: req.body.connection_id || null,
  };

  try {
    await ruleService.update(req.tenant.id, req.params.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('autoReply.updated') : 'Auto-reply rule updated successfully');
    return res.redirect('/auto-reply');
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'auto-reply: failed to update rule');

    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .select('id', 'display_name', 'kind')
      .where({ status: 'active' })
      .orderBy('display_name');

    return res.render('auto-reply/edit', {
      layout: 'layouts/main',
      title: req.t ? req.t('autoReply.edit.title') : 'Edit Auto-Reply Rule',
      rule: { id: req.params.id, ...input },
      connections,
      responseValue: input.response,
      error: err.message || 'Failed to update rule',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /auto-reply/:id/delete — delete rule
// ---------------------------------------------------------------------------

router.post('/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await ruleService.remove(req.tenant.id, req.params.id);

    if (req.flash) req.flash('success', req.t ? req.t('autoReply.deleted') : 'Auto-reply rule deleted');
    return res.redirect('/auto-reply');
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'auto-reply: failed to delete rule');

    if (req.flash) req.flash('error', err.message || 'Failed to delete rule');
    return res.redirect('/auto-reply');
  }
});

// ---------------------------------------------------------------------------
// POST /auto-reply/:id/toggle — toggle active status
// ---------------------------------------------------------------------------

router.post('/:id/toggle', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    const isActive = req.body.is_active === 'true' || req.body.is_active === 'on';
    await ruleService.toggleActive(req.tenant.id, req.params.id, isActive);

    if (req.flash) req.flash('success', req.t ? req.t('autoReply.toggled') : 'Rule status updated');
    return res.redirect('/auto-reply');
  } catch (err) {
    log.warn({ err, ruleId: req.params.id }, 'auto-reply: failed to toggle rule');

    if (req.flash) req.flash('error', err.message || 'Failed to toggle rule');
    return res.redirect('/auto-reply');
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
