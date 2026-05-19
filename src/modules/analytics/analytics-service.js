'use strict';

/**
 * Analytics Service — query rollup data with Redis caching.
 *
 * Provides:
 *   - getTimeSeries() — date-range time-series for a metric
 *   - getBreakdown() — breakdown by subject (connection, rule, etc.)
 *   - getSummary() — totals for all metrics in a range
 *   - getAvailableMetrics() — list of valid metric names
 *   - invalidateCache() — manual cache bust for a tenant
 *
 * All queries go through a Redis cache layer with TTL 60s.
 *
 * References:
 *   - requirements.md §13.2 — time-series dashboard
 *   - requirements.md §13.3 — breakdown per connection/rule
 *   - design.md "Analytics Module" — caching with TTL 60s
 */

const { getDb, tenantQuery } = require('../../infra/db');
const { getRedis } = require('../../infra/redis');
const { getLogger } = require('../../infra/logger');
const { VALID_KINDS } = require('./event-recorder');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAILY_TABLE = 'analytics_daily';
const CACHE_TTL_SECONDS = 60;
const CACHE_PREFIX = 'analytics';

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Build a Redis cache key for analytics queries.
 *
 * @param {string} tenantId
 * @param {string} metric
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [suffix]
 * @returns {string}
 */
function cacheKey(tenantId, metric, startDate, endDate, suffix = '') {
  const base = `${CACHE_PREFIX}:${tenantId}:${metric}:${startDate}:${endDate}`;
  return suffix ? `${base}:${suffix}` : base;
}

/**
 * Get cached value from Redis.
 *
 * @param {string} key
 * @returns {Promise<object|null>}
 */
async function getFromCache(key) {
  try {
    const redis = getRedis();
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (_err) {
    // Cache miss or parse error — fall through to DB
  }
  return null;
}

/**
 * Set value in Redis cache with TTL.
 *
 * @param {string} key
 * @param {object} value
 * @returns {Promise<void>}
 */
async function setInCache(key, value) {
  try {
    const redis = getRedis();
    await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
  } catch (_err) {
    // Cache write failure is non-fatal
  }
}

/**
 * Invalidate all analytics cache entries for a tenant.
 * Uses SCAN to find and delete matching keys.
 *
 * @param {string} tenantId
 * @returns {Promise<number>} Number of keys deleted
 */
async function invalidateCache(tenantId) {
  const redis = getRedis();
  const pattern = `${CACHE_PREFIX}:${tenantId}:*`;
  let deleted = 0;
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');

  return deleted;
}

// ---------------------------------------------------------------------------
// Date range helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a named range to { startDate, endDate } strings (YYYY-MM-DD).
 *
 * @param {string} range - '7d', '30d', '90d'
 * @returns {{ startDate: string, endDate: string }}
 */
function resolveRange(range) {
  const end = new Date();
  const endDate = end.toISOString().slice(0, 10);

  let days;
  switch (range) {
    case '7d': days = 7; break;
    case '30d': days = 30; break;
    case '90d': days = 90; break;
    default: days = 7;
  }

  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);

  return { startDate, endDate };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get time-series data for a metric within a date range.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string} opts.metric - Metric name (one of VALID_KINDS)
 * @param {string} [opts.startDate] - YYYY-MM-DD
 * @param {string} [opts.endDate] - YYYY-MM-DD
 * @param {string} [opts.range] - '7d', '30d', '90d' (used if startDate/endDate not provided)
 * @returns {Promise<Array<{ date: string, value: number }>>}
 */
