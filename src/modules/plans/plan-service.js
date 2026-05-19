'use strict';

/**
 * Plan service — business logic layer wrapping plan-repo with validation.
 *
 * References:
 *   - requirements.md §15.1 — CRUD Plan (super_admin only)
 *   - design.md "Subscription / Plan Module"
 */

const { z } = require('zod');
const { parseOrThrow } = require('../../shared/validation');
const { NotFoundError } = require('../../shared/errors');
const planRepo = require('./plan-repo');

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreatePlanSchema = z.object({
  name: z.string().trim().min(1, 'Plan name is required').max(100, 'Plan name is too long'),
  price_cents: z.coerce.number().int().min(0).default(0),
  duration_months: z.coerce.number().int().min(1).max(120).default(1),
  max_bot_connections: z.coerce.number().int().min(0).default(1),
  max_user_connections: z.coerce.number().int().min(0).default(0),
  max_subscribers: z.coerce.number().int().min(0).default(100),
  max_broadcasts_per_month: z.coerce.number().int().min(0).default(10),
  max_auto_reply_rules: z.coerce.number().int().min(0).default(5),
  is_active: z.coerce.boolean().default(true),
});

const UpdatePlanSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  price_cents: z.coerce.number().int().min(0).optional(),
  duration_months: z.coerce.number().int().min(1).max(120).optional(),
  max_bot_connections: z.coerce.number().int().min(0).optional(),
  max_user_connections: z.coerce.number().int().min(0).optional(),
  max_subscribers: z.coerce.number().int().min(0).optional(),
  max_broadcasts_per_month: z.coerce.number().int().min(0).optional(),
  max_auto_reply_rules: z.coerce.number().int().min(0).optional(),
  is_active: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Create a new plan with validated input.
 *
 * @param {object} input - Raw input from request body
 * @returns {Promise<object>} The created plan
 */
async function createPlan(input) {
  const data = parseOrThrow(CreatePlanSchema, input, { message: 'Invalid plan data' });
  return planRepo.create(data);
}

/**
 * Update an existing plan with validated input.
 *
 * @param {string} id - Plan ID
 * @param {object} input - Raw input from request body
 * @returns {Promise<object>} The updated plan
 * @throws {NotFoundError} If plan does not exist
 */
async function updatePlan(id, input) {
  const data = parseOrThrow(UpdatePlanSchema, input, { message: 'Invalid plan data' });
  const plan = await planRepo.update(id, data);
  if (!plan) {
    throw new NotFoundError('Plan not found');
  }
  return plan;
}

/**
 * List all plans.
 *
 * @returns {Promise<object[]>}
 */
async function listPlans() {
  return planRepo.list();
}

/**
 * Get a single plan by ID.
 *
 * @param {string} id - Plan ID
 * @returns {Promise<object>} The plan
 * @throws {NotFoundError} If plan does not exist
 */
async function getPlan(id) {
  const plan = await planRepo.getById(id);
  if (!plan) {
    throw new NotFoundError('Plan not found');
  }
  return plan;
}

/**
 * Soft-delete a plan (set is_active=false).
 *
 * @param {string} id - Plan ID
 * @returns {Promise<object>} The deactivated plan
 * @throws {NotFoundError} If plan does not exist
 */
async function removePlan(id) {
  const plan = await planRepo.remove(id);
  if (!plan) {
    throw new NotFoundError('Plan not found');
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createPlan,
  updatePlan,
  listPlans,
  getPlan,
  removePlan,
};
