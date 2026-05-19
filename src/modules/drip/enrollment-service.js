'use strict';

/**
 * Drip Enrollment Service — enrollment triggers and core enrollment logic.
 *
 * Responsibilities:
 *   - Listen for events (subscribe, tag_added, manual) and enroll subscribers
 *     into matching active drip campaigns.
 *   - Insert drip_enrollments records and enqueue the first step job.
 *   - Prevent duplicate enrollments (campaign_id + subscriber_id is UNIQUE).
 *   - Skip enrollment when campaign has no steps or is not active.
 *
 * References:
 *   - requirements.md §11.2 — trigger enrollment and schedule first step
 *   - design.md "Drip Engine" — enrollment, scheduling, exit conditions
 */

const { getDb, tenantQuery, withTransaction } = require('../../infra/db');
const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');
const { now, addSeconds } = require('../../shared/time');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAMPAIGNS_TABLE = 'drip_campaigns';
const STEPS_TABLE = 'drip_steps';
const ENROLLMENTS_TABLE = 'drip_enrollments';

// ---------------------------------------------------------------------------
// Core enrollment logic
// ---------------------------------------------------------------------------

/**
 * Enroll a single subscriber into a drip campaign.
 *
 * Steps:
 *   1. Check campaign is active
 *   2. Check campaign has at least one step
 *   3. Check subscriber is not already enrolled (UNIQUE constraint)
 *   4. Insert drip_enrollments record with status='running', current_step=0
 *   5. Load first step (step_index=0)
 *   6. Calculate next_run_at = now + step.delay_seconds
 *   7. Enqueue job to BullMQ 'drip-steps' queue
 *   8. Return enrollment record
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @param {string} subscriberId
 * @returns {Promise<object|null>} The enrollment record, or null if skipped
 */
async function enroll(tenantId, campaignId, subscriberId) {
  const log = getLogger();
  const db = getDb();

  // 1. Load campaign and verify it is active
  const campaign = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .first();

  if (!campaign || campaign.status !== 'active') {
    log.debug(
      { tenantId, campaignId, subscriberId },
      'enrollment-service: skipping enrollment — campaign not active'
    );
    return null;
  }

  // 2. Load first step (step_index = 0)
  const firstStep = await db(STEPS_TABLE)
    .where({ campaign_id: campaignId, step_index: 0 })
    .first();

  if (!firstStep) {
    log.debug(
      { tenantId, campaignId, subscriberId },
      'enrollment-service: skipping enrollment — campaign has no steps'
    );
    return null;
  }

  // 3. Check if subscriber is already enrolled (avoid duplicate)
  const existing = await db(ENROLLMENTS_TABLE)
    .where({ campaign_id: campaignId, subscriber_id: subscriberId })
    .first();

  if (existing) {
    log.debug(
      { tenantId, campaignId, subscriberId },
      'enrollment-service: skipping enrollment — subscriber already enrolled'
    );
    return null;
  }

  // 4. Insert enrollment record
  const enrollmentId = newId();
  const timestamp = now();
  const nextRunAt = addSeconds(timestamp, firstStep.delay_seconds);

  const [enrollment] = await db(ENROLLMENTS_TABLE)
    .insert({
      id: enrollmentId,
      campaign_id: campaignId,
      subscriber_id: subscriberId,
      current_step: 0,
      next_run_at: nextRunAt.toISOString(),
      status: 'running',
      created_at: timestamp.toISOString(),
      updated_at: timestamp.toISOString(),
    })
    .onConflict(['campaign_id', 'subscriber_id'])
    .ignore()
    .returning('*');

  // If onConflict ignored the insert (race condition), skip silently
  if (!enrollment) {
    log.debug(
      { tenantId, campaignId, subscriberId },
      'enrollment-service: skipping enrollment — duplicate detected on insert'
    );
    return null;
  }

  // 5. Enqueue first step job
  const queue = getQueue(QUEUE_NAMES.DRIP_STEPS);
  const stepIndex = 0;
  const jobId = `drip:${enrollmentId}:${stepIndex}`;

  await queue.add('step', {
    enrollmentId,
    campaignId,
    subscriberId,
    stepIndex,
  }, {
    jobId,
    delay: firstStep.delay_seconds * 1000,
  });

  log.info(
    { tenantId, campaignId, subscriberId, enrollmentId, nextRunAt: nextRunAt.toISOString() },
    'enrollment-service: subscriber enrolled in drip campaign'
  );

  return enrollment;
}

// ---------------------------------------------------------------------------
// Event-based enrollment triggers
// ---------------------------------------------------------------------------

/**
 * Called when a new subscriber joins (subscribe event). Finds all active
 * campaigns with trigger_kind='subscribe' for the given connection and
 * enrolls the subscriber into each.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @param {string} connectionId
 * @returns {Promise<object[]>} Array of enrollment records created
 */
async function onSubscribe(tenantId, subscriberId, connectionId) {
  const log = getLogger();

  // Find all active campaigns with trigger_kind='subscribe' for this connection
  const campaigns = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({
      trigger_kind: 'subscribe',
      status: 'active',
      connection_id: connectionId,
    });

  const enrollments = [];

  for (const campaign of campaigns) {
    const enrollment = await enroll(tenantId, campaign.id, subscriberId);
    if (enrollment) {
      enrollments.push(enrollment);
    }
  }

  if (enrollments.length > 0) {
    log.info(
      { tenantId, subscriberId, connectionId, count: enrollments.length },
      'enrollment-service: onSubscribe — enrolled subscriber in campaigns'
    );
  }

  return enrollments;
}

/**
 * Called when a tag is added to a subscriber. Finds all active campaigns
 * with trigger_kind='tag_added' where trigger_config.tag_id matches the
 * given tagId and enrolls the subscriber.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @param {string} tagId
 * @returns {Promise<object[]>} Array of enrollment records created
 */
async function onTagAdded(tenantId, subscriberId, tagId) {
  const log = getLogger();

  // Find all active campaigns with trigger_kind='tag_added'
  // We need to check trigger_config->>'tag_id' matches
  const campaigns = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({
      trigger_kind: 'tag_added',
      status: 'active',
    })
    .whereRaw("trigger_config->>'tag_id' = ?", [tagId]);

  const enrollments = [];

  for (const campaign of campaigns) {
    const enrollment = await enroll(tenantId, campaign.id, subscriberId);
    if (enrollment) {
      enrollments.push(enrollment);
    }
  }

  if (enrollments.length > 0) {
    log.info(
      { tenantId, subscriberId, tagId, count: enrollments.length },
      'enrollment-service: onTagAdded — enrolled subscriber in campaigns'
    );
  }

  return enrollments;
}

/**
 * Manually enroll one or more subscribers into a specific campaign.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @param {string[]} subscriberIds - Array of subscriber IDs to enroll
 * @returns {Promise<object[]>} Array of enrollment records created
 */
async function enrollManual(tenantId, campaignId, subscriberIds) {
  const log = getLogger();

  const enrollments = [];

  for (const subscriberId of subscriberIds) {
    const enrollment = await enroll(tenantId, campaignId, subscriberId);
    if (enrollment) {
      enrollments.push(enrollment);
    }
  }

  log.info(
    { tenantId, campaignId, requested: subscriberIds.length, enrolled: enrollments.length },
    'enrollment-service: enrollManual — manual enrollment completed'
  );

  return enrollments;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  enroll,
  onSubscribe,
  onTagAdded,
  enrollManual,
};
