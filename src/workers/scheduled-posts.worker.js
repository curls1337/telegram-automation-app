'use strict';

/**
 * Scheduled Posts Worker — BullMQ consumer for the scheduled-posts queue.
 *
 * Processes scheduled post jobs:
 *   1. Load the scheduled_post record from DB.
 *   2. Skip if status != 'scheduled' (already cancelled/executed).
 *   3. Update status to 'running'.
 *   4. Load connection, decrypt token.
 *   5. Get runtime client from registry (or create temporary one).
 *   6. Resolve media: for each media_id, try cached file_id; if null, download from Object Storage.
 *   7. Send message via Telegram API.
 *   8. On success: update status='success', cache file_ids.
 *   9. On failure: classify error and handle accordingly.
 *
 * References:
 *   - requirements.md §6.2 — send message and record result.
 *   - requirements.md §6.4 — 429 retry with backoff.
 *   - requirements.md §6.5 — chat-not-found → failed, no retry.
 *   - requirements.md §6.6 — media via Object Storage or cached file_id.
 *   - requirements.md §17.4, §17.5 — media upload and file_id caching.
 *   - design.md "Scheduler" — worker process flow.
 */

const { Worker } = require('bullmq');
const Redis = require('ioredis');

const { QUEUE_NAMES } = require('../infra/queues');
const { buildRedisOptions } = require('../infra/redis');
const { getDb } = require('../infra/db');
const { decryptFromColumns } = require('../infra/crypto');
const { getObject } = require('../infra/object-storage');
const { getLogger } = require('../infra/logger');
const { getEnv } = require('../shared/env');
const { nowIso } = require('../shared/time');
const runtimeRegistry = require('../modules/connections/runtime-registry');
const { resolveTelegramFileId, cacheTelegramFileId } = require('../modules/media/media-service');
const { classifyTelegramError } = require('../modules/scheduler/retry-handler');
const { handleRepeat } = require('../modules/scheduler/repeat-handler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'scheduled_posts';
const CONNECTIONS_TABLE = 'telegram_connections';
const MEDIA_TABLE = 'media_files';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a scheduled post by ID.
 *
 * @param {string} postId
 * @returns {Promise<object|null>}
 */
async function loadPost(postId) {
  const db = getDb();
  return db(TABLE).where({ id: postId }).first();
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
 * Update a post's status and optional fields.
 *
 * @param {string} postId
 * @param {object} fields
 * @returns {Promise<void>}
 */
async function updatePost(postId, fields) {
  const db = getDb();
  await db(TABLE)
    .where({ id: postId })
    .update({ ...fields, updated_at: nowIso() });
}

/**
 * Send a message via a bot connection using Telegraf.
 *
 * @param {object} bot - Telegraf bot instance or temporary bot.
 * @param {string} targetChat - Chat ID or username.
 * @param {object} payload - Message payload.
 * @param {string} connectionId - Connection ID for file_id caching.
 * @returns {Promise<object>} Sent message result.
 */
async function sendViaBot(bot, targetChat, payload, connectionId) {
  const log = getLogger();
  const telegram = bot.telegram || bot;

  // Resolve media if present
  if (payload.media_ids && payload.media_ids.length > 0) {
    // Single media — send as photo/document/video/audio
    if (payload.media_ids.length === 1) {
      const mediaId = payload.media_ids[0];
      const source = await resolveMediaSource(mediaId, connectionId);

      if (source.type === 'image') {
        const result = await telegram.sendPhoto(targetChat, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        // Cache file_id if we uploaded fresh
        if (source.fresh && result.photo && result.photo.length > 0) {
          const fileId = result.photo[result.photo.length - 1].file_id;
          await cacheTelegramFileId(mediaId, connectionId, fileId);
        }
        return result;
      } else if (source.type === 'video') {
        const result = await telegram.sendVideo(targetChat, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        if (source.fresh && result.video) {
          await cacheTelegramFileId(mediaId, connectionId, result.video.file_id);
        }
        return result;
      } else if (source.type === 'audio') {
        const result = await telegram.sendAudio(targetChat, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        if (source.fresh && result.audio) {
          await cacheTelegramFileId(mediaId, connectionId, result.audio.file_id);
        }
        return result;
      } else {
        const result = await telegram.sendDocument(targetChat, source.input, {
          caption: payload.text || undefined,
          parse_mode: payload.parse_mode || undefined,
        });
        if (source.fresh && result.document) {
          await cacheTelegramFileId(mediaId, connectionId, result.document.file_id);
        }
        return result;
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
    return telegram.sendMediaGroup(targetChat, mediaGroup);
  }

  // Text-only message
  return telegram.sendMessage(targetChat, payload.text, {
    parse_mode: payload.parse_mode || undefined,
  });
}

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
    // Determine type from media record
    const media = await db(MEDIA_TABLE).where({ id: mediaId }).first();
    const type = media ? media.kind : 'document';
    return { input: cachedFileId, type, fresh: false };
  }

  // Download from Object Storage
  const media = await db(MEDIA_TABLE).where({ id: mediaId }).first();
  if (!media) {
    log.warn({ mediaId }, 'scheduled-posts-worker: media file not found');
    throw new Error(`Media file ${mediaId} not found`);
  }

  const { body } = await getObject(media.object_key);

  // Collect stream into buffer for Telegraf
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

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Process a scheduled post job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processJob(job) {
  const log = getLogger();
  const { postId } = job.data;

  log.info({ postId, jobId: job.id }, 'scheduled-posts-worker: processing job');

  // 1. Load post
  const post = await loadPost(postId);
  if (!post) {
    log.warn({ postId }, 'scheduled-posts-worker: post not found, skipping');
    return;
  }

  // 2. Skip if not in 'scheduled' status
  if (post.status !== 'scheduled') {
    log.info(
      { postId, status: post.status },
      'scheduled-posts-worker: post not in scheduled status, skipping'
    );
    return;
  }

  // 3. Update status to 'running'
  await updatePost(postId, { status: 'running' });

  // 4. Load connection
  const connection = await loadConnection(post.connection_id);
  if (!connection) {
    await updatePost(postId, {
      status: 'failed',
      last_error: 'Connection not found',
      attempts: post.attempts + 1,
    });
    log.error({ postId, connectionId: post.connection_id }, 'scheduled-posts-worker: connection not found');
    return;
  }

  if (connection.status !== 'active') {
    await updatePost(postId, {
      status: 'failed',
      last_error: `Connection is ${connection.status}`,
      attempts: post.attempts + 1,
    });
    log.warn({ postId, connectionId: connection.id, connStatus: connection.status }, 'scheduled-posts-worker: connection not active');
    return;
  }

  // 5. Get or create client
  let client = runtimeRegistry.get(post.connection_id);
  let tempBot = null;

  if (!client && connection.kind === 'bot') {
    // Create a temporary Telegraf instance for sending
    const { Telegraf } = require('telegraf');
    const token = decryptToken(connection);
    tempBot = new Telegraf(token);
    client = tempBot;
  }

  if (!client) {
    await updatePost(postId, {
      status: 'failed',
      last_error: 'No runtime client available for this connection',
      attempts: post.attempts + 1,
    });
    log.error({ postId, connectionId: connection.id }, 'scheduled-posts-worker: no client available');
    return;
  }

  // 6. Parse payload
  const payload = typeof post.payload === 'string' ? JSON.parse(post.payload) : post.payload;

  // 7. Send message
  try {
    await sendViaBot(client, post.target_chat, payload, post.connection_id);

    // 8. Success
    await updatePost(postId, {
      status: 'success',
      attempts: post.attempts + 1,
    });

    log.info({ postId, targetChat: post.target_chat }, 'scheduled-posts-worker: message sent successfully');

    // Handle repeat scheduling
    const repeat = typeof post.repeat === 'string' ? JSON.parse(post.repeat) : post.repeat;
    if (repeat) {
      await handleRepeat(post);
    }
  } catch (err) {
    // 9. Classify error and handle
    const errMsg = err && err.message ? err.message : String(err);
    const errCode = (err && err.response && err.response.error_code) || null;
    const retryAfter = (err && err.response && err.response.parameters && err.response.parameters.retry_after) || null;

    log.warn(
      { postId, errMsg, errCode, retryAfter },
      'scheduled-posts-worker: send failed'
    );

    const classification = classifyTelegramError(err);

    if (classification.retry) {
      // Throw to let BullMQ retry with the configured backoff
      await updatePost(postId, {
        status: 'scheduled',
        last_error: errMsg,
        attempts: post.attempts + 1,
      });

      // For 429, use the retry_after delay
      if (classification.delay) {
        const error = new Error(`Telegram error (retryable): ${errMsg}`);
        error.retryDelay = classification.delay;
        throw error;
      }

      throw new Error(`Telegram error (retryable): ${errMsg}`);
    } else {
      // Permanent failure — no retry
      await updatePost(postId, {
        status: 'failed',
        last_error: errMsg,
        attempts: post.attempts + 1,
      });

      log.info(
        { postId, reason: classification.reason },
        'scheduled-posts-worker: permanent failure, no retry'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/** @type {import('bullmq').Worker|null} */
let worker = null;

/**
 * Start the scheduled posts worker.
 *
 * @returns {import('bullmq').Worker}
 */
function start() {
  const log = getLogger();
  const env = getEnv();

  const connection = new Redis(env.REDIS_URL, buildRedisOptions('worker:scheduled-posts'));

  worker = new Worker(
    QUEUE_NAMES.SCHEDULED_POSTS,
    processJob,
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id }, 'scheduled-posts-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job ? job.id : 'unknown', err: err && err.message },
      'scheduled-posts-worker: job failed'
    );
  });

  worker.on('error', (err) => {
    log.error({ err }, 'scheduled-posts-worker: worker error');
  });

  log.info('scheduled-posts-worker: started');

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
  processJob,
  // Exported for testing
  loadPost,
  loadConnection,
  decryptToken,
  sendViaBot,
  resolveMediaSource,
};
