'use strict';

/**
 * Subscription service — activate, extend, expire subscriptions.
 *
 * References:
 *   - requirements.md §15.2 — activate subscription
 *   - requirements.md §15.5 — expire on end date
 *   - requirements.md §15.6 — extend subscription
 *   - requirements.md §15.7 — audit log for all subscription changes
 *   - design.md "Subscription / Plan Module"
 */

const { getDb } = require('../../infra/db');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');
const { NotFoundError } = require('../../shared/errors');
const audit = require('../audit/audit-logger');
const planRepo = require('./plan-repo');

const TABLE = 'subscriptions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Add months to a date. Uses native Date month arithmetic.
 *
 * @param {Date} date
 * @param {number} months
 * @returns {Date}
 */
function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Activate a subscription for a tenant on a given plan.
 *
 * @param {string} tenantId
 * @param {string} planId
 * @param {{ userId?: string, ip?: string }} [ctx] - Audit context
 * @returns {Promise<object>} The created subscription
 * @throws {NotFoundError} If plan does not exist
 */
async function activate(tenantId, planId, ctx = {}) {
  const plan = await planRepo.getById(planId);
  if (!plan) {
    throw new NotFoundError('Plan not found');
  }

  const db = getDb();
  const timestamp = now();
  const endsAt = addMonths(timestamp, plan.duration_months);

  const row = {
    id: newId(),
    tenant_id: tenantId,
    plan_id: planId,
    status: 'active',
    started_at: timestamp,
    ends_at: endsAt,
    created_at: timestamp,
    updated_at: timestamp,
  };

  const [subscription] = await db(TABLE).insert(row).returning('*');

  await audit.write({
    tenantId,
    userId: ctx.userId || null,
    action: 'subscription.activate',
    resourceType: 'subscription',
    resourceId: subscription.id,
    ip: ctx.ip || null,
    meta: { planId, planName: plan.name, endsAt: endsAt.toISOString() },
  });

  return subscription;
}

/**
 * Extend a subscription by adding the plan's duration_months to ends_at.
 *
 * @param {string} subscriptionId
 * @param {{ userId?: string, ip?: string }} [ctx] - Audit context
 * @returns {Promise<object>} The updated subscription
 * @throws {NotFoundError} If subscription or plan does not exist
 */
async function extend(subscriptionId, ctx = {}) {
  const db = getDb();

  const subscription = await db(TABLE).where({ id: subscriptionId }).first();
  if (!subscription) {
    throw new NotFoundError('Subscription not found');
  }

  const plan = await planRepo.getById(subscription.plan_id);
  if (!plan) {
    throw new NotFoundError('Plan not found');
  }

  const currentEndsAt = new Date(subscription.ends_at);
  const newEndsAt = addMonths(currentEndsAt, plan.duration_months);
  const timestamp = now();

  const [updated] = await db(TABLE)
    .where({ id: subscriptionId })
    .update({
      ends_at: newEndsAt,
      status: 'active',
      updated_at: timestamp,
    })
    .returning('*');

  await audit.write({
    tenantId: subscription.tenant_id,
    userId: ctx.userId || null,
    action: 'subscription.extend',
    resourceType: 'subscription',
    resourceId: subscriptionId,
    ip: ctx.ip || null,
    meta: {
      planId: plan.id,
      planName: plan.name,
      previousEndsAt: currentEndsAt.toISOString(),
      newEndsAt: newEndsAt.toISOString(),
    },
  });

  return updated;
}

/**
 * Expire a subscription (set status='expired').
 *
 * @param {string} subscriptionId
 * @param {{ userId?: string, ip?: string }} [ctx] - Audit context
 * @returns {Promise<object>} The updated subscription
 * @throws {NotFoundError} If subscription does not exist
 */
async function expire(subscriptionId, ctx = {}) {
  const db = getDb();

  const subscription = await db(TABLE).where({ id: subscriptionId }).first();
  if (!subscription) {
    throw new NotFoundError('Subscription not found');
  }

  const timestamp = now();

  const [updated] = await db(TABLE)
    .where({ id: subscriptionId })
    .update({
      status: 'expired',
      updated_at: timestamp,
    })
    .returning('*');

  await audit.write({
    tenantId: subscription.tenant_id,
    userId: ctx.userId || null,
    action: 'subscription.expire',
    resourceType: 'subscription',
    resourceId: subscriptionId,
    ip: ctx.ip || null,
    meta: { planId: subscription.plan_id },
  });

  return updated;
}

/**
 * Get the active subscription for a tenant, or null if none.
 *
 * @param {string} tenantId
 * @returns {Promise<object|null>}
 */
async function getActiveSubscription(tenantId) {
  const db = getDb();
  const subscription = await db(TABLE)
    .where({ tenant_id: tenantId, status: 'active' })
    .orderBy('created_at', 'desc')
    .first();
  return subscription || null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  activate,
  extend,
  expire,
  getActiveSubscription,
  addMonths,
};