async function getTimeSeries(tenantId, opts = {}) {
  let { startDate, endDate } = opts;
  if (!startDate || !endDate) {
    const resolved = resolveRange(opts.range || '7d');
    startDate = startDate || resolved.startDate;
    endDate = endDate || resolved.endDate;
  }

  const metric = opts.metric || 'message_sent';
  const key = cacheKey(tenantId, metric, startDate, endDate, 'ts');

  // Check cache
  const cached = await getFromCache(key);
  if (cached) return cached;

  // Query DB
  const db = getDb();
  const rows = await db(DAILY_TABLE)
    .where({ tenant_id: tenantId, metric })
    .whereBetween('date', [startDate, endDate])
    .orderBy('date', 'asc')
    .select('date', 'value');

  const result = rows.map((r) => ({
    date: typeof r.date === 'string' ? r.date : r.date.toISOString().slice(0, 10),
    value: parseInt(r.value, 10) || 0,
  }));

  // Cache result
  await setInCache(key, result);

  return result;
}

/**
 * Get breakdown data for a metric (grouped by subject_id from breakdown JSONB).
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string} opts.metric
 * @param {string} [opts.startDate]
 * @param {string} [opts.endDate]
 * @param {string} [opts.range]
 * @param {string} [opts.groupBy] - 'connection_id' or 'rule_id' (informational)
 * @returns {Promise<Array<{ subject_id: string, value: number }>>}
 */
async function getBreakdown(tenantId, opts = {}) {
  let { startDate, endDate } = opts;
  if (!startDate || !endDate) {
    const resolved = resolveRange(opts.range || '7d');
    startDate = startDate || resolved.startDate;
    endDate = endDate || resolved.endDate;
  }

  const metric = opts.metric || 'message_sent';
  const key = cacheKey(tenantId, metric, startDate, endDate, 'breakdown');

  // Check cache
  const cached = await getFromCache(key);
  if (cached) return cached;

  // Query DB — aggregate breakdown JSONB across the date range
  const db = getDb();
  const rows = await db(DAILY_TABLE)
    .where({ tenant_id: tenantId, metric })
    .whereBetween('date', [startDate, endDate])
    .select('breakdown');

  // Merge all breakdown objects
  const merged = {};
  for (const row of rows) {
    const breakdown = typeof row.breakdown === 'string'
      ? JSON.parse(row.breakdown)
      : (row.breakdown || {});

    for (const [subjectId, val] of Object.entries(breakdown)) {
      merged[subjectId] = (merged[subjectId] || 0) + (parseInt(val, 10) || 0);
    }
  }

  // Convert to sorted array
  const result = Object.entries(merged)
    .map(([subject_id, value]) => ({ subject_id, value }))
    .sort((a, b) => b.value - a.value);

  // Cache result
  await setInCache(key, result);

  return result;
}

/**
 * Get summary totals for all metrics in a date range.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string} [opts.startDate]
 * @param {string} [opts.endDate]
 * @param {string} [opts.range]
 * @returns {Promise<Record<string, number>>}
 */
async function getSummary(tenantId, opts = {}) {
  let { startDate, endDate } = opts;
  if (!startDate || !endDate) {
    const resolved = resolveRange(opts.range || '7d');
    startDate = startDate || resolved.startDate;
    endDate = endDate || resolved.endDate;
  }

  const key = cacheKey(tenantId, 'all', startDate, endDate, 'summary');

  // Check cache
  const cached = await getFromCache(key);
  if (cached) return cached;

  // Query DB
  const db = getDb();
  const rows = await db(DAILY_TABLE)
    .where({ tenant_id: tenantId })
    .whereBetween('date', [startDate, endDate])
    .groupBy('metric')
    .select('metric', db.raw('SUM(value) as total'));

  const result = {};
  for (const kind of VALID_KINDS) {
    result[kind] = 0;
  }
  for (const row of rows) {
    result[row.metric] = parseInt(row.total, 10) || 0;
  }

  // Cache result
  await setInCache(key, result);

  return result;
}

/**
 * Return the list of available metric names.
 *
 * @returns {string[]}
 */
function getAvailableMetrics() {
  return [...VALID_KINDS];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getTimeSeries,
  getBreakdown,
  getSummary,
  getAvailableMetrics,
  invalidateCache,
  // Exported for testing
  CACHE_TTL_SECONDS,
  CACHE_PREFIX,
  resolveRange,
};
