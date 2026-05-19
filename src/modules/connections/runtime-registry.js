'use strict';

/**
 * Connection Runtime Registry — singleton map of active Telegram connections.
 *
 * Responsibilities:
 *   - Track which connections are running in this worker process
 *   - Acquire/release distributed Redis locks (connection-lock:<id>)
 *   - Refresh lock TTL every 10s to maintain ownership
 *   - Provide lookup for active client instances
 *
 * The lock mechanism ensures only one worker instance runs a given connection
 * at any time. Lock TTL is 30s, refreshed every 10s. If a worker crashes,
 * the lock expires and the sweeper cron will re-assign the connection.
 *
 * References:
 *   - design.md "ConnectionRuntimeRegistry" — singleton, Redis lock TTL 30s,
 *     refresh every 10s
 */

const { getRedis } = require('../../infra/redis');
const { getLogger } = require('../../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_PREFIX = 'connection-lock:';
const LOCK_TTL_SECONDS = 30;
const LOCK_REFRESH_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Registry state (singleton)
// ---------------------------------------------------------------------------

/**
 * Map of connectionId → { client, lockInterval }
 * @type {Map<string, { client: unknown, lockInterval: NodeJS.Timeout|null }>}
 */
const registry = new Map();

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire a distributed lock for a connection.
 * Uses Redis SET NX EX pattern for atomic lock acquisition.
 *
 * If acquired, starts a setInterval to refresh the TTL every 10s.
 *
 * @param {string} connectionId
 * @returns {Promise<boolean>} true if lock was acquired, false if already held
 */
async function acquire(connectionId) {
  const log = getLogger();
  const redis = getRedis();
  const lockKey = `${LOCK_PREFIX}${connectionId}`;

  // SET key value NX EX ttl — atomic acquire
  const result = await redis.set(lockKey, 'locked', 'EX', LOCK_TTL_SECONDS, 'NX');

  if (result !== 'OK') {
    return false;
  }

  // Start refresh interval
  const interval = setInterval(async () => {
    try {
      await redis.expire(lockKey, LOCK_TTL_SECONDS);
    } catch (err) {
      log.warn({ err, connectionId }, 'runtime-registry: failed to refresh lock TTL');
    }
  }, LOCK_REFRESH_INTERVAL_MS);

  // Store interval reference (client will be registered separately)
  const existing = registry.get(connectionId);
  if (existing) {
    existing.lockInterval = interval;
  } else {
    registry.set(connectionId, { client: null, lockInterval: interval });
  }

  log.info({ connectionId }, 'runtime-registry: lock acquired');
  return true;
}

/**
 * Release the lock for a connection.
 * Clears the refresh interval and deletes the Redis lock key.
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function release(connectionId) {
  const log = getLogger();
  const redis = getRedis();
  const lockKey = `${LOCK_PREFIX}${connectionId}`;

  const entry = registry.get(connectionId);
  if (entry && entry.lockInterval) {
    clearInterval(entry.lockInterval);
  }

  // Delete lock key
  try {
    await redis.del(lockKey);
  } catch (err) {
    log.warn({ err, connectionId }, 'runtime-registry: failed to delete lock key');
  }

  // Remove from map
  registry.delete(connectionId);

  log.info({ connectionId }, 'runtime-registry: lock released');
}

/**
 * Register a client instance for a connection.
 * The connection should already have a lock acquired.
 *
 * @param {string} connectionId
 * @param {unknown} client - Telegraf bot instance or GramJS client
 */
function register(connectionId, client) {
  const entry = registry.get(connectionId);
  if (entry) {
    entry.client = client;
  } else {
    registry.set(connectionId, { client, lockInterval: null });
  }
}

/**
 * Get the client instance for a connection.
 *
 * @param {string} connectionId
 * @returns {unknown|null} The client instance or null if not running
 */
function get(connectionId) {
  const entry = registry.get(connectionId);
  return entry ? entry.client : null;
}

/**
 * Check if a connection is currently running in this process.
 *
 * @param {string} connectionId
 * @returns {boolean}
 */
function isRunning(connectionId) {
  return registry.has(connectionId);
}

/**
 * Release all locks. Used during graceful shutdown.
 *
 * @returns {Promise<void>}
 */
async function releaseAll() {
  const log = getLogger();
  const ids = Array.from(registry.keys());

  log.info({ count: ids.length }, 'runtime-registry: releasing all locks');

  await Promise.all(ids.map((id) => release(id)));
}

/**
 * Get the count of currently running connections.
 *
 * @returns {number}
 */
function size() {
  return registry.size;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  acquire,
  release,
  register,
  get,
  isRunning,
  releaseAll,
  size,
  // Constants exported for testing
  LOCK_PREFIX,
  LOCK_TTL_SECONDS,
  LOCK_REFRESH_INTERVAL_MS,
};
