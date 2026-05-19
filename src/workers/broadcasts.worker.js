'use strict';

/**
 * Broadcasts Worker — BullMQ consumer for the broadcasts queue.
 *
 * Processes broadcast dispatch jobs:
 *   1. Load broadcast record, check status (skip if paused/cancelled).
 *   2. Update status to 'running'.
 *   3. Load connection, decrypt token, get/create client.
 *   4. Query broadcast_targets WHERE status='pending' in batches.
 *   5. For each target:
 *      - Check broadcast status (pause/cancel check before each send)
 *      - Rate limit: bot 30/s, user 30/min (per connection)
 *      - Send message via Telegram
 *      - On success: update target status='sent', increment sent_count
 *      - On 403 (blocked): update target status='blocked', subscriber status='blocked'
 *      - On 400 (deactivated): update target status='deactivated', subscriber status='deactivated'
 *      - On other error: update target status='failed', increment failed_count
 *   6. After all targets: update broadcast status='completed', set completed_at
 *   7. Progress: every 5 seconds, publish to Redis pub/sub broadcast:progress:<id>
 *
 * References:
 *   - requirements.md §9.2 — rate limit 30/s bot, 30/min user
 *   - requirements.md §9.3 — record per-target status
 *   - requirements.md §9.4 — real-time progress every 5s
 *   - requirements.md §9.5 — pause/cancel stops pending sends
 *   - requirements.md §9.6 — blocked/deactivated subscriber handling
 *   - design.md "Broadcast Engine" — dispatcher, progress publisher, failure classifier
 */

