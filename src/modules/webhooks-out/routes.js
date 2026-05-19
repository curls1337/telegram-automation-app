'use strict';

/**
 * Webhooks Web UI Routes — manage outbound webhooks via browser.
 *
 * Mounted at /webhooks in the main Express app.
 *
 * Routes:
 *   GET  /webhooks           → list webhooks
 *   GET  /webhooks/new       → new webhook form
 *   POST /webhooks           → create webhook
 *   GET  /webhooks/:id       → webhook detail (edit + deliveries)
 *   POST /webhooks/:id       → update webhook
 *   POST /webhooks/:id/delete → delete webhook
 *   POST /webhooks/:id/test  → send test delivery
 *
 * References:
 *   - requirements.md §14.5 — webhook management UI
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const webhookService = require('./webhook-service');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /webhooks — list webhooks
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const webhooks = await webhookService.list(req.tenant.id);

    return res.render('webhooks/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('webhooks.title') : 'Webhooks',
      webhooks,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /webhooks/new — new webhook form
// ---------------------------------------------------------------------------

router.get('/new', requireAuth(), requireAction('write'), async (req, res, _next) => {
  return res.render('webhooks/new', {
    layout: 'layouts/main',
    title: req.t ? req.t('webhooks.new.title') : 'New Webhook',
    events: webhookService.VALID_EVENTS,
    error: null,
    formData: {},
    csrfToken: req.csrfToken ? req.csrfToken() : '',
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks — create webhook
// ---------------------------------------------------------------------------

router.post('/', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    const { url, events, secret } = req.body;

    // Parse events from form (checkboxes send array or single value)
    const parsedEvents = Array.isArray(events) ? events : (events ? [events] : []);

    await webhookService.create(req.tenant.id, {
      url,
      events: parsedEvents,
      secret,
    });

    if (req.flash) req.flash('success', req.t ? req.t('webhooks.created') : 'Webhook created');
    return res.redirect('/webhooks');
  } catch (err) {
    log.warn({ err }, 'webhooks-routes: failed to create webhook');

    if (err.code === 'validation_error') {
      return res.status(400).render('webhooks/new', {
        layout: 'layouts/main',
        title: req.t ? req.t('webhooks.new.title') : 'New Webhook',
        events: webhookService.VALID_EVENTS,
        error: err.message,
        formData: req.body,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }

    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /webhooks/:id — webhook detail (edit + deliveries)
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const webhook = await webhookService.getById(req.tenant.id, req.params.id);
    const deliveries = await webhookService.getDeliveries(req.params.id, { limit: 50 });

    return res.render('webhooks/detail', {
      layout: 'layouts/main',
      title: req.t ? req.t('webhooks.detail.title') : 'Webhook Detail',
      webhook,
      deliveries,
      events: webhookService.VALID_EVENTS,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).render('webhooks/detail', {
        layout: 'layouts/main',
        title: 'Webhook Not Found',
        webhook: null,
        deliveries: [],
        events: webhookService.VALID_EVENTS,
        error: 'Webhook not found',
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /webhooks/:id — update webhook
// ---------------------------------------------------------------------------

router.post('/:id', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    const { url, events, secret, status } = req.body;

    const parsedEvents = Array.isArray(events) ? events : (events ? [events] : []);

    const input = { url, events: parsedEvents };
    if (secret && secret.trim().length > 0) {
      input.secret = secret;
    }
    if (status) {
      input.status = status;
    }

    await webhookService.update(req.tenant.id, req.params.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('webhooks.updated') : 'Webhook updated');
    return res.redirect(`/webhooks/${req.params.id}`);
  } catch (err) {
    log.warn({ err, webhookId: req.params.id }, 'webhooks-routes: failed to update webhook');

    if (err.code === 'validation_error') {
      try {
        const webhook = await webhookService.getById(req.tenant.id, req.params.id);
        const deliveries = await webhookService.getDeliveries(req.params.id, { limit: 50 });

        return res.status(400).render('webhooks/detail', {
          layout: 'layouts/main',
          title: req.t ? req.t('webhooks.detail.title') : 'Webhook Detail',
          webhook,
          deliveries,
          events: webhookService.VALID_EVENTS,
          error: err.message,
          csrfToken: req.csrfToken ? req.csrfToken() : '',
        });
      } catch (innerErr) {
        return next(innerErr);
      }
    }

    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /webhooks/:id/delete — delete webhook
// ---------------------------------------------------------------------------

router.post('/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await webhookService.remove(req.tenant.id, req.params.id);

    log.info({ webhookId: req.params.id, tenantId: req.tenant.id }, 'webhooks-routes: webhook deleted');

    if (req.flash) req.flash('success', req.t ? req.t('webhooks.deleted') : 'Webhook deleted');
    return res.redirect('/webhooks');
  } catch (err) {
    log.warn({ err, webhookId: req.params.id }, 'webhooks-routes: failed to delete webhook');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /webhooks/:id/test — send test delivery
// ---------------------------------------------------------------------------

router.post('/:id/test', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    const webhook = await webhookService.getById(req.tenant.id, req.params.id);

    // Publish a test event
    await webhookService.publishEvent(req.tenant.id, 'webhook.test', {
      webhook_id: webhook.id,
      message: 'This is a test delivery',
      timestamp: new Date().toISOString(),
    });

    log.info({ webhookId: req.params.id, tenantId: req.tenant.id }, 'webhooks-routes: test delivery sent');

    if (req.flash) req.flash('success', req.t ? req.t('webhooks.testSent') : 'Test delivery enqueued');
    return res.redirect(`/webhooks/${req.params.id}`);
  } catch (err) {
    log.warn({ err, webhookId: req.params.id }, 'webhooks-routes: failed to send test delivery');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
