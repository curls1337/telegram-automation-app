'use strict';

/**
 * Admin routes for Plan and Subscription management (super_admin only).
 *
 * Mounted at /admin, protected by requireRole('super_admin').
 *
 * References:
 *   - requirements.md §2.6 — super_admin access
 *   - requirements.md §15.1 — CRUD Plan
 *   - requirements.md §15.2, §15.6 — activate/extend subscription
 */

const { Router } = require('express');
const { requireRole } = require('../../server/middleware/rbac');
const planService = require('./plan-service');
const subscriptionService = require('./subscription-service');
const { getDb } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

const router = Router();
const log = getLogger().child({ module: 'admin-routes' });

// All admin routes require super_admin role
router.use(requireRole('super_admin'));

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * GET /admin/plans — List all plans, render admin plans page.
 */
router.get('/plans', async (req, res, next) => {
  try {
    const plans = await planService.listPlans();
    res.render('admin/plans', {
      title: 'Manage Plans',
      plans,
      error: null,
      success: req.query.success || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/plans — Create a new plan.
 */
router.post('/plans', async (req, res, next) => {
  try {
    await planService.createPlan(req.body);
    res.redirect('/admin/plans?success=Plan+created+successfully');
  } catch (err) {
    if (err.code === 'validation_error') {
      const plans = await planService.listPlans();
      return res.status(400).render('admin/plans', {
        title: 'Manage Plans',
        plans,
        error: err.message,
        success: null,
      });
    }
    next(err);
  }
});

/**
 * POST /admin/plans/:id — Update an existing plan.
 */
router.post('/plans/:id', async (req, res, next) => {
  try {
    await planService.updatePlan(req.params.id, req.body);
    res.redirect('/admin/plans?success=Plan+updated+successfully');
  } catch (err) {
    if (err.code === 'validation_error' || err.code === 'not_found') {
      const plans = await planService.listPlans();
      return res.status(err.httpStatus || 400).render('admin/plans', {
        title: 'Manage Plans',
        plans,
        error: err.message,
        success: null,
      });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * GET /admin/subscriptions — List all subscriptions with tenant info.
 */
router.get('/subscriptions', async (req, res, next) => {
  try {
    const db = getDb();
    const subscriptions = await db('subscriptions')
      .join('tenants', 'subscriptions.tenant_id', 'tenants.id')
      .join('plans', 'subscriptions.plan_id', 'plans.id')
      .select(
        'subscriptions.*',
        'tenants.name as tenant_name',
        'plans.name as plan_name'
      )
      .orderBy('subscriptions.created_at', 'desc');

    const plans = await planService.listPlans();
    const tenants = await db('tenants').select('id', 'name').orderBy('name');

    res.render('admin/subscriptions', {
      title: 'Manage Subscriptions',
      subscriptions,
      plans,
      tenants,
      error: null,
      success: req.query.success || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/subscriptions/activate — Activate a subscription for a tenant.
 */
router.post('/subscriptions/activate', async (req, res, next) => {
  try {
    const { tenant_id, plan_id } = req.body;
    await subscriptionService.activate(tenant_id, plan_id, {
      userId: req.user ? req.user.id : null,
      ip: req.ip,
    });
    res.redirect('/admin/subscriptions?success=Subscription+activated+successfully');
  } catch (err) {
    log.warn({ err }, 'Failed to activate subscription');
    if (err.code === 'not_found' || err.code === 'validation_error') {
      return res.redirect('/admin/subscriptions?error=' + encodeURIComponent(err.message));
    }
    next(err);
  }
});

/**
 * POST /admin/subscriptions/:id/extend — Extend a subscription.
 */
router.post('/subscriptions/:id/extend', async (req, res, next) => {
  try {
    await subscriptionService.extend(req.params.id, {
      userId: req.user ? req.user.id : null,
      ip: req.ip,
    });
    res.redirect('/admin/subscriptions?success=Subscription+extended+successfully');
  } catch (err) {
    log.warn({ err }, 'Failed to extend subscription');
    if (err.code === 'not_found') {
      return res.redirect('/admin/subscriptions?error=' + encodeURIComponent(err.message));
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
