'use strict';

/**
 * Drip Campaign Service — CRUD for drip_campaigns and drip_steps.
 *
 * Responsibilities:
 *   - Create, list, get, update, remove drip campaigns
 *   - Manage campaign lifecycle: activate, pause, archive
 *   - Add, update, remove, list, reorder drip steps
 *   - Validate step payload (must have delay_seconds + payload with text or media_ids)
 *   - Validate campaign input (name, connection_id, trigger_kind, trigger_config)
 *   - Enforce status transitions: draft → active, active → paused, paused → active, any → archived
 *
 * References:
 *   - requirements.md §11.1 — campaign creation with trigger and steps
 *   - design.md "Drip Engine" — enrollment, scheduling, exit conditions
 */

const { z } = require('zod');
const { tenantQuery, tenantInsert, withTransaction, getDb } = require('../../infra/db');
const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');
const { nowIso, now, addSeconds } = require('../../shared/time');
const { NotFoundError, ValidationError } = require('../../shared/errors');
const { parseOrThrow } = require('../../shared/validation');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAMPAIGNS_TABLE = 'drip_campaigns';
const STEPS_TABLE = 'drip_steps';
const ENROLLMENTS_TABLE = 'drip_enrollments';

const VALID_TRIGGER_KINDS = ['subscribe', 'tag_added', 'manual'];
const VALID_STATUSES = ['draft', 'active', 'paused', 'archived'];

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Payload schema: must contain either `text` (non-empty string) or
 * `media_ids` (non-empty array of strings), or both.
 */
const StepPayloadSchema = z.object({
  text: z.string().min(1).optional(),
  media_ids: z.array(z.string().min(1)).min(1).optional(),
}).refine(
  (data) => Boolean(data.text) || (data.media_ids && data.media_ids.length > 0),
  { message: 'Payload must contain text or media_ids' }
);

/**
 * Step input schema: delay_seconds must be a positive integer, payload must
 * be a valid StepPayloadSchema.
 */
const StepInputSchema = z.object({
  delay_seconds: z.number().int().positive('delay_seconds must be a positive integer'),
  payload: StepPayloadSchema,
});

/**
 * Campaign creation schema.
 */
const CampaignCreateSchema = z.object({
  name: z.string().trim().min(1, 'Campaign name is required'),
  connection_id: z.string().uuid('connection_id must be a valid UUID'),
  trigger_kind: z.enum(VALID_TRIGGER_KINDS, {
    errorMap: () => ({ message: `trigger_kind must be one of: ${VALID_TRIGGER_KINDS.join(', ')}` }),
  }),
  trigger_config: z.record(z.unknown()).optional().default({}),
  exit_conditions: z.record(z.unknown()).optional().nullable().default(null),
});

/**
 * Campaign update schema (all fields optional).
 */
