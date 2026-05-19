'use strict';

/**
 * Symmetric encryption helpers (AES-256-GCM) for credentials at rest.
 *
 * This module is the single source of truth for encrypting and decrypting
 * sensitive Tenant data — bot tokens, MTProto session strings, MTProto
 * `api_hash`, Gemini API keys, and webhook secrets — before they hit
 * PostgreSQL. Every ciphertext blob carries a `keyId` so master keys can be
 * rotated without touching existing rows: the new key is rolled in as
 * `APP_MASTER_KEY` while the old one stays available as
 * `APP_MASTER_KEY_PREV`, and a background re-encrypt job lazily migrates
 * blobs from `keyId='v0'` to `keyId='v1'`.
 *
 * Public API:
 *   encrypt(plaintext)                  → { keyId, iv, tag, ciphertext } (Buffers)
 *   decrypt(blob)                       → Buffer
 *   encryptToColumns(plaintext)         → { encrypted_secret, secret_iv,
 *                                            secret_tag, secret_key_id }
 *   decryptFromColumns(cols)            → Buffer
 *   serializeBlob(blob)                 → base64 JSON string
 *   deserializeBlob(string)             → blob
 *   getKeyStore() / resetKeyStoreCache()  ← test seams
 *
 * Algorithm choice: Node's built-in `aes-256-gcm` via `crypto.createCipheriv`
 * and `crypto.createDecipheriv`. We never roll our own primitives.
 *
 * IV / tag conventions:
 *   - IV: 12 random bytes from `crypto.randomBytes` (NIST SP 800-38D recommends
 *     96-bit IVs for GCM; reusing an IV with the same key is catastrophic).
 *   - Tag: 16 bytes, the full GCM authentication tag.
 *
 * References:
 *   - requirements.md §4.3, §5.2, §5.7, §8.2, §20.1 — credentials encrypted
 *     with AES-256-GCM, master key from env.
 *   - design.md "Encryption & Security Model" — KeyStore with `keyId` per blob,
 *     `APP_MASTER_KEY` (active) + optional `APP_MASTER_KEY_PREV` for rotation.
 *   - design.md Property 1 — `decrypt(encrypt(p)) == p`, ciphertext does not
 *     contain plaintext.
 *
 * NOTE: PBKDF2 (backup key derivation) and bcrypt (password hashing) helpers
 * are added by task 2.6 below this section.
 */

const crypto = require('crypto');

const { getEnv } = require('../shared/env');

// ---------------------------------------------------------------------------
// Algorithm constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;   // AES-256 → 256-bit key
const IV_BYTES = 12;    // GCM recommended IV size (96 bits)
const TAG_BYTES = 16;   // GCM authentication tag

const DEFAULT_ACTIVE_KEY_ID = 'v1';
const DEFAULT_PREV_KEY_ID = 'v0';

// ---------------------------------------------------------------------------
// KeyStore
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of the keys currently loaded in memory.
 *
 * Built from the validated env (`getEnv()`) which already exposes
 * `appMasterKey` and `appMasterKeyPrev` as decoded 32-byte Buffers.
 *
 * @typedef {Object} KeyStore
 * @property {string} activeKeyId            id stamped on every newly produced ciphertext
 * @property {Buffer} activeKey              32-byte buffer for the active key
 * @property {string|null} previousKeyId     id of the rotation predecessor, if any
 * @property {Buffer|null} previousKey       32-byte buffer for the predecessor, if any
 * @property {(keyId: string) => Buffer|null} get  lookup helper (returns null if unknown)
 */

/**
 * Build a fresh `KeyStore` from validated env. Performs defensive checks even
 * though `env.js` already validates the base64 → 32-byte invariant; if the
 * keys ever drift out of sync (e.g. after a future env-loader refactor) this
 * module must still refuse to operate rather than silently encrypt with a
 * truncated key.
 *
 * @returns {KeyStore}
 */
