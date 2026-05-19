'use strict';

/**
 * Connection Runtime Worker — manages live Telegram connections.
 *
 * Subscribes to Redis channel 'connection-events' and handles:
 *   - start: load connection, decrypt token, acquire lock, launch bot
 *   - stop: stop bot, release lock
 *   - restart: stop then start
 *
 * Bot connections use Telegraf for polling mode. Webhook mode registers
 * a handler on the web process (not managed here).
 *
 * On auth errors (401 / AUTH_KEY_UNREGISTERED), delegates to health-monitor
 * to mark the connection as invalid and notify the owner.
 *
 * References:
 *   - requirements.md §4.6 — receive updates via polling or webhook
 *   - requirements.md §4.7 — handle 401, mark invalid, notify
 *   - design.md "Connection Manager" — worker subscribes to connection-events
 */

const { getRedisSubscriber } = require('../infra/redis');
const { getDb } = require('../infra/db');
const { decryptFromColumns } = require('../infra/crypto');
const { getLogger } = require('../infra/logger');
const runtimeRegistry = require('../modules/connections/runtime-registry');
const healthMonitor = require('../modules/connections/health-monitor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL = 'connection-events';
const TABLE = 'telegram_connections';

// ---------------------------------------------------------------------------
// Connection loader
// ---------------------------------------------------------------------------

/**
 * Load a connection record from the database.
 *
 * @param {string} connectionId
 * @returns {Promise<object|null>}
 */
async function loadConnection(connectionId) {
  const db = getDb();
  return db(TABLE).where({ id: connectionId }).first();
}

/**
 * Decrypt the bot token from a connection record.
 *
 * @param {object} connection
 * @returns {string}
 */
function decryptToken(connection) {
  return decryptFromColumns({
    encrypted_secret: connection.encrypted_secret,
    secret_iv: connection.secret_iv,
    secret_tag: connection.secret_tag,
    secret_key_id: connection.secret_key_id,
  }).toString('utf8');
}

// ---------------------------------------------------------------------------
// Bot lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a bot connection (polling mode).
 * Acquires lock, creates Telegraf instance, launches polling.
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function startConnection(connectionId) {
  const log = getLogger();

  // Skip if already running
  if (runtimeRegistry.isRunning(connectionId)) {
    log.debug({ connectionId }, 'connection-runtime: already running, skipping start');
    return;
  }

  // Load connection
  const connection = await loadConnection(connectionId);
  if (!connection) {
    log.warn({ connectionId }, 'connection-runtime: connection not found in DB');
    return;
  }

  if (connection.status !== 'active') {
    log.info({ connectionId, status: connection.status }, 'connection-runtime: connection not active, skipping');
    return;
  }

  // Acquire lock
  const acquired = await runtimeRegistry.acquire(connectionId);
  if (!acquired) {
    log.debug({ connectionId }, 'connection-runtime: lock not acquired (another worker owns it)');
    return;
  }

  // Handle bot connections
  if (connection.kind === 'bot') {
    try {
      const token = decryptToken(connection);

      // Dynamically require Telegraf to avoid hard dependency at module load
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(token);

      // Error handler — detect auth errors
      bot.catch((err) => {
        log.error({ err, connectionId }, 'connection-runtime: bot error');

        const errMsg = err && err.message ? err.message : '';
        const errCode = err && err.response && err.response.error_code;

        // 401 or AUTH_KEY_UNREGISTERED → mark invalid
        if (errCode === 401 || errMsg.includes('401') || errMsg.includes('AUTH_KEY_UNREGISTERED')) {
          healthMonitor.handleAuthError(connectionId, err).catch((e) => {
            log.error({ err: e, connectionId }, 'connection-runtime: health-monitor error');
          });
        }
      });

      // Launch polling (non-blocking)
      if (connection.mode === 'polling') {
        bot.launch().catch((err) => {
          log.error({ err, connectionId }, 'connection-runtime: bot.launch() failed');

          const errMsg = err && err.message ? err.message : '';
          const errCode = err && err.response && err.response.error_code;

          if (errCode === 401 || errMsg.includes('401') || errMsg.includes('AUTH_KEY_UNREGISTERED')) {
            healthMonitor.handleAuthError(connectionId, err).catch((e) => {
              log.error({ err: e, connectionId }, 'connection-runtime: health-monitor error');
            });
          }
        });
      }

      // Register in runtime registry
      runtimeRegistry.register(connectionId, bot);
      log.info({ connectionId, mode: connection.mode }, 'connection-runtime: bot started');
    } catch (err) {
      log.error({ err, connectionId }, 'connection-runtime: failed to start bot');
      await runtimeRegistry.release(connectionId);
    }
  } else if (connection.kind === 'user') {
    // User (MTProto) connections — GramJS persistent client
    try {
      const sessionString = decryptToken(connection);

      // Dynamically require GramJS to avoid hard dependency at module load
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');

      const session = new StringSession(sessionString);
      const client = new TelegramClient(session, connection.api_id, '', {
        connectionRetries: 3,
      });

      await client.connect();

      // Verify the session is still valid by getting self
      try {
        await client.getMe();
      } catch (err) {
        const errMsg = err && err.message ? err.message : '';
        const errType = err && err.errorMessage ? err.errorMessage : '';

        if (
          errType === 'AUTH_KEY_UNREGISTERED' ||
          errType === 'SESSION_REVOKED' ||
          errMsg.includes('AUTH_KEY_UNREGISTERED') ||
          errMsg.includes('SESSION_REVOKED')
        ) {
          log.warn({ connectionId, error: errMsg }, 'connection-runtime: user session invalid');
          await healthMonitor.handleAuthError(connectionId, err);
          try { await client.disconnect(); } catch (_e) { /* best effort */ }
          await runtimeRegistry.release(connectionId);
          return;
        }
        throw err;
      }

      // Register in runtime registry
      runtimeRegistry.register(connectionId, client);
      log.info({ connectionId, kind: 'user' }, 'connection-runtime: user MTProto client started');
    } catch (err) {
      log.error({ err, connectionId }, 'connection-runtime: failed to start user connection');

      const errMsg = err && err.message ? err.message : '';
      const errType = err && err.errorMessage ? err.errorMessage : '';

      if (
        errType === 'AUTH_KEY_UNREGISTERED' ||
        errType === 'SESSION_REVOKED' ||
        errMsg.includes('AUTH_KEY_UNREGISTERED') ||
        errMsg.includes('SESSION_REVOKED')
      ) {
        await healthMonitor.handleAuthError(connectionId, err).catch((e) => {
          log.error({ err: e, connectionId }, 'connection-runtime: health-monitor error');
        });
      }

      await runtimeRegistry.release(connectionId);
    }
  } else {
    log.warn({ connectionId, kind: connection.kind }, 'connection-runtime: unknown connection kind');
    await runtimeRegistry.release(connectionId);
  }
}

/**
 * Stop a running connection.
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function stopConnection(connectionId) {
  const log = getLogger();

  if (!runtimeRegistry.isRunning(connectionId)) {
    log.debug({ connectionId }, 'connection-runtime: not running, skipping stop');
    return;
  }

  const client = runtimeRegistry.get(connectionId);

  // Stop the client gracefully — Telegraf uses stop(), GramJS uses disconnect()
  if (client) {
    try {
      if (typeof client.stop === 'function') {
        client.stop('connection-stop');
      } else if (typeof client.disconnect === 'function') {
        await client.disconnect();
      }
    } catch (err) {
      log.warn({ err, connectionId }, 'connection-runtime: error stopping client');
    }
  }

  // Release lock
  await runtimeRegistry.release(connectionId);
  log.info({ connectionId }, 'connection-runtime: stopped');
}

/**
 * Restart a connection (stop then start).
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function restartConnection(connectionId) {
  await stopConnection(connectionId);
  await startConnection(connectionId);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * Handle a message from the connection-events channel.
 *
 * @param {string} message - JSON string with { action, connectionId }
 */
async function handleMessage(message) {
  const log = getLogger();

  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch (err) {
    log.warn({ err, message }, 'connection-runtime: invalid JSON on connection-events');
    return;
  }

  const { action, connectionId } = parsed;

  if (!connectionId) {
    log.warn({ parsed }, 'connection-runtime: missing connectionId in event');
    return;
  }

  log.info({ action, connectionId }, 'connection-runtime: received event');

  switch (action) {
    case 'start':
      await startConnection(connectionId);
      break;
    case 'stop':
      await stopConnection(connectionId);
      break;
    case 'restart':
      await restartConnection(connectionId);
      break;
    default:
      log.warn({ action, connectionId }, 'connection-runtime: unknown action');
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Start the connection runtime worker.
 * Subscribes to Redis 'connection-events' channel and processes messages.
 *
 * @returns {Promise<void>}
 */
async function start() {
  const log = getLogger();
  const subscriber = getRedisSubscriber();

  await subscriber.subscribe(CHANNEL);
  log.info({ channel: CHANNEL }, 'connection-runtime: subscribed to channel');

  subscriber.on('message', (channel, message) => {
    if (channel === CHANNEL) {
      handleMessage(message).catch((err) => {
        log.error({ err }, 'connection-runtime: unhandled error in message handler');
      });
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    log.info('connection-runtime: shutting down...');
    try {
      await subscriber.unsubscribe(CHANNEL);
    } catch (_err) {
      // best effort
    }
    await runtimeRegistry.releaseAll();
    log.info('connection-runtime: shutdown complete');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  startConnection,
  stopConnection,
  restartConnection,
  handleMessage,
  // Exported for testing
  loadConnection,
  decryptToken,
};
