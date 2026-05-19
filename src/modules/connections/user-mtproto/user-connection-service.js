'use strict';

/**
 * User Connection Service — lifecycle management for Telegram MTProto user connections.
 *
 * Responsibilities:
 *   - Multi-step login flow: sendCode → signIn (OTP) → checkPassword (2FA)
 *   - Store intermediate login state in Redis with TTL
 *   - Encrypt and store session string (AES-256-GCM)
 *   - Enforce quota before creation
 *   - Publish runtime events via Redis pub/sub
 *   - Delete connection (logout MTProto, remove row)
 *   - Write audit log entries for create/delete
 *
 * References:
 *   - requirements.md §5.1–5.8
 *   - design.md "Connection Manager" — UserConnectionService
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');

const { getDb, tenantInsert, tenantQuery } = require('../../../infra/db');
const { encryptToColumns, decryptFromColumns } = require('../../../infra/crypto');
const { getRedis, getRedisPublisher } = require('../../../infra/redis');
const { getLogger } = require('../../../infra/logger');
const { TelegramError, AuthError, NotFoundError } = require('../../../shared/errors');
const { newId } = require('../../../shared/ids');
const { now } = require('../../../shared/time');
const quotaService = require('../../plans/quota-service');
const auditLogger = require('../../audit/audit-logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'telegram_connections';
const CHANNEL = 'connection-events';
const LOGIN_STATE_PREFIX = 'login-state:';
const LOGIN_STATE_TTL = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Redis key for login state.
 * @param {string} loginId
 * @returns {string}
 */
function loginStateKey(loginId) {
  return `${LOGIN_STATE_PREFIX}${loginId}`;
}

/**
 * Create a GramJS TelegramClient with the given session string.
 * @param {string} sessionString
 * @param {number} apiId
 * @param {string} apiHash
 * @returns {TelegramClient}
 */
