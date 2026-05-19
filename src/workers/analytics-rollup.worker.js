'use strict';

/**
 * Analytics Rollup Worker — cron-style script that runs every 5 minutes.
 *
 * Aggregates analytics_events into analytics_daily (per tenant, per metric,
 * per day). Tracks last rollup timestamp in Redis to avoid re-processing.
 *
 * NOT a BullMQ worker — uses setInterval for scheduling.
 *
 * References:
 *   - requirements.md §13.5 — rollup aggregation
 *   - design.md "Analytics Module" — 5-minute rollup cron
 */

const { getDb } = require('../infra/db');
const { getRedis } = require('../infra/redis');
const { getLogger } = require('../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENTS_TABLE = 'analytics_events';
const DAILY_TABLE = 'analytics_daily';
const REDIS_KEY = 'analytics:last-rollup';
const ROLLUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Rollup logic
// ---------------------------------------------------------------------------

/**
 * Perform a single rollup pass: aggregate events since last rollup into
 * analytics_daily using UPSERT (ON CONFLICT increment value).
 *
 * @returns {Promise<number>} Number of rows upserted
 */
async function runRollup() {
  const log = getLogger();
  const db = getDb();
  const redis = getRedis();

  // Get last rollup timestamp from Redis
  const lastRollupStr = await redis.get(REDIS_KEY);
  const since = lastRollupStr ? new Date(lastRollupStr) : new Date(0);
  const now = new Date();

  // Aggregate events since last rollup grouped by tenant_id, kind, date
  const aggregated = await db(EVENTS_TABLE)
    .select(
      'tenant_id',
      'kind as metric',
      db.raw("DATE(occurred_at) as date"),
      db.raw('SUM(metric_value) as total_value'),
      'subject_id'
    )
    .where('occurred_at', '>', since)
    .where('occurred_at', '<=', now)
    .groupBy('tenant_id', 'kind', db.raw('DATE(occurred_at)'), 'subject_id');

  if (aggregated.length === 0) {
    // Update last rollup even if no events — prevents re-scanning
    await redis.set(REDIS_KEY, now.toISOString());
    return 0;
  }

  // Build breakdown per (tenant_id, metric, date) and upsert
  // Group by (tenant_id, metric, date) to merge subject_id breakdown
  const grouped = new Map();

  for (const row of aggregated) {
    const key = `${row.tenant_id}|${row.metric}|${row.date}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        tenant_id: row.tenant_id,
        metric: row.metric,
        date: row.date,
        value: 0,
        breakdown: {},
      });
    }
    const entry = grouped.get(key);
    const val = parseInt(row.total_value, 10) || 0;
    entry.value += val;

    // Build breakdown by subject_id (connection_id, rule_id, etc.)
    if (row.subject_id) {
      entry.breakdown[row.subject_id] = (entry.breakdown[row.subject_id] || 0) + val;
    }
  }

  // Upsert each grouped row into analytics_daily
  let upsertCount = 0;
  for (const entry of grouped.values()) {
    await db.raw(`
      INSERT INTO ${DAILY_TABLE} (tenant_id, metric, date, value, breakdown)
      VALUES (?, ?, ?, ?, ?::jsonb)
      ON CONFLICT (tenant_id, metric, date)
      DO UPDATE SET
        value = ${DAILY_TABLE}.value + EXCLUDED.value,
        breakdown = (
          SELECT jsonb_object_agg(
            key,
            COALESCE((${DAILY_TABLE}.breakdown->>key)::bigint, 0) + COALESCE((EXCLUDED.breakdown->>key)::bigint, 0)
          )
          FROM jsonb_each_text(${DAILY_TABLE}.breakdown || EXCLUDED.breakdown)
        )
    `, [
      entry.tenant_id,
      entry.metric,
      entry.date,
      entry.value,
      JSON.stringify(entry.breakdown),
    ]);
    upsertCount++;
  }

  // Update last rollup timestamp
  await redis.set(REDIS_KEY, now.toISOString());

  log.info(
    { upsertCount, since: since.toISOString(), until: now.toISOString() },
    'analytics-rollup: rollup completed'
  );

  return upsertCount;
}

// ---------------------------------------------------------------------------
// Cron runner
// ---------------------------------------------------------------------------

/** @type {NodeJS.Timeout|null} */
let intervalHandle = null;

/**
 * Start the rollup cron. Runs runRollup() every 5 minutes.
 */
function startCron() {
  const log = getLogger();

  log.info({ intervalMs: ROLLUP_INTERVAL_MS }, 'analytics-rollup: starting cron');

  // Run immediately on start
  runRollup().catch((err) => {
    log.error({ err }, 'analytics-rollup: error during initial rollup');
  });

  // Then run every 5 minutes
  intervalHandle = setInterval(() => {
    runRollup().catch((err) => {
      log.error({ err }, 'analytics-rollup: error during rollup');
    });
  }, ROLLUP_INTERVAL_MS);
}

/**
 * Stop the rollup cron.
 */
function stopCron() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runRollup,
  startCron,
  stopCron,
  ROLLUP_INTERVAL_MS,
  REDIS_KEY,
};
