'use strict';

/**
 * Tenant context middleware — resolves the active tenant for the current
 * request and attaches `req.tenant` and `req.user` objects.
 *
 * Responsibilities:
 *   - Skip processing for unauthenticated requests (no session).
 *   - Skip processing for paths that don't need tenant context (login,
 *     register, health, API v1 — those have their own auth).
 *   - Load the user record from the database using `req.session.userId`.
 *   - Determine the active tenant: super_admin impersonation via
 *     `?as_tenant=<id>`, or the session's `activeTenantId`.
 *   - Verify the user has membership in `tenant_members` (or is super_admin).
 *   - Load tenant + subscription + plan info.
 *   - Attach `req.tenant` and `req.user` for downstream middleware/routes.
 *   - Throw AuthError if no valid tenant can be resolved and the route
 *     requires one.
 *
 * References:
 *   - requirements.md §2.7 — cross-tenant access returns 404
 *   - requirements.md §3.1 — tenant_id on every domain row
 *   - requirements.md §3.2 — query filter by tenant_id
 *   - design.md "Tenant Context Middleware"
 */

const { getDb } = require('../../infra/db');
const { AuthError } = require('../../shared/errors');

// ---------------------------------------------------------------------------
// Paths that bypass tenant context resolution
// ---------------------------------------------------------------------------

const SKIP_PREFIXES = [
  '/login',
  '/register',
  '/health',
  '/api/v1/',
  '/forgot-password',
  '/reset-password',
  '/invitations',
];

/**
 * Returns true if the request path should skip tenant context loading.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
function shouldSkip(pathname) {
  for (const prefix of SKIP_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that resolves the active tenant for the request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function tenantContextMiddleware(req, res, next) {
  try {
    // Skip for unauthenticated requests
    if (!req.session) {
      return next();
    }

    // Skip for paths that don't need tenant context
    if (shouldSkip(req.path)) {
      return next();
    }

    const db = getDb();

    // Load user from DB
    const user = await db('users')
      .where('id', req.session.userId)
      .first();

    if (!user) {
      throw new AuthError('User not found');
    }

    // Determine which tenant to load
    let tenantId;

    if (user.is_super_admin && req.query.as_tenant) {
      // Super admin impersonation
      tenantId = req.query.as_tenant;
    } else {
      tenantId = req.session.activeTenantId;
    }

    if (!tenantId) {
      throw new AuthError('No active tenant');
    }

    // Verify membership (super_admin bypasses membership check)
    let role = null;

    if (user.is_super_admin) {
      role = 'super_admin';
    } else {
      const membership = await db('tenant_members')
        .where({ tenant_id: tenantId, user_id: user.id })
        .first();

      if (!membership) {
        throw new AuthError('No tenant membership');
      }

      role = membership.role;
    }

    // Load tenant record
    const tenant = await db('tenants')
      .where('id', tenantId)
      .first();

    if (!tenant) {
      throw new AuthError('Tenant not found');
    }

    // Load subscription + plan info
    const subscription = await db('subscriptions')
      .where({ tenant_id: tenantId, status: 'active' })
      .orderBy('started_at', 'desc')
      .first();

    let plan = null;
    if (subscription) {
      plan = await db('plans')
        .where('id', subscription.plan_id)
        .first();
    }

    // Attach req.tenant
    req.tenant = {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      role,
      plan: plan
        ? {
            id: plan.id,
            name: plan.name,
            max_bot_connections: plan.max_bot_connections,
            max_user_connections: plan.max_user_connections,
            max_subscribers: plan.max_subscribers,
            max_broadcasts_per_month: plan.max_broadcasts_per_month,
            max_auto_reply_rules: plan.max_auto_reply_rules,
          }
        : null,
      subscription: subscription
        ? {
            id: subscription.id,
            plan_id: subscription.plan_id,
            status: subscription.status,
            started_at: subscription.started_at,
            ends_at: subscription.ends_at,
          }
        : null,
    };

    // Attach req.user
    req.user = {
      id: user.id,
      email: user.email,
      is_super_admin: user.is_super_admin || false,
      language: user.language || 'en',
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  tenantContextMiddleware,
  // Exported for testing
  shouldSkip,
};
