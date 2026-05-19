'use strict';

/**
 * API Authentication Middleware — Bearer token verification for REST API.
 *
 * Extracts the token from `Authorization: Bearer <key>` header, verifies it
 * via api-key-service, and populates req.tenant / req.apiKey / req.isApiRequest.
 *
 * On failure: returns 401 JSON response and writes an audit log entry.
 *
 * References:
 *   - requirements.md §14.2 — Bearer auth header
 *   - requirements.md §14.3 — 401 on revoked/unknown + audit log
 */

const apiKeyService = require('./api-key-service');
const auditLogger = require('../../audit/audit-logger');
const { getLogger } = require('../../../infra/logger');

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that authenticates API requests via Bearer token.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function apiAuthMiddleware(req, res, next) {
  const log = getLogger();

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Log failed attempt
    auditLogger.write({
      tenantId: null,
      userId: null,
      action: 'api.auth_failed',
      resourceType: 'api_key',
      ip: req.ip,
      meta: { reason: 'missing_or_invalid_header' },
    }).catch((err) => log.warn({ err }, 'api-auth: audit write failed'));

    return res.status(401).json({
      error: { code: 'unauthenticated', message: 'Missing or invalid Authorization header' },
    });
  }

  const token = authHeader.slice(7); // Remove 'Bearer '

  if (!token || token.length === 0) {
    auditLogger.write({
      tenantId: null,
      userId: null,
      action: 'api.auth_failed',
      resourceType: 'api_key',
      ip: req.ip,
      meta: { reason: 'empty_token' },
    }).catch((err) => log.warn({ err }, 'api-auth: audit write failed'));

    return res.status(401).json({
      error: { code: 'unauthenticated', message: 'Missing or invalid Authorization header' },
    });
  }

  try {
    const result = await apiKeyService.verify(token);

    if (!result) {
      auditLogger.write({
        tenantId: null,
        userId: null,
        action: 'api.auth_failed',
        resourceType: 'api_key',
        ip: req.ip,
        meta: { reason: 'invalid_or_revoked_key' },
      }).catch((err) => log.warn({ err }, 'api-auth: audit write failed'));

      return res.status(401).json({
        error: { code: 'unauthenticated', message: 'Invalid or revoked API key' },
      });
    }

    // Set request context
    req.tenant = { id: result.tenantId };
    req.apiKey = { id: result.keyId, scopes: result.scopes };
    req.isApiRequest = true;

    return next();
  } catch (err) {
    log.error({ err }, 'api-auth: unexpected error during verification');
    return res.status(500).json({
      error: { code: 'internal_error', message: 'An unexpected error occurred' },
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { apiAuthMiddleware };
