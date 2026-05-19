'use strict';

/**
 * Web process entry point — boots the Express application, mounts routes,
 * and starts listening on the configured PORT.
 *
 * Start command: `node src/server/index.web.js` (or `npm run start:web`)
 *
 * Responsibilities:
 *   - Initialize i18n before anything else
 *   - Create the Express app (middleware stack)
 *   - Force HTTPS redirect in production (via x-forwarded-proto header)
 *   - Mount auth routes, dashboard route, health routes
 *   - Listen on PORT
 *   - Graceful shutdown on SIGTERM/SIGINT (close server, DB, Redis)
 *
 * References:
 *   - requirements.md §20.2 — HTTPS enforcement
 *   - requirements.md §21.2 — config from env
 *   - requirements.md §21.3 — health-check endpoint
 *   - design.md "Web Shell" — entry point, middleware ordering
 */

const { getEnv } = require('../shared/env');
const { initI18n } = require('../modules/i18n/i18n-service');
const { createApp } = require('./express-app');
const { closeDb } = require('../infra/db');
const { closeRedis } = require('../infra/redis');
const { getLogger } = require('../infra/logger');
const { requireAuth } = require('./middleware/rbac');

const authRoutes = require('../modules/auth/routes');
const healthRoutes = require('./routes/health');
const metricsRoutes = require('./routes/metrics');
const mediaRoutes = require('../modules/media/routes');
const autoReplyRoutes = require('../modules/auto-reply/routes');
const connectionsRoutes = require('../modules/connections/routes');
const subscribersRoutes = require('../modules/subscribers/routes');
const schedulerRoutes = require('../modules/scheduler/routes');
const broadcastsRoutes = require('../modules/broadcasts/routes');
const dripRoutes = require('../modules/drip/routes');
const forwardsRoutes = require('../modules/forwards/routes');
const membersRoutes = require('../modules/members/routes');
const adminRoutes = require('../modules/plans/admin-routes');
const adminPanelRoutes = require('./routes/admin');
const apiV1Routes = require('../modules/api/v1/routes');
const apiKeysRoutes = require('../modules/api/v1/api-keys-routes');
const webhooksRoutes = require('../modules/webhooks-out/routes');
const analyticsRoutes = require('../modules/analytics/routes');
const backupRoutes = require('../modules/backup/routes');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const env = getEnv();
  const logger = getLogger();

  // Initialize i18n (load locale files)
  await initI18n();

  // Create Express app with full middleware stack
  const app = createApp();

  // --- Force HTTPS in production ---
  // Must be mounted before routes but after trust proxy is set.
  // In development, skip the redirect so local HTTP works.
  if (env.NODE_ENV === 'production') {
    app.use(function forceHttps(req, res, next) {
      if (req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
      }
      return next();
    });
  }

  // --- Mount auth routes ---
  app.use('/', authRoutes);

  // --- Mount dashboard route ---
  app.get('/dashboard', requireAuth(), (req, res) => {
    res.render('dashboard/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('dashboard.title') : 'Dashboard',
      connectionsCount: 0,
      scheduledCount: 0,
      broadcastsCount: 0,
      subscribersCount: 0,
    });
  });

  // --- Mount media routes ---
  app.use('/media', mediaRoutes);

  // --- Mount auto-reply routes ---
  app.use('/auto-reply', autoReplyRoutes);

  // --- Mount connections routes ---
  app.use('/connections', connectionsRoutes);

  // --- Mount subscribers routes ---
  app.use('/subscribers', subscribersRoutes);

  // --- Mount scheduler routes ---
  app.use('/posts', schedulerRoutes);

  // --- Mount broadcasts routes ---
  app.use('/broadcasts', broadcastsRoutes);

  // --- Mount drip campaign routes ---
  app.use('/drip', dripRoutes);

  // --- Mount forwards routes ---
  app.use('/forwards', forwardsRoutes);

  // --- Mount members routes ---
  app.use('/members', membersRoutes);

  // --- Mount admin routes (plans/subscriptions + tenants/audit/system) ---
  app.use('/admin', adminRoutes);
  app.use('/admin', adminPanelRoutes);

  // --- Mount API v1 routes (REST API — no CSRF, own auth) ---
  app.use('/api/v1', apiV1Routes);

  // --- Mount API keys UI routes ---
  app.use('/api-keys', apiKeysRoutes);

  // --- Mount webhooks UI routes ---
  app.use('/webhooks', webhooksRoutes);

  // --- Mount analytics routes ---
  app.use('/analytics', analyticsRoutes);

  // --- Mount backup routes ---
  app.use('/backup', backupRoutes);

  // --- Mount health routes ---
  app.use('/', healthRoutes);

  // --- Mount metrics routes ---
  app.use('/', metricsRoutes);

  // --- Start server ---
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'web: server started');
  });

  // --- Graceful shutdown ---
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'web: graceful shutdown initiated');

    // Stop accepting new connections
    server.close(async () => {
      try {
        await closeDb();
        await closeRedis();
        logger.info('web: shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'web: error during shutdown');
        process.exit(1);
      }
    });

    // Force exit after 30s if connections don't drain
    setTimeout(() => {
      logger.warn('web: forced shutdown after timeout');
      process.exit(1);
    }, 30000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[web] Fatal boot error:', err);
  process.exit(1);
});
