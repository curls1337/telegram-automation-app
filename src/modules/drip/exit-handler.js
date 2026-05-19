'use strict';

/**
 * Drip Exit Handler — evaluates exit conditions and stops enrollments.
 *
 * Responsibilities:
 *   - Evaluate exit_conditions JSONB from campaign against incoming events.
 *   - Handle 'user_reply' exit condition: subscriber replied → exit enrollment.
 *   - Handle 'tag_removed' exit condition: specific tag removed → exit enrollment.
 *   - When exiting, set enrollment status='exited' and attempt to remove the
 *     pending BullMQ job for the next step.
 *
 * References:
 *   - requirements.md §11.4 — exit conditions (user reply, tag removed).
 *   - design.md "Drip Engine" — exit conditions evaluation.
 */

const { getDb, tenantQuery } = require('../../infra/db');
const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { getLogger } = require('../../infra/logger');
const { nowIso } = require('../../shared/time');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAMPAIGNS_TABLE = 'drip_campaigns';
const ENROLLMENTS_TABLE = 'drip_enrollments';

// ---------------------------------------------------------------------------
// Core exit logic
// ---------------------------------------------------------------------------

/**
 * Check if an event satisfies any exit condition defined on the campaign.
 *
 * Exit conditions are stored as JSONB on the campaign record. Supported
 * structure:
 *   { "type": "user_reply" }
 *   { "type": "tag_removed", "tag_id": "<uuid>" }
 *   [{ "type": "user_reply" }, { "type": "tag_removed", "tag_id": "..." }]
 *
 * @param {object} enrollment - The enrollment record
 * @param {object} campaign - The campaign record (with exit_conditions)
 * @param {{ type: string, tag_id?: string }} event - The event to evaluate
 * @returns {boolean} true if the event triggers an exit condition
 */
function checkExitConditions(enrollment, campaign, event) {
  if (!campaign.exit_conditions) return false;

  // Parse exit_conditions if it's a string
  let conditions = campaign.exit_conditions;
  if (typeof conditions === 'string') {
    try {
      conditions = JSON.parse(conditions);
    } catch {
      return false;
    }
  }

  // Normalize to array
  const conditionList = Array.isArray(conditions) ? conditions : [conditions];

  for (const condition of conditionList) {
    if (!condition || !condition.type) continue;

    if (condition.type === 'user_reply' && event.type === 'user_reply') {
      return true;
    }

    if (
      condition.type === 'tag_removed' &&
      event.type === 'tag_removed' &&
      condition.tag_id === event.tag_id
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Exit an enrollment: set status='exited' and attempt to remove the pending
 * BullMQ job for the current step.
 *
 * @param {string} enrollmentId
 * @param {number} currentStep - The current step index of the enrollment
 * @returns {Promise<void>}
 */
async function exitEnrollment(enrollmentId, currentStep) {
  const log = getLogger();
  const db = getDb();

  // Set enrollment status to 'exited'
  await db(ENROLLMENTS_TABLE)
    .where({ id: enrollmentId })
    .update({ status: 'exited', next_run_at: null, updated_at: nowIso() });

  // Attempt to remove the pending BullMQ job
  const jobId = `drip:${enrollmentId}:${currentStep}`;
  try {
    const queue = getQueue(QUEUE_NAMES.DRIP_STEPS);
    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove();
      log.debug({ enrollmentId, jobId }, 'exit-handler: removed pending drip job');
    }
  } catch (err) {
    // Non-critical — job may already be processing or completed
    log.debug(
      { enrollmentId, jobId, err: err && err.message },
      'exit-handler: could not remove pending job (may already be processed)'
    );
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Called when a subscriber sends a message (user reply event).
 *
 * Finds all running enrollments for this subscriber where the campaign has
 * an exit_condition of type='user_reply', and exits them.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @param {string} connectionId - The connection through which the reply came
 * @returns {Promise<number>} Number of enrollments exited
 */
async function onUserReply(tenantId, subscriberId, connectionId) {
  const log = getLogger();
  const db = getDb();

  // Find all running enrollments for this subscriber
  const enrollments = await db(ENROLLMENTS_TABLE)
    .where({ subscriber_id: subscriberId, status: 'running' })
    .select('*');

  if (enrollments.length === 0) return 0;

  // For each enrollment, load the campaign and check exit conditions
  let exitedCount = 0;

  for (const enrollment of enrollments) {
    const campaign = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
      .where({ id: enrollment.campaign_id })
      .first();

    if (!campaign) continue;

    // Only check campaigns on the same connection
    if (campaign.connection_id !== connectionId) continue;

    const shouldExit = checkExitConditions(enrollment, campaign, { type: 'user_reply' });

    if (shouldExit) {
      await exitEnrollment(enrollment.id, enrollment.current_step);
      exitedCount++;

      log.info(
        { tenantId, subscriberId, enrollmentId: enrollment.id, campaignId: campaign.id },
        'exit-handler: enrollment exited due to user reply'
      );
    }
  }

  return exitedCount;
}

/**
 * Called when a tag is removed from a subscriber.
 *
 * Finds all running enrollments for this subscriber where the campaign has
 * an exit_condition of type='tag_removed' matching the given tagId, and
 * exits them.
 *
 * @param {string} tenantId
 * @param {string} subscriberId
 * @param {string} tagId - The tag that was removed
 * @returns {Promise<number>} Number of enrollments exited
 */
async function onTagRemoved(tenantId, subscriberId, tagId) {
  const log = getLogger();
  const db = getDb();

  // Find all running enrollments for this subscriber
  const enrollments = await db(ENROLLMENTS_TABLE)
    .where({ subscriber_id: subscriberId, status: 'running' })
    .select('*');

  if (enrollments.length === 0) return 0;

  // For each enrollment, load the campaign and check exit conditions
  let exitedCount = 0;

  for (const enrollment of enrollments) {
    const campaign = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
      .where({ id: enrollment.campaign_id })
      .first();

    if (!campaign) continue;

    const shouldExit = checkExitConditions(enrollment, campaign, {
      type: 'tag_removed',
      tag_id: tagId,
    });

    if (shouldExit) {
      await exitEnrollment(enrollment.id, enrollment.current_step);
      exitedCount++;

      log.info(
        { tenantId, subscriberId, tagId, enrollmentId: enrollment.id, campaignId: campaign.id },
        'exit-handler: enrollment exited due to tag removed'
      );
    }
  }

  return exitedCount;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  checkExitConditions,
  exitEnrollment,
  onUserReply,
  onTagRemoved,
};
