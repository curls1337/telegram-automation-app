'use strict';

/**
 * Redis access layer (ioredis 5.x lazy singletons).
 *
 * Responsibilities:
 *   - Build and cache a primary ioredis client for general commands
 *     (BullMQ producer side, session store, rate limiters, caches, locks).
 *   - Build and cache a separate subscriber client for pub/sub
 *     (`SUBSCRIBE` / `PSUBSCRIBE` puts the connection into a mode that
 *     can no longer issue regular commands, so it must not be shared).
 *   - Expose the primary client as the publisher (publishing does not
 *     enter subscribe mode and stays multiplexed with normal commands).
 *   - Apply a reconnect strategy with exponential backoff (100ms → 30s).
 *   - Configure BullMQ-friendly defaults (`maxRetriesPerRequest: null`,
 *     `enableReadyCheck: false`).
 *   - Defer the actual TCP connect (`lazyConnect: true`) so importing this
 *     module never opens a socket — boot order stays deterministic.
 *   - Provide `closeRedis()` for graceful shutdown and tests, and
 *     `pingRedis(timeoutMs)` for health checks (used by `/health`).
 *
 * References:
 *   - requirements.md §22.3 — Redis-backed session, rate limit, queues.
 *   - design.md "Tech stack" — Redis as cache, queue, distributed lock.
 *   - design.md "Healthcheck endpoint web `/health` (… PING ke Redis)".
 *
 * NOTE: the project logger (task 2.7) is not built yet, so transient
 * connection errors are forwarded to `console.error` with a stable
 * `[redis]` prefix. Once `src/shared/logger.js` lands, swap the handler
 * for the structured logger without changing the public API of this file.
 */

const Redis = require('ioredis');

const { getEnv } = require('../shared/env');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RECONNECT_MIN_MS = 100;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_PING_TIMEOUT_MS = 3_000;

/**
 * Exponential backoff with full-jitter cap.
 *   attempt 1 → 100 ms
 *   attempt 2 → 200 ms
 *   attempt 3 → 400 ms
 *   …
 *   capped at 30 s
 *
 * Returning a number tells ioredis to retry after that many milliseconds.
 *
 * @param {number} times 1-indexed retry attempt counter from ioredis
 * @returns {number} delay in ms before next reconnect attempt
 */
function retryStrategy(times) {
  const exp = RECONNECT_MIN_MS * 2 ** Math.max(0, times - 1);
  return Math.min(RECONNECT_MAX_MS, exp);
}

/**
 * Build the ioredis options object shared by every client (primary and
 * subscriber). `role` is used purely to label the error logs.
 *
 * @param {'primary'|'subscriber'} role
 * @returns {import('ioredis').RedisOptions}
 */
function buildRedisOptions(role) {
  return {
    // BullMQ requires `maxRetriesPerRequest: null` so blocking commands
    // (BRPOPLPUSH, XREADGROUP, …) do not error out after N retries.
    maxRetriesPerRequest: null,
    // BullMQ explicitly recommends disabling the ready check; otherwise
    // ioredis issues `INFO` before queueing commands and that races with
    // the worker's first BLPOP on slow Redis instances.
    enableReadyCheck: false,
    // Defer the TCP connect until the first command (or an explicit
    // `connect()`), so `require('./redis')` cannot trip during tests or
    // before env validation has run.
    lazyConnect: true,
    retryStrategy,
    // Auto-resubscribe to channels and re-run any pending command after a
    // reconnect — important for the subscriber client and for BullMQ
    // workers that hold blocking connections across short Redis blips.
    autoResubscribe: true,
    autoResendUnfulfilledCommands: true,
    // Tag the connection name so it is easy to spot in `CLIENT LIST`.
    connectionName: `tg-automation:${role}`,
  };
}

/**
 * Attach a uniform error handler. We never throw out of the listener — that
 * would crash the process on any transient TCP hiccup.
 *
 * @param {import('ioredis').Redis} client
 * @param {'primary'|'subscriber'} role
 */
function attachErrorHandler(client, role) {
  client.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[redis:${role}] connection error: ${err && err.message ? err.message : err}`);
  });
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

/** @type {import('ioredis').Redis|undefined} */
let primary;
/** @type {import('ioredis').Redis|undefined} */
let subscriber;

/**
 * Return the primary Redis client. Used for general commands: BullMQ
 * producer side, sessions, rate limiters, caches, distributed locks, and
 * pub/sub *publishing*.
 *
 * @returns {import('ioredis').Redis}
 */
function getRedis() {
  if (!primary) {
    const env = getEnv();
    primary = new Redis(env.REDIS_URL, buildRedisOptions('primary'));
    attachErrorHandler(primary, 'primary');
  }
  return primary;
}

/**
 * Return the dedicated subscriber Redis client. Required because issuing
 * `SUBSCRIBE` / `PSUBSCRIBE` puts the connection into subscribe mode,
 * after which it can no longer execute normal commands.
 *
 * Each call returns the same instance; callers should reuse it and
 * register additional channels via `.subscribe()` rather than building
 * one client per channel.
 *
 * @returns {import('ioredis').Redis}
 */
function getRedisSubscriber() {
  if (!subscriber) {
    const env = getEnv();
    subscriber = new Redis(env.REDIS_URL, buildRedisOptions('subscriber'));
    attachErrorHandler(subscriber, 'subscriber');
  }
  return subscriber;
}

/**
 * Return the client to use for `PUBLISH` calls. Publishing does not put
 * the connection into subscribe mode, so the primary client is reused —
 * one fewer TCP connection per process.
 *
 * @returns {import('ioredis').Redis}
 */
function getRedisPublisher() {
  return getRedis();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Gracefully disconnect every cached client. Idempotent — safe to call
 * during shutdown handlers and from tests that recycle the singleton.
 *
 * Uses `quit()` so any in-flight commands are flushed before the socket
 * is closed; falls back to `disconnect()` if `quit()` rejects (e.g. the
 * server is already gone).
 *
 * @returns {Promise<void>}
 */
async function closeRedis() {
  const targets = [];
  if (primary) {
    targets.push({ client: primary, role: 'primary' });
    primary = undefined;
  }
  if (subscriber) {
    targets.push({ client: subscriber, role: 'subscriber' });
    subscriber = undefined;
  }

  await Promise.all(
    targets.map(async ({ client, role }) => {
      try {
        await client.quit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[redis:${role}] quit failed, forcing disconnect: ${err && err.message ? err.message : err}`
        );
        try {
          client.disconnect();
        } catch (_ignored) {
          // already torn down — nothing to do
        }
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * `PING` the primary client and return whether the round-trip succeeded
 * within `timeoutMs`. Never throws — used by `/health` (task 5.10) which
 * must answer quickly even when Redis is unreachable.
 *
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<boolean>}
 */
async function pingRedis(timeoutMs = DEFAULT_PING_TIMEOUT_MS) {
  let timer;
  try {
    const client = getRedis();
    const ping = client.ping();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(Symbol.for('redis.ping.timeout')), timeoutMs);
    });
    const result = await Promise.race([ping, timeout]);
    if (result === Symbol.for('redis.ping.timeout')) return false;
    return result === 'PONG';
  } catch (_err) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  // builders / utilities (exported for tests + callers that need
  // identical options when constructing ad-hoc connections, e.g. BullMQ
  // workers that demand their own Redis instance per Worker).
  buildRedisOptions,
  retryStrategy,
  // singletons
  getRedis,
  getRedisSubscriber,
  getRedisPublisher,
  // lifecycle
  closeRedis,
  pingRedis,
};
