'use strict';

/**
 * BullMQ queue topology for Telegram Automation App.
 *
 * Defines every queue used by the system (producer side + worker lookups)
 * and exposes lazy singletons so producer code (web, cron) and consumer code
 * (`src/workers/*.worker.js`) reach for the *same* `Queue` instance per name.
 *
 * Topology mirrors `design.md` § "Job Queue Topology (BullMQ)":
 *
 *   | Queue                | Producer                  | Limiter strategy            | Job kinds                       |
 *   |----------------------|---------------------------|-----------------------------|---------------------------------|
 *   | scheduled-posts      | Scheduler                 | per-connection key          | send-post, repeat-tick          |
 *   | broadcasts           | Broadcast Engine          | bot 30/s, user 30/min       | expand, send-target             |
 *   | drip-steps           | Drip Engine               | per-connection key          | enroll, step                    |
 *   | forwards             | Forward Engine (runtime)  | per-connection key          | forward-message                 |
 *   | member-cleanup       | Cron                      | none                        | kick-inactive, welcome-replay   |
 *   | webhook-deliveries   | Event bus                 | per-tenant 50/s             | deliver                         |
 *   | backups              | Backup Service            | none (long-running)         | export, import                  |
 *   | connection-runtime   | Connection events         | distributed lock            | start, stop, restart            |
 *   | analytics-rollup     | Cron 5 min                | none                        | rollup-day                      |
 *
 * Concurrency and limiters are configured at *worker* construction time (see
 * `src/workers/index.worker.js`); this module only owns producer-side
 * configuration: `defaultJobOptions` (retry/backoff/retention) and the named
 * Redis connections.
 *
 * BullMQ 5.x requires its own ioredis connection (`maxRetriesPerRequest:null`,
 * `enableReadyCheck:false`) and recommends *not* sharing the application's
 * primary Redis client — long-running blocking commands like `BRPOPLPUSH` and
 * `XREADGROUP` would starve everything else multiplexed on the same socket.
 * For that reason every Queue and QueueEvents instance built here gets its
 * *own* freshly-constructed ioredis connection from `buildRedisOptions(...)`,
 * tracked in `ownedConnections` so `closeQueues()` can shut them down.
 *
 * References:
 *   - design.md § "Job Queue Topology (BullMQ)"
 *   - design.md § "Retry Policies"
 *   - requirements.md §6, §9, §11, §12, §14, §16, §19
 *
 * NOTE: `console.error` is used for transient connection logs because the
 * shared logger (task 2.7) is not built yet. Swap it for the structured
 * logger without changing the public API.
 */

const { Queue, QueueEvents } = require('bullmq');
const Redis = require('ioredis');

const { getEnv } = require('../shared/env');
const { buildRedisOptions } = require('./redis');

// ---------------------------------------------------------------------------
// Queue name constants
// ---------------------------------------------------------------------------

/**
 * Canonical queue names. Use these symbols everywhere instead of string
 * literals so a typo surfaces as an immediate `ReferenceError` instead of a
 * silently-misrouted job.
 *
 * @type {Readonly<{
 *   SCHEDULED_POSTS:    'scheduled-posts',
 *   BROADCASTS:         'broadcasts',
 *   DRIP_STEPS:         'drip-steps',
 *   FORWARDS:           'forwards',
 *   MEMBER_CLEANUP:     'member-cleanup',
 *   WEBHOOK_DELIVERIES: 'webhook-deliveries',
 *   BACKUPS:            'backups',
 *   CONNECTION_RUNTIME: 'connection-runtime',
 *   ANALYTICS_ROLLUP:   'analytics-rollup',
 * }>}
 */
const QUEUE_NAMES = Object.freeze({
  SCHEDULED_POSTS: 'scheduled-posts',
  BROADCASTS: 'broadcasts',
  DRIP_STEPS: 'drip-steps',
  FORWARDS: 'forwards',
  MEMBER_CLEANUP: 'member-cleanup',
  WEBHOOK_DELIVERIES: 'webhook-deliveries',
  BACKUPS: 'backups',
  CONNECTION_RUNTIME: 'connection-runtime',
  ANALYTICS_ROLLUP: 'analytics-rollup',
});

