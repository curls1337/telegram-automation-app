'use strict';

/**
 * Segment service — dynamic subscriber segmentation via JSON predicates.
 *
 * References:
 *   - requirements.md §10.3 — segment with filter by tag, attribute, behavior
 *   - design.md "Subscriber & Segmentation" — predicate JSON → SQL WHERE
 */

const { getDb, tenantQuery, tenantInsert } = require('../../infra/db');
const { NotFoundError, ValidationError } = require('../../shared/errors');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');

// ---------------------------------------------------------------------------
// Predicate validation
// ---------------------------------------------------------------------------

const SUPPORTED_FIELDS = ['status', 'language_code', 'first_seen_at', 'last_active_at', 'tag'];
const SUPPORTED_OPERATORS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'];
const SUPPORTED_LOGIC = ['and', 'or'];

/**
 * Validate a predicate object structure.
 *
 * @param {object} predicate - { conditions: [{ field, operator, value }], logic: 'and'|'or' }
 * @throws {ValidationError}
 */
function validatePredicate(predicate) {
  if (!predicate || typeof predicate !== 'object') {
    throw new ValidationError('Predicate must be an object');
  }

  if (!Array.isArray(predicate.conditions)) {
    throw new ValidationError('Predicate must have a conditions array');
  }

  if (predicate.logic && !SUPPORTED_LOGIC.includes(predicate.logic)) {
    throw new ValidationError(`Predicate logic must be one of: ${SUPPORTED_LOGIC.join(', ')}`);
  }

  for (const condition of predicate.conditions) {
    if (!condition || typeof condition !== 'object') {
      throw new ValidationError('Each condition must be an object');
    }
    if (!SUPPORTED_FIELDS.includes(condition.field)) {
      throw new ValidationError(
        `Unsupported field "${condition.field}". Supported: ${SUPPORTED_FIELDS.join(', ')}`
      );
    }
    if (!SUPPORTED_OPERATORS.includes(condition.operator)) {
      throw new ValidationError(
        `Unsupported operator "${condition.operator}". Supported: ${SUPPORTED_OPERATORS.join(', ')}`
      );
    }
    if (condition.value === undefined || condition.value === null) {
      throw new ValidationError('Each condition must have a value');
    }
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new segment.
 *
 * @param {string} tenantId
 * @param {object} input - { name, predicate }
 * @returns {Promise<object>}
 */
async function create(tenantId, { name, predicate }) {
  validatePredicate(predicate);

  const timestamp = now();
  const [segment] = await tenantInsert(tenantId, 'segments', {
    id: newId(),
    name: name.trim(),
    predicate: JSON.stringify(predicate),
    created_at: timestamp,
    updated_at: timestamp,
  }, { returning: '*' });

  return segment;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List all segments for a tenant.
 *
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function list(tenantId) {
  return tenantQuery(tenantId, 'segments').orderBy('name', 'asc');
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Get a single segment by ID.
 *
 * @param {string} tenantId
 * @param {string} segmentId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, segmentId) {
  const segment = await tenantQuery(tenantId, 'segments')
    .where({ id: segmentId })
    .first();

  if (!segment) {
    throw new NotFoundError('Segment not found');
  }

  return segment;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Update a segment's name and/or predicate.
 *
 * @param {string} tenantId
 * @param {string} segmentId
 * @param {object} input - { name?, predicate? }
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function update(tenantId, segmentId, { name, predicate }) {
  const updates = { updated_at: now() };

  if (name !== undefined) {
    updates.name = name.trim();
  }

  if (predicate !== undefined) {
    validatePredicate(predicate);
    updates.predicate = JSON.stringify(predicate);
  }

  const [updated] = await tenantQuery(tenantId, 'segments')
    .where({ id: segmentId })
    .update(updates)
    .returning('*');

  if (!updated) {
    throw new NotFoundError('Segment not found');
  }

  return updated;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Delete a segment.
 *
 * @param {string} tenantId
 * @param {string} segmentId
 * @returns {Promise<void>}
 * @throws {NotFoundError}
 */
async function remove(tenantId, segmentId) {
  const deleted = await tenantQuery(tenantId, 'segments')
    .where({ id: segmentId })
    .del();

  if (!deleted) {
    throw new NotFoundError('Segment not found');
  }
}

// ---------------------------------------------------------------------------
// members — dynamic evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a segment's predicate and return matching subscribers.
 *
 * Predicate format: { conditions: [{ field, operator, value }], logic: 'and'|'or' }
 * Supported fields: 'status', 'language_code', 'first_seen_at', 'last_active_at', 'tag'
 * Supported operators: 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'
 *
 * @param {string} tenantId
 * @param {string} segmentId
 * @returns {Promise<object[]>} Array of subscriber records
 */
async function members(tenantId, segmentId) {
  const db = getDb();

  const segment = await getById(tenantId, segmentId);
  const predicate = typeof segment.predicate === 'string'
    ? JSON.parse(segment.predicate)
    : segment.predicate;

  const logic = predicate.logic || 'and';
  const conditions = predicate.conditions || [];

  // Separate tag conditions from regular field conditions
  const tagConditions = conditions.filter((c) => c.field === 'tag');
  const fieldConditions = conditions.filter((c) => c.field !== 'tag');

  let query = tenantQuery(tenantId, 'subscribers').select('subscribers.*');

  // Handle tag conditions with joins
  if (tagConditions.length > 0) {
    for (let i = 0; i < tagConditions.length; i++) {
      const alias = `st${i}`;
      const tagAlias = `t${i}`;
      query = query
        .join(`subscriber_tags as ${alias}`, 'subscribers.id', `${alias}.subscriber_id`)
        .join(`tags as ${tagAlias}`, `${alias}.tag_id`, `${tagAlias}.id`)
        .where(`${tagAlias}.name`, tagConditions[i].value)
        .where(`${tagAlias}.tenant_id`, tenantId);
    }
  }

  // Apply field conditions
  if (fieldConditions.length > 0) {
    if (logic === 'and') {
      query = query.where(function () {
        for (const condition of fieldConditions) {
          applyCondition(this, condition, 'and');
        }
      });
    } else {
      query = query.where(function () {
        for (const condition of fieldConditions) {
          applyCondition(this, condition, 'or');
        }
      });
    }
  }

  return query;
}

/**
 * Apply a single condition to a Knex query builder.
 *
 * @param {object} builder - Knex query builder (inside where callback)
 * @param {object} condition - { field, operator, value }
 * @param {string} logic - 'and' or 'or'
 */
function applyCondition(builder, condition, logic) {
  const { field, operator, value } = condition;
  const column = `subscribers.${field}`;
  const method = logic === 'or' ? 'orWhere' : 'where';

  switch (operator) {
    case 'eq':
      builder[method](column, '=', value);
      break;
    case 'neq':
      builder[method](column, '!=', value);
      break;
    case 'gt':
      builder[method](column, '>', value);
      break;
    case 'lt':
      builder[method](column, '<', value);
      break;
    case 'gte':
      builder[method](column, '>=', value);
      break;
    case 'lte':
      builder[method](column, '<=', value);
      break;
    case 'contains':
      builder[method](column, 'ilike', `%${value}%`);
      break;
    case 'in': {
      const values = Array.isArray(value) ? value : [value];
      if (logic === 'or') {
        builder.orWhereIn(column, values);
      } else {
        builder.whereIn(column, values);
      }
      break;
    }
    default:
      break;
  }
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
  members,
  validatePredicate,
};
