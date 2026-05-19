'use strict';

/**
 * Connection Sweeper Cron — ensures all active connections have a running runtime.
 *
 * Runs every 60 seconds. Scans telegram_connections with status='active',
 * checks if a Redis lock exists for each. If not locked (meaning no worker
 * is running it), publishes a 'start' event to the connection-events channel
 * so a worker picks it up.
 *
 * This handles:
 *   - Worker crashes (lock expires after 30s TTL)
 *   - New deployments where connections need to be re-started
 *   - Race conditions where a start event was missed
 *
 * References:
 *   - design.md "Connection Manager" — sweeper cron every 60s
 *   - tasks.md §8.5
 */

const { getDb } = require('../infra/db');
const { getRedis, getRedisPublisher } = require('../infra/redis');
const { getLogger } = require('../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;
const TABLE = 'telegram_connections';
const LOCK_PREFIX = 'connection-lock:';
const CHANNEL = 'connection-events';

// ---------------------------------------------------------------------------
// Sweep logic
// ---------------------------------------------------------------------------

/**
 * Perform a single sweep: find active connections without locks and
 * publish start events for them.
 *
 * @returns {Promise<number>} Number of connections started
 */
async function sweep() {
  const log = getLogger();
  const db = getDb();
  const redis = getRedis();
  const publisher = getRedisPublisher();

  // Query all active connections
  const activeConnections = await db(TABLE)
    .where({ status: 'active' })
    .select('id');

  let startedCount = 0;

  for (const connection of activeConnections) {
    const lockKey = `${LOCK_PREFIX}${connection.id}`;

    // Check if lock exists
    const exists = await redis.exists(lockKey);

    if (!exists) {
      // No lock — publish start event
      await publisher.publish(CHANNEL, JSON.stringify({
        action: 'start',
        connectionId: connection.id,
      }));
      startedCount++;
    }
  }

  if (startedCount > 0) {
    log.info(
      { startedCount, totalActive: activeConnections.length },
      'connection-sweeper: published start events for unlocked connections'
    );
  }

  return startedCount;
}

// ---------------------------------------------------------------------------
// Cron runner
// ---------------------------------------------------------------------------

/** @type {NodeJS.Timeout|null} */
let intervalHandle = null;

/**
 * Start the sweeper cron. Runs sweep() every 60 seconds.
 */
function start() {
  const log = getLogger();

  log.info({ intervalMs: SWEEP_INTERVAL_MS }, 'connection-sweeper: starting');

  // Run immediately on start
  sweep().catch((err) => {
    log.error({ err }, 'connection-sweeper: error during initial sweep');
  });

  // Then run every 60s
  intervalHandle = setInterval(() => {
    sweep().catch((err) => {
      log.error({ err }, 'connection-sweeper: error during sweep');
    });
  }, SWEEP_INTERVAL_MS);
}

/**
 * Stop the sweeper cron.
 */
function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  sweep,
  // Constants exported for testing
  SWEEP_INTERVAL_MS,
  LOCK_PREFIX,
};
