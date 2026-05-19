'use strict';

/**
 * Custom Redis-backed session middleware.
 *
 * Uses Redis directly (not express-session) for full control over session
 * lifecycle, cookie signing, and TTL management.
 *
 * Cookie: `sid`, HttpOnly, Secure (production), SameSite=Lax, Path=/,
 * signed with SESSION_SECRET using HMAC-SHA256.
 *
 * Session data shape in Redis (key `session:<id>`):
 *   { userId, activeTenantId, createdAt }
 *
 * References:
 *   - requirements.md §1.4 — session with 7-day TTL
 *   - requirements.md §22.3 — Redis-backed session
 *   - design.md "Auth Module" — session stored in Redis, HttpOnly+Secure+SameSite=Lax
 */

const crypto = require('crypto');

const { getRedis } = require('../../infra/redis');
const { getEnv } = require('../../shared/env');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'sid';
const SESSION_TTL_SECONDS = 604800; // 7 days
const SIGNATURE_ALGORITHM = 'sha256';

// ---------------------------------------------------------------------------
// Cookie signing helpers
// ---------------------------------------------------------------------------

/**
 * Sign a value with HMAC-SHA256 using the SESSION_SECRET.
 *
 * @param {string} value
 * @param {string} secret
 * @returns {string} value.signature
 */
function sign(value, secret) {
  const signature = crypto
    .createHmac(SIGNATURE_ALGORITHM, secret)
    .update(value)
    .digest('base64url');
  return `${value}.${signature}`;
}

/**
 * Verify and extract the original value from a signed cookie.
 * Returns null if the signature is invalid.
 *
 * @param {string} signedValue
 * @param {string} secret
 * @returns {string|null}
 */
function unsign(signedValue, secret) {
  if (typeof signedValue !== 'string') return null;

  const lastDot = signedValue.lastIndexOf('.');
  if (lastDot === -1) return null;

  const value = signedValue.slice(0, lastDot);
  const providedSig = signedValue.slice(lastDot + 1);

  const expectedSig = crypto
    .createHmac(SIGNATURE_ALGORITHM, secret)
    .update(value)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  if (providedSig.length !== expectedSig.length) return null;

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');

  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return value;
}

// ---------------------------------------------------------------------------
// Cookie parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse a raw Cookie header string into a key-value map.
 *
 * @param {string} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    // Decode URI-encoded values
    try {
      cookies[key] = decodeURIComponent(val);
    } catch (_e) {
      cookies[key] = val;
    }
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that reads the signed session cookie, loads session
 * data from Redis, and attaches `req.session` and `req.sessionId`.
 *
 * If no valid session is found, `req.session` is null and `req.sessionId`
 * is null.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function sessionMiddleware(req, res, next) {
  try {
    const env = getEnv();
    const secret = env.SESSION_SECRET;

    // Parse cookies from header
    const cookies = parseCookies(req.headers.cookie);
    const signedSid = cookies[COOKIE_NAME];

    req.session = null;
    req.sessionId = null;

    if (!signedSid) {
      return next();
    }

    // Verify signature
    const sessionId = unsign(signedSid, secret);
    if (!sessionId) {
      return next();
    }

    // Load session from Redis
    const redis = getRedis();
    const raw = await redis.get(`session:${sessionId}`);

    if (!raw) {
      return next();
    }

    try {
      const sessionData = JSON.parse(raw);
      req.session = sessionData;
      req.sessionId = sessionId;
    } catch (_e) {
      // Malformed session data — treat as no session
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Create a new session in Redis and set the signed cookie on the response.
 *
 * @param {import('express').Response} res
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<string>} The new session ID
 */
async function createSession(res, userId, tenantId) {
  const env = getEnv();
  const sessionId = newId();

  const sessionData = {
    userId,
    activeTenantId: tenantId,
    createdAt: now().toISOString(),
  };

  const redis = getRedis();
  await redis.set(
    `session:${sessionId}`,
    JSON.stringify(sessionData),
    'EX',
    SESSION_TTL_SECONDS
  );

  // Set signed cookie
  const signedValue = sign(sessionId, env.SESSION_SECRET);
  const isProduction = env.NODE_ENV === 'production';

  res.setHeader('Set-Cookie', buildCookieString(signedValue, isProduction));

  return sessionId;
}

/**
 * Destroy a session by removing it from Redis and clearing the cookie.
 *
 * @param {import('express').Response} res
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function destroySession(res, sessionId) {
  if (!sessionId) return;

  const redis = getRedis();
  await redis.del(`session:${sessionId}`);

  // Clear cookie by setting it with an expired date
  const env = getEnv();
  const isProduction = env.NODE_ENV === 'production';

  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (isProduction) {
    parts.push('Secure');
  }

  res.setHeader('Set-Cookie', parts.join('; '));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the Set-Cookie header value.
 *
 * @param {string} signedValue
 * @param {boolean} secure
 * @returns {string}
 */
function buildCookieString(signedValue, secure) {
  const maxAge = SESSION_TTL_SECONDS;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(signedValue)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  sessionMiddleware,
  createSession,
  destroySession,
  // Exported for testing
  sign,
  unsign,
  parseCookies,
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
};
