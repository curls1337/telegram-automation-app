'use strict';

/**
 * API Rate Limit Middleware — Redis token-bucket 100 req/min per API key.
 *
 * Uses `rate-limiter-flexible` with Redis store. Key pattern: `api-rate:<keyId>`.
 * On exceed: 429 JSON response with Retry-After header.
 *
 * References:
 *   - requirements.md §14.8 — rate limit 100 req/min per API key
 */

const { RateLimiterRedis } = require('rate-limiter-flexible');
const { getRedis } = require('../../../infra/redis');
const { getLogger } = require('../../../infra/logger');

// ---------------------------------------------------------------------------
// Rate limiter instance (lazy)
// ---------------------------------------------------------------------------

let rateLimiter;

/**
 * Get or create the rate limiter instance.
 * @returns {RateLimiterRedis}
 */
function getRateLimiter() {
  if (!rateLimiter) {
    rateLimiter = new RateLimiterRedis({
      storeClient: getRedis(),
      keyPrefix: 'api-rate',
      points: 100,       // 100 requests
      duration: 60,      // per 60 seconds (1 minute)
      blockDuration: 0,  // Don't block, just reject
    });
  }
  return rateLimiter;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that enforces rate limiting per API key.
 * Must be mounted AFTER apiAuthMiddleware (requires req.apiKey).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function apiRateLimitMiddleware(req, res, next) {
  const log = getLogger();

  // If no API key context, skip (shouldn't happen if auth middleware ran first)
  if (!req.apiKey || !req.apiKey.id) {
    return next();
  }

  try {
    const limiter = getRateLimiter();
    const result = await limiter.consume(req.apiKey.id);

    // Set rate limit headers
    res.set('X-RateLimit-Limit', '100');
    res.set('X-RateLimit-Remaining', String(result.remainingPoints));
    res.set('X-RateLimit-Reset', String(Math.ceil(result.msBeforeNext / 1000)));

    return next();
  } catch (rateLimiterRes) {
    // rateLimiterRes is a RateLimiterRes when rate limit is exceeded
    if (rateLimiterRes && typeof rateLimiterRes.msBeforeNext === 'number') {
      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);

      res.set('Retry-After', String(retryAfter));
      res.set('X-RateLimit-Limit', '100');
      res.set('X-RateLimit-Remaining', '0');
      res.set('X-RateLimit-Reset', String(retryAfter));

      return res.status(429).json({
        error: {
          code: 'rate_limit_exceeded',
          message: 'Rate limit exceeded. Please retry after the specified time.',
        },
      });
    }

    // Unexpected error from rate limiter — let request through but log
    log.warn({ err: rateLimiterRes }, 'api-rate-limit: unexpected error, allowing request');
    return next();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { apiRateLimitMiddleware };
