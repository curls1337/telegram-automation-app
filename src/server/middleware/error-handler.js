'use strict';

/**
 * Unified Express error middleware.
 *
 * Converts AppError instances to appropriate HTTP responses (JSON or EJS page)
 * based on content negotiation. Unhandled/unknown errors are logged and
 * returned as generic 500 responses.
 *
 * References:
 *   - requirements.md §20.5 — error handling, no internal leak
 *   - design.md "Web Shell" — convert AppError to JSON or EJS error page
 */

const { isAppError, toApiError } = require('../../shared/errors');
const { getLogger } = require('../../infra/logger');

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express error-handling middleware (4-argument signature).
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  const logger = getLogger();

  let status;
  let message;
  let code;

  if (isAppError(err)) {
    status = err.httpStatus || 500;
    message = err.message;
    code = err.code;

    // Log at warn level for client errors, error for server errors
    if (status >= 500) {
      logger.error({ err, reqId: req.id }, 'Server error');
    } else {
      logger.warn({ err, reqId: req.id }, 'Client error');
    }
  } else {
    // Unknown/unhandled error — log full details, return generic message
    status = 500;
    message = 'An unexpected error occurred';
    code = 'internal_error';

    logger.error({ err, reqId: req.id }, 'Unhandled error');
  }

  // Prevent double-send if headers already sent
  if (res.headersSent) {
    return;
  }

  res.status(status);

  // Content negotiation: JSON for API paths or clients that accept JSON
  if (req.path.startsWith('/api/') || req.accepts('json') === 'json') {
    return res.json({ error: toApiError(err) });
  }

  // Render EJS error page for browser requests
  try {
    return res.render('error', {
      status,
      message,
      code,
      title: `Error ${status}`,
    });
  } catch (renderErr) {
    // If view rendering fails, fall back to plain text
    logger.error({ err: renderErr }, 'Failed to render error view');
    return res.type('text').send(`${status} — ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  errorHandler,
};
