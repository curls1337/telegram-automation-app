'use strict';

/**
 * Tag service — CRUD for tags and subscriber-tag associations.
 *
 * References:
 *   - requirements.md §10.2 — tag management, cross-tenant validation
 *   - design.md "Subscriber & Segmentation" — Tag CRUD
 */

const { getDb, tenantQuery, tenantInsert } = require('../../infra/db');
const { NotFoundError, ForbiddenError } = require('../../shared/errors');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new tag for a tenant.
 *
 * @param {string} tenantId
 * @param {string} name
 * @returns {Promise<object>} The created tag record
 */
async function create(tenantId, name) {
  const timestamp = now();
  const [tag] = await tenantInsert(tenantId, 'tags', {
    id: newId(),
    name: name.trim(),
    created_at: timestamp,
    updated_at: timestamp,
  }, { returning: '*' });

  return tag;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List all tags for a tenant.
 *
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function list(tenantId) {
  return tenantQuery(tenantId, 'tags').orderBy('name', 'asc');
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Get a single tag by ID within a tenant.
 *
 * @param {string} tenantId
 * @param {string} tagId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, tagId) {
  const tag = await tenantQuery(tenantId, 'tags')
    .where({ id: tagId })
    .first();

  if (!tag) {
    throw new NotFoundError('Tag not found');
  }

  return tag;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Delete a tag and cascade to subscriber_tags.
 *
 * @param {string} tenantId
 * @param {string} tagId
 * @returns {Promise<void>}
 * @throws {NotFoundError}
 */
async function remove(tenantId, tagId) {
  const db = getDb();

  // Verify tag belongs to tenant
  const tag = await tenantQuery(tenantId, 'tags')
    .where({ id: tagId })
    .first();

  if (!tag) {
    throw new NotFoundError('Tag not found');
  }

  // Delete subscriber_tags associations first
  await db('subscriber_tags').where({ tag_id: tagId }).del();

  // Delete the tag
  await tenantQuery(tenantId, 'tags').where({ id: tagId }).del();
}

// ---------------------------------------------------------------------------
// attachTag
// ---------------------------------------------------------------------------

/**
 * Attach a tag to a subscriber. Validates both belong to the same tenant.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @param {string} tagId
 * @returns {Promise<void>}
 * @throws {NotFoundError|ForbiddenError}
 */
async function attachTag(tenantId, subscriberId, tagId) {
  const db = getDb();

  // Load tag and subscriber, verify both have same tenant_id
  const tag = await tenantQuery(tenantId, 'tags')
    .where({ id: tagId })
    .first();

  if (!tag) {
    throw new NotFoundError('Tag not found');
  }

  const subscriber = await tenantQuery(tenantId, 'subscribers')
    .where({ id: subscriberId })
    .first();

  if (!subscriber) {
    throw new NotFoundError('Subscriber not found');
  }

  // Both verified to belong to same tenant via tenantQuery
  // If somehow tenant_id mismatch (shouldn't happen with tenantQuery but extra safety)
  if (tag.tenant_id !== subscriber.tenant_id) {
    throw new ForbiddenError('Tag and subscriber must belong to the same tenant');
  }

  // INSERT ON CONFLICT DO NOTHING
  await db('subscriber_tags')
    .insert({
      subscriber_id: subscriberId,
      tag_id: tagId,
    })
    .onConflict(['subscriber_id', 'tag_id'])
    .ignore();
}

// ---------------------------------------------------------------------------
// detachTag
// ---------------------------------------------------------------------------

/**
 * Detach a tag from a subscriber.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @param {string} tagId
 * @returns {Promise<void>}
 */
async function detachTag(tenantId, subscriberId, tagId) {
  const db = getDb();

  // Verify subscriber belongs to tenant
  const subscriber = await tenantQuery(tenantId, 'subscribers')
    .where({ id: subscriberId })
    .first();

  if (!subscriber) {
    throw new NotFoundError('Subscriber not found');
  }

  await db('subscriber_tags')
    .where({ subscriber_id: subscriberId, tag_id: tagId })
    .del();
}

// ---------------------------------------------------------------------------
// getSubscriberTags
// ---------------------------------------------------------------------------

/**
 * Get all tags for a subscriber.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @returns {Promise<object[]>}
 */
async function getSubscriberTags(tenantId, subscriberId) {
  const db = getDb();

  // Verify subscriber belongs to tenant
  const subscriber = await tenantQuery(tenantId, 'subscribers')
    .where({ id: subscriberId })
    .first();

  if (!subscriber) {
    throw new NotFoundError('Subscriber not found');
  }

  return db('tags')
    .join('subscriber_tags', 'tags.id', 'subscriber_tags.tag_id')
    .where('subscriber_tags.subscriber_id', subscriberId)
    .where('tags.tenant_id', tenantId)
    .select('tags.*');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  create,
  list,
  getById,
  remove,
  attachTag,
  detachTag,
  getSubscriberTags,
};