function buildKeyStore() {
  const env = getEnv();

  const activeKey = env.appMasterKey;
  if (!Buffer.isBuffer(activeKey) || activeKey.length !== KEY_BYTES) {
    throw new Error(
      `[crypto] APP_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes`,
    );
  }
  const activeKeyId = (env.APP_MASTER_KEY_ID || DEFAULT_ACTIVE_KEY_ID).trim();
  if (!activeKeyId) {
    throw new Error('[crypto] APP_MASTER_KEY_ID must be a non-empty string');
  }

  let previousKey = null;
  let previousKeyId = null;
  if (env.appMasterKeyPrev) {
    if (!Buffer.isBuffer(env.appMasterKeyPrev) || env.appMasterKeyPrev.length !== KEY_BYTES) {
      throw new Error(
        `[crypto] APP_MASTER_KEY_PREV must decode to exactly ${KEY_BYTES} bytes`,
      );
    }
    previousKey = env.appMasterKeyPrev;
    // The previous-key id is not part of the validated env schema (rotations
    // are infrequent and we want to keep the env contract minimal). Read it
    // straight from `process.env`, falling back to the conventional 'v0'.
    const rawPrevId = (process.env.APP_MASTER_KEY_PREV_ID || DEFAULT_PREV_KEY_ID).trim();
    if (!rawPrevId) {
      throw new Error('[crypto] APP_MASTER_KEY_PREV_ID must be a non-empty string');
    }
    previousKeyId = rawPrevId;

    if (previousKeyId === activeKeyId) {
      throw new Error(
        '[crypto] APP_MASTER_KEY_ID and APP_MASTER_KEY_PREV_ID must differ during rotation',
      );
    }
  }

  const map = new Map();
  map.set(activeKeyId, activeKey);
  if (previousKey) map.set(previousKeyId, previousKey);

  return Object.freeze({
    activeKeyId,
    activeKey,
    previousKeyId,
    previousKey,
    get(keyId) {
      if (typeof keyId !== 'string' || keyId.length === 0) return null;
      return map.get(keyId) || null;
    },
  });
}

/** @type {KeyStore|undefined} */
let cachedKeyStore;

/**
 * Return the lazily-built `KeyStore` singleton.
 *
 * @returns {KeyStore}
 */
function getKeyStore() {
  if (!cachedKeyStore) {
    cachedKeyStore = buildKeyStore();
  }
  return cachedKeyStore;
}

/**
 * Reset the memoised KeyStore. Intended for tests that mutate `process.env`
 * (or reset the env cache) between cases.
 */
