'use strict';

/**
 * Read-only mode middleware — blocks write operations when subscription is expired.
 *
 * When a tenant's subscription status is 'expired', only read operations (GET, HEAD, OPTIONS)
 * and backup/export paths are allowed. All other methods are rejected with a ForbiddenError.
 *
 * Super admins bypass this restriction entirely.
 *
 * References:
 *   - requirements.md §15.5 — expired subscription limits to read + export
 *   - design.md "Subscription / Plan Module" — read-only mode middleware
 */

const { ForbiddenError } = require('../../shared/errors');

// Methods that are considered "write" operations
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Paths that are always allowed even when subscription is expired (backup/export)
const ALLOWED_PATHS = [
  '/backup/export',
  '/api/v1/backup',
];

/**
 * Check if a path is in the allowed list (starts with one of the allowed prefixes).
 *
 * @param {string} path
 * @returns {boolean}
 */
function isAllowedPath(path) {
  return ALLOWED_PATHS.some((allowed) => path.startsWith(allowed));
}

/**
 * Read-only mode middleware factory.
 *
 * @returns {function} Express middleware
 */
function readOnlyMode() {
  return function readOnlyMiddleware(req, _res, next) {
    // Super admin always passes
    if (req.user && req.user.is_super_admin) {
      return next();
    }

    // Only check if we have tenant context with subscription info
    if (!req.tenant || !req.tenant.subscription) {
      return next();
    }

    const subscriptionStatus = req.tenant.subscription.status;

    // Only block when subscription is expired
    if (subscriptionStatus !== 'expired') {
      return next();
    }

    // Allow read methods (GET, HEAD, OPTIONS)
    if (!WRITE_METHODS.has(req.method)) {
      return next();
    }

    // Allow backup/export paths
    if (isAllowedPath(req.path)) {
      return next();
    }

    return next(
      new ForbiddenError(
        'Subscription expired. Only read and export operations are allowed.'
      )
    );
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  readOnlyMode,
};
