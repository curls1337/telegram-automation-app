'use strict';

/**
 * Analytics Event Recorder — append-only insert to analytics_events.
 *
 * Records events from all engines: message_sent, subscriber_joined,
 * auto_reply_triggered, ai_called, broadcast_completed, drip_step_sent,
 * forward_sent.
 *
 * Two modes:
 *   - `recordEvent()` — fire-and-forget (setImmediate, errors swallowed)
 *   - `recordEventAsync()` — awaitable, throws on failure
 *
 * References:
 *   - requirements.md §13.1 — analytics event recording
 *   - design.md "Analytics Module" — append-only insert
 */

const { getDb } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'analytics_events';

/**
 * Valid event kinds. Any kind not in this set is rejected.
 */
const VALID_KINDS = Object.freeze([
  'message_sent',
  'subscriber_joined',
  'auto_reply_triggered',
  'ai_called',
  'broadcast_completed',
  'drip_step_sent',
  'forward_sent',
]);

// ---------------------------------------------------------------------------
// Core insert
// ---------------------------------------------------------------------------

/**
 * Insert a single analytics event row. This is the internal implementation
 * used by both the sync and async public APIs.
 *
 * @param {string} tenantId
 * @param {string} kind
 * @param {object} [opts]
 * @param {string} [opts.subjectId] - Related entity ID (connection, rule, broadcast, etc.)
 * @param {number} [opts.metricValue] - Numeric value (default 1)
 * @param {object|null} [opts.meta] - Additional JSONB metadata
 * @returns {Promise<void>}
 */
async function insertEvent(tenantId, kind, opts = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('recordEvent: tenantId is required');
  }
  if (!VALID_KINDS.includes(kind)) {
    throw new TypeError(`recordEvent: invalid kind "${kind}". Valid: ${VALID_KINDS.join(', ')}`);
  }

  const { subjectId = null, metricValue = 1, meta = null } = opts;

  const db = getDb();
  await db(TABLE).insert({
    id: newId(),
    tenant_id: tenantId,
    kind,
    subject_id: subjectId,
    metric_value: metricValue,
    meta: meta ? JSON.stringify(meta) : null,
    occurred_at: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an analytics event (fire-and-forget).
 *
 * This function returns immediately and does NOT block the caller's hot path.
 * Errors are logged but never propagated.
 *
 * @param {string} tenantId
 * @param {string} kind - One of VALID_KINDS
 * @param {object} [opts]
 * @param {string} [opts.subjectId]
 * @param {number} [opts.metricValue]
 * @param {object|null} [opts.meta]
 */
function recordEvent(tenantId, kind, opts = {}) {
  setImmediate(() => {
    insertEvent(tenantId, kind, opts).catch((err) => {
      try {
        const log = getLogger();
        log.warn({ err, tenantId, kind }, 'event-recorder: failed to record event');
      } catch (_ignored) {
        // Logger itself failed — swallow silently
      }
    });
  });
}

/**
 * Record an analytics event (awaitable).
 *
 * Use this when the caller needs confirmation that the event was persisted
 * (e.g. in tests or critical audit paths).
 *
 * @param {string} tenantId
 * @param {string} kind - One of VALID_KINDS
 * @param {object} [opts]
 * @param {string} [opts.subjectId]
 * @param {number} [opts.metricValue]
 * @param {object|null} [opts.meta]
 * @returns {Promise<void>}
 */
async function recordEventAsync(tenantId, kind, opts = {}) {
  await insertEvent(tenantId, kind, opts);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  recordEvent,
  recordEventAsync,
  VALID_KINDS,
};
