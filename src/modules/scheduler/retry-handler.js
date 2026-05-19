'use strict';

/**
 * Retry Handler — classify Telegram errors for retry decisions.
 *
 * Determines whether a Telegram API error is retryable or permanent,
 * and provides the appropriate delay for retryable errors.
 *
 * Classification rules:
 *   - 429 (rate limit): retryable with delay = retry_after * 1000 (or 60s default)
 *   - 400 (chat not found, no access, bot kicked): permanent, no retry
 *   - 401 (unauthorized): permanent, auth invalid
 *   - 403 (forbidden, bot blocked): permanent, no retry
 *   - 5xx (server error): retryable with 60s delay
 *   - Network errors: retryable with 60s delay
 *
 * References:
 *   - requirements.md §6.4 — 429 retry with backoff, max 3x.
 *   - requirements.md §6.5 — chat-not-found / no-access → failed, no retry.
 *   - design.md "Telegram error reaction policy" (Property 12).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_DELAY_MS = 60_000; // 60 seconds
const MAX_RETRY_AFTER_MS = 300_000; // 5 minutes cap

/**
 * Error descriptions that indicate permanent failures (no retry).
 * These are substrings matched against the error message/description.
 */
const PERMANENT_ERROR_PATTERNS = [
  'chat not found',
  'chat_not_found',
  'bot was kicked',
  'bot was blocked',
  'bot is not a member',
  'not enough rights',
  'have no rights',
  'need administrator rights',
  'peer_id_invalid',
  'user is deactivated',
  'user_deactivated',
  'chat_write_forbidden',
  'topic_closed',
  'forum_closed',
];

/**
 * Error descriptions that indicate auth failures (no retry, mark invalid).
 */
const AUTH_ERROR_PATTERNS = [
  'unauthorized',
  'auth_key_unregistered',
  'session_revoked',
  'auth_key_duplicated',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a Telegram error to determine retry behavior.
 *
 * @param {Error|object} error - The error from Telegram API call.
 * @returns {{ retry: boolean, delay?: number, reason?: string }}
 *   - retry: true if the error is transient and should be retried.
 *   - delay: milliseconds to wait before retry (only when retry=true).
 *   - reason: human-readable reason for permanent failures.
 */
function classifyTelegramError(error) {
  if (!error) {
    return { retry: false, reason: 'unknown_error' };
  }

  // Extract error code and description from various error shapes
  const errorCode = extractErrorCode(error);
  const errorDescription = extractErrorDescription(error).toLowerCase();

  // 429 — Rate limited
  if (errorCode === 429) {
    const retryAfter = extractRetryAfter(error);
    const delay = retryAfter
      ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
      : DEFAULT_RETRY_DELAY_MS;

    return { retry: true, delay };
  }

  // 401 — Unauthorized (auth invalid)
  if (errorCode === 401) {
    return { retry: false, reason: 'auth_invalid' };
  }

  // Check for auth error patterns in description
  for (const pattern of AUTH_ERROR_PATTERNS) {
    if (errorDescription.includes(pattern)) {
      return { retry: false, reason: 'auth_invalid' };
    }
  }

  // 400 / 403 — Check for permanent error patterns
  if (errorCode === 400 || errorCode === 403) {
    for (const pattern of PERMANENT_ERROR_PATTERNS) {
      if (errorDescription.includes(pattern)) {
        return { retry: false, reason: 'permanent' };
      }
    }
    // Other 400/403 errors are also permanent
    return { retry: false, reason: 'permanent' };
  }

  // Check permanent patterns in any error description
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (errorDescription.includes(pattern)) {
      return { retry: false, reason: 'permanent' };
    }
  }

  // 5xx — Server error, retryable
  if (errorCode >= 500 && errorCode < 600) {
    return { retry: true, delay: DEFAULT_RETRY_DELAY_MS };
  }

  // Network errors (no code) — retryable
  if (!errorCode || errorCode === 0) {
    const msg = errorDescription;
    if (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enetunreach') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('timeout')
    ) {
      return { retry: true, delay: DEFAULT_RETRY_DELAY_MS };
    }
  }

  // Unknown errors — default to no retry for safety
  return { retry: false, reason: 'unknown' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the HTTP error code from various error shapes.
 *
 * Telegraf errors: error.response.error_code
 * GramJS errors: error.code or error.errorMessage
 * Generic: error.statusCode or error.status
 *
 * @param {Error|object} error
 * @returns {number|null}
 */
function extractErrorCode(error) {
  if (!error) return null;

  // Telegraf shape
  if (error.response && typeof error.response.error_code === 'number') {
    return error.response.error_code;
  }

  // Direct code property
  if (typeof error.code === 'number' && error.code >= 100 && error.code < 600) {
    return error.code;
  }

  // statusCode (common in HTTP errors)
  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }

  // status property
  if (typeof error.status === 'number') {
    return error.status;
  }

  // Try to extract from message (e.g., "429: Too Many Requests")
  const msg = error.message || '';
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

/**
 * Extract the error description from various error shapes.
 *
 * @param {Error|object} error
 * @returns {string}
 */
function extractErrorDescription(error) {
  if (!error) return '';

  // Telegraf shape
  if (error.response && error.response.description) {
    return error.response.description;
  }

  // GramJS shape
  if (error.errorMessage) {
    return error.errorMessage;
  }

  // Standard message
  if (error.message) {
    return error.message;
  }

  return String(error);
}

/**
 * Extract retry_after value from a 429 error.
 *
 * @param {Error|object} error
 * @returns {number|null} Seconds to wait, or null if not available.
 */
function extractRetryAfter(error) {
  if (!error) return null;

  // Telegraf shape: error.response.parameters.retry_after
  if (
    error.response &&
    error.response.parameters &&
    typeof error.response.parameters.retry_after === 'number'
  ) {
    return error.response.parameters.retry_after;
  }

  // Direct property
  if (typeof error.retryAfter === 'number') {
    return error.retryAfter;
  }
  if (typeof error.retry_after === 'number') {
    return error.retry_after;
  }

  // Try to extract from message (e.g., "retry after 30")
  const msg = (error.message || '') + ' ' + (error.response && error.response.description || '');
  const match = msg.match(/retry.?after\s+(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  classifyTelegramError,
  extractErrorCode,
  extractErrorDescription,
  extractRetryAfter,
  // Constants exported for testing
  DEFAULT_RETRY_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  PERMANENT_ERROR_PATTERNS,
  AUTH_ERROR_PATTERNS,
};
