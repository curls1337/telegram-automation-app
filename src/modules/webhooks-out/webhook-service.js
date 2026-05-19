'use strict';

/**
 * Webhook Service — CRUD for outbound webhooks + event publishing.
 *
 * Responsibilities:
 *   - Create webhooks (encrypt secret with AES-256-GCM)
 *   - List, getById, update, remove webhooks
 *   - Publish events: find matching active webhooks, enqueue delivery jobs
 *   - Internal pub/sub event publisher
 *
 * References:
 *   - requirements.md §14.5 — webhook CRUD, event subscription
 */

const { tenantQuery, tenantInsert, getDb } = require('../../infra/db');
const { encrypt, decrypt } = require('../../infra/crypto');
const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');
const { nowIso } = require('../../shared/time');
const { NotFoundError, ValidationError } = require('../../shared/errors');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'webhooks';
const DELIVERIES_TABLE = 'webhook_deliveries';

const VALID_EVENTS = [
  'subscriber.created',
  'subscriber.updated',
  'subscriber.deleted',
  'broadcast.created',
  'broadcast.completed',
  'broadcast.failed',
  'message.received',
  'message.sent',
  'auto_reply.triggered',
  'scheduled_post.sent',
  'scheduled_post.failed',
  'drip.enrolled',
  'drip.completed',
  'tag.added',
  'tag.removed',
];

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new webhook. Secret is encrypted with AES-256-GCM before storage.
 *
 * @param {string} tenantId
 * @param {object} input
 * @param {string} input.url - Webhook endpoint URL
 * @param {string[]} input.events - Array of event types to subscribe to
 * @param {string} input.secret - Signing secret (stored encrypted)
 * @returns {Promise<object>} The created webhook record (without decrypted secret)
 */
