'use strict';

/**
 * ID and token primitives for the Telegram Automation App.
 *
 * Centralizes UUID v4 generation (used for every primary key in the schema),
 * cryptographically-strong random tokens (password reset, invite, API key
 * plaintext), and a small SHA-256 helper used to store hashed tokens in the
 * database (see design.md → "API key handling": store `sha256(token)` only).
 *
 * All randomness comes from Node's `crypto` module, which delegates to the
 * platform CSPRNG. Do not replace with `Math.random` under any circumstance.
 *
 * Design references:
 *  - design.md → "Shared utilities" lists `src/shared/ids.js` alongside the
 *    other cross-cutting helpers.
 *  - design.md → "API key handling" / "Password reset" requires hashed
 *    storage of bearer tokens with constant-time comparison; this module
 *    produces both the plaintext and the hash.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// UUID v4
// ---------------------------------------------------------------------------

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generate a new RFC-4122 v4 UUID using the platform CSPRNG.
 *
 * @returns {string} Lowercase canonical UUID v4 (36 chars, with hyphens).
 */
function newId() {
  return crypto.randomUUID();
}

/**
 * Type guard for UUID v4 strings. Returns `false` for anything that is not a
 * canonical lowercase v4 UUID (uppercase variants are also accepted because
 * external systems sometimes emit them).
 *
 * @param {unknown} s
 * @returns {boolean}
 */
function isUuid(s) {
  return typeof s === 'string' && UUID_V4_RE.test(s);
}

// ---------------------------------------------------------------------------
// Random tokens
// ---------------------------------------------------------------------------

/**
 * Generate a hex-encoded random token suitable for password-reset links,
 * invite codes, API key plaintext, etc.
 *
 * Returned length in characters is `bytes * 2`. The default of 32 bytes
 * yields a 64-character token (256 bits of entropy), which comfortably
 * exceeds the "≥32 characters" requirement for API keys (Property 20).
 *
 * @param {number} [bytes=32] Number of random bytes (must be a positive int).
 * @returns {string} Lowercase hex string of length `bytes * 2`.
 */
function randomToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new TypeError('randomToken(bytes): bytes must be a positive integer');
  }
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/**
 * Compute the lowercase hex SHA-256 digest of `input`.
 *
 * Strings are encoded as UTF-8 before hashing. Buffers are hashed verbatim.
 * Use this for storing API key / reset token hashes (see design.md → "API
 * key handling").
 *
 * @param {string|Buffer} input
 * @returns {string} 64-character lowercase hex digest.
 */
function sha256Hex(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new TypeError('sha256Hex(input): input must be a string or Buffer');
  }
  const hash = crypto.createHash('sha256');
  hash.update(input);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  newId,
  isUuid,
  randomToken,
  sha256Hex,
};
