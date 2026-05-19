'use strict';

/**
 * Cron entry point — one-shot script that runs a specific task based on argv.
 *
 * Start command: `node src/server/index.cron.js <task-name>`
 *
 * Available tasks:
 *   - analytics-rollup     — run analytics rollup once
 *   - member-cleanup       — enqueue daily member cleanup jobs
 *   - connection-sweeper   — run connection sweeper once
 *   - subscription-expire  — expire subscriptions past end date
 *   - audit-log-cleanup    — delete audit logs older than 365 days
 *
 * Designed for Sevalla Scheduled Jobs or system cron. Each invocation
 * runs the task once and exits.
 *
 * References:
 *   - design.md "Cron Jobs" — one-shot scripts
 *   - requirements.md §19.3 — audit log retention 365 days
 */

const { getEnv } = require('../shared/env');
const { getLogger } = require('../infra/logger');
const { getDb, closeDb } = require('../infra/db');
const { closeRedis } = require('../infra/redis');
const { closeQueues } = require('../infra/queues');

// ---------------------------------------------------------------------------
// Task registry
// ---------------------------------------------------------------------------

const TASKS = {
  'analytics-rollup': runAnalyticsRollup,
  'member-cleanup': runMemberCleanup,
  'connection-sweeper': runConnectionSweeper,
  'subscription-expire': runSubscriptionExpire,
  'audit-log-cleanup': runAuditLogCleanup,
};

// ---------------------------------------------------------------------------
// Task implementations
// ---------------------------------------------------------------------------

/**
 * Run analytics rollup once.
 */
async function runAnalyticsRollup() {
  const { runRollup } = require('../workers/analytics-rollup.worker');
  const count = await runRollup();
  return { task: 'analytics-rollup', upsertedRows: count };
}

/**
 * Enqueue daily member cleanup jobs for all tenants with active rules.
 */
async function runMemberCleanup() {
  const { getQueue, QUEUE_NAMES } = require('../infra/queues');
  const db = getDb();

  // Find tenants with active member cleanup rules
  const tenants = await db('member_rules')
    .where({ is_active: true, action: 'kick_inactive' })
    .distinct('tenant_id');

  const queue = getQueue(QUEUE_NAMES.MEMBER_CLEANUP);
  let enqueued = 0;

  for (const row of tenants) {
    await queue.add('kick-inactive', { tenantId: row.tenant_id });
    enqueued++;
  }

  return { task: 'member-cleanup', enqueuedJobs: enqueued };
}

/**
 * Run connection sweeper once (find unlocked active connections and publish start events).
 */
async function runConnectionSweeper() {
  const { sweep } = require('../workers/connection-sweeper.cron');
  const startedCount = await sweep();
  return { task: 'connection-sweeper', connectionsStarted: startedCount };
}

/**
 * Expire subscriptions that have passed their end date.
 */
async function runSubscriptionExpire() {
  const subscriptionService = require('../modules/plans/subscription-service');
  const db = getDb();

  const expiredSubscriptions = await db('subscriptions')
    .where({ status: 'active' })
    .where('ends_at', '<', new Date())
    .select('id', 'tenant_id');

  let expiredCount = 0;
  let errorCount = 0;

  for (const sub of expiredSubscriptions) {
    try {
      await subscriptionService.expire(sub.id, { userId: null, ip: null });
      expiredCount++;
    } catch (_err) {
      errorCount++;
    }
  }

  return { task: 'subscription-expire', expiredCount, errorCount, total: expiredSubscriptions.length };
}

/**
 * Delete audit logs older than 365 days.
 * Requirement: audit log retention is 365 days (design.md).
 */
async function runAuditLogCleanup() {
  const db = getDb();

  const result = await db('audit_logs')
    .where('created_at', '<', db.raw("NOW() - INTERVAL '365 days'"))
    .del();

  return { task: 'audit-log-cleanup', deletedRows: result };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  getEnv(); // validate env
  const logger = getLogger();

  const taskName = process.argv[2];

  if (!taskName) {
    const available = Object.keys(TASKS).join(', ');
    // eslint-disable-next-line no-console
    console.error(`Usage: node src/server/index.cron.js <task-name>\nAvailable tasks: ${available}`);
    process.exit(1);
  }

  const taskFn = TASKS[taskName];

  if (!taskFn) {
    const available = Object.keys(TASKS).join(', ');
    // eslint-disable-next-line no-console
    console.error(`Unknown task: "${taskName}"\nAvailable tasks: ${available}`);
    process.exit(1);
  }

  logger.info({ task: taskName }, 'cron: starting task');

  const result = await taskFn();

  logger.info({ task: taskName, result }, 'cron: task completed');

  // Cleanup and exit
  await closeQueues();
  await closeDb();
  await closeRedis();

  process.exit(0);
}

main().catch((err) => {
  const logger = getLogger();
  logger.fatal({ err, task: process.argv[2] }, 'cron: task failed');

  closeQueues()
    .then(() => closeDb())
    .then(() => closeRedis())
    .finally(() => process.exit(1));
});
