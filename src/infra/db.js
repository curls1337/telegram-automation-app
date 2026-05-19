'use strict';

/**
 * PostgreSQL access layer (Knex.js singleton + tenant-scoped helpers).
 *
 * Responsibilities:
 *   - Build and cache a single Knex instance for the entire process,
 *     configured with a connection pool sized via env.
 *   - Expose `tenantQuery(tenantId, tableName)` so every domain query can
 *     pre-filter by `tenant_id` (Requirement 3.2 — multi-tenancy isolation).
 *   - Expose `withTransaction(fn)` for unit-of-work style operations.
 *   - Expose `closeDb()` for graceful shutdown and tests.
 *
 * References:
 *   - requirements.md §21.2 (config from env), §22.4 (configurable pool size).
 *   - design.md "Application Enforcement" — TenantRepo helper sketch.
 *
 * Note: this module intentionally lazy-initialises the Knex instance the
 * first time it is needed. Importing `db.js` therefore does not validate env
 * or open a pool; callers that want eager validation can call `getDb()`.
 */

const knex = require('knex');

const { getEnv } = require('../shared/env');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Build the Knex configuration object from validated env. Exported (via
 * `buildKnexConfig`) so `knexfile.js` can share a single source of truth.
 *
 * @param {ReturnType<typeof getEnv>} env
 * @returns {import('knex').Knex.Config}
 */
function buildKnexConfig(env) {
  return {
    client: 'pg',
    connection: env.DATABASE_URL,
    pool: {
      min: env.DATABASE_POOL_MIN,
      max: env.DATABASE_POOL_MAX,
    },
    // Long-running migrations must not be killed by the pool's idle timeout.
    acquireConnectionTimeout: 30_000,
    migrations: {
      directory: 'migrations',
      extension: 'js',
      loadExtensions: ['.js'],
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: 'scripts/seeds',
      extension: 'js',
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

/** @type {import('knex').Knex|undefined} */
let instance;

/**
 * Return the lazily-constructed Knex singleton.
 * @returns {import('knex').Knex}
 */
function getDb() {
  if (!instance) {
    const env = getEnv();
    instance = knex(buildKnexConfig(env));
  }
  return instance;
}

/**
 * Destroy the Knex pool. Idempotent. Used by graceful shutdown handlers and
 * tests that want to recycle the singleton between cases.
 *
 * @returns {Promise<void>}
 */
async function closeDb() {
  if (!instance) return;
  const current = instance;
  instance = undefined;
  await current.destroy();
}

// ---------------------------------------------------------------------------
// Tenant-scoped helpers
// ---------------------------------------------------------------------------

/**
 * Build a query builder for `tableName` already filtered to a single tenant.
 *
 * Every domain table (Telegram_Connection, Scheduled_Post, Broadcast,
 * Auto_Reply_Rule, Drip_Campaign, Forward_Rule, Subscriber, Tag, Webhook,
 * API_Key, …) carries a `tenant_id` column. Route handlers MUST go through
 * this helper instead of `db(table).where(...)` directly so the tenant
 * filter is applied even when the caller forgets to add it.
 *
 *   const rules = await tenantQuery(req.tenant.id, 'auto_reply_rules')
 *     .where({ is_active: true })
 *     .orderBy('priority');
 *
 * @param {string} tenantId
 * @param {string} tableName
 * @param {{ trx?: import('knex').Knex.Transaction }} [opts]
 * @returns {import('knex').Knex.QueryBuilder}
 */
function tenantQuery(tenantId, tableName, opts = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('tenantQuery(tenantId, tableName): tenantId is required');
  }
  if (!tableName || typeof tableName !== 'string') {
    throw new TypeError('tenantQuery(tenantId, tableName): tableName is required');
  }
  const qb = opts.trx ? opts.trx(tableName) : getDb()(tableName);
  return qb.where('tenant_id', tenantId);
}

/**
 * Insert one or more rows into `tableName`, automatically stamping each row
 * with `tenant_id`. Caller-supplied `tenant_id` values are overwritten so a
 * forged payload cannot leak into another tenant.
 *
 * @param {string} tenantId
 * @param {string} tableName
 * @param {object|object[]} rowOrRows
 * @param {{ trx?: import('knex').Knex.Transaction, returning?: string|string[] }} [opts]
 * @returns {import('knex').Knex.QueryBuilder}
 */
function tenantInsert(tenantId, tableName, rowOrRows, opts = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('tenantInsert(tenantId, tableName, …): tenantId is required');
  }
  const stamp = (row) => ({ ...row, tenant_id: tenantId });
  const stamped = Array.isArray(rowOrRows) ? rowOrRows.map(stamp) : stamp(rowOrRows);
  const qb = opts.trx ? opts.trx(tableName) : getDb()(tableName);
  const insert = qb.insert(stamped);
  return opts.returning ? insert.returning(opts.returning) : insert;
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a Knex transaction, committing on resolve and rolling back
 * on any thrown error. The callback receives the transaction object which
 * can be threaded into `tenantQuery(..., { trx })` for tenant-safe writes.
 *
 *   await withTransaction(async (trx) => {
 *     await tenantInsert(tenantId, 'subscribers', row, { trx });
 *     await tenantInsert(tenantId, 'subscriber_tags', tagLink, { trx });
 *   });
 *
 * @template T
 * @param {(trx: import('knex').Knex.Transaction) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTransaction(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withTransaction(fn): fn must be a function');
  }
  return getDb().transaction(fn);
}

module.exports = {
  buildKnexConfig,
  getDb,
  closeDb,
  tenantQuery,
  tenantInsert,
  withTransaction,
};
