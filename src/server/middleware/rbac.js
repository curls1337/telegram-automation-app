'use strict';

/**
 * RBAC middleware — Express middleware factories for role and action checks.
 *
 * Provides three middleware factories:
 *   - requireAuth()       — ensures a session exists
 *   - requireRole(roles)  — ensures user has one of the specified roles
 *   - requireAction(kind) — ensures user is authorized for the action kind
 *
 * All middleware assume that `sessionMiddleware` and `tenantContextMiddleware`
 * have already run upstream, populating `req.session`, `req.user`, and
 * `req.tenant`.
 *
 * References:
 *   - requirements.md §2.4 — Viewer can only read
 *   - requirements.md §2.5 — Editor can read/write but not manage
 *   - design.md "RBAC Module" — authorization matrix
 */

const { AuthError, ForbiddenError } = require('../../shared/errors');
const { authorize } = require('../../modules/rbac/rbac-service');

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Middleware that checks a valid session exists.
 * Throws AuthError if `req.session` is null/undefined.
 *
 * @returns {function} Express middleware
 */
function requireAuth() {
  return function requireAuthMiddleware(req, _res, next) {
    if (!req.session) {
      return next(new AuthError('Authentication required'));
    }
    return next();
  };
}

/**
 * Middleware that checks the user has one of the specified roles.
 * Super admins always pass.
 *
 * @param {...string} roles - Allowed roles (e.g. 'tenant_owner', 'editor')
 * @returns {function} Express middleware
 */
function requireRole(...roles) {
  return function requireRoleMiddleware(req, _res, next) {
    if (!req.session) {
      return next(new AuthError('Authentication required'));
    }

    // Super admin always passes
    if (req.user && req.user.is_super_admin) {
      return next();
    }

    if (!req.tenant) {
      return next(new ForbiddenError('No tenant context'));
    }

    if (roles.includes(req.tenant.role)) {
      return next();
    }

    return next(new ForbiddenError('Insufficient role permissions'));
  };
}

/**
 * Middleware that checks the user is authorized for a specific action kind.
 * Uses the RBAC authorization matrix from rbac-service.
 * Super admins always pass.
 *
 * @param {string} actionKind - The action kind to check (e.g. 'read', 'write', 'manage_members')
 * @returns {function} Express middleware
 */
function requireAction(actionKind) {
  return function requireActionMiddleware(req, _res, next) {
    if (!req.session) {
      return next(new AuthError('Authentication required'));
    }

    // Super admin always passes
    if (req.user && req.user.is_super_admin) {
      return next();
    }

    if (!req.tenant) {
      return next(new ForbiddenError('No tenant context'));
    }

    if (authorize(req.tenant.role, actionKind)) {
      return next();
    }

    return next(new ForbiddenError(`Action "${actionKind}" is not allowed for role "${req.tenant.role}"`));
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  requireAuth,
  requireRole,
  requireAction,
};
