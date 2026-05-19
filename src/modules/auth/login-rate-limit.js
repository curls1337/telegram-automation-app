'use strict';

/**
 * Login rate limiting using rate-limiter-flexible with Redis store.
 *
 * Blocks login attempts from a single IP after too many failures within
 * a 15-minute window. The default threshold is 5 attempts (configurable
 * via RATE_LIMIT_LOGIN_MAX env var).
 *
 * References:
 *   - requirements.md §1.5 — block after 5 failed logins in 15 min per IP
 *   - design.md "Auth Module" — login throttle counter per IP in Redis
 */

const { RateLimiterRedis } = require('rate-limiter-flexible');

const { getRedis } = require('../../infra/redis');
const { getEnv } = require('../../shared/env');
const { RateLimitError } = require('../../shared/errors');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DURATION_SECONDS = 900; // 15 minutes
const KEY_PREFIX = 'login_fail';

// ---------------------------------------------------------------------------
// Limiter instance (lazy singleton)
// ---------------------------------------------------------------------------

/** @type {import('rate-limiter-flexible').RateLimiterRedis|undefined} */
let limiter;

/**
 * Build or return the cached rate limiter instance.
 *
 * @returns {import('rate-limiter-flexible').RateLimiterRedis}
 */
function getLimiter() {
  if (!limiter) {
    const env = getEnv();
    const redis = getRedis();

    limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: KEY_PREFIX,
      points: env.RATE_LIMIT_LOGIN_MAX || 5,
      duration: DURATION_SECONDS,
      // Block for the remainder of the window duration
      blockDuration: 0,
    });
  }
  return limiter;
}

/**
 * Reset the cached limiter instance. Intended for tests.
 */
function resetLimiterCache() {
  limiter = undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if the IP is currently rate-limited. Consumes 1 point.
 * Throws RateLimitError if the IP has exceeded the allowed attempts.
 *
 * Call this BEFORE attempting login to block already-exhausted IPs.
 *
 * @param {string} ip
 * @returns {Promise<void>}
 * @throws {RateLimitError} when the IP is blocked
 */
async function checkLoginRateLimit(ip) {
  if (!ip) return;

  const rl = getLimiter();

  try {
    await rl.consume(ip, 1);
  } catch (rateLimiterRes) {
    // rateLimiterRes is a RateLimiterRes object when blocked
    if (rateLimiterRes && typeof rateLimiterRes.msBeforeNext === 'number') {
      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      throw new RateLimitError(
        'Terlalu banyak percobaan login. Silakan coba lagi nanti.',
        {
          details: { retryAfter },
        }
      );
    }
    // Re-throw unexpected errors
    throw rateLimiterRes;
  }
}

/**
 * Record a failed login attempt for the given IP. Consumes 1 point.
 * Called after a failed password verification.
 *
 * @param {string} ip
 * @returns {Promise<void>}
 */
async function recordLoginFailure(ip) {
  if (!ip) return;

  const rl = getLimiter();

  try {
    await rl.consume(ip, 1);
  } catch (_rateLimiterRes) {
    // Already at limit — that's fine, the next checkLoginRateLimit will block
  }
}

/**
 * Reset the rate limit counter for an IP. Called after a successful login
 * so that legitimate users are not penalized by prior typos.
 *
 * @param {string} ip
 * @returns {Promise<void>}
 */
async function resetLoginRateLimit(ip) {
  if (!ip) return;

  const rl = getLimiter();
  await rl.delete(ip);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginRateLimit,
  // test helpers
  getLimiter,
  resetLimiterCache,
};
