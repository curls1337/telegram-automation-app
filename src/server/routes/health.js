'use strict';

/**
 * Health-check routes for monitoring and load balancer probes.
 *
 * Endpoints:
 *   GET /health      — shallow check: PG (SELECT 1) + Redis (PING) within 3s
 *   GET /health/deep — deep check: PG + Redis + queue lag for all registered queues
 *
 * Returns:
 *   200 { status: 'ok', checks: {...} }       — all checks pass
 *   503 { status: 'degraded', checks: {...} } — one or more checks failed
 *
 * References:
 *   - requirements.md §21.3 — health-check endpoint
 *   - design.md "Healthcheck endpoint web /health"
 */

const { Router } = require('express');

const { getDb } = require('../../infra/db');
const { pingRedis } = require('../../infra/redis');
const { getRegisteredQueueNames, getQueue } = require('../../infra/queues');

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. Returns the promise result or a timeout
 * sentinel on expiry.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T|Symbol>}
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(Symbol.for('health.timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Check PostgreSQL connectivity by running SELECT 1.
 *
 * @returns {Promise<boolean>}
 */
async function checkPostgres() {
  try {
    const db = getDb();
    const result = await withTimeout(db.raw('SELECT 1 AS ok'), HEALTH_TIMEOUT_MS);
    if (result === Symbol.for('health.timeout')) return false;
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Check Redis connectivity via PING (uses the built-in pingRedis with timeout).
 *
 * @returns {Promise<boolean>}
 */
async function checkRedis() {
  return pingRedis(HEALTH_TIMEOUT_MS);
}

/**
 * Check queue lag — returns waiting count per registered queue.
 *
 * @returns {Promise<{ name: string, waiting: number, ok: boolean }[]>}
 */
async function checkQueues() {
  const names = getRegisteredQueueNames();
  const results = [];

  for (const name of names) {
    try {
      const queue = getQueue(name);
      const countResult = await withTimeout(queue.getWaitingCount(), HEALTH_TIMEOUT_MS);
      if (countResult === Symbol.for('health.timeout')) {
        results.push({ name, waiting: -1, ok: false });
      } else {
        results.push({ name, waiting: countResult, ok: true });
      }
    } catch (_err) {
      results.push({ name, waiting: -1, ok: false });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health — shallow health check (PG + Redis)
 */
router.get('/health', async (_req, res) => {
  const [pgOk, redisOk] = await Promise.all([checkPostgres(), checkRedis()]);

  const checks = {
    postgres: pgOk ? 'ok' : 'fail',
    redis: redisOk ? 'ok' : 'fail',
  };

  const allOk = pgOk && redisOk;
  const status = allOk ? 'ok' : 'degraded';
  const httpCode = allOk ? 200 : 503;

  return res.status(httpCode).json({ status, checks });
});

/**
 * GET /health/deep — deep health check (PG + Redis + queue lag)
 */
router.get('/health/deep', async (_req, res) => {
  const [pgOk, redisOk, queueResults] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkQueues(),
  ]);

  const queuesOk = queueResults.every((q) => q.ok);

  const checks = {
    postgres: pgOk ? 'ok' : 'fail',
    redis: redisOk ? 'ok' : 'fail',
    queues: queueResults.reduce((acc, q) => {
      acc[q.name] = { waiting: q.waiting, status: q.ok ? 'ok' : 'fail' };
      return acc;
    }, {}),
  };

  const allOk = pgOk && redisOk && queuesOk;
  const status = allOk ? 'ok' : 'degraded';
  const httpCode = allOk ? 200 : 503;

  return res.status(httpCode).json({ status, checks });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
