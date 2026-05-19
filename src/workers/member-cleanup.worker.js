'use strict';

/**
 * Member Cleanup Worker — BullMQ consumer for the member-cleanup queue.
 *
 * Processes job types:
 *   - kick-inactive: receives { tenantId, ruleId, connectionId, thresholdDays }
 *     Query subscribers where last_active_at < now - thresholdDays for this
 *     tenant+connection, then kick each inactive subscriber from the group.
 *
 * Cron trigger: daily at 02:00 UTC, scans all tenants with active
 * auto_kick_inactive rules and enqueues one job per rule.
 *
 * References:
 *   - requirements.md §10.5 — auto-kick inactive
 *   - design.md "Member Management" — cron daily → enqueue member-cleanup per tenant
 */

const { Worker } = require('bullmq');
const Redis = require('ioredis');

const { QUEUE_NAMES, getQueue } = require('../infra/queues');
const { buildRedisOptions } = require('../infra/redis');
const { getDb } = require('../infra/db');
const { decryptFromColumns } = require('../infra/crypto');
const { getLogger } = require('../infra/logger');
const { getEnv } = require('../shared/env');
const runtimeRegistry = require('../modules/connections/runtime-registry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMBER_RULES_TABLE = 'member_rules';
const SUBSCRIBERS_TABLE = 'subscribers';
const CONNECTIONS_TABLE = 'telegram_connections';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSONB field (handles both string and object).
 *
 * @param {string|object|null} value
 * @returns {object|null}
 */
function parseJsonb(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
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

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Process a member-cleanup job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<object>} Result with kick counts
 */
async function processJob(job) {
  const log = getLogger();
  const { tenantId, ruleId, connectionId, thresholdDays } = job.data;

  log.info(
    { ruleId, tenantId, connectionId, thresholdDays, jobName: job.name, jobId: job.id },
    'member-cleanup-worker: processing job'
  );

  if (job.name === 'kick-inactive') {
    return processKickInactive({ tenantId, ruleId, connectionId, thresholdDays });
  }

  log.warn({ jobName: job.name }, 'member-cleanup-worker: unknown job type');
  return { status: 'skipped', reason: 'unknown_job_type' };
}

/**
 * Process kick-inactive job: find inactive subscribers and kick them.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.ruleId
 * @param {string} params.connectionId
 * @param {number} params.thresholdDays
 * @returns {Promise<object>}
 */
async function processKickInactive({ tenantId, ruleId, connectionId, thresholdDays }) {
  const log = getLogger();
  const db = getDb();

  // Verify rule still exists and is active
  const rule = await db(MEMBER_RULES_TABLE)
    .where({ id: ruleId, tenant_id: tenantId, is_active: true })
    .first();

  if (!rule) {
    log.info({ ruleId, tenantId }, 'member-cleanup-worker: rule not found or inactive, skipping');
    return { status: 'skipped', reason: 'rule_not_found_or_inactive' };
  }

  const config = parseJsonb(rule.config);
  const isDryRun = config && config.dry_run === true;

  // Calculate the cutoff date
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - thresholdDays);

  // Query inactive subscribers for this tenant + connection
  const inactiveSubscribers = await db(SUBSCRIBERS_TABLE)
    .where('tenant_id', tenantId)
    .where('connection_id', connectionId)
    .where('last_active_at', '<', cutoffDate.toISOString())
    .select('id', 'telegram_user_id', 'chat_id', 'last_active_at');

  if (inactiveSubscribers.length === 0) {
    log.info(
      { ruleId, tenantId, connectionId, thresholdDays },
      'member-cleanup-worker: no inactive subscribers found'
    );
    return { status: 'completed', kicked: 0, total: 0, dryRun: isDryRun };
  }

  log.info(
    { ruleId, tenantId, count: inactiveSubscribers.length, dryRun: isDryRun },
    'member-cleanup-worker: found inactive subscribers'
  );

  if (isDryRun) {
    log.info(
      { ruleId, tenantId, count: inactiveSubscribers.length },
      'member-cleanup-worker: dry run — no kicks performed'
    );
    return {
      status: 'completed',
      kicked: 0,
      total: inactiveSubscribers.length,
      dryRun: true,
    };
  }

  // Load connection for kicking
  const connection = await db(CONNECTIONS_TABLE)
    .where({ id: connectionId })
    .first();

  if (!connection) {
    log.error({ connectionId, ruleId }, 'member-cleanup-worker: connection not found');
    return { status: 'error', reason: 'connection_not_found' };
  }

  // Get or create client
  let client = runtimeRegistry.get(connectionId);
  let tempBot = null;

  if (!client && connection.kind === 'bot') {
    const { Telegraf } = require('telegraf');
    const token = decryptToken(connection);
    tempBot = new Telegraf(token);
    client = tempBot;
  }

  if (!client) {
    log.error({ connectionId, ruleId }, 'member-cleanup-worker: no client available');
    return { status: 'error', reason: 'no_client' };
  }

  // Kick each inactive subscriber
  let kickedCount = 0;
  let failedCount = 0;

  for (const subscriber of inactiveSubscribers) {
    const chatId = subscriber.chat_id;
    const userId = subscriber.telegram_user_id;

    if (!chatId || !userId) {
      log.warn(
        { subscriberId: subscriber.id },
        'member-cleanup-worker: subscriber missing chat_id or telegram_user_id'
      );
      failedCount++;
      continue;
    }

    try {
      const telegram = client.telegram || client;
      if (telegram.banChatMember) {
        await telegram.banChatMember(chatId, parseInt(userId, 10));
        // Unban immediately to allow rejoin (kick, not permanent ban)
        await telegram.unbanChatMember(chatId, parseInt(userId, 10), { only_if_banned: true });
      }
      kickedCount++;
    } catch (err) {
      log.warn(
        { err: err && err.message, subscriberId: subscriber.id, chatId, userId },
        'member-cleanup-worker: failed to kick subscriber'
      );
      failedCount++;
    }
  }

  log.info(
    { ruleId, tenantId, kickedCount, failedCount, total: inactiveSubscribers.length },
    'member-cleanup-worker: kick-inactive completed'
  );

  return {
    status: 'completed',
    kicked: kickedCount,
    failed: failedCount,
    total: inactiveSubscribers.length,
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Cron: enqueue kick-inactive jobs for all active rules
// ---------------------------------------------------------------------------

/**
 * Scan all tenants with active auto_kick_inactive rules and enqueue
 * one kick-inactive job per rule. Called by the cron scheduler daily at 02:00 UTC.
 *
 * @returns {Promise<number>} Number of jobs enqueued
 */
async function enqueueDailyCleanup() {
  const log = getLogger();
  const db = getDb();

  // Find all active auto_kick_inactive rules
  const rules = await db(MEMBER_RULES_TABLE)
    .where({ kind: 'auto_kick_inactive', is_active: true })
    .select('id', 'tenant_id', 'connection_id', 'config');

  if (rules.length === 0) {
    log.info('member-cleanup-worker: no active auto_kick_inactive rules found');
    return 0;
  }

  const queue = getQueue(QUEUE_NAMES.MEMBER_CLEANUP);
  let enqueued = 0;

  for (const rule of rules) {
    const config = parseJsonb(rule.config);
    const thresholdDays = config && config.threshold_days ? config.threshold_days : 30;

    try {
      await queue.add('kick-inactive', {
        tenantId: rule.tenant_id,
        ruleId: rule.id,
        connectionId: rule.connection_id,
        thresholdDays,
      }, {
        jobId: `cleanup:${rule.id}:${new Date().toISOString().slice(0, 10)}`,
      });
      enqueued++;
    } catch (err) {
      log.warn(
        { err: err && err.message, ruleId: rule.id },
        'member-cleanup-worker: failed to enqueue cleanup job'
      );
    }
  }

  log.info(
    { enqueued, totalRules: rules.length },
    'member-cleanup-worker: daily cleanup jobs enqueued'
  );

  return enqueued;
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/** @type {import('bullmq').Worker|null} */
let worker = null;

/**
 * Start the member-cleanup worker.
 *
 * @returns {import('bullmq').Worker}
 */
function start() {
  const log = getLogger();
  const env = getEnv();

  const connection = new Redis(env.REDIS_URL, buildRedisOptions('worker:member-cleanup'));

  worker = new Worker(
    QUEUE_NAMES.MEMBER_CLEANUP,
    processJob,
    {
      connection,
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id }, 'member-cleanup-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job ? job.id : 'unknown', err: err && err.message },
      'member-cleanup-worker: job failed'
    );
  });

  worker.on('error', (err) => {
    log.error({ err }, 'member-cleanup-worker: worker error');
  });

  log.info('member-cleanup-worker: started (concurrency=2)');

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
// Cron entry point (daily 02:00 UTC)
// ---------------------------------------------------------------------------

/**
 * Start the daily cron schedule for member cleanup.
 * Uses setInterval to check every minute if it's 02:00 UTC.
 * In production, this would be triggered by an external cron scheduler.
 *
 * @returns {{ stop: Function }}
 */
function startCron() {
  const log = getLogger();
  let lastRunDate = null;

  const interval = setInterval(async () => {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const today = now.toISOString().slice(0, 10);

    // Run at 02:00 UTC, once per day
    if (hour === 2 && minute === 0 && lastRunDate !== today) {
      lastRunDate = today;
      log.info('member-cleanup-worker: cron triggered at 02:00 UTC');
      try {
        await enqueueDailyCleanup();
      } catch (err) {
        log.error({ err }, 'member-cleanup-worker: cron failed to enqueue daily cleanup');
      }
    }
  }, 60_000); // Check every minute

  return {
    stop: () => clearInterval(interval),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  startCron,
  enqueueDailyCleanup,
  processJob,
  processKickInactive,
  // Exported for testing
  parseJsonb,
};
