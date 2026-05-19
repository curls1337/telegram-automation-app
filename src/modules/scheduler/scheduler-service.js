'use strict';

/**
 * Scheduler Service — schedule, cancel, and create scheduled posts.
 *
 * Responsibilities:
 *   - Schedule a post by adding a delayed job to BullMQ.
 *   - Cancel a scheduled post by removing the job and updating status.
 *   - Create a new scheduled post (validate, persist, schedule).
 *
 * References:
 *   - requirements.md §6.1 — schedule post with delay.
 *   - requirements.md §6.7 — cancel removes job and marks cancelled.
 *   - design.md "Scheduler" — scheduleScheduledPost, cancelScheduledPost.
 */

const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { getDb, tenantQuery, tenantInsert } = require('../../infra/db');
const { ValidationError } = require('../../shared/errors');
const { newId } = require('../../shared/ids');
const { nowIso } = require('../../shared/time');
const { getLogger } = require('../../infra/logger');
const { z, parseOrThrow } = require('../../shared/validation');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'scheduled_posts';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreatePostSchema = z.object({
  targetChat: z.string().trim().min(1, 'Target chat is required'),
  payload: z.object({
    text: z.string().optional(),
    media_ids: z.array(z.string()).optional(),
    parse_mode: z.string().optional(),
    buttons: z.any().optional(),
  }).refine(
    (p) => (p.text && p.text.trim().length > 0) || (p.media_ids && p.media_ids.length > 0),
    { message: 'Message text or media is required' }
  ),
  runAt: z.string().datetime({ offset: true, message: 'runAt must be a valid ISO-8601 datetime' }),
  repeat: z.object({
    type: z.enum(['daily', 'weekly', 'monthly', 'cron']),
    value: z.string().optional(),
  }).nullable().optional(),
  connectionId: z.string().uuid('Connection ID must be a valid UUID'),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Schedule a post by adding a delayed job to the scheduled-posts queue.
 *
 * @param {object} post - The scheduled post record.
 * @param {string} post.id - Post ID.
 * @param {string} post.tenant_id - Tenant ID.
 * @param {string} post.connection_id - Connection ID.
 * @param {string} post.target_chat - Target chat identifier.
 * @param {object} post.payload - Message payload (text, media_ids, etc.).
 * @param {string|Date} post.run_at - When to execute.
 * @param {object|null} post.repeat - Repeat configuration.
 * @returns {Promise<string>} The BullMQ job ID.
 */
async function scheduleScheduledPost(post) {
  const log = getLogger();
  const queue = getQueue(QUEUE_NAMES.SCHEDULED_POSTS);

  const runAtMs = new Date(post.run_at).getTime();
  const delay = Math.max(0, runAtMs - Date.now());
  const jobId = `post:${post.id}`;

  await queue.add('send-post', { postId: post.id }, {
    jobId,
    delay,
  });

  // Update the bullmq_job_id in the database
  const db = getDb();
  await db(TABLE)
    .where({ id: post.id })
    .update({ bullmq_job_id: jobId, updated_at: nowIso() });

  log.info(
    { postId: post.id, jobId, delay, runAt: post.run_at },
    'scheduler: post scheduled'
  );

  return jobId;
}

/**
 * Cancel a scheduled post: remove the job from BullMQ and update status.
 *
 * @param {string} postId - The scheduled post ID.
 * @param {string} tenantId - Tenant ID for ownership verification.
 * @returns {Promise<void>}
 */
async function cancelScheduledPost(postId, tenantId) {
  const log = getLogger();
  const queue = getQueue(QUEUE_NAMES.SCHEDULED_POSTS);
  const jobId = `post:${postId}`;

  // Remove the job from the queue (may already be gone if executed)
  try {
    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove();
    }
  } catch (err) {
    // Job may not exist or already completed — that's fine
    log.debug({ err, postId, jobId }, 'scheduler: job removal skipped (may not exist)');
  }

  // Update status in database
  const updated = await tenantQuery(tenantId, TABLE)
    .where({ id: postId })
    .whereIn('status', ['scheduled', 'running'])
    .update({ status: 'cancelled', updated_at: nowIso() });

  if (updated === 0) {
    log.warn({ postId, tenantId }, 'scheduler: no post found to cancel (already executed or wrong tenant)');
  }

  log.info({ postId, tenantId }, 'scheduler: post cancelled');
}

/**
 * Create a new scheduled post: validate input, persist to DB, schedule job.
 *
 * @param {string} tenantId - Tenant ID.
 * @param {object} input - Raw input from the user.
 * @param {string} input.targetChat - Target chat ID or username.
 * @param {object} input.payload - Message payload.
 * @param {string} input.runAt - ISO-8601 datetime for execution.
 * @param {object|null} [input.repeat] - Repeat configuration.
 * @param {string} input.connectionId - Telegram connection ID.
 * @returns {Promise<object>} The created scheduled_posts record.
 */
async function createScheduledPost(tenantId, input) {
  const log = getLogger();

  // Validate input
  const validated = parseOrThrow(CreatePostSchema, input, {
    message: 'Invalid scheduled post data',
  });

  // Validate runAt is in the future
  const runAtDate = new Date(validated.runAt);
  if (runAtDate.getTime() <= Date.now()) {
    throw new ValidationError('Schedule time must be in the future', {
      details: [{ path: 'runAt', message: 'Schedule time must be in the future' }],
    });
  }

  // Verify connection belongs to tenant
  const connection = await tenantQuery(tenantId, 'telegram_connections')
    .where({ id: validated.connectionId })
    .first();

  if (!connection) {
    throw new ValidationError('Connection not found or does not belong to this tenant', {
      details: [{ path: 'connectionId', message: 'Connection not found' }],
    });
  }

  // Create the post record
  const postId = newId();
  const now = nowIso();

  const record = {
    id: postId,
    connection_id: validated.connectionId,
    target_chat: validated.targetChat,
    payload: JSON.stringify(validated.payload),
    run_at: validated.runAt,
    repeat: validated.repeat ? JSON.stringify(validated.repeat) : null,
    status: 'scheduled',
    last_error: null,
    attempts: 0,
    bullmq_job_id: null,
    created_at: now,
    updated_at: now,
  };

  const [inserted] = await tenantInsert(tenantId, TABLE, record, {
    returning: '*',
  });

  // Schedule the job
  await scheduleScheduledPost(inserted);

  log.info(
    { postId, tenantId, connectionId: validated.connectionId, runAt: validated.runAt },
    'scheduler: post created and scheduled'
  );

  return inserted;
}

/**
 * List scheduled posts for a tenant.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=25]
 * @param {string} [opts.status] - Filter by status.
 * @returns {Promise<{ data: object[], total: number, page: number, pageSize: number }>}
 */
async function list(tenantId, opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(opts.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;

  let query = tenantQuery(tenantId, TABLE);
  let countQuery = tenantQuery(tenantId, TABLE);

  if (opts.status) {
    query = query.where({ status: opts.status });
    countQuery = countQuery.where({ status: opts.status });
  }

  const [{ count }] = await countQuery.count('* as count');
  const data = await query
    .orderBy('run_at', 'desc')
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
 * Get a single scheduled post by ID for a tenant.
 *
 * @param {string} tenantId
 * @param {string} postId
 * @returns {Promise<object|null>}
 */
async function getById(tenantId, postId) {
  return tenantQuery(tenantId, TABLE)
    .where({ id: postId })
    .first() || null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  scheduleScheduledPost,
  cancelScheduledPost,
  createScheduledPost,
  list,
  getById,
  // Exported for testing
  CreatePostSchema,
};
