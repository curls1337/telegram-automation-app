'use strict';

/**
 * Drip Steps Worker — BullMQ consumer for the drip-steps queue.
 *
 * Processes drip campaign step jobs:
 *   1. Load enrollment record and verify idempotency (current_step > stepIndex → skip).
 *   2. Check enrollment status is 'running'; skip otherwise.
 *   3. Load campaign and verify status (active → proceed, paused → pause enrollment, archived/draft → exit enrollment).
 *   4. Load the step by campaign_id + step_index.
 *   5. Load subscriber to get telegram_user_id.
 *   6. Load connection and get runtime client.
 *   7. Send the step message via Telegram.
 *   8. On success: check for next step; if exists, update enrollment and enqueue next step; if not, mark completed.
 *   9. On Telegram error: classify and handle (retryable → throw for BullMQ retry, permanent → log).
 *
 * References:
 *   - requirements.md §11.3 — step execution, enqueue next step, mark completed.
 *   - design.md "Drip Engine" — enrollment state, pause/resume, exit conditions.
 */

const { Worker } = require('bullmq');
const Redis = require('ioredis');

const { QUEUE_NAMES, getQueue } = require('../infra/queues');
const { buildRedisOptions } = require('../infra/redis');
const { getDb } = require('../infra/db');
const { decryptFromColumns } = require('../infra/crypto');
const { getObject } = require('../infra/object-storage');
const { getLogger } = require('../infra/logger');
const { getEnv } = require('../shared/env');
const { nowIso, now, addSeconds } = require('../shared/time');
const runtimeRegistry = require('../modules/connections/runtime-registry');
const { resolveTelegramFileId, cacheTelegramFileId } = require('../modules/media/media-service');
const { classifyTelegramError } = require('../modules/scheduler/retry-handler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENROLLMENTS_TABLE = 'drip_enrollments';
const CAMPAIGNS_TABLE = 'drip_campaigns';
const STEPS_TABLE = 'drip_steps';
const SUBSCRIBERS_TABLE = 'subscribers';
const CONNECTIONS_TABLE = 'telegram_connections';
const MEDIA_TABLE = 'media_files';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load an enrollment record by ID.
 *
 * @param {string} enrollmentId
 * @returns {Promise<object|null>}
 */
async function loadEnrollment(enrollmentId) {
  const db = getDb();
  return db(ENROLLMENTS_TABLE).where({ id: enrollmentId }).first();
}

/**
 * Load a campaign by ID.
 *
 * @param {string} campaignId
 * @returns {Promise<object|null>}
 */
async function loadCampaign(campaignId) {
  const db = getDb();
  return db(CAMPAIGNS_TABLE).where({ id: campaignId }).first();
}

/**
 * Load a step by campaign_id and step_index.
 *
 * @param {string} campaignId
 * @param {number} stepIndex
 * @returns {Promise<object|null>}
 */
async function loadStep(campaignId, stepIndex) {
  const db = getDb();
  return db(STEPS_TABLE).where({ campaign_id: campaignId, step_index: stepIndex }).first();
}

/**
 * Load a subscriber by ID.
 *
 * @param {string} subscriberId
 * @returns {Promise<object|null>}
 */
async function loadSubscriber(subscriberId) {
  const db = getDb();
  return db(SUBSCRIBERS_TABLE).where({ id: subscriberId }).first();
}

/**
 * Load a connection by ID.
 *
 * @param {string} connectionId
 * @returns {Promise<object|null>}
 */
async function loadConnection(connectionId) {
  const db = getDb();
  return db(CONNECTIONS_TABLE).where({ id: connectionId }).first();
}

/**
 * Update an enrollment record.
 *
 * @param {string} enrollmentId
 * @param {object} fields
 * @returns {Promise<void>}
 */
async function updateEnrollment(enrollmentId, fields) {
  const db = getDb();
  await db(ENROLLMENTS_TABLE)
    .where({ id: enrollmentId })
    .update({ ...fields, updated_at: nowIso() });
}

// ---------------------------------------------------------------------------
// Blocked subscriber detection
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the subscriber blocked the bot or is deactivated.
 * These are substrings matched against the error message/description.
 */
const BLOCKED_ERROR_PATTERNS = [
  'bot was blocked by the user',
  'user is deactivated',
  'user_deactivated',
  'bot was blocked',
];

/**
 * Determine if a Telegram error indicates the subscriber blocked the bot.
 *
 * Checks for:
 *   - 403 Forbidden with "bot was blocked by the user"
 *   - "user is deactivated" / "user_deactivated"
 *
 * @param {Error|object} error
 * @returns {boolean}
 */
function isBlockedError(error) {
  if (!error) return false;

  // Extract error code
  const errorCode = error.response && typeof error.response.error_code === 'number'
    ? error.response.error_code
    : (typeof error.code === 'number' ? error.code : null);

  // Extract description
  const description = (
    (error.response && error.response.description) ||
    error.errorMessage ||
    error.message ||
    String(error)
  ).toLowerCase();

  // 403 with blocked patterns
  if (errorCode === 403) {
    for (const pattern of BLOCKED_ERROR_PATTERNS) {
      if (description.includes(pattern)) return true;
    }
  }

  // Check patterns regardless of code (user deactivated can come as different codes)
  for (const pattern of BLOCKED_ERROR_PATTERNS) {
    if (description.includes(pattern)) return true;
  }

  return false;
}

/**
 * Handle a blocked subscriber: set enrollment status to 'stopped_blocked'
 * and log the event. Does NOT retry.
 *
 * @param {string} enrollmentId
 * @param {string} subscriberId
 * @param {string} reason - The error message/reason
 * @returns {Promise<void>}
 */
async function handleBlockedSubscriber(enrollmentId, subscriberId, reason) {
  const log = getLogger();

  await updateEnrollment(enrollmentId, {
    status: 'stopped_blocked',
    next_run_at: null,
  });

  log.info(
    { enrollmentId, subscriberId, reason },
    'drip-steps-worker: subscriber blocked bot — enrollment stopped'
  );
}

/**
 * Decrypt the token/session from a connection record.
 *
 * @param {object} connection
 * @returns {string}
 */
function decryptToken(connection) {
  return decryptFromColumns({
    encrypted_secret: connection.encrypted_secret,
    secret_iv: connection.secret_iv,
    secret_tag: connection.secret_tag,
    secret_key_id: connection.secret_key_id,
  }).toString('utf8');
}

/**
 * Get the runtime client for a connection. Falls back to creating a
 * temporary Telegraf instance for bot connections.
 *
 * @param {object} connection
 * @returns {object|null}
 */
function getRuntimeClient(connection) {
  // Try the runtime registry first
  let client = runtimeRegistry.get(connection.id);
  if (client) return client;

  // For bot connections, create a temporary Telegraf instance
  if (connection.kind === 'bot') {
    const { Telegraf } = require('telegraf');
    const token = decryptToken(connection);
    return new Telegraf(token);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Message sending
// ---------------------------------------------------------------------------

/**
 * Resolve media source: try cached file_id first, then download from Object Storage.
 *
 * @param {string} mediaId
 * @param {string} connectionId
 * @returns {Promise<{ input: any, type: string, fresh: boolean }>}
 */
async function resolveMediaSource(mediaId, connectionId) {
  const log = getLogger();
  const db = getDb();

  // Try cached file_id
  const cachedFileId = await resolveTelegramFileId(mediaId, connectionId);
  if (cachedFileId) {
    const media = await db(MEDIA_TABLE).where({ id: mediaId }).first();
    const type = media ? media.kind : 'document';
    return { input: cachedFileId, type, fresh: false };
  }

  // Download from Object Storage
  const media = await db(MEDIA_TABLE).where({ id: mediaId }).first();
  if (!media) {
    log.warn({ mediaId }, 'drip-steps-worker: media file not found');
    throw new Error(`Media file ${mediaId} not found`);
  }

  const { body } = await getObject(media.object_key);

  // Collect stream into buffer
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  const type = media.kind || 'document';
  return {
    input: { source: buffer, filename: media.original_name || `file.${type}` },
    type,
    fresh: true,
  };
}

/**
 * Send a drip step message to a subscriber via Telegram.
 *
 * Handles text-only, single media, and multi-media payloads.
 *
 * @param {object} client - Telegraf bot instance or GramJS client
 * @param {string} subscriberTelegramId - Subscriber's Telegram user ID
 * @param {object} payload - Step payload ({ text?, media_ids?, parse_mode? })
 * @param {string} connectionId - Connection ID for file_id caching
 * @returns {Promise<void>}
 */
async function sendStepMessage(client, subscriberTelegramId, payload, connectionId) {
  const telegram = client.telegram || client;

  // Handle media payloads
  if (payload.media_ids && payload.media_ids.length > 0) {
    if (payload.media_ids.length === 1) {
      // Single media
      const mediaId = payload.media_ids[0];
      const source = await resolveMediaSource(mediaId, connectionId);

      if (source.type === 'image') {
        const result = await telegram.sendPhoto(subscriberTelegramId, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        if (source.fresh && result.photo && result.photo.length > 0) {
          const fileId = result.photo[result.photo.length - 1].file_id;
          await cacheTelegramFileId(mediaId, connectionId, fileId);
        }
        return;
      } else if (source.type === 'video') {
        const result = await telegram.sendVideo(subscriberTelegramId, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        if (source.fresh && result.video) {
          await cacheTelegramFileId(mediaId, connectionId, result.video.file_id);
        }
        return;
      } else if (source.type === 'audio') {
        const result = await telegram.sendAudio(subscriberTelegramId, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        if (source.fresh && result.audio) {
          await cacheTelegramFileId(mediaId, connectionId, result.audio.file_id);
        }
        return;
      } else {
        const result = await telegram.sendDocument(subscriberTelegramId, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        if (source.fresh && result.document) {
          await cacheTelegramFileId(mediaId, connectionId, result.document.file_id);
        }
        return;
      }
    }

    // Multiple media — send as media group
    const mediaGroup = [];
    for (const mediaId of payload.media_ids) {
      const source = await resolveMediaSource(mediaId, connectionId);
      mediaGroup.push({
        type: source.type === 'image' ? 'photo' : source.type === 'video' ? 'video' : 'document',
        media: source.input,
        caption: mediaGroup.length === 0 ? (payload.text || undefined) : undefined,
        parse_mode: mediaGroup.length === 0 ? (payload.parse_mode || undefined) : undefined,
      });
    }
    await telegram.sendMediaGroup(subscriberTelegramId, mediaGroup);
    return;
  }

  // Text-only message
  await telegram.sendMessage(subscriberTelegramId, payload.text, {
    parse_mode: payload.parse_mode || undefined,
  });
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Process a drip step job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processStep(job) {
  const log = getLogger();
  const { enrollmentId, campaignId, subscriberId, stepIndex } = job.data;

  log.info(
    { enrollmentId, campaignId, subscriberId, stepIndex, jobId: job.id },
    'drip-steps-worker: processing step'
  );

  // 1. Load enrollment and check idempotency
  const enrollment = await loadEnrollment(enrollmentId);
  if (!enrollment) {
    log.warn({ enrollmentId }, 'drip-steps-worker: enrollment not found, skipping');
    return;
  }

  // Idempotency: if current_step > stepIndex, step was already executed
  if (enrollment.current_step > stepIndex) {
    log.info(
      { enrollmentId, currentStep: enrollment.current_step, stepIndex },
      'drip-steps-worker: step already executed (idempotency), skipping'
    );
    return;
  }

  // 2. Check enrollment status
  if (enrollment.status !== 'running') {
    log.info(
      { enrollmentId, status: enrollment.status },
      'drip-steps-worker: enrollment not running, skipping'
    );
    return;
  }

  // 3. Load campaign and check status
  const campaign = await loadCampaign(campaignId);
  if (!campaign) {
    log.warn({ campaignId }, 'drip-steps-worker: campaign not found, skipping');
    return;
  }

  if (campaign.status === 'paused') {
    // Campaign paused — pause the enrollment
    await updateEnrollment(enrollmentId, { status: 'paused' });
    log.info(
      { enrollmentId, campaignId },
      'drip-steps-worker: campaign paused, enrollment paused'
    );
    return;
  }

  if (campaign.status !== 'active') {
    // Campaign is archived or draft — exit the enrollment
    await updateEnrollment(enrollmentId, { status: 'exited' });
    log.info(
      { enrollmentId, campaignId, campaignStatus: campaign.status },
      'drip-steps-worker: campaign not active, enrollment exited'
    );
    return;
  }

  // 4. Load the step
  const step = await loadStep(campaignId, stepIndex);
  if (!step) {
    log.warn(
      { campaignId, stepIndex },
      'drip-steps-worker: step not found, skipping'
    );
    return;
  }

  // 5. Load subscriber
  const subscriber = await loadSubscriber(subscriberId);
  if (!subscriber) {
    log.warn({ subscriberId }, 'drip-steps-worker: subscriber not found, skipping');
    return;
  }

  // 6. Load connection and get client
  const connection = await loadConnection(campaign.connection_id);
  if (!connection) {
    log.error(
      { connectionId: campaign.connection_id, campaignId },
      'drip-steps-worker: connection not found'
    );
    return;
  }

  if (connection.status !== 'active') {
    log.warn(
      { connectionId: connection.id, connStatus: connection.status },
      'drip-steps-worker: connection not active, skipping'
    );
    return;
  }

  const client = getRuntimeClient(connection);
  if (!client) {
    log.error(
      { connectionId: connection.id },
      'drip-steps-worker: no runtime client available'
    );
    return;
  }

  // 7. Send the message
  const payload = typeof step.payload === 'string' ? JSON.parse(step.payload) : step.payload;

  try {
    await sendStepMessage(client, subscriber.telegram_user_id.toString(), payload, connection.id);

    log.info(
      { enrollmentId, campaignId, stepIndex, subscriberId },
      'drip-steps-worker: step message sent successfully'
    );

    // 8. Check for next step
    const nextStepIndex = stepIndex + 1;
    const nextStep = await loadStep(campaignId, nextStepIndex);

    if (nextStep) {
      // There is a next step — update enrollment and enqueue
      const timestamp = now();
      const nextRunAt = addSeconds(timestamp, nextStep.delay_seconds);

      await updateEnrollment(enrollmentId, {
        current_step: nextStepIndex,
        next_run_at: nextRunAt.toISOString(),
        status: 'running',
      });

      // Enqueue next step job
      const queue = getQueue(QUEUE_NAMES.DRIP_STEPS);
      const jobId = `drip:${enrollmentId}:${nextStepIndex}`;

      await queue.add('step', {
        enrollmentId,
        campaignId,
        subscriberId,
        stepIndex: nextStepIndex,
      }, {
        jobId,
        delay: nextStep.delay_seconds * 1000,
      });

      log.info(
        { enrollmentId, nextStepIndex, delaySeconds: nextStep.delay_seconds },
        'drip-steps-worker: next step enqueued'
      );
    } else {
      // No more steps — campaign completed for this subscriber
      await updateEnrollment(enrollmentId, {
        status: 'completed',
        next_run_at: null,
      });

      log.info(
        { enrollmentId, campaignId, subscriberId },
        'drip-steps-worker: enrollment completed — all steps executed'
      );
    }
  } catch (err) {
    // 9. Handle Telegram error
    const errMsg = err && err.message ? err.message : String(err);
    const classification = classifyTelegramError(err);

    log.warn(
      { enrollmentId, campaignId, stepIndex, errMsg, retry: classification.retry },
      'drip-steps-worker: step send failed'
    );

    // Check if subscriber blocked the bot (403 Forbidden patterns)
    if (isBlockedError(err)) {
      await handleBlockedSubscriber(enrollmentId, subscriberId, errMsg);
      return; // Do NOT retry
    }

    if (classification.retry) {
      // Retryable error — throw to let BullMQ retry with configured backoff
      const error = new Error(`Telegram error (retryable): ${errMsg}`);
      if (classification.delay) {
        error.retryDelay = classification.delay;
      }
      throw error;
    }

    // Permanent failure — do not retry
    log.info(
      { enrollmentId, reason: classification.reason },
      'drip-steps-worker: permanent failure for step'
    );
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/** @type {import('bullmq').Worker|null} */
let worker = null;

/**
 * Start the drip steps worker.
 *
 * @returns {import('bullmq').Worker}
 */
function start() {
  const log = getLogger();
  const env = getEnv();

  const connection = new Redis(env.REDIS_URL, buildRedisOptions('worker:drip-steps'));

  worker = new Worker(
    QUEUE_NAMES.DRIP_STEPS,
    processStep,
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id }, 'drip-steps-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job ? job.id : 'unknown', err: err && err.message },
      'drip-steps-worker: job failed'
    );
  });

  worker.on('error', (err) => {
    log.error({ err }, 'drip-steps-worker: worker error');
  });

  log.info('drip-steps-worker: started');

  return worker;
}

/**
 * Stop the worker gracefully.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  processStep,
  // Exported for testing
  loadEnrollment,
  loadCampaign,
  loadStep,
  loadSubscriber,
  loadConnection,
  updateEnrollment,
  getRuntimeClient,
  sendStepMessage,
  resolveMediaSource,
  isBlockedError,
  handleBlockedSubscriber,
};
