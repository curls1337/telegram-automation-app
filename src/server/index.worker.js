'use strict';

/**
 * Worker process entry point — initializes all BullMQ workers.
 *
 * Start command: `node src/server/index.worker.js` (or `npm run start:worker`)
 *
 * Responsibilities:
 *   - Initialize all BullMQ workers (one per queue)
 *   - Start the connection sweeper cron (60s interval)
 *   - Graceful shutdown on SIGTERM/SIGINT (close workers, DB, Redis, queues)
 *
 * References:
 *   - design.md "Job Queue Topology (BullMQ)" — worker processes
 *   - requirements.md §22.1 — separate worker process
 */

const { getEnv } = require('../shared/env');
const { getLogger } = require('../infra/logger');
const { closeDb } = require('../infra/db');
const { closeRedis } = require('../infra/redis');
const { closeQueues } = require('../infra/queues');

// Import workers — each module exports a start/stop interface
const connectionRuntimeWorker = require('../workers/connection-runtime.worker');
const scheduledPostsWorker = require('../workers/scheduled-posts.worker');
const broadcastsWorker = require('../workers/broadcasts.worker');
const dripStepsWorker = require('../workers/drip-steps.worker');
const forwardsWorker = require('../workers/forwards.worker');
const memberCleanupWorker = require('../workers/member-cleanup.worker');
const webhookDeliveriesWorker = require('../workers/webhook-deliveries.worker');
const backupsWorker = require('../workers/backups.worker');

// Cron-style workers that run on intervals
const analyticsRollup = require('../workers/analytics-rollup.worker');
const connectionSweeper = require('../workers/connection-sweeper.cron');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const env = getEnv();
  const logger = getLogger();

  logger.info({ env: env.NODE_ENV }, 'worker: starting all BullMQ workers');

  // Start BullMQ workers
  const workers = [
    connectionRuntimeWorker,
    scheduledPostsWorker,
    broadcastsWorker,
    dripStepsWorker,
    forwardsWorker,
    memberCleanupWorker,
    webhookDeliveriesWorker,
    backupsWorker,
  ];

  for (const worker of workers) {
    if (typeof worker.start === 'function') {
      worker.start();
    }
  }

  // Start cron-style workers
  analyticsRollup.startCron();
  connectionSweeper.start();

  logger.info('worker: all workers started');

  // --- Graceful shutdown ---
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'worker: graceful shutdown initiated');

    try {
      // Stop cron-style workers
      analyticsRollup.stopCron();
      connectionSweeper.stop();

      // Stop BullMQ workers
      for (const worker of workers) {
        if (typeof worker.stop === 'function') {
          await worker.stop();
        }
      }

      // Close infrastructure
      await closeQueues();
      await closeDb();
      await closeRedis();

      logger.info('worker: shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'worker: error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[worker] Fatal boot error:', err);
  process.exit(1);
});
