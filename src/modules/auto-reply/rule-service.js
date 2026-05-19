'use strict';

/**
 * Auto-Reply Rule Service — CRUD operations for auto-reply rules.
 *
 * Responsibilities:
 *   - Create, list, get, update, remove, and toggle auto-reply rules
 *   - Validate trigger_kind (exact/contains/regex), trigger_value, response
 *   - Validate regex patterns at create/update time (reject invalid regex)
 *   - Enforce quota before creating new rules
 *
 * References:
 *   - requirements.md §7.1 — create rules with trigger (keyword, regex, exact)
 *   - requirements.md §7.5 — reject invalid regex
 *   - requirements.md §7.6 — quota enforcement
 *   - design.md "Auto-Reply Engine" — rule matching, CRUD
 */

const { tenantQuery, tenantInsert } = require('../../infra/db');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');
const { parseOrThrow, z } = require('../../shared/validation');
const quotaService = require('../plans/quota-service');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'auto_reply_rules';

const TRIGGER_KINDS = ['exact', 'contains', 'regex'];

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const RuleInputSchema = z.object({
  trigger_kind: z.enum(TRIGGER_KINDS, {
    required_error: 'trigger_kind is required',
    invalid_type_error: 'trigger_kind must be one of: exact, contains, regex',
  }),
  trigger_value: z
    .string({ required_error: 'trigger_value is required' })
    .trim()
    .min(1, 'trigger_value must not be empty'),
  response: z.union([
    z.string().min(1, 'response must not be empty'),
    z.object({
      text: z.string().optional(),
      media_ids: z.array(z.string()).optional(),
    }),
  ]),
  priority: z
    .number({ required_error: 'priority is required' })
    .int('priority must be an integer')
    .min(0, 'priority must be >= 0')
    .max(10000, 'priority must be <= 10000'),
  case_sensitive: z.boolean().default(false),
  is_active: z.boolean().default(true),
  connection_id: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a regex trigger_value is a valid regular expression.
 * Throws ValidationError if the regex cannot be compiled.
 *
 * @param {string} pattern
 */
function validateRegex(pattern) {
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new ValidationError(`Invalid regex pattern: ${err.message}`, {
      details: [{ path: 'trigger_value', message: `Invalid regex: ${err.message}` }],
    });
  }
}

/**
 * Normalize response to JSONB format.
 * If response is a plain string, wrap it as { text: string }.
 *
 * @param {string|object} response
 * @returns {object}
 */
function normalizeResponse(response) {
  if (typeof response === 'string') {
    return { text: response };
  }
  return response;
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Create a new auto-reply rule.
 *
 * @param {string} tenantId
 * @param {object} input
 * @returns {Promise<object>} The created rule
 */
async function create(tenantId, input) {
  const validated = parseOrThrow(RuleInputSchema, input, {
    message: 'Invalid auto-reply rule input',
  });

  // Validate regex if trigger_kind is regex
  if (validated.trigger_kind === 'regex') {
    validateRegex(validated.trigger_value);
  }

  // Quota check before insert
  await quotaService.check(tenantId, 'auto_reply_rules', 1);

  const id = newId();
  const timestamp = now();

  const row = {
    id,
    connection_id: validated.connection_id || null,
    trigger_kind: validated.trigger_kind,
    trigger_value: validated.trigger_value,
    response: JSON.stringify(normalizeResponse(validated.response)),
    priority: validated.priority,
    case_sensitive: validated.case_sensitive,
    is_active: validated.is_active,
    created_at: timestamp,
    updated_at: timestamp,
  };

  const [created] = await tenantInsert(tenantId, TABLE, row, { returning: '*' });
  return created;
}

/**
 * List auto-reply rules for a tenant, optionally filtered by connection_id.
 * Ordered by priority ASC.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {string} [opts.connectionId] - Filter by connection_id
 * @returns {Promise<object[]>}
 */
async function list(tenantId, opts = {}) {
  let query = tenantQuery(tenantId, TABLE);

  if (opts.connectionId) {
    query = query.where(function () {
      this.where('connection_id', opts.connectionId)
        .orWhereNull('connection_id');
    });
  }

  return query.orderBy('priority', 'asc');
}

/**
 * Get a single rule by ID within a tenant.
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
    throw new NotFoundError('Auto-reply rule not found');
  }

  return rule;
}

/**
 * Update an existing auto-reply rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @param {object} input
 * @returns {Promise<object>} The updated rule
 * @throws {NotFoundError}
 */
async function update(tenantId, ruleId, input) {
  // Ensure rule exists
  await getById(tenantId, ruleId);

  const validated = parseOrThrow(RuleInputSchema, input, {
    message: 'Invalid auto-reply rule input',
  });

  // Validate regex if trigger_kind is regex
  if (validated.trigger_kind === 'regex') {
    validateRegex(validated.trigger_value);
  }

  const updateData = {
    connection_id: validated.connection_id || null,
    trigger_kind: validated.trigger_kind,
    trigger_value: validated.trigger_value,
    response: JSON.stringify(normalizeResponse(validated.response)),
    priority: validated.priority,
    case_sensitive: validated.case_sensitive,
    is_active: validated.is_active,
    updated_at: now(),
  };

  const [updated] = await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .update(updateData)
    .returning('*');

  if (!updated) {
    throw new NotFoundError('Auto-reply rule not found');
  }

  return updated;
}

/**
 * Remove an auto-reply rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @returns {Promise<void>}
 * @throws {NotFoundError}
 */
async function remove(tenantId, ruleId) {
  const deleted = await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .del();

  if (deleted === 0) {
    throw new NotFoundError('Auto-reply rule not found');
  }
}

/**
 * Toggle the is_active flag on a rule.
 *
 * @param {string} tenantId
 * @param {string} ruleId
 * @param {boolean} isActive
 * @returns {Promise<object>} The updated rule
 * @throws {NotFoundError}
 */
async function toggleActive(tenantId, ruleId, isActive) {
  const [updated] = await tenantQuery(tenantId, TABLE)
    .where({ id: ruleId })
    .update({ is_active: Boolean(isActive), updated_at: now() })
    .returning('*');

  if (!updated) {
    throw new NotFoundError('Auto-reply rule not found');
  }

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