function resetKeyStoreCache() {
  cachedKeyStore = undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce `plaintext` to a Buffer. Strings are interpreted as UTF-8.
 *
 * @param {string|Buffer} plaintext
 * @returns {Buffer}
 */
function toPlaintextBuffer(plaintext) {
  if (Buffer.isBuffer(plaintext)) return plaintext;
  if (typeof plaintext === 'string') return Buffer.from(plaintext, 'utf8');
  throw new TypeError('[crypto] encrypt(plaintext): plaintext must be a string or Buffer');
}

/**
 * Validate that `value` is a Buffer with exactly `expectedBytes` bytes.
 *
 * @param {unknown} value
 * @param {number} expectedBytes
 * @param {string} label
 * @returns {Buffer}
 */
function assertBufferOfLength(value, expectedBytes, label) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`[crypto] ${label} must be a Buffer`);
  }
  if (value.length !== expectedBytes) {
    throw new RangeError(
      `[crypto] ${label} must be exactly ${expectedBytes} bytes (got ${value.length})`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public encryption API
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` with the currently active master key.
 *
 * Always uses a fresh 12-byte random IV; never reuse an IV with the same
 * key (catastrophic for GCM). The returned blob carries the `keyId` so a
 * future `decrypt()` call can find the right key even after rotation.
 *
 * @param {string|Buffer} plaintext   string (interpreted UTF-8) or raw bytes
 * @returns {{ keyId: string, iv: Buffer, tag: Buffer, ciphertext: Buffer }}
 */
function encrypt(plaintext) {
  const buf = toPlaintextBuffer(plaintext);
  const store = getKeyStore();

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, store.activeKey, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    keyId: store.activeKeyId,
    iv,
    tag,
    ciphertext,
  };
}

/**
 * Decrypt an AES-GCM blob produced by `encrypt` (or rebuilt from DB columns
 * via `decryptFromColumns`). Throws if `keyId` is unknown to the current
 * KeyStore — that signals either a misconfigured environment or a row that
 * was encrypted under a key that has been retired without re-encryption.
 *
 * @param {{ keyId: string, iv: Buffer, tag: Buffer, ciphertext: Buffer }} blob
 * @returns {Buffer}  raw decrypted bytes (callers decode to UTF-8 if needed)
 */
function decrypt(blob) {
  if (!blob || typeof blob !== 'object') {
    throw new TypeError('[crypto] decrypt(blob): blob must be an object');
  }
  const { keyId, iv, tag, ciphertext } = blob;

  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new TypeError('[crypto] decrypt(blob): blob.keyId must be a non-empty string');
  }
  assertBufferOfLength(iv, IV_BYTES, 'blob.iv');
  assertBufferOfLength(tag, TAG_BYTES, 'blob.tag');
  if (!Buffer.isBuffer(ciphertext)) {
    throw new TypeError('[crypto] decrypt(blob): blob.ciphertext must be a Buffer');
  }

  const store = getKeyStore();
  const key = store.get(keyId);
  if (!key) {
    throw new Error(`[crypto] decrypt: unknown keyId '${keyId}' (rotation predecessor missing?)`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
// Column-oriented helpers (telegram_connections schema)
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` and shape the result so it can be spread directly into
 * the `telegram_connections` columns defined in design.md:
 *
 *   encrypted_secret BYTEA, secret_iv BYTEA, secret_tag BYTEA,
 *   secret_key_id TEXT
 *
 * The same shape is reused by `webhooks.secret_encrypted` (same trio of
 * iv/tag/key_id) and by `ai_settings.api_key_encrypted` — repository code
 * just maps column names per table.
 *
 * @param {string|Buffer} plaintext
 * @returns {{ encrypted_secret: Buffer, secret_iv: Buffer, secret_tag: Buffer, secret_key_id: string }}
 */
function encryptToColumns(plaintext) {
  const blob = encrypt(plaintext);
  return {
    encrypted_secret: blob.ciphertext,
    secret_iv: blob.iv,
    secret_tag: blob.tag,
    secret_key_id: blob.keyId,
  };
}

/**
 * Reverse of `encryptToColumns`: rebuild a blob from the four DB columns and
 * decrypt it. Throws the same shape of errors as `decrypt` for unknown keys
 * or malformed inputs.
 *
 * @param {{ encrypted_secret: Buffer, secret_iv: Buffer, secret_tag: Buffer, secret_key_id: string }} cols
 * @returns {Buffer}
 */
function decryptFromColumns(cols) {
  if (!cols || typeof cols !== 'object') {
    throw new TypeError('[crypto] decryptFromColumns(cols): cols must be an object');
  }
  return decrypt({
    keyId: cols.secret_key_id,
    iv: cols.secret_iv,
    tag: cols.secret_tag,
    ciphertext: cols.encrypted_secret,
  });
}

// ---------------------------------------------------------------------------
// Portable serialization (used by backup export / cross-process payloads)
// ---------------------------------------------------------------------------

/**
 * Serialize a blob to a single base64 string. Useful when the blob has to
 * travel through a transport that only speaks text (JSON payload, env var,
 * BullMQ job data, backup manifest, …).
 *
 * Format: base64( JSON.stringify({ keyId, iv:b64, tag:b64, ciphertext:b64 }) )
 * The outer base64 keeps the value compact and avoids JSON-escaping headaches
 * when the string is itself stored inside another JSON document.
 *
 * @param {{ keyId: string, iv: Buffer, tag: Buffer, ciphertext: Buffer }} blob
 * @returns {string}
 */
function serializeBlob(blob) {
  if (!blob || typeof blob !== 'object') {
    throw new TypeError('[crypto] serializeBlob(blob): blob must be an object');
  }
  if (typeof blob.keyId !== 'string' || blob.keyId.length === 0) {
    throw new TypeError('[crypto] serializeBlob(blob): blob.keyId must be a non-empty string');
  }
  assertBufferOfLength(blob.iv, IV_BYTES, 'blob.iv');
  assertBufferOfLength(blob.tag, TAG_BYTES, 'blob.tag');
  if (!Buffer.isBuffer(blob.ciphertext)) {
    throw new TypeError('[crypto] serializeBlob(blob): blob.ciphertext must be a Buffer');
  }

  const json = JSON.stringify({
    keyId: blob.keyId,
    iv: blob.iv.toString('base64'),
    tag: blob.tag.toString('base64'),
    ciphertext: blob.ciphertext.toString('base64'),
  });
  return Buffer.from(json, 'utf8').toString('base64');
}

/**
 * Reverse of `serializeBlob`. Throws on malformed input.
 *
 * @param {string} serialized
 * @returns {{ keyId: string, iv: Buffer, tag: Buffer, ciphertext: Buffer }}
 */
function deserializeBlob(serialized) {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new TypeError('[crypto] deserializeBlob(s): s must be a non-empty string');
  }

  let parsed;
  try {
    const json = Buffer.from(serialized, 'base64').toString('utf8');
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`[crypto] deserializeBlob: malformed input (${err.message})`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('[crypto] deserializeBlob: payload is not an object');
  }
  if (typeof parsed.keyId !== 'string' || parsed.keyId.length === 0) {
    throw new Error('[crypto] deserializeBlob: missing keyId');
  }
  if (typeof parsed.iv !== 'string'
    || typeof parsed.tag !== 'string'
    || typeof parsed.ciphertext !== 'string') {
    throw new Error('[crypto] deserializeBlob: iv/tag/ciphertext must be base64 strings');
  }

  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const ciphertext = Buffer.from(parsed.ciphertext, 'base64');
  assertBufferOfLength(iv, IV_BYTES, 'serialized.iv');
  assertBufferOfLength(tag, TAG_BYTES, 'serialized.tag');

  return {
    keyId: parsed.keyId,
    iv,
    tag,
    ciphertext,
  };
}

// ---------------------------------------------------------------------------
// Passphrase-based encryption (PBKDF2-SHA256) — used by encrypted backup export
// ---------------------------------------------------------------------------

const bcrypt = require('bcrypt');

/**
 * PBKDF2 parameters chosen for backup-key derivation.
 *
 * - SHA-256: hardware-accelerated on most modern server CPUs and is the same
 *   family used to build the GCM authentication tag, so we don't introduce a
 *   second cryptographic primitive.
 * - 200000 iterations (default): tunable via `BACKUP_PASSPHRASE_PBKDF2_ITERS`.
 *   Defends against offline brute-force when an attacker captures the
 *   encrypted backup; the iteration count is stored alongside the ciphertext
 *   so future parameter increases stay backward compatible with old backups.
 * - 16-byte random salt: standard size, makes precomputed/rainbow tables
 *   useless even if a passphrase is reused across tenants.
 * - 32-byte output: feeds straight into AES-256-GCM via the same primitives
 *   used by the master-key path above.
 *
 * References:
 *   - requirements.md §16.2 — encrypted backup export with passphrase-derived key.
 *   - design.md "Backup & Export" — PBKDF2-SHA256, 200k iterations, salt stored
 *     in the manifest; decryption fails loudly on wrong passphrase.
 */
const PBKDF2_DIGEST = 'sha256';
const PBKDF2_KEYLEN = KEY_BYTES; // 32 → AES-256
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_DEFAULT_ITERATIONS = 200000;

const BCRYPT_COST = 12;

/**
 * Resolve the iteration count to use when a caller does not pass one
 * explicitly. Reads `BACKUP_PASSPHRASE_PBKDF2_ITERS` from the validated env;
 * if env validation has not run yet (very early boot, or some test wirings)
 * we fall back to the constant so the helper still works in isolation.
 */
function getDefaultPbkdf2Iterations() {
  try {
    const env = getEnv();
    const fromEnv = Number(env.BACKUP_PASSPHRASE_PBKDF2_ITERS);
    if (Number.isInteger(fromEnv) && fromEnv >= 1) {
      return fromEnv;
    }
  } catch (_err) {
    // env not yet validated — fall through to the safe default.
  }
  return PBKDF2_DEFAULT_ITERATIONS;
}

/**
 * Derive a 32-byte AES-256 key from a UTF-8 passphrase via PBKDF2-HMAC-SHA256.
 *
 * Synchronous on purpose: backup export/import is a low-frequency, offline
 * operation, so blocking the event loop for a fraction of a second is
 * acceptable and keeps the API simple. If we ever derive keys on a hot path
 * (we currently don't) we can add an async sibling.
 *
 * @param {string|Buffer} passphrase   user-supplied passphrase (UTF-8 string or raw bytes)
 * @param {Buffer} salt                 16-byte random salt
 * @param {number} [iterations]         defaults to env `BACKUP_PASSPHRASE_PBKDF2_ITERS` (200000)
 * @returns {Buffer} 32-byte derived key
 */
function derivePassphraseKey(passphrase, salt, iterations) {
  if (typeof passphrase !== 'string' && !Buffer.isBuffer(passphrase)) {
    throw new TypeError(
      '[crypto] derivePassphraseKey: passphrase must be a string or Buffer',
    );
  }
  if (typeof passphrase === 'string' && passphrase.length === 0) {
    throw new RangeError('[crypto] derivePassphraseKey: passphrase must not be empty');
  }
  if (Buffer.isBuffer(passphrase) && passphrase.length === 0) {
    throw new RangeError('[crypto] derivePassphraseKey: passphrase must not be empty');
  }
  assertBufferOfLength(salt, PBKDF2_SALT_BYTES, 'salt');

  const iters = iterations == null ? getDefaultPbkdf2Iterations() : iterations;
  if (!Number.isInteger(iters) || iters < 1) {
    throw new RangeError(
      '[crypto] derivePassphraseKey: iterations must be a positive integer',
    );
  }

  const passBuf = typeof passphrase === 'string'
    ? Buffer.from(passphrase, 'utf8')
    : passphrase;

  return crypto.pbkdf2Sync(passBuf, salt, iters, PBKDF2_KEYLEN, PBKDF2_DIGEST);
}

/**
 * Generate a fresh 16-byte random salt suitable for passing to
 * `derivePassphraseKey` / `encryptWithPassphrase`.
 *
 * @returns {Buffer}
 */
function generatePassphraseSalt() {
  return crypto.randomBytes(PBKDF2_SALT_BYTES);
}

/**
 * Encrypt `plaintext` under a passphrase. The returned blob carries everything
 * a future caller needs to derive the same key and verify integrity:
 *
 *   { salt, iterations, iv, tag, ciphertext }
 *
 * Each call generates a fresh salt and IV, so encrypting the same plaintext
 * with the same passphrase twice yields different ciphertexts (no determinism
 * leak). The shape mirrors the master-key blob but swaps `keyId` for
 * `salt + iterations` since passphrase-derived keys live outside the
 * KeyStore registry.
 *
 * @param {string|Buffer} plaintext
 * @param {string|Buffer} passphrase
 * @param {{ iterations?: number, salt?: Buffer }} [options]
 *   `iterations` overrides the env default; `salt` lets tests pin determinism.
 * @returns {{ salt: Buffer, iterations: number, iv: Buffer, tag: Buffer, ciphertext: Buffer }}
 */
function encryptWithPassphrase(plaintext, passphrase, options = {}) {
  if (options !== null && typeof options !== 'object') {
    throw new TypeError(
      '[crypto] encryptWithPassphrase(options): options must be an object when provided',
    );
  }
  const buf = toPlaintextBuffer(plaintext);

  const iterations =
    options.iterations == null ? getDefaultPbkdf2Iterations() : options.iterations;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(
      '[crypto] encryptWithPassphrase: options.iterations must be a positive integer',
    );
  }

  const salt = options.salt == null ? generatePassphraseSalt() : options.salt;
  assertBufferOfLength(salt, PBKDF2_SALT_BYTES, 'options.salt');

  const key = derivePassphraseKey(passphrase, salt, iterations);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt,
    iterations,
    iv,
    tag,
    ciphertext,
  };
}

