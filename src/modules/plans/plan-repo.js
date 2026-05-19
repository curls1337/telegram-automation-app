'use strict';

/**
 * Plan repository — CRUD operations for the `plans` table.
 *
 * Plans are global (not tenant-scoped) and managed by super_admin only.
 *
 * References:
 *   - requirements.md §15.1 — CRUD Plan
 *   - design.md "Subscription / Plan Module"
 *   - migrations/0002_plans_subscriptions.js
 */

const { getDb } = require('../../infra/db');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');

const TABLE = 'plans';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * List all plans ordered by name.
 *
 * @returns {Promise<object[]>}
 */
async function list() {
  const db = getDb();
  return db(TABLE).orderBy('name', 'asc');
}

/**
 * Get a single plan by ID.
 *
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
async function getById(id) {
  const db = getDb();
  return db(TABLE).where({ id }).first();
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Create a new plan.
 *
 * @param {object} data - Plan fields (name, price_cents, duration_months, limits, etc.)
 * @returns {Promise<object>} The inserted plan row
 */
async function create(data) {
  const db = getDb();
  const timestamp = now();

  const row = {
    id: newId(),
    name: data.name,
    price_cents: data.price_cents ?? 0,
    duration_months: data.duration_months ?? 1,
    max_bot_connections: data.max_bot_connections ?? 1,
    max_user_connections: data.max_user_connections ?? 0,
    max_subscribers: data.max_subscribers ?? 100,
    max_broadcasts_per_month: data.max_broadcasts_per_month ?? 10,
    max_auto_reply_rules: data.max_auto_reply_rules ?? 5,
    is_active: data.is_active !== undefined ? data.is_active : true,
    created_at: timestamp,
    updated_at: timestamp,
  };

  const [inserted] = await db(TABLE).insert(row).returning('*');
  return inserted;
}

/**
 * Update an existing plan.
 *
 * @param {string} id
 * @param {object} data - Fields to update
 * @returns {Promise<object|undefined>} The updated plan row, or undefined if not found
 */
async function update(id, data) {
  const db = getDb();

  const fields = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.price_cents !== undefined) fields.price_cents = data.price_cents;
  if (data.duration_months !== undefined) fields.duration_months = data.duration_months;
  if (data.max_bot_connections !== undefined) fields.max_bot_connections = data.max_bot_connections;
  if (data.max_user_connections !== undefined) fields.max_user_connections = data.max_user_connections;
  if (data.max_subscribers !== undefined) fields.max_subscribers = data.max_subscribers;
  if (data.max_broadcasts_per_month !== undefined) fields.max_broadcasts_per_month = data.max_broadcasts_per_month;
  if (data.max_auto_reply_rules !== undefined) fields.max_auto_reply_rules = data.max_auto_reply_rules;
  if (data.is_active !== undefined) fields.is_active = data.is_active;

  fields.updated_at = now();

  const [updated] = await db(TABLE).where({ id }).update(fields).returning('*');
  return updated;
}

/**
 * Remove a plan by setting is_active=false (soft delete).
 *
 * @param {string} id
 * @returns {Promise<object|undefined>} The updated plan row, or undefined if not found
 */
async function remove(id) {
  const db = getDb();
  const [updated] = await db(TABLE)
    .where({ id })
    .update({ is_active: false, updated_at: now() })
    .returning('*');
  return updated;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
};
