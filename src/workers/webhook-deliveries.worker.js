'use strict';

/**
 * Webhook Deliveries Worker — POST JSON payloads to webhook endpoints.
 *
 * BullMQ Worker for queue 'webhook-deliveries', concurrency 5.
 *
 * Process:
 *   1. Load webhook from DB
 *   2. Decrypt secret
 *   3. Compute HMAC-SHA256 of JSON payload
 *   4. POST to url with signature headers
 *   5. Record delivery in webhook_deliveries table
 *   6. Handle retry policy on failure
 *
 * Headers sent:
 *   - Content-Type: application/json
 *   - X-Webhook-Signature: sha256=<hex hmac>
 *   - X-Webhook-Id: <delivery_id> (for consumer dedupe)
 *
 * Retry policy (task 21.8):
 *   - Delays: 1m, 5m, 15m, 1h, 6h (max 5 attempts)
 *   - 24h continuous failure → set webhook status='disabled'
 *
 * References:
 *   - requirements.md §14.6 — HMAC-SHA256 signed delivery
 *   - requirements.md §14.7 — retry policy, auto-disable
 */

const crypto = require('crypto');
const { Worker } = require('bullmq');
const Redis = require('ioredis');

const { getEnv } = require('../shared/env');
const { buildRedisOptions } = require('../infra/redis');
const { getDb } = require('../infra/db');
const { getQueue, QUEUE_NAMES, WEBHOOK_BACKOFF_SCHEDULE_MS } = require('../infra/queues');
const { getLogger } = require('../infra/logger');
const { newId } = require('../shared/ids');
const { nowIso } = require('../shared/time');
const webhookService = require('../modules/webhooks-out/webhook-service');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOKS_TABLE = 'webhooks';
const DELIVERIES_TABLE = 'webhook_deliveries';
const MAX_ATTEMPTS = 5;
const DISABLE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Worker processor
// ---------------------------------------------------------------------------

/**
 * Process a webhook delivery job.
 *
 * @param {import('bullmq').Job} job
 */
async function processDelivery(job) {
  const log = getLogger();
  const { webhookId, event, payload, attempt = 1 } = job.data;

  log.info({ webhookId, event, attempt, jobId: job.id }, 'webhook-worker: processing delivery');

  const db = getDb();

  // Load webhook (raw row with secret_encrypted)
  const webhook = await db(WEBHOOKS_TABLE)
    .where({ id: webhookId })
    .first();

  if (!webhook) {
    log.warn({ webhookId }, 'webhook-worker: webhook not found, skipping');
    return;
  }

  if (webhook.status === 'disabled') {
    log.info({ webhookId }, 'webhook-worker: webhook disabled, skipping');
    return;
  }

  // Decrypt secret and compute HMAC
  let secret;
  try {
    secret = webhookService.decryptSecret(webhook);
  } catch (err) {
    log.error({ err, webhookId }, 'webhook-worker: failed to decrypt secret');
    return;
  }

  const payloadJson = JSON.stringify(payload);
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payloadJson)
    .digest('hex');

  const deliveryId = newId();

  // POST to webhook URL
  let statusCode = null;
  let success = false;

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${hmac}`,
        'X-Webhook-Id': deliveryId,
      },
      body: payloadJson,
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    statusCode = response.status;
    success = statusCode >= 200 && statusCode < 300;
  } catch (err) {
    log.warn({ err, webhookId, url: webhook.url }, 'webhook-worker: delivery request failed');
    statusCode = 0; // Network error
    success = false;
  }

  // Record delivery in webhook_deliveries table
  await db(DELIVERIES_TABLE).insert({
    id: deliveryId,
    webhook_id: webhookId,
    event,
    payload: JSON.stringify(payload),
    status_code: statusCode,
    attempt,
    delivered_at: nowIso(),
  });

  if (success) {
    // Reset consecutive_failures on success
    await db(WEBHOOKS_TABLE)
      .where({ id: webhookId })
      .update({
        consecutive_failures: 0,
        updated_at: nowIso(),
      });

    log.info({ webhookId, deliveryId, statusCode }, 'webhook-worker: delivery successful');
  } else {
    // Handle failure — increment consecutive_failures
    const now = new Date();
    const updatedWebhook = await db(WEBHOOKS_TABLE)
      .where({ id: webhookId })
      .increment('consecutive_failures', 1)
      .update({
        last_failure_at: nowIso(),
        updated_at: nowIso(),
      })
      .returning('*');

    const currentWebhook = updatedWebhook[0] || webhook;
    const failures = (currentWebhook.consecutive_failures || 0);

    log.warn(
      { webhookId, deliveryId, statusCode, attempt, failures },
      'webhook-worker: delivery failed'
    );

    // Check if we should disable the webhook
    // If consecutive_failures >= 5 AND first failure was > 24h ago
    if (failures >= MAX_ATTEMPTS && currentWebhook.last_failure_at) {
      const firstFailureApprox = new Date(now.getTime() - (failures - 1) * getAverageRetryDelay());
      const elapsed = now.getTime() - firstFailureApprox.getTime();

      if (elapsed >= DISABLE_AFTER_MS || failures >= MAX_ATTEMPTS) {
        await db(WEBHOOKS_TABLE)
          .where({ id: webhookId })
          .update({ status: 'disabled', updated_at: nowIso() });

        log.warn({ webhookId, failures }, 'webhook-worker: webhook disabled after repeated failures');
        return;
      }
    }

    // Re-enqueue with next retry delay if under max attempts
    if (attempt < MAX_ATTEMPTS) {
      const delay = WEBHOOK_BACKOFF_SCHEDULE_MS[attempt - 1] || WEBHOOK_BACKOFF_SCHEDULE_MS[WEBHOOK_BACKOFF_SCHEDULE_MS.length - 1];
      const queue = getQueue(QUEUE_NAMES.WEBHOOK_DELIVERIES);

      await queue.add('deliver', {
        webhookId,
        event,
        payload,
        attempt: attempt + 1,
      }, { delay });

      log.info(
        { webhookId, nextAttempt: attempt + 1, delayMs: delay },
        'webhook-worker: re-enqueued for retry'
      );
    } else {
      log.warn({ webhookId, attempt }, 'webhook-worker: max attempts reached');
    }
  }
}

/**
 * Get average retry delay for estimating first failure time.
 * @returns {number}
 */
function getAverageRetryDelay() {
  const total = WEBHOOK_BACKOFF_SCHEDULE_MS.reduce((a, b) => a + b, 0);
  return total / WEBHOOK_BACKOFF_SCHEDULE_MS.length;
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Start the webhook deliveries worker.
 *
 * @returns {import('bullmq').Worker}
 */
function start() {
  const log = getLogger();
  const env = getEnv();

  const connection = new Redis(env.REDIS_URL, buildRedisOptions('worker:webhook-deliveries'));
  connection.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[webhook-deliveries-worker] Redis error: ${err.message}`);
  });

  const worker = new Worker(
    QUEUE_NAMES.WEBHOOK_DELIVERIES,
    processDelivery,
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id }, 'webhook-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job ? job.id : null, err }, 'webhook-worker: job failed');
  });

  log.info('webhook-deliveries-worker: started');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('webhook-deliveries-worker: shutting down...');
    await worker.close();
    await connection.quit().catch(() => connection.disconnect());
    log.info('webhook-deliveries-worker: shutdown complete');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return worker;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  processDelivery,
};
