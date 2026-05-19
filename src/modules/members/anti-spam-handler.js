'use strict';

/**
 * Anti-Spam Handler — pre-check incoming messages against spam patterns.
 *
 * Responsibilities:
 *   - Load active member_rules with kind='anti_spam' for the connection
 *   - Compile patterns (regex) and check incoming message text
 *   - If match: delete message, optionally mute or kick sender
 *   - Return { blocked: true/false } so caller knows whether to continue
 *
 * Called from bot runtime BEFORE auto-reply engine (pre-check).
 *
 * References:
 *   - requirements.md §10.6 — anti-spam
 *   - design.md "Member Management" — pre-check pesan masuk pakai pattern
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
 * Compile a pattern string into a RegExp. Returns null if invalid.
 *
 * @param {string} pattern
 * @returns {RegExp|null}
 */
function compilePattern(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/**
 * Check if message text matches any of the given patterns.
 *
 * @param {string} text - Message text to check
 * @param {string[]} patterns - Array of regex pattern strings
 * @returns {boolean} true if any pattern matches
 */
function matchesPatterns(text, patterns) {
  if (!text || !patterns || patterns.length === 0) return false;

  for (const pattern of patterns) {
    const regex = compilePattern(pattern);
    if (regex && regex.test(text)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Handle anti-spam pre-check for an incoming message.
 *
 * Called from bot runtime BEFORE the auto-reply engine processes the message.
 * If the message matches any anti-spam pattern, it is deleted and the sender
 * may be muted or kicked based on the rule's action config.
 *
 * @param {object} ctx - Telegraf context or equivalent
 * @param {object} ctx.message - The incoming message
 * @param {string} ctx.message.text - Message text
 * @param {number} ctx.message.message_id - Message ID
 * @param {object} ctx.message.from - Sender info
 * @param {number} ctx.message.from.id - Sender user ID
 * @param {object} ctx.chat - Chat object
 * @param {number} ctx.chat.id - Chat ID
 * @param {object} [ctx.telegram] - Telegram API instance
 * @param {Function} [ctx.deleteMessage] - Delete message function
 * @param {string} tenantId - Tenant ID
 * @param {string} connectionId - Connection ID
 * @returns {Promise<{ blocked: boolean }>}
 */
async function handleAntiSpam(ctx, tenantId, connectionId) {
  const log = getLogger();

  try {
    // Load active anti-spam rules for this connection
    const rules = await tenantQuery(tenantId, TABLE)
      .where({
        connection_id: connectionId,
        kind: 'anti_spam',
        is_active: true,
      });

    if (!rules || rules.length === 0) {
      return { blocked: false };
    }

    // Get message text
    const messageText = ctx.message && ctx.message.text;
    if (!messageText) {
      // No text to check — allow through
      return { blocked: false };
    }

    const chatId = ctx.chat && ctx.chat.id;
    const messageId = ctx.message && ctx.message.message_id;
    const senderId = ctx.message && ctx.message.from && ctx.message.from.id;

    // Check each anti-spam rule
    for (const rule of rules) {
      const config = parseJsonb(rule.config);
      if (!config || !config.patterns || config.patterns.length === 0) {
        continue;
      }

      if (matchesPatterns(messageText, config.patterns)) {
        log.info(
          { ruleId: rule.id, connectionId, chatId, senderId, messageId },
          'anti-spam-handler: spam detected, taking action'
        );

        // Delete the message
        try {
          if (ctx.deleteMessage) {
            await ctx.deleteMessage(messageId);
          } else if (ctx.telegram && ctx.telegram.deleteMessage) {
            await ctx.telegram.deleteMessage(chatId, messageId);
          }
        } catch (delErr) {
          log.warn(
            { err: delErr, ruleId: rule.id, chatId, messageId },
            'anti-spam-handler: failed to delete message'
          );
        }

        // Take additional action based on config
        const action = config.action || 'delete';

        if (action === 'mute' && senderId && chatId) {
          try {
            const muteDuration = config.mute_duration_seconds || 3600; // default 1 hour
            const untilDate = Math.floor(Date.now() / 1000) + muteDuration;

            if (ctx.telegram && ctx.telegram.restrictChatMember) {
              await ctx.telegram.restrictChatMember(chatId, senderId, {
                permissions: {
                  can_send_messages: false,
                  can_send_media_messages: false,
                  can_send_other_messages: false,
                  can_add_web_page_previews: false,
                },
                until_date: untilDate,
              });
            }

            log.info(
              { ruleId: rule.id, chatId, senderId, muteDuration },
              'anti-spam-handler: user muted'
            );
          } catch (muteErr) {
            log.warn(
              { err: muteErr, ruleId: rule.id, chatId, senderId },
              'anti-spam-handler: failed to mute user'
            );
          }
        } else if (action === 'kick' && senderId && chatId) {
          try {
            if (ctx.telegram && ctx.telegram.banChatMember) {
              await ctx.telegram.banChatMember(chatId, senderId);
              // Unban immediately to allow rejoin (kick, not permanent ban)
              await ctx.telegram.unbanChatMember(chatId, senderId, { only_if_banned: true });
            }

            log.info(
              { ruleId: rule.id, chatId, senderId },
              'anti-spam-handler: user kicked'
            );
          } catch (kickErr) {
            log.warn(
              { err: kickErr, ruleId: rule.id, chatId, senderId },
              'anti-spam-handler: failed to kick user'
            );
          }
        }

        return { blocked: true };
      }
    }

    return { blocked: false };
  } catch (err) {
    log.error(
      { err, connectionId, tenantId },
      'anti-spam-handler: error during anti-spam check'
    );
    // On error, allow message through to avoid blocking legitimate messages
    return { blocked: false };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleAntiSpam,
  // Exported for testing
  matchesPatterns,
  compilePattern,
  parseJsonb,
};
