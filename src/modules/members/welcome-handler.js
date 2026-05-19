'use strict';

/**
 * Welcome Handler — sends welcome template when a new member joins.
 *
 * Responsibilities:
 *   - Handle `chat_member` event (new member joined)
 *   - Load active member_rules with kind='welcome' for the connection
 *   - If rule exists and is_active, send the template message to the chat
 *   - Optional delay before sending (config.delay_seconds)
 *
 * References:
 *   - requirements.md §10.4 — welcome message
 *   - design.md "Member Management" — handler `chat_member` event → send template
 */

const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'member_rules';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSONB field (handles both string and object).
 *
 * @param {string|object|null} value
 * @returns {object|null}
 */
function parseJsonb(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Sleep for a given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Handle a chat_member event (new member joined).
 *
 * Called from bot runtime when a `chat_member` event fires indicating
 * a new member has joined the group/channel.
 *
 * @param {object} ctx - Telegraf context or equivalent
 * @param {object} ctx.chat - Chat object with id
 * @param {object} [ctx.from] - The new member info
 * @param {Function} [ctx.reply] - Reply function to send message to chat
 * @param {object} [ctx.telegram] - Telegram API instance (for sendMessage)
 * @param {string} tenantId - Tenant ID
 * @param {string} connectionId - Connection ID
 * @returns {Promise<boolean>} true if welcome was sent, false otherwise
 */
async function handleChatMember(ctx, tenantId, connectionId) {
  const log = getLogger();

  try {
    // Load active welcome rules for this connection
    const rules = await tenantQuery(tenantId, TABLE)
      .where({
        connection_id: connectionId,
        kind: 'welcome',
        is_active: true,
      });

    if (!rules || rules.length === 0) {
      return false;
    }

    const chatId = ctx.chat && ctx.chat.id;
    if (!chatId) {
      log.warn({ connectionId, tenantId }, 'welcome-handler: no chat.id in context');
      return false;
    }

    // Process each active welcome rule
    for (const rule of rules) {
      const config = parseJsonb(rule.config);
      if (!config || !config.template) {
        log.warn(
          { ruleId: rule.id, connectionId },
          'welcome-handler: rule has no template in config'
        );
        continue;
      }

      // Optional delay before sending
      if (config.delay_seconds && config.delay_seconds > 0) {
        await sleep(config.delay_seconds * 1000);
      }

      // Replace placeholders in template
      const memberName = ctx.from
        ? (ctx.from.first_name || '') + (ctx.from.last_name ? ' ' + ctx.from.last_name : '')
        : 'Member';
      const message = config.template
        .replace(/\{name\}/g, memberName.trim())
        .replace(/\{username\}/g, ctx.from && ctx.from.username ? '@' + ctx.from.username : '');

      // Send the welcome message
      try {
        if (ctx.telegram && ctx.telegram.sendMessage) {
          await ctx.telegram.sendMessage(chatId, message);
        } else if (ctx.reply) {
          await ctx.reply(message);
        } else {
          log.warn(
            { ruleId: rule.id, connectionId },
            'welcome-handler: no send method available in context'
          );
          continue;
        }

        log.info(
          { ruleId: rule.id, connectionId, chatId },
          'welcome-handler: welcome message sent'
        );
      } catch (sendErr) {
        log.warn(
          { err: sendErr, ruleId: rule.id, connectionId, chatId },
          'welcome-handler: failed to send welcome message'
        );
      }
    }

    return true;
  } catch (err) {
    log.error(
      { err, connectionId, tenantId },
      'welcome-handler: error processing chat_member event'
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleChatMember,
  // Exported for testing
  parseJsonb,
};