/**
 * Decrypt a passphrase-encrypted blob produced by `encryptWithPassphrase`.
 *
 * Throws a clear "wrong passphrase or corrupted backup" error when the GCM
 * authentication tag does not verify. By design we do not distinguish between
 * a bad passphrase and tampered ciphertext: both indicate the data cannot be
 * trusted, and merging the two avoids leaking which case occurred.
 *
 * @param {{ salt: Buffer, iterations: number, iv: Buffer, tag: Buffer, ciphertext: Buffer }} blob
 * @param {string|Buffer} passphrase
 * @returns {Buffer} raw decrypted bytes (callers decode to UTF-8 if needed)
 */
function decryptWithPassphrase(blob, passphrase) {
  if (!blob || typeof blob !== 'object') {
    throw new TypeError('[crypto] decryptWithPassphrase(blob): blob must be an object');
  }
  const { salt, iterations, iv, tag, ciphertext } = blob;
  assertBufferOfLength(salt, PBKDF2_SALT_BYTES, 'blob.salt');
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(
      '[crypto] decryptWithPassphrase: blob.iterations must be a positive integer',
    );
  }
  assertBufferOfLength(iv, IV_BYTES, 'blob.iv');
  assertBufferOfLength(tag, TAG_BYTES, 'blob.tag');
  if (!Buffer.isBuffer(ciphertext)) {
    throw new TypeError(
      '[crypto] decryptWithPassphrase: blob.ciphertext must be a Buffer',
    );
  }

  const key = derivePassphraseKey(passphrase, salt, iterations);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_err) {
    // Node throws an opaque "Unsupported state or unable to authenticate data"
    // error when the GCM tag fails. Rewrite to a security-honest message that
    // signals the most common cause to the caller (backup restore UX).
    throw new Error(
      '[crypto] decryptWithPassphrase: wrong passphrase or corrupted backup (auth tag mismatch)',
    );
  }
}

