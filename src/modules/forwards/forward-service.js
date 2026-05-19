'use strict';

/**
 * Forward Service — CRUD for forward_rules.
 *
 * Responsibilities:
 *   - Create, list, getById, update, remove, toggleActive forward rules
 *   - Validate input with Zod (source_chat, destinations, connection_id, filters, remove_header, is_active)
 *   - Multi-tenant isolation via tenantQuery/tenantInsert
 *
 * References:
 *   - requirements.md §12.1 — forward rule CRUD
 *   - design.md "Forward Engine" — rule management
 */

const { z } = require('zod');
const { tenantQuery, tenantInsert } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');
const { nowIso } = require('../../shared/time');
const { NotFoundError, ValidationError } = require('../../shared/errors');
const { parseOrThrow } = require('../../shared/validation');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'forward_rules';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const FiltersSchema = z.object({
  keywords: z.array(z.string().min(1)).optional(),
  media_types: z.array(z.string().min(1)).optional(),
  senders: z.array(z.string().min(1)).optional(),
}).optional().nullable().default(null);

const CreateSchema = z.object({
  connection_id: z.string().uuid('connection_id must be a valid UUID'),
  source_chat: z.string().trim().min(1, 'source_chat is required'),
  destinations: z.array(z.string().min(1)).min(1, 'At least one destination is required'),
  filters: FiltersSchema,
  remove_header: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

const UpdateSchema = z.object({
  connection_id: z.string().uuid('connection_id must be a valid UUID').optional(),
  source_chat: z.string().trim().min(1, 'source_chat is required').optional(),
  destinations: z.array(z.string().min(1)).min(1, 'At least one destination is required').optional(),
  filters: FiltersSchema,
  remove_header: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new forward rule.
 *
 * @param {string} tenantId
 * @param {object} input
 * @returns {Promise<object>} The created forward rule record
 */
async function create(tenantId, input) {
  const data = parseOrThrow(CreateSchema, input, {
    message: 'Invalid forward rule data',
  });

  const ruleId = newId();
  const timestamp = nowIso();

  const [rule] = await tenantInsert(tenantId, TABLE, {
    id: ruleId,
    connection_id: data.connection_id,
    source_chat: data.source_chat,
    destinations: JSON.stringify(data.destinations),
    filters: data.filters ? JSON.stringify(data.filters) : null,
    remove_header: data.remove_header,
    is_active: data.is_active,
    created_at: timestamp,
    updated_at: timestamp,
  }, { returning: '*' });

  getLogger().info(
    { ruleId, tenantId, source: data.source_chat },
    'forward-service: rule created'
  );

  return rule;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List forward rules for a tenant with pagination.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=25]
 * @param {string} [opts.connectionId]
 * @returns {Promise<{ data: object[], total: number, page: number, pageSize: number }>}
 */
async function list(tenantId, opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(opts.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;

  let query = tenantQuery(tenantId, TABLE);
  let countQuery = tenantQuery(tenantId, TABLE);

  if (opts.connectionId) {
    query = query.where({ connection_id: opts.connectionId });
    countQuery = countQuery.where({ connection_id: opts.connectionId });
  }

  const [{ count }] = await countQuery.count('* as count');
  const data = await query
    .orderBy('created_at', 'desc')
    .limit(pageSize)
    .offset(offset);

  return {
    data,
    total: parseInt(count, 10),
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Get a single forward rule by ID.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, ruleId) {
  const rule = await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .first();

  if (!rule) {
    throw new NotFoundError('Forward rule not found');
  }

  return rule;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Update a forward rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @param {object} input
 * @returns {Promise<object>}
 */
async function update(tenantId, ruleId, input) {
  await getById(tenantId, ruleId);

  const data = parseOrThrow(UpdateSchema, input, {
    message: 'Invalid forward rule update data',
  });

  const updatePayload = { updated_at: nowIso() };
  if (data.connection_id !== undefined) updatePayload.connection_id = data.connection_id;
  if (data.source_chat !== undefined) updatePayload.source_chat = data.source_chat;
  if (data.destinations !== undefined) updatePayload.destinations = JSON.stringify(data.destinations);
  if (data.filters !== undefined) {
    updatePayload.filters = data.filters ? JSON.stringify(data.filters) : null;
  }
  if (data.remove_header !== undefined) updatePayload.remove_header = data.remove_header;
  if (data.is_active !== undefined) updatePayload.is_active = data.is_active;

  const [updated] = await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .update(updatePayload)
    .returning('*');

  return updated;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Delete a forward rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @returns {Promise<void>}
 */
async function remove(tenantId, ruleId) {
  await getById(tenantId, ruleId);

  await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .del();

  getLogger().info({ ruleId, tenantId }, 'forward-service: rule deleted');
}

// ---------------------------------------------------------------------------
// toggleActive
// ---------------------------------------------------------------------------

/**
 * Toggle the is_active flag on a forward rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @returns {Promise<object>} Updated rule
 */
async function toggleActive(tenantId, ruleId) {
  const rule = await getById(tenantId, ruleId);

  const [updated] = await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .update({
      is_active: !rule.is_active,
      updated_at: nowIso(),
    })
    .returning('*');

  getLogger().info(
    { ruleId, tenantId, is_active: updated.is_active },
    'forward-service: rule toggled'
  );

  return updated;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  create,
  list,
  getById,
  update,
  remove,
  toggleActive,
};