function createClient(sessionString, apiId, apiHash) {
  const session = new StringSession(sessionString);
  return new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Start the user login flow — sends OTP code to the phone number.
 *
 * Flow:
 *   1. Check quota (user_connections)
 *   2. Create GramJS client with empty session
 *   3. Connect and call sendCode
 *   4. Store login state in Redis with TTL
 *   5. Disconnect client
 *   6. Return loginId
 *
 * @param {string} tenantId
 * @param {number|string} apiId
 * @param {string} apiHash
 * @param {string} phone
 * @param {{ userId?: string, ip?: string }} context
 * @returns {Promise<{ loginId: string }>}
 */
async function startUserLogin(tenantId, apiId, apiHash, phone, { userId, ip } = {}) {
  const log = getLogger();

  // 1. Quota check
  await quotaService.check(tenantId, 'user_connections', 1);

  // 2. Create client with empty session
  const numericApiId = typeof apiId === 'string' ? parseInt(apiId, 10) : apiId;
  const client = createClient('', numericApiId, apiHash);

  let phoneCodeHash;
  try {
    // 3. Connect and send code
    await client.connect();

    const result = await client.sendCode(
      { apiId: numericApiId, apiHash },
      phone
    );
    phoneCodeHash = result.phoneCodeHash;
  } catch (err) {
    log.error({ err, tenantId, phone }, 'user-connection: sendCode failed');
    try { await client.disconnect(); } catch (_e) { /* best effort */ }
    throw new TelegramError(`Telegram login failed: ${err.message}`, {
      details: { raw: err.message },
      cause: err,
    });
  }

  // 4. Store state in Redis
  const loginId = newId();
  const sessionString = client.session.save();

  const state = JSON.stringify({
    tenantId,
    apiId: numericApiId,
    apiHash,
    phone,
    phoneCodeHash,
    sessionString,
    userId: userId || null,
    ip: ip || null,
  });

  const redis = getRedis();
  await redis.set(loginStateKey(loginId), state, 'EX', LOGIN_STATE_TTL);

  // 5. Disconnect client
  try { await client.disconnect(); } catch (_e) { /* best effort */ }

  log.info({ tenantId, loginId }, 'user-connection: login started, OTP sent');

  // 6. Return loginId
  return { loginId };
}

/**
 * Submit OTP code to complete sign-in (or detect 2FA requirement).
 *
 * @param {string} loginId
 * @param {string} code
 * @returns {Promise<object|{ needs2FA: boolean, loginId: string }>}
 */
async function submitOtp(loginId, code) {
  const log = getLogger();
  const redis = getRedis();

  // Load state from Redis
  const raw = await redis.get(loginStateKey(loginId));
  if (!raw) {
    throw new AuthError('Login session expired');
  }

  const state = JSON.parse(raw);
  const { tenantId, apiId, apiHash, phone, phoneCodeHash, sessionString, userId, ip } = state;

  // Recreate client with saved session
  const client = createClient(sessionString, apiId, apiHash);

  try {
    await client.connect();

    // Attempt sign in
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    const errMsg = err && err.message ? err.message : '';
    const errType = err && err.errorMessage ? err.errorMessage : '';

    // Check if 2FA is needed
    if (errType === 'SESSION_PASSWORD_NEEDED' || errMsg.includes('SESSION_PASSWORD_NEEDED')) {
      // Update state in Redis to preserve the connected session
      const updatedSessionString = client.session.save();
      const updatedState = JSON.stringify({
        ...state,
        sessionString: updatedSessionString,
        needs2FA: true,
      });
      await redis.set(loginStateKey(loginId), updatedState, 'EX', LOGIN_STATE_TTL);

      try { await client.disconnect(); } catch (_e) { /* best effort */ }

      log.info({ loginId }, 'user-connection: 2FA required');
      return { needs2FA: true, loginId };
    }

    // Other error
    try { await client.disconnect(); } catch (_e) { /* best effort */ }
    log.error({ err, loginId }, 'user-connection: signIn failed');
    throw new TelegramError(`OTP verification failed: ${errMsg || err}`, {
      details: { raw: errMsg },
      cause: err,
    });
  }

  // Success — save connection
  const finalSessionString = client.session.save();
  try { await client.disconnect(); } catch (_e) { /* best effort */ }

  const connection = await saveConnection(tenantId, apiId, apiHash, phone, finalSessionString, { userId, ip });

  // Delete login state
  await redis.del(loginStateKey(loginId));

  return connection;
}

/**
 * Submit 2FA password to complete sign-in.
 *
 * @param {string} loginId
 * @param {string} password
 * @returns {Promise<object>}
 */
async function submit2FA(loginId, password) {
  const log = getLogger();
  const redis = getRedis();

  // Load state from Redis
  const raw = await redis.get(loginStateKey(loginId));
  if (!raw) {
    throw new AuthError('Login session expired');
  }

  const state = JSON.parse(raw);
  const { tenantId, apiId, apiHash, phone, sessionString, userId, ip } = state;

  // Recreate client with saved session
  const client = createClient(sessionString, apiId, apiHash);

  try {
    await client.connect();

    // Get password SRP parameters
    const passwordResult = await client.invoke(new Api.account.GetPassword());

    // Compute password check using GramJS helper
    const passwordCheck = await client.invoke(
      new Api.auth.CheckPassword({
        password: await client._computePasswordSrp(passwordResult, password),
      })
    );
  } catch (err) {
    try { await client.disconnect(); } catch (_e) { /* best effort */ }
    const errMsg = err && err.message ? err.message : '';
    log.error({ err, loginId }, 'user-connection: 2FA verification failed');
    throw new TelegramError(`2FA verification failed: ${errMsg}`, {
      details: { raw: errMsg },
      cause: err,
    });
  }

  // Success — save connection
  const finalSessionString = client.session.save();
  try { await client.disconnect(); } catch (_e) { /* best effort */ }

  const connection = await saveConnection(tenantId, apiId, apiHash, phone, finalSessionString, { userId, ip });

  // Delete login state
  await redis.del(loginStateKey(loginId));

  log.info({ loginId, connectionId: connection.id }, 'user-connection: 2FA completed, connection saved');

  return connection;
}

/**
 * Save a user connection to the database after successful authentication.
 *
 * @param {string} tenantId
 * @param {number} apiId
 * @param {string} apiHash
 * @param {string} phone
 * @param {string} sessionString
 * @param {{ userId?: string, ip?: string }} context
 * @returns {Promise<object>}
 */
async function saveConnection(tenantId, apiId, apiHash, phone, sessionString, { userId, ip } = {}) {
  const log = getLogger();

  // Encrypt session string
  const encryptedCols = encryptToColumns(sessionString);

  // Insert connection
  const id = newId();
  const row = {
    id,
    kind: 'user',
    display_name: phone,
    username: null,
    telegram_id: null,
    encrypted_secret: encryptedCols.encrypted_secret,
    secret_iv: encryptedCols.secret_iv,
    secret_tag: encryptedCols.secret_tag,
    secret_key_id: encryptedCols.secret_key_id,
    api_id: apiId,
    phone,
    status: 'active',
    mode: null,
    rate_limit_msgs_per_min: 30,
    created_at: now(),
    updated_at: now(),
  };

  const [connection] = await tenantInsert(tenantId, TABLE, row, { returning: '*' });

  // Audit log
  await auditLogger.write({
    tenantId,
    userId: userId || null,
    action: 'connection.create',
    resourceType: 'telegram_connection',
    resourceId: id,
    ip: ip || null,
    meta: { kind: 'user', phone },
  });

  // Publish start event
  const publisher = getRedisPublisher();
  await publisher.publish(CHANNEL, JSON.stringify({
    action: 'start',
    connectionId: id,
  }));

  log.info({ connectionId: id, tenantId }, 'user-connection: created and start event published');

  return connection;
}

/**
 * Delete a User Connection.
 *
 * Flow:
 *   1. Load connection, verify tenant ownership
 *   2. Publish 'stop' event to Redis
 *   3. Try to logout MTProto session
 *   4. Delete row from database
 *   5. Write audit log
 *
 * @param {string} connectionId
 * @param {string} tenantId
 * @param {{ userId?: string, ip?: string }} context
 * @returns {Promise<void>}
 */
async function remove(connectionId, tenantId, { userId, ip } = {}) {
  const log = getLogger();
  const db = getDb();

  // 1. Load and verify
  const connection = await tenantQuery(tenantId, TABLE)
    .where({ id: connectionId, kind: 'user' })
    .first();

  if (!connection) {
    throw new NotFoundError('User connection not found');
  }

  // 2. Publish stop event
  const publisher = getRedisPublisher();
  await publisher.publish(CHANNEL, JSON.stringify({
    action: 'stop',
    connectionId,
  }));

  // 3. Try to logout MTProto
  try {
    const sessionString = decryptFromColumns({
      encrypted_secret: connection.encrypted_secret,
      secret_iv: connection.secret_iv,
      secret_tag: connection.secret_tag,
      secret_key_id: connection.secret_key_id,
    }).toString('utf8');

    const client = createClient(sessionString, connection.api_id, '');
    await client.connect();
    await client.invoke(new Api.auth.LogOut());
    await client.disconnect();
  } catch (err) {
    log.warn({ err, connectionId }, 'user-connection: failed to logout MTProto during removal');
  }

  // 4. Delete row
  await db(TABLE).where({ id: connectionId, tenant_id: tenantId }).del();

  // 5. Audit log
  await auditLogger.write({
    tenantId,
    userId: userId || null,
    action: 'connection.delete',
    resourceType: 'telegram_connection',
    resourceId: connectionId,
    ip: ip || null,
    meta: { kind: 'user', phone: connection.phone },
  });

  log.info({ connectionId, tenantId }, 'user-connection: deleted');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  startUserLogin,
  submitOtp,
  submit2FA,
  delete: remove,
  // Exported for testing
  createClient,
  saveConnection,
  loginStateKey,
};
