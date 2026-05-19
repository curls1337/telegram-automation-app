'use strict';

/**
 * Express application factory — creates and configures the Express app with
 * all middleware in the correct order.
 *
 * Middleware order:
 *   1. Helmet (CSP with nonce)
 *   2. trust proxy
 *   3. request-id (generate req.id)
 *   4. pino-http style request logging
 *   5. body parsers (urlencoded + json)
 *   6. session middleware
 *   7. i18n middleware
 *   8. tenant-context middleware
 *   9. CSRF middleware
 *  10. EJS view engine setup
 *  11. Routes (placeholder)
 *  12. CSRF error handler
 *  13. Error handler
 *
 * This module does NOT call app.listen() — that is handled by the web
 * entry point (src/server/index.web.js).
 *
 * References:
 *   - requirements.md §20.2 — HTTPS enforcement, trust proxy
 *   - requirements.md §20.4 — CSP headers
 *   - design.md "Web Shell" — middleware ordering
 */

const path = require('path');

const express = require('express');

const { getEnv } = require('../shared/env');
const { newId } = require('../shared/ids');
const { getLogger } = require('../infra/logger');
const { helmetMiddleware } = require('./middleware/csp');
const { sessionMiddleware } = require('./middleware/session');
const { i18nMiddleware } = require('./middleware/i18n');
const { tenantContextMiddleware } = require('./middleware/tenant-context');
const { csrfMiddleware, csrfErrorHandler } = require('./middleware/csrf');
const { errorHandler } = require('./middleware/error-handler');

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Create and configure the Express application.
 *
 * @returns {import('express').Application}
 */
function createApp() {
  const env = getEnv();
  const app = express();

  // --- 1. Helmet (CSP with nonce) ---
  app.use(helmetMiddleware);

  // --- 2. Trust proxy ---
  app.set('trust proxy', env.TRUST_PROXY);

  // --- 3. Request ID ---
  app.use(function requestId(req, _res, next) {
    req.id = req.headers['x-request-id'] || newId();
    next();
  });

  // --- 4. Request logging (pino) ---
  const logger = getLogger();
  app.use(function requestLogger(req, res, next) {
    const start = Date.now();
    const log = logger.child({ reqId: req.id });

    res.on('finish', function onFinish() {
      const duration = Date.now() - start;
      log.info(
        {
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          duration,
        },
        'request completed'
      );
    });

    req.log = log;
    next();
  });

  // --- 5. Body parsers ---
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  // --- 6. Session middleware ---
  app.use(sessionMiddleware);

  // --- 7. i18n middleware ---
  app.use(i18nMiddleware);

  // --- 8. Tenant context middleware ---
  app.use(tenantContextMiddleware);

  // --- 9. CSRF middleware ---
  app.use(csrfMiddleware);

  // --- 10. EJS view engine ---
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../../views'));

  // --- 11. Static files ---
  app.use(express.static(path.join(__dirname, '../../public')));

  // --- 12. Routes placeholder ---
  // Routes will be mounted here by the web entry point or route modules.
  // Example: app.use('/', require('../modules/auth/routes'));

  // --- 13. CSRF error handler ---
  app.use(csrfErrorHandler);

  // --- 14. Error handler ---
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createApp,
};