/** Set of valid names — used by `assertKnownQueue` for fast validation. */
const VALID_QUEUE_NAMES = new Set(Object.values(QUEUE_NAMES));

// ---------------------------------------------------------------------------
// Retry / backoff schedules
// ---------------------------------------------------------------------------

/**
 * Webhook delivery backoff (design.md "Retry Policies"): 1m, 5m, 15m, 1h, 6h.
 *
 * BullMQ does not have a built-in non-uniform backoff, so the worker for
 * `webhook-deliveries` registers a custom strategy under the name
 * `'webhook-schedule'` via `Worker({ settings: { backoffStrategy } })`. The
 * Queue side just declares `backoff: { type: 'webhook-schedule' }` — BullMQ
 * looks the strategy up on the Worker that picks the job up.
 *
 * Total elapsed time at the 5th retry: 1m + 5m + 15m + 1h + 6h ≈ 7h21m, so
 * a webhook that fails continuously is auto-disabled after 24h (design.md).
 *
 * Exposed so `src/workers/webhook-deliveries.worker.js` can reuse the exact
 * schedule when registering its `backoffStrategy`.
 */
const WEBHOOK_BACKOFF_SCHEDULE_MS = Object.freeze([
  60_000, // attempt 1 → 1 minute
  300_000, // attempt 2 → 5 minutes
  900_000, // attempt 3 → 15 minutes
  3_600_000, // attempt 4 → 1 hour
  21_600_000, // attempt 5 → 6 hours
]);

// ---------------------------------------------------------------------------
// Default job options per queue
// ---------------------------------------------------------------------------

const ONE_HOUR_S = 60 * 60;
const ONE_DAY_S = 24 * ONE_HOUR_S;
const ONE_WEEK_S = 7 * ONE_DAY_S;

/**
 * Per-queue `defaultJobOptions` applied to every job added through the
 * corresponding `Queue`. Per-call overrides at `queue.add(name, data, opts)`
 * are still honoured.
 *
 * Retention strategy:
 *   - `removeOnComplete` is small (age ≤ 1 day, count ≤ 1k–1.5k) — successful
 *     jobs are not interesting after the metric for them is recorded.
 *   - `removeOnFail` is larger (age 1–7 days, count 1k–5k) — failed jobs
 *     stay around long enough for an operator to inspect them.
 *
 * Retry strategy:
 *   - `attempts` reflects the design's policy table.
 *   - `broadcasts` uses `attempts: 1` because per-target failure
 *     classification (blocked/deactivated vs. transient) is performed by the
 *     worker itself, not by BullMQ retry. Re-queueing a `send-target` job
 *     would double-deliver.
 *   - `webhook-deliveries` uses a named custom backoff (`webhook-schedule`,
 *     see above) registered by its worker.
 *   - `backups`, `connection-runtime` and `analytics-rollup` rarely benefit
 *     from BullMQ retries — they have their own idempotent producers (cron,
 *     sweeper, retry button in UI), so a single attempt keeps semantics clean.
 */
