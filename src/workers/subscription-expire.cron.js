'use strict';

/**
 * Cron job: Expire subscriptions that have passed their end date.
 *
 * Designed to run daily at 03:00 UTC via Sevalla Scheduled Job or system cron.
 * This is a one-shot script that:
 *   1. Queries subscriptions WHERE status='active' AND ends_at < now()
 *   2. For each: calls subscriptionService.expire(id)
 *   3. Logs the count of expired subscriptions
 *   4. Closes DB and exits
 *
 * References:
 *   - requirements.md §15.5 — expire subscription on end date
 *   - design.md "Subscription / Plan Module" — cron daily expire
 */

const { getDb, closeDb } = require('../infra/db');
const { getLogger } = require('../infra/logger');
const subscriptionService = require('../modules/plans/subscription-service');

const log = getLogger().child({ worker: 'subscription-expire-cron' });

async function main() {
  log.info('Starting subscription expiration cron job');

  const db = getDb();

  // Find all active subscriptions that have passed their end date
  const expiredSubscriptions = await db('subscriptions')
    .where({ status: 'active' })
    .where('ends_at', '<', new Date())
    .select('id', 'tenant_id');

  log.info({ count: expiredSubscriptions.length }, 'Found subscriptions to expire');

  let expiredCount = 0;
  let errorCount = 0;

  for (const sub of expiredSubscriptions) {
    try {
      await subscriptionService.expire(sub.id, { userId: null, ip: null });
      expiredCount++;
    } catch (err) {
      errorCount++;
      log.error({ err, subscriptionId: sub.id, tenantId: sub.tenant_id }, 'Failed to expire subscription');
    }
  }

  log.info(
    { expiredCount, errorCount, total: expiredSubscriptions.length },
    'Subscription expiration cron job completed'
  );

  // Close DB connection and exit
  await closeDb();
  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  log.fatal({ err }, 'Subscription expiration cron job failed');
  closeDb().finally(() => process.exit(1));
});
