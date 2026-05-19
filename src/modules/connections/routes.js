'use strict';

/**
 * Connection routes — CRUD for Telegram connections (Bot API).
 *
 * Routes:
 *   GET  /connections          → list all connections for tenant
 *   GET  /connections/new-bot  → form to add a new bot connection
 *   POST /connections/bot      → create a bot connection
 *   GET  /connections/:id      → connection detail page
 *   POST /connections/:id/delete → delete a connection
 *
 * All routes require authentication and write operations require 'write' action.
 *
 * References:
 *   - requirements.md §4.1, §4.4, §4.6
 *   - design.md "Connection Manager" — UI routes
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const botConnectionService = require('./bot/bot-connection-service');
const userConnectionService = require('./user-mtproto/user-connection-service');
const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

const router = Router();

const TABLE = 'telegram_connections';

// ---------------------------------------------------------------------------
// GET /connections — list all connections
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const connections = await tenantQuery(req.tenant.id, TABLE)
      .orderBy('created_at', 'desc');

    return res.render('connections/list', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.list.title') : 'Connections',
      connections,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /connections/new-bot — new bot connection form
// ---------------------------------------------------------------------------

router.get('/new-bot', requireAuth(), requireAction('write'), (req, res) => {
  res.render('connections/new-bot', {
    layout: 'layouts/main',
    title: req.t ? req.t('connections.newBot.title') : 'Add Bot Connection',
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /connections/bot — create bot connection
// ---------------------------------------------------------------------------

router.post('/bot', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { token } = req.body;

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return res.render('connections/new-bot', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.newBot.title') : 'Add Bot Connection',
      error: req.t ? req.t('connections.newBot.tokenRequired') : 'Bot token is required',
    });
  }

  try {
    await botConnectionService.create(req.tenant.id, token.trim(), {
      userId: req.session.userId || (req.user && req.user.id),
      ip: req.ip,
    });

    // Flash success and redirect
    if (req.flash) req.flash('success', req.t ? req.t('connections.created') : 'Bot connection created successfully');
    return res.redirect('/connections');
  } catch (err) {
    log.warn({ err }, 'connections: failed to create bot connection');

    return res.render('connections/new-bot', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.newBot.title') : 'Add Bot Connection',
      error: err.message || 'Failed to create bot connection',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /connections/:id — connection detail
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const connection = await tenantQuery(req.tenant.id, TABLE)
      .where({ id: req.params.id })
      .first();

    if (!connection) {
      return res.status(404).render('connections/detail', {
        layout: 'layouts/main',
        title: 'Connection Not Found',
        connection: null,
        error: req.t ? req.t('connections.notFound') : 'Connection not found',
      });
    }

    return res.render('connections/detail', {
      layout: 'layouts/main',
      title: connection.display_name || 'Connection Detail',
      connection,
      error: null,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /connections/:id/delete — delete connection
// ---------------------------------------------------------------------------

router.post('/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await botConnectionService.delete(req.params.id, req.tenant.id, {
      userId: req.session.userId || (req.user && req.user.id),
      ip: req.ip,
    });

    if (req.flash) req.flash('success', req.t ? req.t('connections.deleted') : 'Connection deleted successfully');
    return res.redirect('/connections');
  } catch (err) {
    log.warn({ err, connectionId: req.params.id }, 'connections: failed to delete connection');

    if (err.httpStatus === 404) {
      return res.status(404).render('connections/detail', {
        layout: 'layouts/main',
        title: 'Connection Not Found',
        connection: null,
        error: err.message,
      });
    }

    return next(err);
  }
});

// ---------------------------------------------------------------------------
// User Connection (MTProto) Routes
// ---------------------------------------------------------------------------

// GET /connections/new-user — new user connection form with ban risk disclaimer
router.get('/new-user', requireAuth(), requireAction('write'), (req, res) => {
  res.render('connections/new-user', {
    layout: 'layouts/main',
    title: req.t ? req.t('connections.newUser.title') : 'Add User Connection (MTProto)',
    error: null,
  });
});

// POST /connections/user — start user login (send OTP)
router.post('/user', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { api_id, api_hash, phone } = req.body;

  if (!api_id || !api_hash || !phone) {
    return res.render('connections/new-user', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.newUser.title') : 'Add User Connection (MTProto)',
      error: req.t ? req.t('connections.newUser.allFieldsRequired') : 'All fields are required (API ID, API Hash, Phone)',
    });
  }

  try {
    const result = await userConnectionService.startUserLogin(
      req.tenant.id,
      api_id,
      api_hash.trim(),
      phone.trim(),
      {
        userId: req.session.userId || (req.user && req.user.id),
        ip: req.ip,
      }
    );

    return res.redirect(`/connections/user/otp/${result.loginId}`);
  } catch (err) {
    log.warn({ err }, 'connections: failed to start user login');

    return res.render('connections/new-user', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.newUser.title') : 'Add User Connection (MTProto)',
      error: err.message || 'Failed to start login',
    });
  }
});

// GET /connections/user/otp/:loginId — OTP input form
router.get('/user/otp/:loginId', requireAuth(), requireAction('write'), (req, res) => {
  res.render('connections/otp', {
    layout: 'layouts/main',
    title: req.t ? req.t('connections.otp.title') : 'Enter OTP Code',
    loginId: req.params.loginId,
    error: null,
  });
});

// POST /connections/user/otp — submit OTP code
router.post('/user/otp', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { loginId, code } = req.body;

  if (!loginId || !code) {
    return res.render('connections/otp', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.otp.title') : 'Enter OTP Code',
      loginId: loginId || '',
      error: req.t ? req.t('connections.otp.codeRequired') : 'OTP code is required',
    });
  }

  try {
    const result = await userConnectionService.submitOtp(loginId, code.trim());

    // Check if 2FA is needed
    if (result && result.needs2FA) {
      return res.redirect(`/connections/user/2fa/${result.loginId}`);
    }

    // Success — redirect to connections list
    if (req.flash) req.flash('success', req.t ? req.t('connections.created') : 'User connection created successfully');
    return res.redirect('/connections');
  } catch (err) {
    log.warn({ err, loginId }, 'connections: OTP verification failed');

    return res.render('connections/otp', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.otp.title') : 'Enter OTP Code',
      loginId: loginId || '',
      error: err.message || 'OTP verification failed',
    });
  }
});

// GET /connections/user/2fa/:loginId — 2FA password input form
router.get('/user/2fa/:loginId', requireAuth(), requireAction('write'), (req, res) => {
  res.render('connections/2fa', {
    layout: 'layouts/main',
    title: req.t ? req.t('connections.2fa.title') : 'Two-Factor Authentication',
    loginId: req.params.loginId,
    error: null,
  });
});

// POST /connections/user/2fa — submit 2FA password
router.post('/user/2fa', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { loginId, password } = req.body;

  if (!loginId || !password) {
    return res.render('connections/2fa', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.2fa.title') : 'Two-Factor Authentication',
      loginId: loginId || '',
      error: req.t ? req.t('connections.2fa.passwordRequired') : '2FA password is required',
    });
  }

  try {
    await userConnectionService.submit2FA(loginId, password);

    if (req.flash) req.flash('success', req.t ? req.t('connections.created') : 'User connection created successfully');
    return res.redirect('/connections');
  } catch (err) {
    log.warn({ err, loginId }, 'connections: 2FA verification failed');

    return res.render('connections/2fa', {
      layout: 'layouts/main',
      title: req.t ? req.t('connections.2fa.title') : 'Two-Factor Authentication',
      loginId: loginId || '',
      error: err.message || '2FA verification failed',
    });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