const DEFAULT_JOB_OPTIONS = Object.freeze({
  // Telegram 5xx → exponential 1m, 2m, 4m. Worker overrides on 429 (retry_after)
  // and on permanent errors (chat-not-found, 401) per design.md "Retry Policies".
  [QUEUE_NAMES.SCHEDULED_POSTS]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: ONE_HOUR_S, count: 1000 },
    removeOnFail: { age: ONE_DAY_S, count: 5000 },
  },
  // Single attempt — worker classifies per-target errors itself (Property 12).
  [QUEUE_NAMES.BROADCASTS]: {
    attempts: 1,
    removeOnComplete: { age: ONE_HOUR_S, count: 1000 },
    removeOnFail: { age: ONE_DAY_S, count: 5000 },
  },
  [QUEUE_NAMES.DRIP_STEPS]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: ONE_HOUR_S, count: 1000 },
    removeOnFail: { age: ONE_DAY_S, count: 5000 },
  },
  [QUEUE_NAMES.FORWARDS]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: ONE_HOUR_S, count: 500 },
    removeOnFail: { age: ONE_DAY_S, count: 1000 },
  },
  // Once-daily cron job; one retry after 5 minutes is enough for transient
  // DB blips. Keep failed jobs a week so an operator can inspect them.
  [QUEUE_NAMES.MEMBER_CLEANUP]: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5 * 60_000 },
    removeOnComplete: { age: ONE_DAY_S, count: 100 },
    removeOnFail: { age: ONE_WEEK_S, count: 500 },
  },
  // 5 attempts with custom schedule (1m, 5m, 15m, 1h, 6h) — design.md.
  // Strategy is registered on the worker side; see WEBHOOK_BACKOFF_SCHEDULE_MS.
  [QUEUE_NAMES.WEBHOOK_DELIVERIES]: {
    attempts: WEBHOOK_BACKOFF_SCHEDULE_MS.length,
    backoff: { type: 'webhook-schedule' },
    removeOnComplete: { age: ONE_DAY_S, count: 1000 },
    removeOnFail: { age: ONE_WEEK_S, count: 5000 },
  },
  // Long-running, single-attempt — re-running halfway through corrupts
  // partial export streams. The UI exposes a manual "retry" button that
  // enqueues a fresh job rather than relying on BullMQ retry.
  [QUEUE_NAMES.BACKUPS]: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { age: ONE_WEEK_S, count: 200 },
  },
  // Connection lifecycle events are coordinated by the sweeper cron (60s),
  // so BullMQ retry would race with the sweeper. One attempt; failures are
  // visible to the operator and re-emitted by the next sweep cycle.
  [QUEUE_NAMES.CONNECTION_RUNTIME]: {
    attempts: 1,
    removeOnComplete: { age: ONE_HOUR_S, count: 100 },
    removeOnFail: { age: ONE_DAY_S, count: 500 },
  },
  // Analytics rollup is idempotent and re-emitted every 5 min by the cron;
  // 3 attempts give us resilience to transient PG hiccups.
  [QUEUE_NAMES.ANALYTICS_ROLLUP]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { age: ONE_WEEK_S, count: 200 },
  },
});

// ---------------------------------------------------------------------------
// Singleton registries
// ---------------------------------------------------------------------------

/** @type {Map<string, import('bullmq').Queue>} */
const queues = new Map();
/** @type {Map<string, import('bullmq').QueueEvents>} */
const queueEvents = new Map();
/** @type {Set<import('ioredis').Redis>} */
const ownedConnections = new Set();

/**
 * Throw if `name` is not a known queue. Catches typos at producer call sites
 * before they reach Redis — `getQueue('forward')` (singular) would otherwise
 * silently create a brand-new, never-consumed queue.
 *
 * @param {string} name
 */
function assertKnownQueue(name) {
  if (!VALID_QUEUE_NAMES.has(name)) {
    const known = Array.from(VALID_QUEUE_NAMES).join(', ');
    throw new Error(
      `Unknown BullMQ queue '${name}'. Known queues: ${known}. ` +
        'Add the name to QUEUE_NAMES (src/infra/queues.js) before using it.'
    );
  }
}

/**
 * Build a fresh ioredis client for one BullMQ component (Queue or
 * QueueEvents). BullMQ requires its *own* connection (see file header), so
 * the application's primary client (`src/infra/redis.js`) is never reused.
 *
 * The connection is registered in `ownedConnections` so `closeQueues()` can
 * tear it down at shutdown.
 *
 * @param {string} role connection name visible in `CLIENT LIST` (debug aid)
 * @returns {import('ioredis').Redis}
 */
