'use strict';

/**
 * Auto-Reply Engine — core pipeline that evaluates incoming messages against
 * active rules and returns the first matching rule, with AI fallback.
 *
 * Responsibilities:
 *   - Load active rules for a tenant + connection (priority ASC)
 *   - Also load rules where connection_id IS NULL (applies to all connections)
 *   - Iterate rules and call matcher.match() for each
 *   - Return the first matching rule, or null if no match
 *   - If no rule matches and AI is enabled, call Gemini as fallback
 *
 * This is the core pipeline called by the bot runtime handler (incoming-handler.js).
 *
 * References:
 *   - requirements.md §7.2 — evaluate rules by priority, send first match
 *   - requirements.md §7.3 — no match + no AI = no reply
 *   - requirements.md §8.3 — AI fallback when no rule matches
 *   - requirements.md §8.6 — record token usage
 *   - design.md "Auto-Reply Engine" — pipeline diagram
 */

const { tenantQuery } = require('../../infra/db');
const { getRedis } = require('../../infra/redis');
const { getLogger } = require('../../infra/logger');
const { match } = require('./matcher');
const aiSettingsService = require('./ai-settings-service');
const geminiProvider = require('./ai-providers/gemini-provider');
const aiErrorHandler = require('./ai-error-handler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'auto_reply_rules';

/** Redis key prefix for AI rate limiting per tenant (token bucket) */
const AI_RATE_KEY_PREFIX = 'ai-rate:';

/** Default max AI calls per minute per tenant */
const AI_RATE_LIMIT_PER_MINUTE = 10;

/** Rate limit window in seconds */
const AI_RATE_WINDOW_SECONDS = 60;

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

/**
 * Check if the tenant is within the AI rate limit using a Redis token bucket.
 * Returns true if the request is allowed, false if rate limited.
 *
 * @param {string} tenantId
 * @returns {Promise<boolean>}
 */
async function checkAIRateLimit(tenantId) {
  const redis = getRedis();
  const key = `${AI_RATE_KEY_PREFIX}${tenantId}`;

  const current = await redis.incr(key);

  // Set TTL on first increment
  if (current === 1) {
    await redis.expire(key, AI_RATE_WINDOW_SECONDS);
  }

  return current <= AI_RATE_LIMIT_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Evaluate incoming message text against active auto-reply rules for a
 * tenant and connection. Returns the first matching rule (by priority ASC),
 * or null if no rule matches.
 *
 * Rules are loaded where:
 *   - tenant_id matches
 *   - is_active = true
 *   - connection_id matches OR connection_id IS NULL (global rules)
 *
 * @param {string} tenantId
 * @param {string} connectionId
 * @param {string} messageText - The incoming message text to evaluate
 * @returns {Promise<object|null>} The first matching rule, or null
 */
async function evaluate(tenantId, connectionId, messageText) {
  if (!messageText || typeof messageText !== 'string') {
    return null;
  }

  // Load active rules for this tenant + connection (or global rules)
  // Ordered by priority ASC so lowest priority number wins
  const rules = await tenantQuery(tenantId, TABLE)
    .where({ is_active: true })
    .where(function () {
      this.where('connection_id', connectionId)
        .orWhereNull('connection_id');
    })
    .orderBy('priority', 'asc');

  // Iterate rules and return first match
  for (const rule of rules) {
    if (match(rule, messageText)) {
      return rule;
    }
  }

  return null;
}

/**
 * Evaluate incoming message with AI fallback. First tries rule-based matching,
 * then falls back to AI if enabled and within rate limits.
 *
 * @param {string} tenantId
 * @param {string} connectionId
 * @param {string} messageText - The incoming message text to evaluate
 * @returns {Promise<{ type: 'rule', rule: object } | { type: 'ai', text: string } | null>}
 */
async function evaluateWithAI(tenantId, connectionId, messageText) {
  const log = getLogger();

  // 1. Try rule-based matching first
  const matchedRule = await evaluate(tenantId, connectionId, messageText);

  if (matchedRule) {
    return { type: 'rule', rule: matchedRule };
  }

  // 2. Check if AI fallback is enabled for this tenant
  let settings;
  try {
    settings = await aiSettingsService.getSettings(tenantId);
  } catch (err) {
    log.warn({ err, tenantId }, 'engine: failed to load AI settings');
    return null;
  }

  if (!settings || !settings.isEnabled || !settings.apiKey) {
    return null;
  }

  // 3. Check daily token limit
  if (settings.dailyTokenLimit) {
    try {
      const usage = await aiSettingsService.getDailyUsage(tenantId);
      if (usage.totalTokens >= settings.dailyTokenLimit) {
        log.info(
          { tenantId, usage: usage.totalTokens, limit: settings.dailyTokenLimit },
          'engine: daily token limit reached, skipping AI'
        );
        return null;
      }
    } catch (err) {
      log.warn({ err, tenantId }, 'engine: failed to check daily usage');
    }
  }

  // 4. Check Redis rate limit per tenant
  let withinRateLimit;
  try {
    withinRateLimit = await checkAIRateLimit(tenantId);
  } catch (err) {
    log.warn({ err, tenantId }, 'engine: rate limit check failed, allowing request');
    withinRateLimit = true;
  }

  if (!withinRateLimit) {
    log.info({ tenantId }, 'engine: AI rate limit exceeded for tenant');
    // Rate limit exceeded — disable AI and notify owner
    try {
      await aiErrorHandler.handleAIError(tenantId, new Error('Rate limit exceeded'));
    } catch (handlerErr) {
      log.warn({ err: handlerErr, tenantId }, 'engine: error handler failed');
    }
    return null;
  }

  // 5. Call Gemini with system prompt + message
  try {
    const result = await geminiProvider.generateReply(
      settings.apiKey,
      settings.systemPrompt || '',
      messageText
    );

    // 6. Record usage in ai_usage_log
    try {
      await aiSettingsService.recordUsage(
        tenantId,
        connectionId,
        result.tokensIn,
        result.tokensOut
      );
    } catch (usageErr) {
      log.warn({ err: usageErr, tenantId }, 'engine: failed to record AI usage');
    }

    log.info(
      { tenantId, connectionId, tokensIn: result.tokensIn, tokensOut: result.tokensOut },
      'engine: AI reply generated'
    );

    return { type: 'ai', text: result.text };
  } catch (err) {
    log.error({ err, tenantId, connectionId }, 'engine: AI reply generation failed');

    // Handle the error (log, potentially disable AI)
    try {
      await aiErrorHandler.handleAIError(tenantId, err);
    } catch (handlerErr) {
      log.warn({ err: handlerErr, tenantId }, 'engine: error handler failed');
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  evaluate,
  evaluateWithAI,
  checkAIRateLimit,
  AI_RATE_KEY_PREFIX,
  AI_RATE_LIMIT_PER_MINUTE,
  AI_RATE_WINDOW_SECONDS,
};