const CampaignUpdateSchema = z.object({
  name: z.string().trim().min(1, 'Campaign name is required').optional(),
  connection_id: z.string().uuid('connection_id must be a valid UUID').optional(),
  trigger_kind: z.enum(VALID_TRIGGER_KINDS, {
    errorMap: () => ({ message: `trigger_kind must be one of: ${VALID_TRIGGER_KINDS.join(', ')}` }),
  }).optional(),
  trigger_config: z.record(z.unknown()).optional(),
  exit_conditions: z.record(z.unknown()).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new drip campaign.
 *
 * @param {string} tenantId
 * @param {object} input
 * @returns {Promise<object>} The created campaign record
 */
async function create(tenantId, input) {
  const data = parseOrThrow(CampaignCreateSchema, input, {
    message: 'Invalid campaign data',
  });

  const campaignId = newId();
  const timestamp = nowIso();

  const [campaign] = await tenantInsert(tenantId, CAMPAIGNS_TABLE, {
    id: campaignId,
    name: data.name,
    connection_id: data.connection_id,
    trigger_kind: data.trigger_kind,
    trigger_config: JSON.stringify(data.trigger_config),
    exit_conditions: data.exit_conditions ? JSON.stringify(data.exit_conditions) : null,
    status: 'draft',
    created_at: timestamp,
    updated_at: timestamp,
  }, { returning: '*' });

  return campaign;
}

/**
 * List drip campaigns for a tenant with pagination.
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

  let query = tenantQuery(tenantId, CAMPAIGNS_TABLE);
  let countQuery = tenantQuery(tenantId, CAMPAIGNS_TABLE);

  if (opts.status) {
    if (!VALID_STATUSES.includes(opts.status)) {
      throw new ValidationError(`Invalid status filter: ${opts.status}`);
    }
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

/**
 * Get a single campaign by ID.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, campaignId) {
  const campaign = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .first();

  if (!campaign) {
    throw new NotFoundError('Drip campaign not found');
  }

  return campaign;
}

/**
 * Update a drip campaign. Only allowed when status is 'draft' or 'paused'.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @param {object} input
 * @returns {Promise<object>}
 */
async function update(tenantId, campaignId, input) {
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new ValidationError(
      `Cannot update campaign with status "${campaign.status}". Only draft or paused campaigns can be updated.`
    );
  }

  const data = parseOrThrow(CampaignUpdateSchema, input, {
    message: 'Invalid campaign update data',
  });

  // Build update payload — only include fields that were provided
  const updatePayload = { updated_at: nowIso() };
  if (data.name !== undefined) updatePayload.name = data.name;
  if (data.connection_id !== undefined) updatePayload.connection_id = data.connection_id;
  if (data.trigger_kind !== undefined) updatePayload.trigger_kind = data.trigger_kind;
  if (data.trigger_config !== undefined) updatePayload.trigger_config = JSON.stringify(data.trigger_config);
  if (data.exit_conditions !== undefined) {
    updatePayload.exit_conditions = data.exit_conditions ? JSON.stringify(data.exit_conditions) : null;
  }

  const [updated] = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .update(updatePayload)
    .returning('*');

  return updated;
}

/**
 * Remove a drip campaign. Only allowed when status is 'draft' or 'archived'.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @returns {Promise<void>}
 */
async function remove(tenantId, campaignId) {
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'draft' && campaign.status !== 'archived') {
    throw new ValidationError(
      `Cannot delete campaign with status "${campaign.status}". Only draft or archived campaigns can be deleted.`
    );
  }

  await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .del();
}

// ---------------------------------------------------------------------------
// Campaign Lifecycle (status transitions)
// ---------------------------------------------------------------------------

/**
 * Activate a campaign (draft → active, paused → active).
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @returns {Promise<object>}
 */
async function activate(tenantId, campaignId) {
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new ValidationError(
      `Cannot activate campaign with status "${campaign.status}". Only draft or paused campaigns can be activated.`
    );
  }

  // Ensure campaign has at least one step before activation
  const steps = await getDb()(STEPS_TABLE)
    .where({ campaign_id: campaignId })
    .count('* as count');

  if (parseInt(steps[0].count, 10) === 0) {
    throw new ValidationError('Cannot activate campaign without any steps');
  }

  const [updated] = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .update({ status: 'active', updated_at: nowIso() })
    .returning('*');

  return updated;
}

/**
 * Pause an active campaign (active → paused).
 * Also pauses all running enrollments for this campaign.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @returns {Promise<object>}
 */
async function pause(tenantId, campaignId) {
  const log = getLogger();
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'active') {
    throw new ValidationError(
      `Cannot pause campaign with status "${campaign.status}". Only active campaigns can be paused.`
    );
  }

  const db = getDb();
  const timestamp = nowIso();

  // Update campaign status to paused
  const [updated] = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .update({ status: 'paused', updated_at: timestamp })
    .returning('*');

  // Pause all running enrollments for this campaign
  const pausedCount = await db(ENROLLMENTS_TABLE)
    .where({ campaign_id: campaignId, status: 'running' })
    .update({ status: 'paused', updated_at: timestamp });

  if (pausedCount > 0) {
    log.info(
      { tenantId, campaignId, pausedEnrollments: pausedCount },
      'drip-service: paused campaign and running enrollments'
    );
  }

  return updated;
}

/**
 * Resume a paused campaign (paused → active).
 * Scans all paused enrollments for this campaign, re-calculates delays,
 * and re-enqueues step jobs.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @returns {Promise<object>}
 */