async function create(tenantId, input) {
  const log = getLogger();

  if (!input.url || typeof input.url !== 'string' || input.url.trim().length === 0) {
    throw new ValidationError('URL is required');
  }

  if (!input.events || !Array.isArray(input.events) || input.events.length === 0) {
    throw new ValidationError('At least one event is required');
  }

  if (!input.secret || typeof input.secret !== 'string' || input.secret.trim().length === 0) {
    throw new ValidationError('Secret is required');
  }

  // Encrypt the secret
  const blob = encrypt(input.secret);
  const secretEncrypted = Buffer.concat([
    blob.iv,        // 12 bytes
    blob.tag,       // 16 bytes
    blob.ciphertext,
  ]);

  const webhookId = newId();
  const timestamp = nowIso();

  const [webhook] = await tenantInsert(tenantId, TABLE, {
    id: webhookId,
    url: input.url.trim(),
    secret_encrypted: secretEncrypted,
    events: JSON.stringify(input.events),
    status: 'active',
    last_failure_at: null,
    consecutive_failures: 0,
    created_at: timestamp,
    updated_at: timestamp,
  }, { returning: '*' });

  log.info({ webhookId, tenantId, url: input.url }, 'webhook-service: webhook created');

  // Return without secret_encrypted
  const { secret_encrypted: _s, ...safe } = webhook;
  return {
    ...safe,
    events: typeof safe.events === 'string' ? JSON.parse(safe.events) : safe.events,
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List all webhooks for a tenant.
 *
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function list(tenantId) {
  const webhooks = await tenantQuery(tenantId, TABLE)
    .select('id', 'url', 'events', 'status', 'last_failure_at', 'consecutive_failures', 'created_at', 'updated_at')
    .orderBy('created_at', 'desc');

  return webhooks.map((wh) => ({
    ...wh,
    events: typeof wh.events === 'string' ? JSON.parse(wh.events) : (wh.events || []),
  }));
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Get a single webhook by ID.
 *
 * @param {string} tenantId
 * @param {string} webhookId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, webhookId) {
  const webhook = await tenantQuery(tenantId, TABLE)
    .where({ id: webhookId })
    .first();

  if (!webhook) {
    throw new NotFoundError('Webhook not found');
  }

  const { secret_encrypted: _s, ...safe } = webhook;
  return {
    ...safe,
    events: typeof safe.events === 'string' ? JSON.parse(safe.events) : (safe.events || []),
  };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Update a webhook (url, events, secret, status).
 *
 * @param {string} tenantId
 * @param {string} webhookId
 * @param {object} input
 * @returns {Promise<object>}
 */
async function update(tenantId, webhookId, input) {
  await getById(tenantId, webhookId);

  const updatePayload = { updated_at: nowIso() };

  if (input.url !== undefined) {
    updatePayload.url = input.url.trim();
  }

  if (input.events !== undefined) {
    if (!Array.isArray(input.events) || input.events.length === 0) {
      throw new ValidationError('At least one event is required');
    }
    updatePayload.events = JSON.stringify(input.events);
  }

  if (input.secret !== undefined && input.secret.length > 0) {
    const blob = encrypt(input.secret);
    updatePayload.secret_encrypted = Buffer.concat([
      blob.iv,
      blob.tag,
      blob.ciphertext,
    ]);
  }

  if (input.status !== undefined) {
    if (!['active', 'disabled'].includes(input.status)) {
      throw new ValidationError('Status must be active or disabled');
    }
    updatePayload.status = input.status;
    if (input.status === 'active') {
      updatePayload.consecutive_failures = 0;
      updatePayload.last_failure_at = null;
    }
  }

  const [updated] = await tenantQuery(tenantId, TABLE)
    .where({ id: webhookId })
    .update(updatePayload)
    .returning('*');

  const { secret_encrypted: _s, ...safe } = updated;
  return {
    ...safe,
    events: typeof safe.events === 'string' ? JSON.parse(safe.events) : (safe.events || []),
  };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Delete a webhook and its delivery history.
 *
 * @param {string} tenantId
 * @param {string} webhookId
 * @returns {Promise<void>}
 */
async function remove(tenantId, webhookId) {
  await getById(tenantId, webhookId);

  const db = getDb();

  // Delete deliveries first
  await db(DELIVERIES_TABLE).where({ webhook_id: webhookId }).del();

  // Delete webhook
  await tenantQuery(tenantId, TABLE).where({ id: webhookId }).del();

  getLogger().info({ webhookId, tenantId }, 'webhook-service: webhook deleted');
}

// ---------------------------------------------------------------------------
// getDeliveries
// ---------------------------------------------------------------------------

/**
 * Get delivery history for a webhook.
 *
 * @param {string} webhookId
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @returns {Promise<object[]>}
 */
async function getDeliveries(webhookId, opts = {}) {
  const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 50));
  const db = getDb();

  return db(DELIVERIES_TABLE)
    .where({ webhook_id: webhookId })
    .orderBy('delivered_at', 'desc')
    .limit(limit);
}

// ---------------------------------------------------------------------------
// decryptSecret
// ---------------------------------------------------------------------------

/**
 * Decrypt the webhook secret from the raw DB record.
 * Used by the delivery worker to sign payloads.
 *
 * @param {object} webhookRow - Raw DB row with secret_encrypted
 * @returns {string} Decrypted secret
 */
function decryptSecret(webhookRow) {
  const buf = Buffer.isBuffer(webhookRow.secret_encrypted)
    ? webhookRow.secret_encrypted
    : Buffer.from(webhookRow.secret_encrypted);

  // Layout: iv (12) + tag (16) + ciphertext (rest)
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ciphertext = buf.slice(28);

  const { getKeyStore } = require('../../infra/crypto');
  const store = getKeyStore();

  return decrypt({
    keyId: store.activeKeyId,
    iv,
    tag,
    ciphertext,
  }).toString('utf8');
}

// ---------------------------------------------------------------------------
// publishEvent
// ---------------------------------------------------------------------------

/**
 * Publish an event to all matching active webhooks for a tenant.
 * Enqueues a delivery job for each matching webhook.
 *
 * @param {string} tenantId
 * @param {string} event - Event type (e.g. 'subscriber.created')
 * @param {object} payload - Event payload data
 * @returns {Promise<number>} Number of delivery jobs enqueued
 */
async function publishEvent(tenantId, event, payload) {
  const log = getLogger();

  // Find all active webhooks for this tenant that subscribe to this event
  const webhooks = await tenantQuery(tenantId, TABLE)
    .where({ status: 'active' })
    .select('id', 'events');

  let enqueued = 0;
  const queue = getQueue(QUEUE_NAMES.WEBHOOK_DELIVERIES);

  for (const wh of webhooks) {
    const events = typeof wh.events === 'string' ? JSON.parse(wh.events) : (wh.events || []);

    if (events.includes(event) || events.includes('*')) {
      await queue.add('deliver', {
        webhookId: wh.id,
        event,
        payload,
        attempt: 1,
      });
      enqueued++;
    }
  }

  if (enqueued > 0) {
    log.debug({ tenantId, event, enqueued }, 'webhook-service: event published');
  }

  return enqueued;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  create,
  list,
  getById,
  update,
  remove,
  getDeliveries,
  decryptSecret,
  publishEvent,
  VALID_EVENTS,
};
