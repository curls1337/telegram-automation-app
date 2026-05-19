'use strict';

/**
 * Forward Listener — handles incoming messages and publishes forward jobs.
 *
 * Responsibilities:
 *   - Load active forward rules for a connection (with Redis cache, TTL 60s)
 *   - Match incoming message source_chat against rules
 *   - Publish matching jobs to the 'forwards' queue
 *   - Subscribe to Redis pub/sub for cache invalidation
 *
 * References:
 *   - requirements.md §12.2 — publish to queue on new message in source chat
 *   - requirements.md §12.6 — deactivation within 60s (cache TTL or pub/sub)
 *   - design.md "Forward Engine" — handler publishes event to queue
 */

const { getRedis, getRedisSubscriber } = require('../../infra/redis');
const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_PREFIX = 'forward-rules:';
const CACHE_TTL_SECONDS = 60;
const INVALIDATION_PREFIX = 'forward-rules-invalidate:';

// Track which connections have subscribed to invalidation
const subscribedConnections = new Set();

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Get cached forward rules for a connection from Redis.
 *
 * @param {string} connectionId
 * @returns {Promise<object[]|null>} Cached rules or null if not cached
 */
async function getCachedRules(connectionId) {
  try {
    const redis = getRedis();
    const cached = await redis.get(`${CACHE_PREFIX}${connectionId}`);
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  } catch (err) {
    getLogger().warn({ err, connectionId }, 'forward-listener: cache read failed');
    return null;
  }
}

/**
 * Set cached forward rules for a connection in Redis.
 *
 * @param {string} connectionId
 * @param {object[]} rules
 * @returns {Promise<void>}
 */
async function setCachedRules(connectionId, rules) {
  try {
    const redis = getRedis();
    await redis.set(
      `${CACHE_PREFIX}${connectionId}`,
      JSON.stringify(rules),
      'EX',
      CACHE_TTL_SECONDS
    );
  } catch (err) {
    getLogger().warn({ err, connectionId }, 'forward-listener: cache write failed');
  }
}

/**
 * Invalidate cached forward rules for a connection.
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function invalidateCache(connectionId) {
  try {
    const redis = getRedis();
    await redis.del(`${CACHE_PREFIX}${connectionId}`);
  } catch (err) {
    getLogger().warn({ err, connectionId }, 'forward-listener: cache invalidation failed');
  }
}

// ---------------------------------------------------------------------------
// Pub/Sub invalidation
// ---------------------------------------------------------------------------

/**
 * Subscribe to cache invalidation events for a connection.
 * Called once per connection when the listener is first invoked.
 *
 * @param {string} connectionId
 */
function subscribeToInvalidation(connectionId) {
  if (subscribedConnections.has(connectionId)) return;

  try {
    const sub = getRedisSubscriber();
    const channel = `${INVALIDATION_PREFIX}${connectionId}`;

    sub.subscribe(channel, (err) => {
      if (err) {
        getLogger().warn({ err, connectionId }, 'forward-listener: failed to subscribe to invalidation');
        return;
      }
      subscribedConnections.add(connectionId);
    });

    sub.on('message', (ch, message) => {
      if (ch === channel) {
        // Invalidate local cache
        invalidateCache(connectionId);
      }
    });
  } catch (err) {
    getLogger().warn({ err, connectionId }, 'forward-listener: invalidation subscription error');
  }
}

/**
 * Publish a cache invalidation event for a connection.
 * Called when a rule is toggled or modified.
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function publishInvalidation(connectionId) {
  try {
    const redis = getRedis();
    await redis.publish(`${INVALIDATION_PREFIX}${connectionId}`, 'invalidate');
  } catch (err) {
    getLogger().warn({ err, connectionId }, 'forward-listener: failed to publish invalidation');
  }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Load active forward rules for a connection, using cache.
 *
 * @param {string} tenantId
 * @param {string} connectionId
 * @returns {Promise<object[]>}
 */
async function loadActiveRules(tenantId, connectionId) {
  // Try cache first
  const cached = await getCachedRules(connectionId);
  if (cached !== null) {
    return cached;
  }

  // Load from DB
  const rules = await tenantQuery(tenantId, 'forward_rules')
    .where({ connection_id: connectionId, is_active: true });

  // Cache the result
  await setCachedRules(connectionId, rules);

  return rules;
}

/**
 * Handle an incoming message for auto-forwarding.
 *
 * Called from bot/user runtime when a new message arrives.
 * Loads active forward rules for this connection where source_chat matches,
 * then publishes a job to the 'forwards' queue for each matching rule.
 *
 * @param {object} ctx - Message context
 * @param {string} ctx.chatId - The chat ID where the message was received
 * @param {string} ctx.messageId - The message ID
 * @param {string} [ctx.text] - Message text (if any)
 * @param {string} [ctx.mediaType] - Media type (photo, video, document, etc.)
 * @param {string} [ctx.senderId] - Sender's user ID
 * @param {string} tenantId - The tenant that owns the connection
 * @param {string} connectionId - The connection that received the message
 * @returns {Promise<number>} Number of forward jobs published
 */
async function handleIncomingForForward(ctx, tenantId, connectionId) {
  const log = getLogger();

  // Subscribe to invalidation channel (once per connection)
  subscribeToInvalidation(connectionId);

  // Load active rules for this connection
  const rules = await loadActiveRules(tenantId, connectionId);

  if (!rules || rules.length === 0) {
    return 0;
  }

  const { chatId, messageId, text, mediaType, senderId } = ctx;
  const chatIdStr = String(chatId);

  // Find rules where source_chat matches the incoming chat
  const matchingRules = rules.filter((rule) => {
    return String(rule.source_chat) === chatIdStr;
  });

  if (matchingRules.length === 0) {
    return 0;
  }

  // Publish a job for each matching rule
  const queue = getQueue(QUEUE_NAMES.FORWARDS);
  let published = 0;

  for (const rule of matchingRules) {
    // Double-check is_active from the rule (cache may be slightly stale)
    if (!rule.is_active) continue;

    try {
      await queue.add('forward-message', {
        ruleId: rule.id,
        messageId,
        chatId: chatIdStr,
        text: text || null,
        mediaType: mediaType || null,
        senderId: senderId ? String(senderId) : null,
        connectionId,
      }, {
        jobId: `fwd:${rule.id}:${messageId}`,
      });
      published++;
    } catch (err) {
      log.warn(
        { err, ruleId: rule.id, messageId, connectionId },
        'forward-listener: failed to publish forward job'
      );
    }
  }

  if (published > 0) {
    log.debug(
      { connectionId, chatId: chatIdStr, published },
      'forward-listener: published forward jobs'
    );
  }

  return published;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleIncomingForForward,
  loadActiveRules,
  invalidateCache,
  publishInvalidation,
  subscribeToInvalidation,
  // Exported for testing
  getCachedRules,
  setCachedRules,
  CACHE_PREFIX,
  CACHE_TTL_SECONDS,
};
