'use strict';

/**
 * Authentication routes — registration, login, logout, password reset,
 * and invitation acceptance.
 *
 * All routes render EJS views from `views/auth/` using the auth layout.
 * Error handling catches service errors and re-renders the form with the
 * error message so the user can correct their input.
 *
 * References:
 *   - requirements.md §1.1–1.8 (auth flows)
 *   - requirements.md §2.3 (invitation acceptance)
 *   - design.md "Auth Module", "RBAC Module"
 */

const { Router } = require('express');

const { register, login, requestPasswordReset, resetPassword } = require('./auth-service');
const { checkLoginRateLimit, recordLoginFailure, resetLoginRateLimit } = require('./login-rate-limit');
const { createSession, destroySession } = require('../../server/middleware/session');
const { acceptInvitation } = require('../rbac/rbac-service');

const router = Router();

// ---------------------------------------------------------------------------
// GET /register
// ---------------------------------------------------------------------------

router.get('/register', (req, res) => {
  res.render('auth/register', {
    layout: 'layouts/auth',
    title: req.t ? req.t('auth.register.title') : 'Register',
    error: null,
    email: '',
    name: '',
  });
});

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;

  try {
    const result = await register({ email, password, name });
    await createSession(res, result.user.id, result.tenant.id);
    return res.redirect('/dashboard');
  } catch (err) {
    return res.render('auth/register', {
      layout: 'layouts/auth',
      title: req.t ? req.t('auth.register.title') : 'Register',
      error: err.message || 'Registration failed',
      email: email || '',
      name: name || '',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /login
// ---------------------------------------------------------------------------

router.get('/login', (req, res) => {
  res.render('auth/login', {
    layout: 'layouts/auth',
    title: req.t ? req.t('auth.login.title') : 'Login',
    error: null,
    email: '',
  });
});

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  try {
    await checkLoginRateLimit(ip);

    const result = await login(email, password, ip);

    await resetLoginRateLimit(ip);
    await createSession(res, result.session.userId, result.session.activeTenantId);

    return res.redirect('/dashboard');
  } catch (err) {
    // Record failure for rate limiting (only if it was an auth error, not rate limit)
    if (err.name !== 'RateLimitError') {
      try {
        await recordLoginFailure(ip);
      } catch (_e) {
        // swallow rate-limit recording errors
      }
    }

    return res.render('auth/login', {
      layout: 'layouts/auth',
      title: req.t ? req.t('auth.login.title') : 'Login',
      error: err.message || 'Login failed',
      email: email || '',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------

router.post('/logout', async (req, res) => {
  try {
    await destroySession(res, req.sessionId);
  } catch (_err) {
    // swallow — best effort
  }
  return res.redirect('/login');
});

// ---------------------------------------------------------------------------
// GET /forgot-password
// ---------------------------------------------------------------------------

router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', {
    layout: 'layouts/auth',
    title: req.t ? req.t('auth.forgot.title') : 'Forgot Password',
    error: null,
    success: null,
  });
});

// ---------------------------------------------------------------------------
// POST /forgot-password
// ---------------------------------------------------------------------------

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    await requestPasswordReset(email);
    return res.render('auth/forgot-password', {
      layout: 'layouts/auth',
      title: req.t ? req.t('auth.forgot.title') : 'Forgot Password',
      error: null,
      success: req.t
        ? req.t('auth.forgot.success')
        : 'If that email is registered, a reset link has been sent.',
    });
  } catch (err) {
    return res.render('auth/forgot-password', {
      layout: 'layouts/auth',
      title: req.t ? req.t('auth.forgot.title') : 'Forgot Password',
      error: err.message || 'An error occurred',
      success: null,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /reset-password/:token
// ---------------------------------------------------------------------------

router.get('/reset-password/:token', (req, res) => {
  res.render('auth/reset-password', {
    layout: 'layouts/auth',
    title: req.t ? req.t('auth.reset.title') : 'Reset Password',
    token: req.params.token,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /reset-password/:token
// ---------------------------------------------------------------------------

router.post('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    await resetPassword(token, password);
    // Redirect to login with a success flash via query param
    return res.redirect('/login?reset=success');
  } catch (err) {
    return res.render('auth/reset-password', {
      layout: 'layouts/auth',
      title: req.t ? req.t('auth.reset.title') : 'Reset Password',
      token,
      error: err.message || 'Reset failed',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /invitations/:token
// ---------------------------------------------------------------------------

router.get('/invitations/:token', (req, res) => {
  res.render('auth/accept-invitation', {
    layout: 'layouts/auth',
    title: req.t ? req.t('auth.invitation.title') : 'Accept Invitation',
    token: req.params.token,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /invitations/:token
// ---------------------------------------------------------------------------

router.post('/invitations/:token', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    const result = await acceptInvitation(token, password);
    await createSession(res, result.user.id, result.tenantId);
    return res.redirect('/dashboard');
  } catch (err) {
    return res.render('auth/accept-invitation', {
      layout: 'layouts/auth',
      title: req.t ? req.t('auth.invitation.title') : 'Accept Invitation',
      token,
      error: err.message || 'Invitation acceptance failed',
    });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
