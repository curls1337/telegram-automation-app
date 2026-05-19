'use strict';

/**
 * Subscriber service — manages subscriber lifecycle (upsert, list, status).
 *
 * References:
 *   - requirements.md §10.1 — first interaction creates subscriber record
 *   - requirements.md §15.4 — quota enforcement for subscribers
 *   - design.md "Subscriber & Segmentation" — CRUD Subscriber
 */

const { getDb, tenantQuery, tenantInsert } = require('../../infra/db');
const { NotFoundError } = require('../../shared/errors');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');
const quotaService = require('../plans/quota-service');

// ---------------------------------------------------------------------------
// upsertOnFirstInteraction
// ---------------------------------------------------------------------------

/**
 * Upsert a subscriber when they first interact with a connection.
 * If the subscriber already exists (by tenant_id + connection_id + telegram_user_id),
 * update last_active_at and profile fields. If new, check quota first.
 *
 * @param {string} tenantId
 * @param {string} connectionId
 * @param {object} telegramUser - { id (bigint), username, first_name, last_name, language_code }
 * @returns {Promise<object>} The subscriber record
 */
async function upsertOnFirstInteraction(tenantId, connectionId, telegramUser) {
  const db = getDb();
  const timestamp = now();

  // Check if subscriber already exists
  const existing = await tenantQuery(tenantId, 'subscribers')
    .where({ connection_id: connectionId, telegram_user_id: telegramUser.id })
    .first();

  // Only check quota for NEW subscribers
  if (!existing) {
    await quotaService.check(tenantId, 'subscribers', 1);
  }

  const id = existing ? existing.id : newId();

  const [subscriber] = await db('subscribers')
    .insert({
      id,
      tenant_id: tenantId,
      connection_id: connectionId,
      telegram_user_id: telegramUser.id,
      username: telegramUser.username || null,
      first_name: telegramUser.first_name || null,
      last_name: telegramUser.last_name || null,
      language_code: telegramUser.language_code || null,
      status: 'active',
      first_seen_at: timestamp,
      last_active_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .onConflict(['tenant_id', 'connection_id', 'telegram_user_id'])
    .merge({
      last_active_at: timestamp,
      username: telegramUser.username || null,
      first_name: telegramUser.first_name || null,
      last_name: telegramUser.last_name || null,
      updated_at: timestamp,
    })
    .returning('*');

  return subscriber;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List subscribers with pagination and optional filters.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=25]
 * @param {string} [opts.connectionId]
 * @param {string} [opts.status]
 * @param {string} [opts.search]
 * @returns {Promise<{ data: object[], total: number, page: number, pageSize: number }>}
 */
async function list(tenantId, opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(opts.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;

  let query = tenantQuery(tenantId, 'subscribers');
  let countQuery = tenantQuery(tenantId, 'subscribers');

  if (opts.connectionId) {
    query = query.where('connection_id', opts.connectionId);
    countQuery = countQuery.where('connection_id', opts.connectionId);
  }

  if (opts.status) {
    query = query.where('status', opts.status);
    countQuery = countQuery.where('status', opts.status);
  }

  if (opts.search) {
    const search = `%${opts.search}%`;
    query = query.where(function () {
      this.where('username', 'ilike', search)
        .orWhere('first_name', 'ilike', search)
        .orWhere('last_name', 'ilike', search);
    });
    countQuery = countQuery.where(function () {
      this.where('username', 'ilike', search)
        .orWhere('first_name', 'ilike', search)
        .orWhere('last_name', 'ilike', search);
    });
  }

  const [{ count }] = await countQuery.count('* as count');
  const total = parseInt(count, 10);

  const data = await query
    .orderBy('last_active_at', 'desc')
    .limit(pageSize)
    .offset(offset);

  return { data, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Get a single subscriber by ID within a tenant.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, subscriberId) {
  const subscriber = await tenantQuery(tenantId, 'subscribers')
    .where({ id: subscriberId })
    .first();

  if (!subscriber) {
    throw new NotFoundError('Subscriber not found');
  }

  return subscriber;
}

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

/**
 * Update subscriber status (active, blocked, deactivated).
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @param {string} status - One of: active, blocked, deactivated
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function updateStatus(tenantId, subscriberId, status) {
  const [updated] = await tenantQuery(tenantId, 'subscribers')
    .where({ id: subscriberId })
    .update({ status, updated_at: now() })
    .returning('*');

  if (!updated) {
    throw new NotFoundError('Subscriber not found');
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  upsertOnFirstInteraction,
  list,
  getById,
  updateStatus,
};
