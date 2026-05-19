'use strict';

/**
 * Bot Connection Service — lifecycle management for Telegram Bot API connections.
 *
 * Responsibilities:
 *   - Validate bot token via Telegram getMe endpoint
 *   - Encrypt and store bot token (AES-256-GCM)
 *   - Enforce quota before creation
 *   - Publish runtime events via Redis pub/sub
 *   - Delete connection (stop runtime, unset webhook, remove row)
 *   - Write audit log entries for create/delete
 *
 * References:
 *   - requirements.md §4.1–4.5, §4.7
 *   - design.md "Connection Manager" — BotConnectionService
 */

const { getDb, tenantInsert, tenantQuery } = require('../../../infra/db');
const { encryptToColumns, decryptFromColumns } = require('../../../infra/crypto');
const { getRedisPublisher } = require('../../../infra/redis');
const { getLogger } = require('../../../infra/logger');
const { TelegramError, NotFoundError } = require('../../../shared/errors');
const { newId } = require('../../../shared/ids');
const { now } = require('../../../shared/time');
const quotaService = require('../../plans/quota-service');
const auditLogger = require('../../audit/audit-logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'telegram_connections';
const CHANNEL = 'connection-events';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

/**
 * Call Telegram Bot API getMe to validate a token and retrieve bot info.
 * Uses the global fetch (Node 20+).
 *
 * @param {string} token - Bot token from BotFather
 * @returns {Promise<{ id: number, first_name: string, username: string }>}
 * @throws {TelegramError} if token is invalid or API unreachable
 */
async function telegramGetMe(token) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/getMe`;

  let response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (err) {
    throw new TelegramError('Failed to connect to Telegram API', {
      details: { raw: err.message },
      cause: err,
    });
  }

  const body = await response.json();

  if (!response.ok || !body.ok) {
    const description = body.description || `HTTP ${response.status}`;
    throw new TelegramError(`Telegram: ${description}`, {
      details: {
        telegramCode: body.error_code || response.status,
        telegramDescription: description,
      },
    });
  }

  return body.result;
}

/**
 * Call Telegram Bot API deleteWebhook to unset any active webhook.
 *
 * @param {string} token - Bot token
 * @returns {Promise<boolean>} true if successful
 */
async function telegramDeleteWebhook(token) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/deleteWebhook`;

  try {
    const response = await fetch(url, { method: 'GET' });
    const body = await response.json();
    return body.ok === true;
  } catch (_err) {
    // Best effort — if we can't reach Telegram, the webhook will expire
    return false;
  }
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Create a new Bot Connection.
 *
 * Flow:
 *   1. Check quota (bot_connections)
 *   2. Validate token via Telegram getMe
 *   3. Encrypt token
 *   4. Insert into telegram_connections
 *   5. Write audit log
 *   6. Publish 'start' event to Redis
 *   7. Return connection record
 *
 * @param {string} tenantId
 * @param {string} token - Bot token from BotFather
 * @param {{ userId?: string, ip?: string }} context - Audit context
 * @returns {Promise<object>} The created connection record
 */
async function create(tenantId, token, { userId, ip } = {}) {
  const log = getLogger();

  // 1. Quota check
  await quotaService.check(tenantId, 'bot_connections', 1);

  // 2. Validate token with Telegram
  const botInfo = await telegramGetMe(token);
  log.info(
    { tenantId, botUsername: botInfo.username },
    'bot-connection: getMe validated'
  );

  // 3. Encrypt token
  const encryptedCols = encryptToColumns(token);

  // 4. Insert connection
  const id = newId();
  const row = {
    id,
    kind: 'bot',
    display_name: botInfo.first_name || botInfo.username || 'Bot',
    username: botInfo.username || null,
    telegram_id: botInfo.id,
    encrypted_secret: encryptedCols.encrypted_secret,
    secret_iv: encryptedCols.secret_iv,
    secret_tag: encryptedCols.secret_tag,
    secret_key_id: encryptedCols.secret_key_id,
    status: 'active',
    mode: 'polling',
    created_at: now(),
    updated_at: now(),
  };

  const [connection] = await tenantInsert(tenantId, TABLE, row, { returning: '*' });

  // 5. Audit log
  await auditLogger.write({
    tenantId,
    userId: userId || null,
    action: 'connection.create',
    resourceType: 'telegram_connection',
    resourceId: id,
    ip: ip || null,
    meta: { kind: 'bot', username: botInfo.username, telegram_id: botInfo.id },
  });

  // 6. Publish start event
  const publisher = getRedisPublisher();
  await publisher.publish(CHANNEL, JSON.stringify({
    action: 'start',
    connectionId: id,
  }));

  log.info({ connectionId: id, tenantId }, 'bot-connection: created and start event published');

  return connection;
}

/**
 * Delete a Bot Connection.
 *
 * Flow:
 *   1. Load connection, verify tenant ownership
 *   2. Publish 'stop' event to Redis
 *   3. Decrypt token and call deleteWebhook
 *   4. Delete row from database
 *   5. Write audit log
 *
 * @param {string} connectionId
 * @param {string} tenantId
 * @param {{ userId?: string, ip?: string }} context - Audit context
 * @returns {Promise<void>}
 */
async function remove(connectionId, tenantId, { userId, ip } = {}) {
  const log = getLogger();
  const db = getDb();

  // 1. Load and verify
  const connection = await tenantQuery(tenantId, TABLE)
    .where({ id: connectionId })
    .first();

  if (!connection) {
    throw new NotFoundError('Connection not found');
  }

  // 2. Publish stop event
  const publisher = getRedisPublisher();
  await publisher.publish(CHANNEL, JSON.stringify({
    action: 'stop',
    connectionId,
  }));

  // 3. Try to unset Telegram webhook
  try {
    const token = decryptFromColumns({
      encrypted_secret: connection.encrypted_secret,
      secret_iv: connection.secret_iv,
      secret_tag: connection.secret_tag,
      secret_key_id: connection.secret_key_id,
    }).toString('utf8');

    await telegramDeleteWebhook(token);
  } catch (err) {
    log.warn({ err, connectionId }, 'bot-connection: failed to delete webhook during removal');
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
    meta: { kind: connection.kind, username: connection.username },
  });

  log.info({ connectionId, tenantId }, 'bot-connection: deleted');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  create,
  delete: remove,
  // Exported for testing
  telegramGetMe,
  telegramDeleteWebhook,
};
