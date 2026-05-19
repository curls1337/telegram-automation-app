'use strict';

/**
 * Rate limiter for User (MTProto) connections.
 *
 * Enforces a maximum of 30 messages per minute per User_Connection to
 * reduce the risk of Telegram account bans.
 *
 * Uses rate-limiter-flexible with Redis backend for distributed enforcement
 * across multiple worker instances.
 *
 * References:
 *   - requirements.md §5.6 — rate limit default 30 msg/min per User_Connection
 *   - design.md "Connection Manager" — Redis token bucket key user-conn-rate:<id>
 */

const { RateLimiterRedis } = require('rate-limiter-flexible');

const { getRedis } = require('../../../infra/redis');
const { RateLimitError } = require('../../../shared/errors');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'user-conn-rate';
const POINTS = 30;       // 30 messages
const DURATION = 60;     // per 60 seconds (1 minute)

// ---------------------------------------------------------------------------
// Limiter instance (lazy singleton)
// ---------------------------------------------------------------------------

/** @type {RateLimiterRedis|undefined} */
let limiterInstance;

/**
 * Get or create the rate limiter instance.
 *
 * @returns {RateLimiterRedis}
 */
function getUserConnectionLimiter() {
  if (!limiterInstance) {
    const redis = getRedis();
    limiterInstance = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: KEY_PREFIX,
      points: POINTS,
      duration: DURATION,
    });
  }
  return limiterInstance;
}

/**
 * Reset the limiter instance (for testing).
 */
function resetLimiter() {
  limiterInstance = undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Consume one rate limit point for the given connection.
 * Throws RateLimitError if the connection has exceeded 30 messages/minute.
 *
 * @param {string} connectionId
 * @throws {RateLimitError}
 */
async function checkUserConnectionRate(connectionId) {
  const limiter = getUserConnectionLimiter();

  try {
    await limiter.consume(connectionId, 1);
  } catch (rateLimiterRes) {
    // rate-limiter-flexible rejects with a RateLimiterRes object when limit exceeded
    const retryAfter = rateLimiterRes && rateLimiterRes.msBeforeNext
      ? Math.ceil(rateLimiterRes.msBeforeNext / 1000)
      : DURATION;

    throw new RateLimitError(
      `User connection rate limit exceeded (max ${POINTS} messages per minute)`,
      {
        details: {
          connectionId,
          retryAfter,
          limit: POINTS,
          duration: DURATION,
        },
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  checkUserConnectionRate,
  getUserConnectionLimiter,
  resetLimiter,
  // Constants exported for testing
  KEY_PREFIX,
  POINTS,
  DURATION,
};