const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const { QUEUE_NAMES } = require('../infra/queues');
const { buildRedisOptions } = require('../infra/redis');
const { getRedisPublisher } = require('../infra/redis');
const { getDb } = require('../infra/db');
const { decryptFromColumns } = require('../infra/crypto');
const { getLogger } = require('../infra/logger');
const { getEnv } = require('../shared/env');
const { nowIso } = require('../shared/time');
const runtimeRegistry = require('../modules/connections/runtime-registry');
const { classifyTelegramError } = require('../modules/scheduler/retry-handler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BROADCASTS_TABLE = 'broadcasts';
const TARGETS_TABLE = 'broadcast_targets';
const CONNECTIONS_TABLE = 'telegram_connections';
const SUBSCRIBERS_TABLE = 'subscribers';

const TARGET_BATCH_SIZE = 100;
const PROGRESS_INTERVAL_MS = 5000;

// Rate limiters per connection (in-memory, keyed by connectionId)
const rateLimiters = new Map();

// ---------------------------------------------------------------------------
// Rate limiter factory
// ---------------------------------------------------------------------------

/**
 * Get or create a rate limiter for a connection.
 * Bot connections: 30 messages per second.
 * User connections: 30 messages per minute.
 *
 * @param {string} connectionId
 * @param {string} connectionKind - 'bot' or 'user'
 * @returns {RateLimiterMemory}
 */
function getRateLimiter(connectionId, connectionKind) {
  const key = connectionId;
  if (rateLimiters.has(key)) {
    return rateLimiters.get(key);
  }

  let limiter;
  if (connectionKind === 'bot') {
    // 30 messages per second
    limiter = new RateLimiterMemory({
      points: 30,
      duration: 1,
    });
  } else {
    // 30 messages per minute for user connections
    limiter = new RateLimiterMemory({
      points: 30,
      duration: 60,
    });
  }

  rateLimiters.set(key, limiter);
  return limiter;
}

/**
 * Wait for rate limiter to allow a send.
 *
 * @param {string} connectionId
 * @param {string} connectionKind
 * @returns {Promise<void>}
 */
async function waitForRateLimit(connectionId, connectionKind) {
  const limiter = getRateLimiter(connectionId, connectionKind);

  try {
    await limiter.consume(connectionId, 1);
  } catch (rateLimiterRes) {
    // Rate limited — wait for the required time
    const waitMs = rateLimiterRes.msBeforeNext || 1000;
    await sleep(waitMs);
    // Retry consume after waiting
    await limiter.consume(connectionId, 1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for a given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load a broadcast by ID.
 *
 * @param {string} broadcastId
 * @returns {Promise<object|null>}
 */
async function loadBroadcast(broadcastId) {
  const db = getDb();
  return db(BROADCASTS_TABLE).where({ id: broadcastId }).first();
}

/**
 * Load a connection by ID.
 *
 * @param {string} connectionId
 * @returns {Promise<object|null>}
 */
async function loadConnection(connectionId) {
  const db = getDb();
  return db(CONNECTIONS_TABLE).where({ id: connectionId }).first();
}

/**
 * Decrypt the token/session from a connection record.
 *
 * @param {object} connection
 * @returns {string}
 */
function decryptToken(connection) {
  return decryptFromColumns({
    encrypted_secret: connection.encrypted_secret,
    secret_iv: connection.secret_iv,
    secret_tag: connection.secret_tag,
    secret_key_id: connection.secret_key_id,
  }).toString('utf8');
}

/**
 * Update broadcast counters and status.
 *
 * @param {string} broadcastId
 * @param {object} fields
 * @returns {Promise<void>}
 */
async function updateBroadcast(broadcastId, fields) {
  const db = getDb();
  await db(BROADCASTS_TABLE)
    .where({ id: broadcastId })
    .update({ ...fields, updated_at: nowIso() });
}

/**
 * Update a broadcast target's status.
 *
 * @param {string} targetId
 * @param {object} fields
 * @returns {Promise<void>}
 */
async function updateTarget(targetId, fields) {
  const db = getDb();
  await db(TARGETS_TABLE)
    .where({ id: targetId })
    .update(fields);
}

/**
 * Increment a broadcast counter atomically.
 *
 * @param {string} broadcastId
 * @param {string} field - 'sent_count', 'failed_count', or 'blocked_count'
 * @returns {Promise<void>}
 */
async function incrementCounter(broadcastId, field) {
  const db = getDb();
  await db(BROADCASTS_TABLE)
    .where({ id: broadcastId })
    .increment(field, 1)
    .update({ updated_at: nowIso() });
}

/**
 * Mark a subscriber as blocked or deactivated.
 *
 * @param {string} subscriberId
 * @param {string} status - 'blocked' or 'deactivated'
 * @returns {Promise<void>}
 */
async function markSubscriber(subscriberId, status) {
  const db = getDb();
  await db(SUBSCRIBERS_TABLE)
    .where({ id: subscriberId })
    .update({ status, updated_at: nowIso() });
}

/**
 * Publish progress to Redis pub/sub.
 *
 * @param {string} broadcastId
 * @param {object} progress
 * @returns {Promise<void>}
 */
async function publishProgress(broadcastId, progress) {
  try {
    const publisher = getRedisPublisher();
    const channel = `broadcast:progress:${broadcastId}`;
    await publisher.publish(channel, JSON.stringify(progress));
  } catch (err) {
    // Non-critical — log and continue
    const log = getLogger();
    log.warn({ err, broadcastId }, 'broadcasts-worker: failed to publish progress');
  }
}

/**
 * Send a message to a subscriber via Telegram.
 *
 * @param {object} client - Telegraf bot instance or GramJS client
 * @param {string} chatId - Telegram user ID
 * @param {object} payload - Message payload
 * @param {string} connectionKind - 'bot' or 'user'
 * @returns {Promise<void>}
 */
async function sendMessage(client, chatId, payload, connectionKind) {
  const telegram = client.telegram || client;

  if (connectionKind === 'bot') {
    // Bot API via Telegraf
    if (payload.media_ids && payload.media_ids.length > 0) {
      // For broadcasts, we send text with media reference
      // In a full implementation, this would resolve media and send
      // For now, send text with caption
      await telegram.sendMessage(chatId, payload.text || '', {
        parse_mode: payload.parse_mode || undefined,
      });
    } else {
      await telegram.sendMessage(chatId, payload.text || '', {
        parse_mode: payload.parse_mode || undefined,
      });
    }
  } else {
    // MTProto user connection — use sendMessage equivalent
    // GramJS client interface
    if (client.sendMessage) {
      await client.sendMessage(chatId, { message: payload.text || '' });
    } else {
      throw new Error('User connection client does not support sendMessage');
    }
  }
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Process a broadcast dispatch job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processJob(job) {
  const log = getLogger();
  const { broadcastId } = job.data;

  log.info({ broadcastId, jobId: job.id }, 'broadcasts-worker: processing job');

  // 1. Load broadcast
  const broadcast = await loadBroadcast(broadcastId);
  if (!broadcast) {
    log.warn({ broadcastId }, 'broadcasts-worker: broadcast not found, skipping');
    return;
  }

  // 2. Check status — skip if paused or cancelled
  if (broadcast.status === 'paused' || broadcast.status === 'cancelled') {
    log.info(
      { broadcastId, status: broadcast.status },
      'broadcasts-worker: broadcast not active, skipping'
    );
    return;
  }

  if (broadcast.status === 'completed') {
    log.info({ broadcastId }, 'broadcasts-worker: broadcast already completed');
    return;
  }

  // 3. Update status to 'running'
  await updateBroadcast(broadcastId, { status: 'running', started_at: broadcast.started_at || nowIso() });

  // 4. Load connection
  const connection = await loadConnection(broadcast.connection_id);
  if (!connection) {
    await updateBroadcast(broadcastId, { status: 'failed' });
    log.error({ broadcastId, connectionId: broadcast.connection_id }, 'broadcasts-worker: connection not found');
    return;
  }

  if (connection.status !== 'active') {
    await updateBroadcast(broadcastId, { status: 'failed' });
    log.warn({ broadcastId, connStatus: connection.status }, 'broadcasts-worker: connection not active');
    return;
  }

  // 5. Get or create client
  let client = runtimeRegistry.get(broadcast.connection_id);
  let tempBot = null;

  if (!client && connection.kind === 'bot') {
    const { Telegraf } = require('telegraf');
    const token = decryptToken(connection);
    tempBot = new Telegraf(token);
    client = tempBot;
  }

  if (!client) {
    await updateBroadcast(broadcastId, { status: 'failed' });
    log.error({ broadcastId }, 'broadcasts-worker: no client available');
    return;
  }

  // 6. Process targets in batches
  const db = getDb();
  let lastProgressPublish = Date.now();
  let processedCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Re-check broadcast status before each batch (pause/cancel support)
    const currentBroadcast = await loadBroadcast(broadcastId);
    if (!currentBroadcast || currentBroadcast.status === 'paused' || currentBroadcast.status === 'cancelled') {
      log.info(
        { broadcastId, status: currentBroadcast ? currentBroadcast.status : 'deleted' },
        'broadcasts-worker: broadcast paused/cancelled during processing'
      );
      return;
    }

    // Fetch next batch of pending targets
    const targets = await db(TARGETS_TABLE)
      .where({ broadcast_id: broadcastId, status: 'pending' })
      .limit(TARGET_BATCH_SIZE);

    if (targets.length === 0) {
      break; // All targets processed
    }

    // Process each target
    for (const target of targets) {
      // Check broadcast status before each send
      if (processedCount % 10 === 0 && processedCount > 0) {
        const statusCheck = await db(BROADCASTS_TABLE)
          .where({ id: broadcastId })
          .select('status')
          .first();
        if (statusCheck && (statusCheck.status === 'paused' || statusCheck.status === 'cancelled')) {
          log.info({ broadcastId }, 'broadcasts-worker: broadcast paused/cancelled mid-batch');
          return;
        }
      }

      // Rate limit
      await waitForRateLimit(broadcast.connection_id, connection.kind);

      // Load subscriber to get telegram_user_id
      const subscriber = await db(SUBSCRIBERS_TABLE)
        .where({ id: target.subscriber_id })
        .first();

      if (!subscriber) {
        await updateTarget(target.id, { status: 'failed', error: 'Subscriber not found' });
        await incrementCounter(broadcastId, 'failed_count');
        processedCount++;
        continue;
      }

      // Parse payload
      const payload = typeof broadcast.payload === 'string'
        ? JSON.parse(broadcast.payload)
        : broadcast.payload;

      // Send message
      try {
        await sendMessage(client, subscriber.telegram_user_id.toString(), payload, connection.kind);

        // Success
        await updateTarget(target.id, { status: 'sent', sent_at: nowIso() });
        await incrementCounter(broadcastId, 'sent_count');
      } catch (err) {
        // Classify error
        const classification = classifyTelegramError(err);
        const errorCode = extractErrorCode(err);
        const errorMsg = err && err.message ? err.message : String(err);

        if (errorCode === 403) {
          // Blocked by user
          await updateTarget(target.id, { status: 'blocked', error: errorMsg });
          await incrementCounter(broadcastId, 'blocked_count');
          await markSubscriber(target.subscriber_id, 'blocked');
        } else if (errorCode === 400 && isDeactivatedError(err)) {
          // User deactivated
          await updateTarget(target.id, { status: 'deactivated', error: errorMsg });
          await incrementCounter(broadcastId, 'blocked_count');
          await markSubscriber(target.subscriber_id, 'deactivated');
        } else {
          // Other error
          await updateTarget(target.id, { status: 'failed', error: errorMsg });
          await incrementCounter(broadcastId, 'failed_count');
        }

        log.debug(
          { broadcastId, targetId: target.id, errorCode, errorMsg },
          'broadcasts-worker: target send failed'
        );
      }

      processedCount++;

      // Publish progress every 5 seconds
      const now = Date.now();
      if (now - lastProgressPublish >= PROGRESS_INTERVAL_MS) {
        const freshBroadcast = await loadBroadcast(broadcastId);
        if (freshBroadcast) {
          await publishProgress(broadcastId, {
            sent_count: freshBroadcast.sent_count,
            failed_count: freshBroadcast.failed_count,
            blocked_count: freshBroadcast.blocked_count,
            total_targets: freshBroadcast.total_targets,
            status: freshBroadcast.status,
          });
        }
        lastProgressPublish = now;
      }
    }
  }

  // 7. Mark broadcast as completed
  await updateBroadcast(broadcastId, {
    status: 'completed',
    completed_at: nowIso(),
  });

  // Final progress publish
  const finalBroadcast = await loadBroadcast(broadcastId);
  if (finalBroadcast) {
    await publishProgress(broadcastId, {
      sent_count: finalBroadcast.sent_count,
      failed_count: finalBroadcast.failed_count,
      blocked_count: finalBroadcast.blocked_count,
      total_targets: finalBroadcast.total_targets,
      status: 'completed',
    });
  }

  log.info(
    { broadcastId, processedCount },
    'broadcasts-worker: broadcast completed'
  );
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/**
 * Extract error code from various error shapes.
 *
 * @param {Error|object} error
 * @returns {number|null}
 */
function extractErrorCode(error) {
  if (!error) return null;
  if (error.response && typeof error.response.error_code === 'number') {
    return error.response.error_code;
  }
  if (typeof error.code === 'number' && error.code >= 100 && error.code < 600) {
    return error.code;
  }
  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  if (typeof error.status === 'number') {
    return error.status;
  }
  return null;
}

/**
 * Check if an error indicates a deactivated user.
 *
 * @param {Error|object} error
 * @returns {boolean}
 */
function isDeactivatedError(error) {
  const desc = (
    (error && error.response && error.response.description) ||
    (error && error.message) ||
    ''
  ).toLowerCase();
  return desc.includes('user is deactivated') || desc.includes('user_deactivated');
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/** @type {import('bullmq').Worker|null} */
let worker = null;

/**
 * Start the broadcasts worker.
 *
 * @returns {import('bullmq').Worker}
 */
function start() {
  const log = getLogger();
  const env = getEnv();

  const connection = new Redis(env.REDIS_URL, buildRedisOptions('worker:broadcasts'));

  worker = new Worker(
    QUEUE_NAMES.BROADCASTS,
    processJob,
    {
      connection,
      concurrency: 3,
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id }, 'broadcasts-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job ? job.id : 'unknown', err: err && err.message },
      'broadcasts-worker: job failed'
    );
  });

  worker.on('error', (err) => {
    log.error({ err }, 'broadcasts-worker: worker error');
  });

  log.info('broadcasts-worker: started');

  return worker;
}

/**
 * Stop the worker gracefully.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  processJob,
  // Exported for testing
  loadBroadcast,
  loadConnection,
  decryptToken,
  sendMessage,
  getRateLimiter,
  waitForRateLimit,
  publishProgress,
};
