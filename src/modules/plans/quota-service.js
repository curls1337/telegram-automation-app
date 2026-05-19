'use strict';

/**
 * Quota service — enforce plan limits before resource-creating operations.
 *
 * References:
 *   - requirements.md §4.5 — bot connection quota
 *   - requirements.md §7.6 — auto-reply rules quota
 *   - requirements.md §9.7 — broadcast quota
 *   - requirements.md §15.3 — enforce quota while subscription active
 *   - requirements.md §15.4 — reject with upgrade message when exceeded
 *   - design.md "Subscription / Plan Module" — QuotaService.check(tenantId, kind, delta)
 */

const { getDb } = require('../../infra/db');
const { QuotaExceededError } = require('../../shared/errors');
const subscriptionService = require('./subscription-service');
const planRepo = require('./plan-repo');

// ---------------------------------------------------------------------------
// Kind → limit field mapping
// ---------------------------------------------------------------------------

const KIND_TO_LIMIT_FIELD = {
  bot_connections: 'max_bot_connections',
  user_connections: 'max_user_connections',
  auto_reply_rules: 'max_auto_reply_rules',
  monthly_broadcasts: 'max_broadcasts_per_month',
  subscribers: 'max_subscribers',
};

// ---------------------------------------------------------------------------
// Usage counters
// ---------------------------------------------------------------------------

/**
 * Count current usage for a given kind within a tenant.
 *
 * @param {string} tenantId
 * @param {string} kind
 * @returns {Promise<number>}
 */
async function countUsage(tenantId, kind) {
  const db = getDb();

  switch (kind) {
    case 'bot_connections': {
      const [{ count }] = await db('telegram_connections')
        .where({ tenant_id: tenantId, kind: 'bot' })
        .whereNot({ status: 'invalid' })
        .count('* as count');
      return parseInt(count, 10);
    }

    case 'user_connections': {
      const [{ count }] = await db('telegram_connections')
        .where({ tenant_id: tenantId, kind: 'user' })
        .whereNot({ status: 'invalid' })
        .count('* as count');
      return parseInt(count, 10);
    }

    case 'auto_reply_rules': {
      const [{ count }] = await db('auto_reply_rules')
        .where({ tenant_id: tenantId, is_active: true })
        .count('* as count');
      return parseInt(count, 10);
    }

    case 'monthly_broadcasts': {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const [{ count }] = await db('broadcasts')
        .where({ tenant_id: tenantId })
        .where('created_at', '>=', startOfMonth)
        .count('* as count');
      return parseInt(count, 10);
    }

    case 'subscribers': {
      const [{ count }] = await db('subscribers')
        .where({ tenant_id: tenantId })
        .whereNot({ status: 'deactivated' })
        .count('* as count');
      return parseInt(count, 10);
    }

    default:
      throw new Error(`Unknown quota kind: ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

/**
 * Check whether a tenant can perform an operation that would consume `delta`
 * units of the given quota kind. Throws QuotaExceededError if the limit
 * would be exceeded.
 *
 * @param {string} tenantId
 * @param {string} kind - One of: bot_connections, user_connections, auto_reply_rules, monthly_broadcasts, subscribers
 * @param {number} [delta=1] - Number of units to add
 * @throws {QuotaExceededError}
 */
async function check(tenantId, kind, delta = 1) {
  if (!KIND_TO_LIMIT_FIELD[kind]) {
    throw new Error(`Unknown quota kind: ${kind}`);
  }

  // Load active subscription
  const subscription = await subscriptionService.getActiveSubscription(tenantId);
  if (!subscription) {
    throw new QuotaExceededError(
      'No active subscription. Please activate a plan to continue.',
      { details: { kind, limit: 0, current: 0 } }
    );
  }

  // Load plan to get limits
  const plan = await planRepo.getById(subscription.plan_id);
  if (!plan) {
    throw new QuotaExceededError(
      'Plan not found for active subscription.',
      { details: { kind, limit: 0, current: 0 } }
    );
  }

  const limitField = KIND_TO_LIMIT_FIELD[kind];
  const limit = plan[limitField];

  // Count current usage
  const current = await countUsage(tenantId, kind);

  if (current + delta > limit) {
    throw new QuotaExceededError(
      `Quota exceeded for ${kind}. Current: ${current}, limit: ${limit}. Please upgrade your plan.`,
      { details: { kind, limit, current } }
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  check,
  countUsage,
};
