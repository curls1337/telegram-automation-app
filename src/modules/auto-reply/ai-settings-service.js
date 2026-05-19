'use strict';

/**
 * AI Settings Service — manages per-tenant AI auto-reply configuration.
 *
 * Responsibilities:
 *   - Get/save AI settings (api_key encrypted, system_prompt, daily_token_limit, is_enabled)
 *   - Validate API key via Gemini before saving
 *   - Track daily token usage from ai_usage_log
 *
 * References:
 *   - requirements.md §8.1 — validate API key before saving
 *   - requirements.md §8.2 — store API key encrypted (AES-256-GCM)
 *   - requirements.md §8.4 — system prompt per tenant
 *   - requirements.md §8.6 — token usage logging
 *   - design.md "ai_settings" table — tenant_id PK, api_key_encrypted, system_prompt, etc.
 */

const { getDb } = require('../../infra/db');
const { encrypt, decrypt } = require('../../infra/crypto');
const { getLogger } = require('../../infra/logger');
const { ValidationError, ExternalServiceError } = require('../../shared/errors');
const { nowIso } = require('../../shared/time');
const geminiProvider = require('./ai-providers/gemini-provider');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AI_SETTINGS_TABLE = 'ai_settings';
const AI_USAGE_LOG_TABLE = 'ai_usage_log';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Get AI settings for a tenant. Decrypts the API key if present.
 *
 * @param {string} tenantId
 * @returns {Promise<object|null>} Settings object or null if not configured
 */
async function getSettings(tenantId) {
  const log = getLogger();

  const row = await getDb()(AI_SETTINGS_TABLE)
    .where({ tenant_id: tenantId })
    .first();

  if (!row) {
    return null;
  }

  // Decrypt API key if present
  let apiKeyDecrypted = null;
  if (row.api_key_encrypted && row.secret_iv && row.secret_tag && row.secret_key_id) {
    try {
      const decrypted = decrypt({
        keyId: row.secret_key_id,
        iv: row.secret_iv,
        tag: row.secret_tag,
        ciphertext: row.api_key_encrypted,
      });
      apiKeyDecrypted = decrypted.toString('utf8');
    } catch (err) {
      log.error({ err, tenantId }, 'ai-settings: failed to decrypt API key');
    }
  }

  return {
    tenantId: row.tenant_id,
    provider: row.provider,
    hasApiKey: !!apiKeyDecrypted,
    apiKey: apiKeyDecrypted,
    systemPrompt: row.system_prompt,
    isEnabled: row.is_enabled,
    dailyTokenLimit: row.daily_token_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Save AI settings for a tenant. Validates API key if provided.
 * Performs upsert on tenant_id PK.
 *
 * @param {string} tenantId
 * @param {object} input
 * @param {string} [input.apiKey] - New API key (validated before saving)
 * @param {string} [input.systemPrompt] - System prompt text
 * @param {number|null} [input.dailyTokenLimit] - Daily token limit (null = unlimited)
 * @param {boolean} [input.isEnabled] - Whether AI auto-reply is enabled
 * @returns {Promise<object>} Updated settings
 */
async function saveSettings(tenantId, input) {
  const log = getLogger();
  const { apiKey, systemPrompt, dailyTokenLimit, isEnabled } = input;

  // Build the update payload
  const payload = {
    updated_at: nowIso(),
  };

  // If API key is provided, validate it first
  if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
    log.info({ tenantId }, 'ai-settings: validating Gemini API key');

    let isValid;
    try {
      isValid = await geminiProvider.validateApiKey(apiKey.trim());
    } catch (err) {
      throw new ExternalServiceError(
        'Failed to validate Gemini API key. Please check your network connection and try again.',
        { details: { service: 'gemini' }, cause: err }
      );
    }

    if (!isValid) {
      throw new ValidationError('Invalid Gemini API key. Please check the key and try again.');
    }

    // Encrypt the API key
    const blob = encrypt(apiKey.trim());
    payload.api_key_encrypted = blob.ciphertext;
    payload.secret_iv = blob.iv;
    payload.secret_tag = blob.tag;
    payload.secret_key_id = blob.keyId;
  }

  if (systemPrompt !== undefined) {
    payload.system_prompt = typeof systemPrompt === 'string' ? systemPrompt : null;
  }

  if (dailyTokenLimit !== undefined) {
    payload.daily_token_limit = dailyTokenLimit === null || dailyTokenLimit === ''
      ? null
      : parseInt(dailyTokenLimit, 10) || null;
  }

  if (isEnabled !== undefined) {
    payload.is_enabled = !!isEnabled;
  }

  // Upsert: INSERT or UPDATE on tenant_id PK
  const db = getDb();
  const existing = await db(AI_SETTINGS_TABLE)
    .where({ tenant_id: tenantId })
    .first();

  if (existing) {
    await db(AI_SETTINGS_TABLE)
      .where({ tenant_id: tenantId })
      .update(payload);
  } else {
    await db(AI_SETTINGS_TABLE).insert({
      tenant_id: tenantId,
      provider: 'gemini',
      is_enabled: payload.is_enabled !== undefined ? payload.is_enabled : false,
      system_prompt: payload.system_prompt || null,
      daily_token_limit: payload.daily_token_limit || null,
      api_key_encrypted: payload.api_key_encrypted || null,
      secret_iv: payload.secret_iv || null,
      secret_tag: payload.secret_tag || null,
      secret_key_id: payload.secret_key_id || null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  log.info({ tenantId }, 'ai-settings: settings saved');
  return getSettings(tenantId);
}

/**
 * Get daily token usage for a tenant (sum of tokens from ai_usage_log for today).
 *
 * @param {string} tenantId
 * @returns {Promise<{ tokensIn: number, tokensOut: number, totalTokens: number }>}
 */
async function getDailyUsage(tenantId) {
  const db = getDb();

  // Get start of today (UTC)
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const result = await db(AI_USAGE_LOG_TABLE)
    .where({ tenant_id: tenantId })
    .where('created_at', '>=', today.toISOString())
    .select(
      db.raw('COALESCE(SUM(tokens_in), 0) as total_tokens_in'),
      db.raw('COALESCE(SUM(tokens_out), 0) as total_tokens_out')
    )
    .first();

  const tokensIn = parseInt(result.total_tokens_in, 10) || 0;
  const tokensOut = parseInt(result.total_tokens_out, 10) || 0;

  return {
    tokensIn,
    tokensOut,
    totalTokens: tokensIn + tokensOut,
  };
}

/**
 * Record AI usage in the ai_usage_log table.
 *
 * @param {string} tenantId
 * @param {string} connectionId
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @returns {Promise<void>}
 */
async function recordUsage(tenantId, connectionId, tokensIn, tokensOut) {
  const { newId } = require('../../shared/ids');

  await getDb()(AI_USAGE_LOG_TABLE).insert({
    id: newId(),
    tenant_id: tenantId,
    connection_id: connectionId,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate_cents: 0, // Can be calculated based on model pricing later
    created_at: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getSettings,
  saveSettings,
  getDailyUsage,
  recordUsage,
};
