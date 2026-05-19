'use strict';

/**
 * Broadcast Service — create, pause, resume, cancel, list, and get broadcasts.
 *
 * Responsibilities:
 *   - Materialize broadcast targets from audience (all / segment / subscriber_ids)
 *   - Enforce quota via QuotaService
 *   - Insert broadcast + broadcast_targets records
 *   - Enqueue broadcast job to BullMQ
 *   - Pause / resume / cancel lifecycle management
 *
 * References:
 *   - requirements.md §9.1 — create broadcast with audience targeting
 *   - requirements.md §9.5 — pause/cancel running broadcast
 *   - requirements.md §9.7 — quota enforcement
 *   - design.md "Broadcast Engine" — planner, dispatcher, progress
 */

const { getDb, tenantQuery, tenantInsert, withTransaction } = require('../../infra/db');
const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');
const { nowIso } = require('../../shared/time');
const { NotFoundError, ValidationError } = require('../../shared/errors');
const quotaService = require('../plans/quota-service');
const segmentService = require('../subscribers/segment-service');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BROADCASTS_TABLE = 'broadcasts';
const TARGETS_TABLE = 'broadcast_targets';
const SUBSCRIBERS_TABLE = 'subscribers';

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new broadcast, materialize targets, and enqueue the job.
 *
 * @param {string} tenantId
 * @param {object} input
 * @param {string} input.connectionId - Telegram connection to send from
 * @param {object} input.audience - { type: 'all' | 'segment' | 'subscribers', segmentId?, subscriberIds? }
 * @param {object} input.payload - Message payload (text, media_ids, parse_mode)
 * @returns {Promise<object>} The created broadcast record
 */
async function create(tenantId, input) {
  const log = getLogger();
  const { connectionId, audience, payload } = input;

  if (!connectionId) {
    throw new ValidationError('Connection is required');
  }
  if (!audience || !audience.type) {
    throw new ValidationError('Audience type is required');
  }
  if (!payload || (!payload.text && (!payload.media_ids || payload.media_ids.length === 0))) {
    throw new ValidationError('Message text or media is required');
  }

  // Materialize target subscriber IDs
  const targetSubscriberIds = await materializeTargets(tenantId, audience);

  if (targetSubscriberIds.length === 0) {
    throw new ValidationError('No subscribers match the selected audience');
  }

  // Check quota
  await quotaService.check(tenantId, 'monthly_broadcasts', targetSubscriberIds.length);

  const broadcastId = newId();
  const timestamp = nowIso();

  // Insert broadcast + targets in a transaction
  const broadcast = await withTransaction(async (trx) => {
    const [record] = await tenantInsert(tenantId, BROADCASTS_TABLE, {
      id: broadcastId,
      connection_id: connectionId,
      audience: JSON.stringify(audience),
      payload: JSON.stringify(payload),
      status: 'pending',
      total_targets: targetSubscriberIds.length,
      sent_count: 0,
      failed_count: 0,
      blocked_count: 0,
      started_at: null,
      completed_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    }, { trx, returning: '*' });

    // Insert broadcast_targets in batches of 500
    const batchSize = 500;
    for (let i = 0; i < targetSubscriberIds.length; i += batchSize) {
      const batch = targetSubscriberIds.slice(i, i + batchSize);
      const targetRows = batch.map((subscriberId) => ({
        id: newId(),
        broadcast_id: broadcastId,
        subscriber_id: subscriberId,
        status: 'pending',
        error: null,
        sent_at: null,
      }));
      await trx(TARGETS_TABLE).insert(targetRows);
    }

    return record;
  });

  // Enqueue the broadcast job
  const queue = getQueue(QUEUE_NAMES.BROADCASTS);
  await queue.add('broadcast-dispatch', { broadcastId }, {
    jobId: `broadcast:${broadcastId}`,
  });

  log.info(
    { broadcastId, tenantId, targetCount: targetSubscriberIds.length },
    'broadcast-service: broadcast created and enqueued'
  );

  return broadcast;
}

// ---------------------------------------------------------------------------
// materializeTargets
// ---------------------------------------------------------------------------

/**
 * Resolve audience to a list of subscriber IDs.
 *
 * @param {string} tenantId
 * @param {object} audience - { type, segmentId?, subscriberIds? }
 * @returns {Promise<string[]>}
 */
async function materializeTargets(tenantId, audience) {
  switch (audience.type) {
    case 'all': {
      const subscribers = await tenantQuery(tenantId, SUBSCRIBERS_TABLE)
        .where({ status: 'active' })
        .select('id');
      return subscribers.map((s) => s.id);
    }

    case 'segment': {
      if (!audience.segmentId) {
        throw new ValidationError('Segment ID is required for segment audience');
      }
      const subscribers = await segmentService.members(tenantId, audience.segmentId);
      return subscribers.map((s) => s.id);
    }

    case 'subscribers': {
      if (!audience.subscriberIds || !Array.isArray(audience.subscriberIds) || audience.subscriberIds.length === 0) {
        throw new ValidationError('Subscriber IDs are required for manual audience');
      }
      // Validate that all subscriber IDs belong to this tenant
      const valid = await tenantQuery(tenantId, SUBSCRIBERS_TABLE)
        .whereIn('id', audience.subscriberIds)
        .where({ status: 'active' })
        .select('id');
      return valid.map((s) => s.id);
    }

    default:
      throw new ValidationError(`Invalid audience type: ${audience.type}`);
  }
}

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

