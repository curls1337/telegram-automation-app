'use strict';

/**
 * API Key Service — create, verify, revoke, and list API keys.
 *
 * Responsibilities:
 *   - Generate cryptographically strong tokens (≥32 chars)
 *   - Store only sha256(token) in the database (never plaintext)
 *   - Constant-time comparison during verification
 *   - Revoke keys (soft-delete via revoked_at timestamp)
 *   - List keys for a tenant (without exposing hashes)
 *
 * References:
 *   - requirements.md §14.1 — API key creation, plaintext shown once
 *   - requirements.md §14.3 — sha256 hash storage, const-time verify
 */

const crypto = require('crypto');
const { getDb, tenantQuery, tenantInsert } = require('../../../infra/db');
const { getLogger } = require('../../../infra/logger');
const { newId, randomToken, sha256Hex } = require('../../../shared/ids');
const { nowIso } = require('../../../shared/time');
const { NotFoundError } = require('../../../shared/errors');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'api_keys';

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new API key for a tenant.
 * Generates a 32-byte random token (64 hex chars), stores sha256(token).
 * Returns the plaintext token exactly once.
 *
 * @param {string} tenantId
 * @param {string} name - Human-readable label for the key
 * @param {string[]} scopes - Array of permission scopes
 * @returns {Promise<{ id: string, plaintext: string }>}
 */
async function create(tenantId, name, scopes) {
  const log = getLogger();

  // Generate 32-byte random token → 64 hex chars
  const plaintext = randomToken(32);
  const tokenHash = sha256Hex(plaintext);

  const keyId = newId();
  const timestamp = nowIso();

  await tenantInsert(tenantId, TABLE, {
    id: keyId,
    name: name.trim(),
    token_hash: tokenHash,
    scopes: JSON.stringify(scopes || []),
    last_used_at: null,
    revoked_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  });

  log.info({ keyId, tenantId, name }, 'api-key-service: key created');

  return { id: keyId, plaintext };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Verify an API key token. Uses constant-time comparison to prevent timing
 * attacks. Returns key metadata on success, null on failure.
 *
 * @param {string} token - The plaintext API key token
 * @returns {Promise<{ tenantId: string, scopes: string[], keyId: string } | null>}
 */
async function verify(token) {
  if (!token || typeof token !== 'string') return null;

  const tokenHash = sha256Hex(token);
  const db = getDb();

  // Lookup all non-revoked keys and compare hashes in constant time
  const keys = await db(TABLE)
    .whereNull('revoked_at')
    .select('id', 'tenant_id', 'token_hash', 'scopes');

  let matched = null;

  for (const key of keys) {
    const storedHashBuf = Buffer.from(key.token_hash, 'hex');
    const incomingHashBuf = Buffer.from(tokenHash, 'hex');

    if (storedHashBuf.length === incomingHashBuf.length) {
      if (crypto.timingSafeEqual(storedHashBuf, incomingHashBuf)) {
        matched = key;
        // Don't break early — maintain constant-time behavior across all keys
        // Actually for practical purposes, once matched we can break since
        // the timing attack vector is on the comparison itself, not iteration.
        break;
      }
    }
  }

  if (!matched) return null;

  // Update last_used_at
  await db(TABLE)
    .where({ id: matched.id })
    .update({ last_used_at: nowIso() });

  const scopes = typeof matched.scopes === 'string'
    ? JSON.parse(matched.scopes)
    : (matched.scopes || []);

  return {
    tenantId: matched.tenant_id,
    scopes,
    keyId: matched.id,
  };
}

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

/**
 * Revoke an API key by setting revoked_at timestamp.
 *
 * @param {string} tenantId
 * @param {string} keyId
 * @returns {Promise<void>}
 * @throws {NotFoundError}
 */
async function revoke(tenantId, keyId) {
  const log = getLogger();

  const key = await tenantQuery(tenantId, TABLE)
    .where({ id: keyId })
    .first();

  if (!key) {
    throw new NotFoundError('API key not found');
  }

  await tenantQuery(tenantId, TABLE)
    .where({ id: keyId })
    .update({ revoked_at: nowIso(), updated_at: nowIso() });

  log.info({ keyId, tenantId }, 'api-key-service: key revoked');
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List all API keys for a tenant (without exposing token hashes).
 *
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function list(tenantId) {
  const keys = await tenantQuery(tenantId, TABLE)
    .select('id', 'name', 'scopes', 'last_used_at', 'revoked_at', 'created_at', 'updated_at')
    .orderBy('created_at', 'desc');

  return keys.map((key) => ({
    ...key,
    scopes: typeof key.scopes === 'string' ? JSON.parse(key.scopes) : (key.scopes || []),
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  create,
  verify,
  revoke,
  list,
};