async function resume(tenantId, campaignId) {
  const log = getLogger();
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'paused') {
    throw new ValidationError(
      `Cannot resume campaign with status "${campaign.status}". Only paused campaigns can be resumed.`
    );
  }

  // Ensure campaign has at least one step before resuming
  const db = getDb();
  const steps = await db(STEPS_TABLE)
    .where({ campaign_id: campaignId })
    .count('* as count');

  if (parseInt(steps[0].count, 10) === 0) {
    throw new ValidationError('Cannot resume campaign without any steps');
  }

  const timestamp = nowIso();

  // Set campaign status back to 'active'
  const [updated] = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .update({ status: 'active', updated_at: timestamp })
    .returning('*');

  // Scan all paused enrollments for this campaign
  const pausedEnrollments = await db(ENROLLMENTS_TABLE)
    .where({ campaign_id: campaignId, status: 'paused' })
    .select('*');

  if (pausedEnrollments.length === 0) {
    log.info(
      { tenantId, campaignId },
      'drip-service: resumed campaign (no paused enrollments to re-enqueue)'
    );
    return updated;
  }

  // Re-enqueue each paused enrollment
  const queue = getQueue(QUEUE_NAMES.DRIP_STEPS);
  let resumedCount = 0;

  for (const enrollment of pausedEnrollments) {
    // Load the step at enrollment.current_step
    const step = await db(STEPS_TABLE)
      .where({ campaign_id: campaignId, step_index: enrollment.current_step })
      .first();

    if (!step) {
      // Step no longer exists (campaign was edited while paused) — mark completed
      await db(ENROLLMENTS_TABLE)
        .where({ id: enrollment.id })
        .update({ status: 'completed', next_run_at: null, updated_at: timestamp });
      continue;
    }

    // Calculate new delay and next_run_at
    const currentTime = now();
    const nextRunAt = addSeconds(currentTime, step.delay_seconds);

    // Update enrollment: set status back to 'running' with new next_run_at
    await db(ENROLLMENTS_TABLE)
      .where({ id: enrollment.id })
      .update({
        status: 'running',
        next_run_at: nextRunAt.toISOString(),
        updated_at: timestamp,
      });

    // Enqueue the step job
    const jobId = `drip:${enrollment.id}:${enrollment.current_step}`;

    await queue.add('step', {
      enrollmentId: enrollment.id,
      campaignId,
      subscriberId: enrollment.subscriber_id,
      stepIndex: enrollment.current_step,
    }, {
      jobId,
      delay: step.delay_seconds * 1000,
    });

    resumedCount++;
  }

  log.info(
    { tenantId, campaignId, resumedEnrollments: resumedCount },
    'drip-service: resumed campaign and re-enqueued paused enrollments'
  );

  return updated;
}

/**
 * Archive a campaign (any status → archived).
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @returns {Promise<object>}
 */
async function archive(tenantId, campaignId) {
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status === 'archived') {
    throw new ValidationError('Campaign is already archived');
  }

  const [updated] = await tenantQuery(tenantId, CAMPAIGNS_TABLE)
    .where({ id: campaignId })
    .update({ status: 'archived', updated_at: nowIso() })
    .returning('*');

  return updated;
}

// ---------------------------------------------------------------------------
// Step CRUD
// ---------------------------------------------------------------------------

/**
 * Add a step to a campaign. Appends at the end (highest step_index + 1).
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @param {object} input - { delay_seconds, payload }
 * @returns {Promise<object>} The created step record
 */
async function addStep(tenantId, campaignId, input) {
  // Verify campaign exists and belongs to tenant
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new ValidationError(
      `Cannot add steps to campaign with status "${campaign.status}". Only draft or paused campaigns can be modified.`
    );
  }

  const data = parseOrThrow(StepInputSchema, input, {
    message: 'Invalid step data',
  });

  // Determine next step_index
  const maxResult = await getDb()(STEPS_TABLE)
    .where({ campaign_id: campaignId })
    .max('step_index as max_index')
    .first();

  const nextIndex = (maxResult && maxResult.max_index != null)
    ? maxResult.max_index + 1
    : 0;

  const stepId = newId();
  const timestamp = nowIso();

  const [step] = await getDb()(STEPS_TABLE)
    .insert({
      id: stepId,
      campaign_id: campaignId,
      step_index: nextIndex,
      delay_seconds: data.delay_seconds,
      payload: JSON.stringify(data.payload),
      created_at: timestamp,
      updated_at: timestamp,
    })
    .returning('*');

  return step;
}

/**
 * Update an existing step.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @param {string} stepId
 * @param {object} input - { delay_seconds?, payload? }
 * @returns {Promise<object>}
 */
