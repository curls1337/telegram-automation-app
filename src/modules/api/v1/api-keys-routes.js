'use strict';

/**
 * API Keys Web UI Routes — manage API keys via browser.
 *
 * Mounted at /api-keys in the main Express app (web UI, not REST).
 *
 * Routes:
 *   GET  /api-keys           → list keys
 *   POST /api-keys           → create a new key (returns plaintext once)
 *   POST /api-keys/:id/revoke → revoke a key
 *
 * References:
 *   - requirements.md §14.1 — API key management UI
 */

const { Router } = require('express');

const { requireAuth } = require('../../../server/middleware/rbac');
const apiKeyService = require('./api-key-service');
const { getLogger } = require('../../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /api-keys — list all API keys
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const keys = await apiKeyService.list(req.tenant.id);

    return res.render('api-keys/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('apiKeys.title') : 'API Keys',
      keys,
      newKey: null,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api-keys — create a new API key
// ---------------------------------------------------------------------------

router.post('/', requireAuth(), async (req, res, next) => {
  const log = getLogger();

  try {
    const { name, scopes } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      const keys = await apiKeyService.list(req.tenant.id);
      return res.status(400).render('api-keys/index', {
        layout: 'layouts/main',
        title: req.t ? req.t('apiKeys.title') : 'API Keys',
        keys,
        newKey: null,
        error: 'Name is required',
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }

    // Parse scopes from form (comma-separated or array)
    let parsedScopes = [];
    if (scopes) {
      parsedScopes = Array.isArray(scopes)
        ? scopes.filter(Boolean)
        : scopes.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const { id, plaintext } = await apiKeyService.create(req.tenant.id, name.trim(), parsedScopes);

    log.info({ keyId: id, tenantId: req.tenant.id }, 'api-keys-routes: key created');

    // Re-render the page with the new key plaintext shown once
    const keys = await apiKeyService.list(req.tenant.id);

    return res.render('api-keys/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('apiKeys.title') : 'API Keys',
      keys,
      newKey: { id, plaintext },
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    log.warn({ err }, 'api-keys-routes: failed to create key');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api-keys/:id/revoke — revoke an API key
// ---------------------------------------------------------------------------

router.post('/:id/revoke', requireAuth(), async (req, res, next) => {
  const log = getLogger();

  try {
    await apiKeyService.revoke(req.tenant.id, req.params.id);

    log.info({ keyId: req.params.id, tenantId: req.tenant.id }, 'api-keys-routes: key revoked');

    if (req.flash) req.flash('success', req.t ? req.t('apiKeys.revoked') : 'API key revoked');
    return res.redirect('/api-keys');
  } catch (err) {
    log.warn({ err, keyId: req.params.id }, 'api-keys-routes: failed to revoke key');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