// ---------------------------------------------------------------------------
// Password hashing (bcrypt) — used by user authentication
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password with bcrypt at cost factor 12.
 *
 * Cost 12 is a deliberate trade-off: roughly 250–400ms on a modern server CPU,
 * which makes targeted offline brute-force expensive while keeping login
 * latency well within the 1s SLO. Because the cost factor is embedded in the
 * resulting hash string, raising the cost in the future is trivial: bump the
 * constant and re-hash on the next successful login per user.
 *
 * @param {string} plaintext
 * @returns {Promise<string>} bcrypt hash string of the form `$2b$12$…`
 */
async function hashPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('[crypto] hashPassword: plaintext must be a non-empty string');
  }
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verify a plaintext password against a bcrypt hash. Returns `false` for any
 * malformed hash, missing input, or internal comparison error — it never
 * throws — so callers can plug it straight into login flows without a
 * try/catch and without leaking which precondition failed.
 *
 * @param {string} plaintext
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plaintext, hash) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (typeof hash !== 'string' || hash.length === 0) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch (_err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // constants (handy for tests + downstream callers building blobs by hand)
  ALGORITHM,
  KEY_BYTES,
  IV_BYTES,
  TAG_BYTES,
  PBKDF2_DIGEST,
  PBKDF2_SALT_BYTES,
  PBKDF2_DEFAULT_ITERATIONS,
  BCRYPT_COST,
  // KeyStore
  getKeyStore,
  resetKeyStoreCache,
  // core
  encrypt,
  decrypt,
  // schema-shaped helpers
  encryptToColumns,
  decryptFromColumns,
  // transport helpers
  serializeBlob,
  deserializeBlob,
  // passphrase-based (backup) helpers — task 2.6
  derivePassphraseKey,
  generatePassphraseSalt,
  encryptWithPassphrase,
  decryptWithPassphrase,
  // password hashing — task 2.6
  hashPassword,
  verifyPassword,
};