/**
 * Pause a running broadcast.
 *
 * @param {string} tenantId
 * @param {string} broadcastId
 * @returns {Promise<object>}
 */
async function pause(tenantId, broadcastId) {
  const broadcast = await getById(tenantId, broadcastId);

  if (broadcast.status !== 'running' && broadcast.status !== 'pending') {
    throw new ValidationError(`Cannot pause broadcast with status "${broadcast.status}"`);
  }

  const [updated] = await tenantQuery(tenantId, BROADCASTS_TABLE)
    .where({ id: broadcastId })
    .update({ status: 'paused', updated_at: nowIso() })
    .returning('*');

  getLogger().info({ broadcastId, tenantId }, 'broadcast-service: broadcast paused');
  return updated;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

/**
 * Resume a paused broadcast.
 *
 * @param {string} tenantId
 * @param {string} broadcastId
 * @returns {Promise<object>}
 */
async function resume(tenantId, broadcastId) {
  const broadcast = await getById(tenantId, broadcastId);

  if (broadcast.status !== 'paused') {
    throw new ValidationError(`Cannot resume broadcast with status "${broadcast.status}"`);
  }

  const [updated] = await tenantQuery(tenantId, BROADCASTS_TABLE)
    .where({ id: broadcastId })
    .update({ status: 'running', updated_at: nowIso() })
    .returning('*');

  // Re-enqueue the job to continue processing
  const queue = getQueue(QUEUE_NAMES.BROADCASTS);
  await queue.add('broadcast-dispatch', { broadcastId }, {
    jobId: `broadcast:${broadcastId}:resume:${Date.now()}`,
  });

  getLogger().info({ broadcastId, tenantId }, 'broadcast-service: broadcast resumed');
  return updated;
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

/**
 * Cancel a broadcast (pending, running, or paused).
 *
 * @param {string} tenantId
 * @param {string} broadcastId
 * @returns {Promise<object>}
 */
async function cancel(tenantId, broadcastId) {
  const broadcast = await getById(tenantId, broadcastId);

  if (broadcast.status === 'completed' || broadcast.status === 'cancelled') {
    throw new ValidationError(`Cannot cancel broadcast with status "${broadcast.status}"`);
  }

  const [updated] = await tenantQuery(tenantId, BROADCASTS_TABLE)
    .where({ id: broadcastId })
    .update({ status: 'cancelled', updated_at: nowIso() })
    .returning('*');

  // Mark remaining pending targets as skipped
  await getDb()(TARGETS_TABLE)
    .where({ broadcast_id: broadcastId, status: 'pending' })
    .update({ status: 'skipped' });

  getLogger().info({ broadcastId, tenantId }, 'broadcast-service: broadcast cancelled');
  return updated;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List broadcasts for a tenant with pagination.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=25]
 * @param {string} [opts.status]
 * @returns {Promise<{ data: object[], total: number, page: number, pageSize: number }>}
 */
async function list(tenantId, opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(opts.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;

  let query = tenantQuery(tenantId, BROADCASTS_TABLE);
  let countQuery = tenantQuery(tenantId, BROADCASTS_TABLE);

  if (opts.status) {
    query = query.where({ status: opts.status });
    countQuery = countQuery.where({ status: opts.status });
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
 * Get a single broadcast by ID with target counts.
 *
 * @param {string} tenantId
 * @param {string} broadcastId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, broadcastId) {
  const broadcast = await tenantQuery(tenantId, BROADCASTS_TABLE)
    .where({ id: broadcastId })
    .first();

  if (!broadcast) {
    throw new NotFoundError('Broadcast not found');
  }

  return broadcast;
}

// ---------------------------------------------------------------------------
// getProgress
// ---------------------------------------------------------------------------

/**
 * Get current progress for a broadcast (for the polling endpoint).
 *
 * @param {string} tenantId
 * @param {string} broadcastId
 * @returns {Promise<object>}
 */
async function getProgress(tenantId, broadcastId) {
  const broadcast = await getById(tenantId, broadcastId);

  return {
    status: broadcast.status,
    total_targets: broadcast.total_targets,
    sent_count: broadcast.sent_count,
    failed_count: broadcast.failed_count,
    blocked_count: broadcast.blocked_count,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  create,
  pause,
  resume,
  cancel,
  list,
  getById,
  getProgress,
  materializeTargets,
};
