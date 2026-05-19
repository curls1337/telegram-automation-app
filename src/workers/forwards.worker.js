'use strict';

/**
 * Forwards Worker — BullMQ consumer for the forwards queue.
 *
 * Processes forward-message jobs:
 *   1. Load forward rule by ID, verify is_active.
 *   2. Evaluate filters (keyword match, media_type match, sender match).
 *   3. If message passes filters, iterate destinations array.
 *   4. For each destination: send message (forward or copy based on remove_header).
 *   5. Record per-destination status (success/failed with error).
 *   6. On failure of one destination, continue to next (don't abort loop).
 *
 * remove_header logic:
 *   - remove_header=false: use forwardMessage (preserves original sender attribution)
 *   - remove_header=true for Bot: use copyMessage (sends as new message without forward header)
 *   - remove_header=true for MTProto/User: re-send content as new message
 *
 * References:
 *   - requirements.md §12.3 — filter evaluation and per-destination send
 *   - requirements.md §12.4 — remove forward header mode
 *   - requirements.md §12.5 — per-destination status recording
 *   - design.md "Forward Engine" — worker processes filter and sends
 */

const { Worker } = require('bullmq');
const Redis = require('ioredis');

const { QUEUE_NAMES } = require('../infra/queues');
const { buildRedisOptions } = require('../infra/redis');
const { getDb } = require('../infra/db');
const { decryptFromColumns } = require('../infra/crypto');
const { getLogger } = require('../infra/logger');
const { getEnv } = require('../shared/env');
const runtimeRegistry = require('../modules/connections/runtime-registry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORWARD_RULES_TABLE = 'forward_rules';
const CONNECTIONS_TABLE = 'telegram_connections';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a forward rule by ID.
 *
 * @param {string} ruleId
 * @returns {Promise<object|null>}
 */
async function loadRule(ruleId) {
  const db = getDb();
  return db(FORWARD_RULES_TABLE).where({ id: ruleId }).first();
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
 * Parse JSONB field (handles both string and object).
 *
 * @param {string|object|null} value
 * @returns {object|null}
 */
function parseJsonb(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate filters against a message.
 * Returns true if the message passes all filters (should be forwarded).
 * If no filters are defined, all messages pass.
 *
 * @param {object|null} filters - { keywords?: string[], media_types?: string[], senders?: string[] }
 * @param {object} message - { text, mediaType, senderId }
 * @returns {boolean}
 */
function evaluateFilters(filters, message) {
  if (!filters) return true;

  const { keywords, media_types, senders } = filters;

  // Keyword filter: message text must contain at least one keyword (case-insensitive)
  if (keywords && keywords.length > 0) {
    const text = (message.text || '').toLowerCase();
    const hasKeyword = keywords.some((kw) => text.includes(kw.toLowerCase()));
    if (!hasKeyword) return false;
  }

  // Media type filter: message media_type must match one of the allowed types
  if (media_types && media_types.length > 0) {
    const msgMediaType = message.mediaType || '';
    if (!msgMediaType) return false;
    const hasMediaType = media_types.some(
      (mt) => mt.toLowerCase() === msgMediaType.toLowerCase()
    );
    if (!hasMediaType) return false;
  }

  // Sender filter: message sender must be in the allowed senders list
  if (senders && senders.length > 0) {
    const msgSender = message.senderId ? String(message.senderId) : '';
    if (!msgSender) return false;
    const hasSender = senders.some((s) => String(s) === msgSender);
    if (!hasSender) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Message sending
// ---------------------------------------------------------------------------

/**
 * Forward a message to a destination using forwardMessage (preserves header).
 *
 * @param {object} client - Telegraf bot instance or GramJS client
 * @param {string} fromChatId - Source chat ID
 * @param {string} messageId - Message ID to forward
 * @param {string} toChatId - Destination chat ID
 * @param {string} connectionKind - 'bot' or 'user'
 * @returns {Promise<void>}
 */
async function forwardMessage(client, fromChatId, messageId, toChatId, connectionKind) {
  if (connectionKind === 'bot') {
    const telegram = client.telegram || client;
    await telegram.forwardMessage(toChatId, fromChatId, parseInt(messageId, 10));
  } else {
    // MTProto user connection
    if (client.forwardMessages) {
      await client.forwardMessages(toChatId, {
        fromPeer: fromChatId,
        messages: [parseInt(messageId, 10)],
      });
    } else if (client.invoke) {
      // GramJS style
      const { Api } = require('telegram');
      await client.invoke(new Api.messages.ForwardMessages({
        fromPeer: fromChatId,
        toPeer: toChatId,
        id: [parseInt(messageId, 10)],
      }));
    } else {
      throw new Error('User connection client does not support forwardMessages');
    }
  }
}

/**
 * Copy a message to a destination without forward header (Bot API copyMessage).
 *
 * @param {object} client - Telegraf bot instance
 * @param {string} fromChatId - Source chat ID
 * @param {string} messageId - Message ID to copy
 * @param {string} toChatId - Destination chat ID
 * @returns {Promise<void>}
 */
async function copyMessage(client, fromChatId, messageId, toChatId) {
  const telegram = client.telegram || client;
  await telegram.copyMessage(toChatId, fromChatId, parseInt(messageId, 10));
}

/**
 * Re-send content as a new message for MTProto (removes forward header).
 * Falls back to sending text if media re-upload is not possible.
 *
 * @param {object} client - GramJS client
 * @param {string} toChatId - Destination chat ID
 * @param {object} messageData - { text, mediaType }
 * @returns {Promise<void>}
 */
async function resendAsNew(client, toChatId, messageData) {
  if (client.sendMessage) {
    // Send as plain text message (simplest re-send without header)
    await client.sendMessage(toChatId, {
      message: messageData.text || '',
    });
  } else {
    throw new Error('User connection client does not support sendMessage for re-send');
  }
}

/**
 * Send a message to a destination based on remove_header flag.
 *
 * @param {object} client - Bot or user client
 * @param {string} fromChatId - Source chat ID
 * @param {string} messageId - Message ID
 * @param {string} toChatId - Destination chat ID
 * @param {boolean} removeHeader - Whether to remove forward header
 * @param {string} connectionKind - 'bot' or 'user'
 * @param {object} messageData - { text, mediaType }
 * @returns {Promise<void>}
 */
async function sendToDestination(client, fromChatId, messageId, toChatId, removeHeader, connectionKind, messageData) {
  if (!removeHeader) {
    // Preserve forward header — use forwardMessage
    await forwardMessage(client, fromChatId, messageId, toChatId, connectionKind);
  } else if (connectionKind === 'bot') {
    // Bot API: use copyMessage to send without forward header
    await copyMessage(client, fromChatId, messageId, toChatId);
  } else {
    // MTProto/User: re-send content as new message
    await resendAsNew(client, toChatId, messageData);
  }
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Process a forward-message job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<object>} Result with per-destination statuses
 */
async function processJob(job) {
  const log = getLogger();
  const { ruleId, messageId, chatId, text, mediaType, senderId, connectionId } = job.data;

  log.info({ ruleId, messageId, jobId: job.id }, 'forwards-worker: processing job');

  // 1. Load rule
  const rule = await loadRule(ruleId);
  if (!rule) {
    log.warn({ ruleId }, 'forwards-worker: rule not found, skipping');
    return { status: 'skipped', reason: 'rule_not_found' };
  }

  // 2. Check is_active
  if (!rule.is_active) {
    log.info({ ruleId }, 'forwards-worker: rule is inactive, skipping');
    return { status: 'skipped', reason: 'rule_inactive' };
  }

  // 3. Evaluate filters
  const filters = parseJsonb(rule.filters);
  const message = { text, mediaType, senderId };

  if (!evaluateFilters(filters, message)) {
    log.debug({ ruleId, messageId }, 'forwards-worker: message did not pass filters');
    return { status: 'filtered', reason: 'filters_not_matched' };
  }

  // 4. Load connection
  const connection = await loadConnection(connectionId);
  if (!connection) {
    log.error({ connectionId, ruleId }, 'forwards-worker: connection not found');
    return { status: 'error', reason: 'connection_not_found' };
  }

  // 5. Get or create client
  let client = runtimeRegistry.get(connectionId);
  let tempBot = null;

  if (!client && connection.kind === 'bot') {
    const { Telegraf } = require('telegraf');
    const token = decryptToken(connection);
    tempBot = new Telegraf(token);
    client = tempBot;
  }

  if (!client) {
    log.error({ connectionId, ruleId }, 'forwards-worker: no client available');
    return { status: 'error', reason: 'no_client' };
  }

  // 6. Parse destinations
  const destinations = parseJsonb(rule.destinations) || [];
  const results = [];

  // 7. Iterate destinations and send
  for (const destination of destinations) {
    try {
      await sendToDestination(
        client,
        chatId,
        messageId,
        destination,
        rule.remove_header,
        connection.kind,
        { text, mediaType }
      );

      results.push({ destination, status: 'success', error: null });
    } catch (err) {
      const errorMsg = err && err.message ? err.message : String(err);
      log.warn(
        { ruleId, messageId, destination, err: errorMsg },
        'forwards-worker: failed to send to destination'
      );
      results.push({ destination, status: 'failed', error: errorMsg });
      // Continue to next destination — don't abort loop
    }
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;

  log.info(
    { ruleId, messageId, successCount, failedCount, total: destinations.length },
    'forwards-worker: job completed'
  );

  return {
    status: 'completed',
    results,
    successCount,
    failedCount,
  };
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/** @type {import('bullmq').Worker|null} */
let worker = null;

/**
 * Start the forwards worker.
 *
 * @returns {import('bullmq').Worker}
 */
function start() {
  const log = getLogger();
  const env = getEnv();

  const connection = new Redis(env.REDIS_URL, buildRedisOptions('worker:forwards'));

  worker = new Worker(
    QUEUE_NAMES.FORWARDS,
    processJob,
    {
      connection,
      concurrency: 10,
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id }, 'forwards-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job ? job.id : 'unknown', err: err && err.message },
      'forwards-worker: job failed'
    );
  });

  worker.on('error', (err) => {
    log.error({ err }, 'forwards-worker: worker error');
  });

  log.info('forwards-worker: started (concurrency=10)');

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
  evaluateFilters,
  loadRule,
  loadConnection,
  sendToDestination,
  forwardMessage,
  copyMessage,
  resendAsNew,
  parseJsonb,
};