async function updateStep(tenantId, campaignId, stepId, input) {
  // Verify campaign exists and belongs to tenant
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new ValidationError(
      `Cannot update steps in campaign with status "${campaign.status}". Only draft or paused campaigns can be modified.`
    );
  }

  // Verify step exists
  const step = await getDb()(STEPS_TABLE)
    .where({ id: stepId, campaign_id: campaignId })
    .first();

  if (!step) {
    throw new NotFoundError('Drip step not found');
  }

  // Validate partial input
  const UpdateStepSchema = z.object({
    delay_seconds: z.number().int().positive('delay_seconds must be a positive integer').optional(),
    payload: StepPayloadSchema.optional(),
  }).refine(
    (data) => data.delay_seconds !== undefined || data.payload !== undefined,
    { message: 'At least one field (delay_seconds or payload) must be provided' }
  );

  const data = parseOrThrow(UpdateStepSchema, input, {
    message: 'Invalid step update data',
  });

  const updatePayload = { updated_at: nowIso() };
  if (data.delay_seconds !== undefined) updatePayload.delay_seconds = data.delay_seconds;
  if (data.payload !== undefined) updatePayload.payload = JSON.stringify(data.payload);

  const [updated] = await getDb()(STEPS_TABLE)
    .where({ id: stepId, campaign_id: campaignId })
    .update(updatePayload)
    .returning('*');

  return updated;
}

/**
 * Remove a step from a campaign and re-index remaining steps.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @param {string} stepId
 * @returns {Promise<void>}
 */
async function removeStep(tenantId, campaignId, stepId) {
  // Verify campaign exists and belongs to tenant
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new ValidationError(
      `Cannot remove steps from campaign with status "${campaign.status}". Only draft or paused campaigns can be modified.`
    );
  }

  const step = await getDb()(STEPS_TABLE)
    .where({ id: stepId, campaign_id: campaignId })
    .first();

  if (!step) {
    throw new NotFoundError('Drip step not found');
  }

  await withTransaction(async (trx) => {
    // Delete the step
    await trx(STEPS_TABLE)
      .where({ id: stepId, campaign_id: campaignId })
      .del();

    // Re-index remaining steps to fill the gap
    await trx.raw(`
      UPDATE ${STEPS_TABLE}
      SET step_index = step_index - 1, updated_at = ?
      WHERE campaign_id = ? AND step_index > ?
    `, [nowIso(), campaignId, step.step_index]);
  });
}

/**
 * List all steps for a campaign, ordered by step_index.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @returns {Promise<object[]>}
 */
async function listSteps(tenantId, campaignId) {
  // Verify campaign exists and belongs to tenant
  await getById(tenantId, campaignId);

  const steps = await getDb()(STEPS_TABLE)
    .where({ campaign_id: campaignId })
    .orderBy('step_index', 'asc');

  return steps;
}

/**
 * Reorder steps within a campaign. Accepts an array of step IDs in the
 * desired order.
 *
 * @param {string} tenantId
 * @param {string} campaignId
 * @param {string[]} stepIds - Array of step IDs in desired order
 * @returns {Promise<object[]>} Updated steps in new order
 */
async function reorderSteps(tenantId, campaignId, stepIds) {
  // Verify campaign exists and belongs to tenant
  const campaign = await getById(tenantId, campaignId);

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new ValidationError(
      `Cannot reorder steps in campaign with status "${campaign.status}". Only draft or paused campaigns can be modified.`
    );
  }

  if (!Array.isArray(stepIds) || stepIds.length === 0) {
    throw new ValidationError('stepIds must be a non-empty array');
  }

  // Verify all step IDs belong to this campaign
  const existingSteps = await getDb()(STEPS_TABLE)
    .where({ campaign_id: campaignId })
    .select('id');

  const existingIds = new Set(existingSteps.map((s) => s.id));

  for (const id of stepIds) {
    if (!existingIds.has(id)) {
      throw new ValidationError(`Step ID "${id}" does not belong to this campaign`);
    }
  }

  if (stepIds.length !== existingSteps.length) {
    throw new ValidationError(
      `stepIds must contain all ${existingSteps.length} steps of the campaign, got ${stepIds.length}`
    );
  }

  const timestamp = nowIso();

  await withTransaction(async (trx) => {
    // Use a temporary negative offset to avoid unique constraint violations
    // during reordering (campaign_id, step_index is unique)
    for (let i = 0; i < stepIds.length; i++) {
      await trx(STEPS_TABLE)
        .where({ id: stepIds[i], campaign_id: campaignId })
        .update({ step_index: -(i + 1), updated_at: timestamp });
    }
    // Now flip to positive
    for (let i = 0; i < stepIds.length; i++) {
      await trx(STEPS_TABLE)
        .where({ id: stepIds[i], campaign_id: campaignId })
        .update({ step_index: i });
    }
  });

  return listSteps(tenantId, campaignId);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Campaign CRUD
  create,
  list,
  getById,
  update,
  remove,
  // Campaign lifecycle
  activate,
  pause,
  resume,
  archive,
  // Step CRUD
  addStep,
  updateStep,
  removeStep,
  listSteps,
  reorderSteps,
};
