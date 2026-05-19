'use strict';

/**
 * Member Rule Service — CRUD for member_rules.
 *
 * Responsibilities:
 *   - Create, list, getById, update, remove, toggleActive member rules
 *   - Validate input with Zod (kind, connection_id, config JSONB, is_active)
 *   - Config schemas per kind:
 *     - welcome: { template, delay_seconds? }
 *     - auto_kick_inactive: { threshold_days, dry_run? }
 *     - anti_spam: { patterns[], action, mute_duration_seconds? }
 *   - Multi-tenant isolation via tenantQuery/tenantInsert
 *   - Audit log on create/update/remove/toggleActive
 *
 * References:
 *   - requirements.md §10.4 — welcome message
 *   - requirements.md §10.5 — auto-kick inactive
 *   - requirements.md §10.6 — anti-spam
 *   - design.md "Member Management" — rule management
 */

const { z } = require('zod');
const { tenantQuery, tenantInsert } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');
const { nowIso } = require('../../shared/time');
const { NotFoundError, ValidationError } = require('../../shared/errors');
const { parseOrThrow } = require('../../shared/validation');
const auditLogger = require('../audit/audit-logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'member_rules';
const VALID_KINDS = ['welcome', 'auto_kick_inactive', 'anti_spam'];

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const WelcomeConfigSchema = z.object({
  template: z.string().min(1, 'template is required'),
  delay_seconds: z.number().int().min(0).optional(),
});

const AutoKickConfigSchema = z.object({
  threshold_days: z.number().int().positive('threshold_days must be a positive integer'),
  dry_run: z.boolean().optional(),
});

const AntiSpamConfigSchema = z.object({
  patterns: z.array(z.string().min(1)).min(1, 'At least one pattern is required'),
  action: z.enum(['delete', 'mute', 'kick'], {
    errorMap: () => ({ message: 'action must be one of: delete, mute, kick' }),
  }),
  mute_duration_seconds: z.number().int().positive().optional(),
});

const KindEnum = z.enum(VALID_KINDS, {
  errorMap: () => ({ message: `kind must be one of: ${VALID_KINDS.join(', ')}` }),
});

const CreateSchema = z.object({
  connection_id: z.string().uuid('connection_id must be a valid UUID'),
  kind: KindEnum,
  config: z.record(z.unknown()),
  is_active: z.boolean().default(true),
});

const UpdateSchema = z.object({
  connection_id: z.string().uuid('connection_id must be a valid UUID').optional(),
  kind: KindEnum.optional(),
  config: z.record(z.unknown()).optional(),
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate config against the appropriate schema for the given kind.
 *
 * @param {string} kind
 * @param {object} config
 * @returns {object} Validated config
 */
function validateConfig(kind, config) {
  switch (kind) {
    case 'welcome':
      return parseOrThrow(WelcomeConfigSchema, config, {
        message: 'Invalid welcome config',
      });
    case 'auto_kick_inactive':
      return parseOrThrow(AutoKickConfigSchema, config, {
        message: 'Invalid auto_kick_inactive config',
      });
    case 'anti_spam':
      return parseOrThrow(AntiSpamConfigSchema, config, {
        message: 'Invalid anti_spam config',
      });
    default:
      throw new ValidationError(`Unknown kind: ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new member rule.
 *
 * @param {string} tenantId
 * @param {object} input
 * @param {{ userId?: string }} [ctx] - Context for audit logging
 * @returns {Promise<object>} The created member rule record
 */
async function create(tenantId, input, ctx = {}) {
  const data = parseOrThrow(CreateSchema, input, {
    message: 'Invalid member rule data',
  });

  // Validate config against kind-specific schema
  const validatedConfig = validateConfig(data.kind, data.config);

  const ruleId = newId();
  const timestamp = nowIso();

  const [rule] = await tenantInsert(tenantId, TABLE, {
    id: ruleId,
    connection_id: data.connection_id,
    kind: data.kind,
    config: JSON.stringify(validatedConfig),
    is_active: data.is_active,
    created_at: timestamp,
    updated_at: timestamp,
  }, { returning: '*' });

  getLogger().info(
    { ruleId, tenantId, kind: data.kind },
    'member-rule-service: rule created'
  );

  // Audit log
  await auditLogger.write({
    tenantId,
    userId: ctx.userId || null,
    action: 'member_rule.created',
    resourceType: 'member_rule',
    resourceId: ruleId,
    meta: { kind: data.kind, is_active: data.is_active },
  });

  return rule;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List member rules for a tenant with pagination.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=25]
 * @param {string} [opts.connectionId]
 * @param {string} [opts.kind]
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

  if (opts.kind) {
    if (!VALID_KINDS.includes(opts.kind)) {
      throw new ValidationError(`Invalid kind filter: ${opts.kind}`);
    }
    query = query.where({ kind: opts.kind });
    countQuery = countQuery.where({ kind: opts.kind });
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
 * Get a single member rule by ID.
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
    throw new NotFoundError('Member rule not found');
  }

  return rule;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Update a member rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @param {object} input
 * @param {{ userId?: string }} [ctx] - Context for audit logging
 * @returns {Promise<object>}
 */
async function update(tenantId, ruleId, input, ctx = {}) {
  const existing = await getById(tenantId, ruleId);

  const data = parseOrThrow(UpdateSchema, input, {
    message: 'Invalid member rule update data',
  });

  // Determine the effective kind (updated or existing)
  const effectiveKind = data.kind || existing.kind;

  // If config is provided, validate against the effective kind
  if (data.config !== undefined) {
    validateConfig(effectiveKind, data.config);
  }

  const updatePayload = { updated_at: nowIso() };
  if (data.connection_id !== undefined) updatePayload.connection_id = data.connection_id;
  if (data.kind !== undefined) updatePayload.kind = data.kind;
  if (data.config !== undefined) updatePayload.config = JSON.stringify(data.config);
  if (data.is_active !== undefined) updatePayload.is_active = data.is_active;

  const [updated] = await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .update(updatePayload)
    .returning('*');

  getLogger().info(
    { ruleId, tenantId, kind: effectiveKind },
    'member-rule-service: rule updated'
  );

  // Audit log
  await auditLogger.write({
    tenantId,
    userId: ctx.userId || null,
    action: 'member_rule.updated',
    resourceType: 'member_rule',
    resourceId: ruleId,
    meta: { kind: effectiveKind, is_active: updated.is_active },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Delete a member rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @param {{ userId?: string }} [ctx] - Context for audit logging
 * @returns {Promise<void>}
 */
async function remove(tenantId, ruleId, ctx = {}) {
  const rule = await getById(tenantId, ruleId);

  await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .del();

  getLogger().info({ ruleId, tenantId }, 'member-rule-service: rule deleted');

  // Audit log
  await auditLogger.write({
    tenantId,
    userId: ctx.userId || null,
    action: 'member_rule.deleted',
    resourceType: 'member_rule',
    resourceId: ruleId,
    meta: { kind: rule.kind, is_active: rule.is_active },
  });
}

// ---------------------------------------------------------------------------
// toggleActive
// ---------------------------------------------------------------------------

/**
 * Toggle the is_active flag on a member rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @param {{ userId?: string }} [ctx] - Context for audit logging
 * @returns {Promise<object>} Updated rule
 */
async function toggleActive(tenantId, ruleId, ctx = {}) {
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
    'member-rule-service: rule toggled'
  );

  // Audit log
  await auditLogger.write({
    tenantId,
    userId: ctx.userId || null,
    action: 'member_rule.toggled',
    resourceType: 'member_rule',
    resourceId: ruleId,
    meta: { kind: updated.kind, is_active: updated.is_active },
  });

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
  // Exported for testing
  validateConfig,
  VALID_KINDS,
};
