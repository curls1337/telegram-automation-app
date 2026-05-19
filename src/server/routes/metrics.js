'use strict';

/**
 * Prometheus metrics endpoint — GET /metrics
 *
 * Exposes application counters in Prometheus text exposition format when
 * METRICS_ENABLED=1. Returns 404 when disabled.
 *
 * Counters (in-memory, reset on process restart):
 *   - messages_sent_total — total messages sent via Telegram
 *   - broadcasts_in_flight — currently running broadcasts
 *   - queue_depth{queue} — waiting + active + delayed jobs per queue
 *   - ai_calls_total — total AI provider calls
 *   - errors_total{type} — errors by type
 *
 * No external dependency (prom-client) needed for MVP — uses simple
 * in-memory counters and formats output manually.
 *
 * References:
 *   - requirements.md §21.3 — observability
 *   - design.md "Observability" — Prometheus metrics
 */

const { Router } = require('express');
const { getEnv } = require('../../shared/env');
const { QUEUE_NAMES, getQueue } = require('../../infra/queues');
const { getDb } = require('../../infra/db');

const router = Router();

// ---------------------------------------------------------------------------
// In-memory counters (process-local, reset on restart)
// ---------------------------------------------------------------------------

const counters = {
  messages_sent_total: 0,
  ai_calls_total: 0,
  errors: {}, // { type: count }
};

/**
 * Increment a counter. Called by other modules via require.
 * @param {string} name
 * @param {number} [value=1]
 */
function increment(name, value = 1) {
  if (name === 'messages_sent_total' || name === 'ai_calls_total') {
    counters[name] += value;
  }
}

/**
 * Increment an error counter by type.
 * @param {string} type
 */
function incrementError(type) {
  counters.errors[type] = (counters.errors[type] || 0) + 1;
}

/**
 * Get current counter values (for testing).
 */
function getCounters() {
  return { ...counters };
}

// ---------------------------------------------------------------------------
// GET /metrics
// ---------------------------------------------------------------------------

router.get('/metrics', async (req, res, next) => {
  try {
    const env = getEnv();

    if (!env.METRICS_ENABLED) {
      return res.status(404).send('Metrics not enabled');
    }

    const lines = [];

    // messages_sent_total
    lines.push('# HELP messages_sent_total Total messages sent via Telegram');
    lines.push('# TYPE messages_sent_total counter');
    lines.push(`messages_sent_total ${counters.messages_sent_total}`);

    // ai_calls_total
    lines.push('# HELP ai_calls_total Total AI provider calls');
    lines.push('# TYPE ai_calls_total counter');
    lines.push(`ai_calls_total ${counters.ai_calls_total}`);

    // broadcasts_in_flight
    lines.push('# HELP broadcasts_in_flight Currently running broadcasts');
    lines.push('# TYPE broadcasts_in_flight gauge');
    try {
      const db = getDb();
      const [{ count }] = await db('broadcasts').where({ status: 'running' }).count('* as count');
      lines.push(`broadcasts_in_flight ${parseInt(count, 10)}`);
    } catch (_err) {
      lines.push('broadcasts_in_flight 0');
    }

    // queue_depth per queue
    lines.push('# HELP queue_depth Number of jobs waiting/active/delayed per queue');
    lines.push('# TYPE queue_depth gauge');
    for (const qName of Object.values(QUEUE_NAMES)) {
      try {
        const queue = getQueue(qName);
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        const depth = counts.waiting + counts.active + counts.delayed;
        lines.push(`queue_depth{queue="${qName}"} ${depth}`);
      } catch (_err) {
        lines.push(`queue_depth{queue="${qName}"} 0`);
      }
    }

    // errors_total per type
    lines.push('# HELP errors_total Total errors by type');
    lines.push('# TYPE errors_total counter');
    for (const [type, count] of Object.entries(counters.errors)) {
      lines.push(`errors_total{type="${type}"} ${count}`);
    }
    if (Object.keys(counters.errors).length === 0) {
      lines.push('errors_total{type="none"} 0');
    }

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.increment = increment;
module.exports.incrementError = incrementError;
module.exports.getCounters = getCounters;
