'use strict';

/**
 * AI Error Handler — handles errors from AI auto-reply calls.
 *
 * Responsibilities:
 *   - Log AI errors
 *   - If rate limit exceeded: disable AI for tenant, send email notification to owner
 *   - Otherwise: just log, no reply sent
 *
 * References:
 *   - requirements.md §8.5 — error/quota → log, no reply
 *   - requirements.md §8.7 — rate limit exceeded → disable AI, notify owner
 *   - design.md "Auto-Reply Engine" — error handling flow
 */

const { getDb } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');
const { sendTemplate } = require('../../infra/mailer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AI_SETTINGS_TABLE = 'ai_settings';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle an AI error for a tenant.
 *
 * - Logs the error
 * - If rate limit exceeded: disables AI for the tenant and sends email notification
 * - Otherwise: just logs (no reply is sent to the subscriber)
 *
 * @param {string} tenantId
 * @param {Error} error
 * @returns {Promise<void>}
 */
async function handleAIError(tenantId, error) {
  const log = getLogger();
  const message = error && error.message ? error.message : 'Unknown AI error';

  log.error(
    { tenantId, error: message },
    'ai-error-handler: AI error occurred'
  );

  // Check if this is a rate limit error
  const isRateLimitError = isRateLimit(error);

  if (isRateLimitError) {
    log.warn({ tenantId }, 'ai-error-handler: rate limit exceeded, disabling AI for tenant');

    // Disable AI for the tenant
    try {
      await getDb()(AI_SETTINGS_TABLE)
        .where({ tenant_id: tenantId })
        .update({ is_enabled: false, updated_at: new Date().toISOString() });
    } catch (dbErr) {
      log.error({ err: dbErr, tenantId }, 'ai-error-handler: failed to disable AI settings');
    }

    // Send email notification to the tenant owner
    try {
      await notifyOwner(tenantId, message);
    } catch (mailErr) {
      log.warn({ err: mailErr, tenantId }, 'ai-error-handler: failed to send notification email');
    }
  }
  // For non-rate-limit errors: just log, no reply sent (already handled above)
}

/**
 * Determine if an error is a rate limit error.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isRateLimit(error) {
  if (!error) return false;

  const message = (error.message || '').toLowerCase();

  // Check for common rate limit indicators
  if (message.includes('rate limit')) return true;
  if (message.includes('quota')) return true;
  if (message.includes('too many requests')) return true;
  if (message.includes('429')) return true;

  // Check error details
  if (error.details) {
    const status = error.details.status || error.details.httpStatus;
    if (status === 429) return true;
  }

  return false;
}

/**
 * Send email notification to the tenant owner about AI being disabled.
 *
 * @param {string} tenantId
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function notifyOwner(tenantId, reason) {
  const log = getLogger();
  const db = getDb();

  // Look up the tenant owner
  const tenant = await db('tenants')
    .where({ id: tenantId })
    .first();

  if (!tenant || !tenant.owner_user_id) {
    log.warn({ tenantId }, 'ai-error-handler: no tenant owner found for notification');
    return;
  }

  const owner = await db('users')
    .where({ id: tenant.owner_user_id })
    .first();

  if (!owner || !owner.email) {
    log.warn({ tenantId }, 'ai-error-handler: no owner email found for notification');
    return;
  }

  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';

  await sendTemplate(owner.email, 'ai_disabled', {
    name: owner.email.split('@')[0],
    workspace: tenant.name || 'Your workspace',
    reason: reason || 'Rate limit exceeded',
    dashboard_url: `${baseUrl}/auto-reply/ai-settings`,
  }, owner.language || 'en');

  log.info({ tenantId, email: owner.email }, 'ai-error-handler: notification sent to owner');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleAIError,
  isRateLimit,
};
