'use strict';

/**
 * Auto-Reply Incoming Handler — processes incoming messages from Telegram
 * connections and dispatches auto-reply responses.
 *
 * Responsibilities:
 *   - Upsert subscriber on first interaction
 *   - Evaluate message against auto-reply rules via engine
 *   - If rule matched: send response via the connection's runtime client
 *   - If no match but AI enabled: send AI-generated response
 *   - If no match and no AI: return (no reply)
 *
 * This handler is called by the bot runtime (Telegraf bot.on('text'))
 * and the MTProto user runtime equivalent.
 *
 * References:
 *   - requirements.md §7.2 — evaluate rules and send first match response
 *   - requirements.md §7.3 — no match + no AI = no reply
 *   - requirements.md §8.3 — AI fallback when no rule matches
 *   - requirements.md §10.1 — upsert subscriber on first interaction
 *   - design.md "Auto-Reply Engine" — pipeline
 */

const { getLogger } = require('../../infra/logger');
const subscriberService = require('../subscribers/subscriber-service');
const runtimeRegistry = require('../connections/runtime-registry');
const engine = require('./engine');

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming message from a Telegram connection.
 *
 * @param {string} connectionId - The connection that received the message
 * @param {string} tenantId - The tenant that owns the connection
 * @param {object} message - The incoming message object
 * @param {string} message.text - The message text
 * @param {object} message.from - The sender info (telegram user)
 * @param {number|string} message.from.id - Telegram user ID
 * @param {string} [message.from.username] - Telegram username
 * @param {string} [message.from.first_name] - First name
 * @param {string} [message.from.last_name] - Last name
 * @param {string} [message.from.language_code] - Language code
 * @param {string|number} message.chat_id - The chat ID to reply to
 * @returns {Promise<{ matched: boolean, rule?: object, aiText?: string }>}
 */
async function handleIncomingMessage(connectionId, tenantId, message) {
  const log = getLogger();

  if (!message || !message.text || !message.from) {
    return { matched: false };
  }

  // 1. Upsert subscriber on first interaction
  try {
    await subscriberService.upsertOnFirstInteraction(tenantId, connectionId, {
      id: message.from.id,
      username: message.from.username || null,
      first_name: message.from.first_name || null,
      last_name: message.from.last_name || null,
      language_code: message.from.language_code || null,
    });
  } catch (err) {
    // Log but don't fail the auto-reply pipeline if subscriber upsert fails
    log.warn({ err, connectionId, tenantId }, 'auto-reply: subscriber upsert failed');
  }

  // 2. Evaluate message against auto-reply rules + AI fallback
  const result = await engine.evaluateWithAI(tenantId, connectionId, message.text);

  if (!result) {
    // No match and no AI response
    return { matched: false };
  }

  // 3. Send response via the connection's runtime client
  try {
    const client = runtimeRegistry.get(connectionId);

    if (!client) {
      log.warn({ connectionId, tenantId }, 'auto-reply: no runtime client found for connection');
      return {
        matched: true,
        rule: result.type === 'rule' ? result.rule : undefined,
        aiText: result.type === 'ai' ? result.text : undefined,
      };
    }

    const chatId = message.chat_id;
    let responseText;

    if (result.type === 'rule') {
      // Rule-based response
      const response = typeof result.rule.response === 'string'
        ? JSON.parse(result.rule.response)
        : result.rule.response;

      responseText = response && response.text ? response.text : null;
    } else if (result.type === 'ai') {
      // AI-generated response
      responseText = result.text;
    }

    if (responseText) {
      if (typeof client.sendMessage === 'function') {
        // Telegraf-style bot client
        await client.sendMessage(chatId, responseText);
      } else if (typeof client.telegram === 'object' && typeof client.telegram.sendMessage === 'function') {
        // Telegraf bot instance
        await client.telegram.sendMessage(chatId, responseText);
      }
    }

    log.info(
      {
        connectionId,
        tenantId,
        type: result.type,
        ruleId: result.type === 'rule' ? result.rule.id : undefined,
      },
      'auto-reply: response sent'
    );

    return {
      matched: true,
      rule: result.type === 'rule' ? result.rule : undefined,
      aiText: result.type === 'ai' ? result.text : undefined,
    };
  } catch (err) {
    log.error(
      { err, connectionId, tenantId },
      'auto-reply: failed to send response'
    );
    return {
      matched: true,
      rule: result.type === 'rule' ? result.rule : undefined,
      aiText: result.type === 'ai' ? result.text : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleIncomingMessage,
};
