'use strict';

/**
 * CSRF protection middleware using csurf (session-based).
 *
 * Skips CSRF enforcement for:
 *   - /api/v1/* paths (stateless API uses API keys, not CSRF)
 *   - Non-mutating HTTP methods (GET, HEAD, OPTIONS)
 *
 * For all other routes, applies csurf protection and attaches
 * `res.locals.csrfToken` for use in EJS templates.
 *
 * References:
 *   - requirements.md §20.3 — CSRF token for all HTML forms
 *   - design.md "Web Shell" — CSRF double-submit, exclude /api/v1/*
 */

const csurf = require('csurf');

// ---------------------------------------------------------------------------
// csurf instance (session-based, cookie: false)
// ---------------------------------------------------------------------------

const csurfProtection = csurf({ cookie: false });

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * CSRF middleware that conditionally applies csurf protection.
 *
 * csurf with cookie:false stores the CSRF secret in req.session.
 * If there is no session object, we skip CSRF (unauthenticated pages
 * that need CSRF tokens must ensure a session-like object exists).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function csrfMiddleware(req, res, next) {
  // Skip /api/v1/* paths — stateless API uses API keys
  if (req.path.startsWith('/api/v1/') || req.path === '/api/v1') {
    return next();
  }

  // csurf requires req.session to be an object to store the secret.
  // If no session exists yet, create a minimal object for CSRF storage.
  if (!req.session) {
    req.session = {};
  }

  // Apply csurf protection (validates token on mutating methods,
  // generates token function on all methods)
  csurfProtection(req, res, function afterCsurf(err) {
    if (err) return next(err);
    // Attach token for EJS templates
    res.locals.csrfToken = req.csrfToken();
    return next();
  });
}

/**
 * Error handler for CSRF token validation failures.
 * Catches EBADCSRFTOKEN errors and returns 403.
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function csrfErrorHandler(err, req, res, next) {
  if (err.code !== 'EBADCSRFTOKEN') {
    return next(err);
  }

  res.status(403);

  if (req.accepts('json') || req.path.startsWith('/api/')) {
    return res.json({
      error: {
        code: 'invalid_csrf_token',
        message: 'Invalid or missing CSRF token',
      },
    });
  }

  return res.send('Forbidden — invalid CSRF token');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  csrfMiddleware,
  csrfErrorHandler,
};