function createQueueConnection(role) {
  const env = getEnv();
  const conn = new Redis(env.REDIS_URL, buildRedisOptions(role));
  conn.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[queues:${role}] connection error: ${err && err.message ? err.message : err}`
    );
  });
  ownedConnections.add(conn);
  return conn;
}

// ---------------------------------------------------------------------------
// Public lookups
// ---------------------------------------------------------------------------

/**
 * Return the cached `Queue` for `name`, constructing it on first use. The
 * same instance is returned to every caller (web, cron, worker bootstrap)
 * so jobs added in one process land in the queue consumed by another.
 *
 *   const queue = getQueue(QUEUE_NAMES.SCHEDULED_POSTS);
 *   await queue.add('send-post', { postId }, { delay: msUntilRunAt });
 *
 * @param {string} name one of the values in `QUEUE_NAMES`
 * @returns {import('bullmq').Queue}
 */
function getQueue(name) {
  assertKnownQueue(name);
  const existing = queues.get(name);
  if (existing) return existing;

  const connection = createQueueConnection(`queue:${name}`);
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[name],
  });
  queues.set(name, queue);
  return queue;
}

/**
 * Return the cached `QueueEvents` for `name`, constructing it on first use.
 * QueueEvents listens to the BullMQ event stream (`completed`, `failed`,
 * `progress`, `stalled`, …) and is used by:
 *
 *   - `/health/deep` — expose queue lag (task 5.10)
 *   - Broadcast progress publisher (task 17.3) — bridges BullMQ `progress`
 *     events to Redis pub/sub `broadcast:progress:<id>` for the dashboard.
 *
 * QueueEvents holds a long-running blocking connection (`XREAD … BLOCK`),
 * which is why it always gets its own ioredis client.
 *
 * @param {string} name one of the values in `QUEUE_NAMES`
 * @returns {import('bullmq').QueueEvents}
 */
function getQueueEvents(name) {
  assertKnownQueue(name);
  const existing = queueEvents.get(name);
  if (existing) return existing;

  const connection = createQueueConnection(`queue-events:${name}`);
  const events = new QueueEvents(name, { connection });
  queueEvents.set(name, events);
  return events;
}

/**
 * Snapshot of currently-instantiated queues. Useful for `/health/deep`,
 * shutdown logs, and tests that want to assert no stray queue was opened.
 *
 * Order is insertion order (Map iteration semantics).
 *
 * @returns {string[]}
 */
function getRegisteredQueueNames() {
  return Array.from(queues.keys());
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Gracefully tear down every cached Queue, QueueEvents, and the ioredis
 * connections owned by this module. Idempotent — safe to call multiple
 * times during shutdown sequencing.
 *
 * Order matters:
 *   1. QueueEvents first — they hold blocking reads; closing the underlying
 *      Redis socket out from under them would log spurious errors.
 *   2. Queues next — flush any in-flight `add` commands.
 *   3. Owned ioredis connections last — `quit()` for clean FIN, fall back
 *      to `disconnect()` if quit fails (server already gone).
 *
 * Errors are swallowed (logged to stderr) — a shutdown handler must never
 * itself throw.
 *
 * @returns {Promise<void>}
 */
async function closeQueues() {
  // 1) QueueEvents
  const eventsList = Array.from(queueEvents.values());
  queueEvents.clear();
  await Promise.all(
    eventsList.map(async (e) => {
      try {
        await e.close();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[queues] queueEvents.close failed: ${err && err.message ? err.message : err}`
        );
      }
    })
  );

  // 2) Queues
  const queueList = Array.from(queues.values());
  queues.clear();
  await Promise.all(
    queueList.map(async (q) => {
      try {
        await q.close();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[queues] queue.close failed: ${err && err.message ? err.message : err}`
        );
      }
    })
  );

  // 3) Owned ioredis connections — BullMQ does not close connections it did
  // not create itself, so we must do it here.
  const connList = Array.from(ownedConnections);
  ownedConnections.clear();
  await Promise.all(
    connList.map(async (c) => {
      // `status` is set to 'end' once the socket is fully closed; skip
      // already-closed connections to avoid noisy errors.
      if (c.status === 'end') return;
      try {
        await c.quit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[queues] redis.quit failed, forcing disconnect: ${err && err.message ? err.message : err}`
        );
        try {
          c.disconnect();
        } catch (_ignored) {
          // already torn down
        }
      }
    })
  );
}

module.exports = {
  // names + per-queue config (frozen, exported for tests + worker setup)
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  WEBHOOK_BACKOFF_SCHEDULE_MS,
  // singleton lookups
  getQueue,
  getQueueEvents,
  getRegisteredQueueNames,
  // lifecycle
  closeQueues,
};
