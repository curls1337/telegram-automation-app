'use strict';

/**
 * Connection Health Monitor — handles authentication errors and connection invalidation.
 *
 * When a Telegram connection encounters a 401 or AUTH_KEY_UNREGISTERED error,
 * this module:
 *   1. Updates the connection status to 'invalid' with the error message
 *   2. Publishes a 'stop' event to halt the runtime
 *   3. Writes an audit log entry
 *   4. Sends a notification email to the tenant owner
 *
 * References:
 *   - requirements.md §4.7 — 401 → mark invalid, stop, notify
 *   - requirements.md §5.8 — AUTH_KEY_UNREGISTERED / SESSION_REVOKED
 *   - design.md "ConnectionHealthMonitor"
 */

const { getDb } = require('../../infra/db');
const { getRedisPublisher } = require('../../infra/redis');
const { getLogger } = require('../../infra/logger');
const { sendTemplate } = require('../../infra/mailer');
const auditLogger = require('../audit/audit-logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'telegram_connections';
const CHANNEL = 'connection-events';

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle an authentication error for a connection.
 *
 * @param {string} connectionId
 * @param {Error|object} error - The error that triggered this
 * @returns {Promise<void>}
 */
async function handleAuthError(connectionId, error) {
  const log = getLogger();
  const db = getDb();
  const publisher = getRedisPublisher();

  const errorMessage = error && error.message ? error.message : 'Authentication failed';

  log.warn({ connectionId, errorMessage }, 'health-monitor: auth error detected');

  // 1. Update connection status to 'invalid'
  const [connection] = await db(TABLE)
    .where({ id: connectionId })
    .update({
      status: 'invalid',
      last_error: errorMessage,
      updated_at: new Date(),
    })
    .returning('*');

  if (!connection) {
    log.warn({ connectionId }, 'health-monitor: connection not found for update');
    return;
  }

  // 2. Publish stop event
  await publisher.publish(CHANNEL, JSON.stringify({
    action: 'stop',
    connectionId,
  }));

  // 3. Write audit log
  await auditLogger.write({
    tenantId: connection.tenant_id,
    userId: null,
    action: 'connection.invalid',
    resourceType: 'telegram_connection',
    resourceId: connectionId,
    ip: null,
    meta: {
      kind: connection.kind,
      username: connection.username,
      error: errorMessage,
    },
  });

  // 4. Send notification email to tenant owner
  try {
    const tenant = await db('tenants')
      .where({ id: connection.tenant_id })
      .first();

    if (tenant && tenant.owner_user_id) {
      const owner = await db('users')
        .where({ id: tenant.owner_user_id })
        .first();

      if (owner && owner.email) {
        await sendTemplate(owner.email, 'connection_invalid', {
          name: owner.email.split('@')[0],
          connection_name: connection.display_name || connection.username || connectionId,
          reason: errorMessage,
          dashboard_url: `${process.env.APP_URL || 'http://localhost:3000'}/connections/${connectionId}`,
        }, owner.language || 'en');

        log.info(
          { connectionId, ownerEmail: owner.email },
          'health-monitor: notification email sent'
        );
      }
    }
  } catch (emailErr) {
    // Email failure should not break the flow
    log.error({ err: emailErr, connectionId }, 'health-monitor: failed to send notification email');
  }

  log.info({ connectionId }, 'health-monitor: connection marked invalid');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleAuthError,
};
