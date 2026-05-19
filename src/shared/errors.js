'use strict';

/**
 * Centralized error taxonomy for the Telegram Automation App.
 *
 * Every operational/expected failure in the codebase should be raised as an
 * {@link AppError} (or one of its subclasses). The HTTP and API error
 * middleware can then map these to the appropriate response shape without
 * leaking internal details.
 *
 * Design references:
 *  - design.md → "Error Handling" / "Error Surface": web routes return JSON
 *    `{ error: { code, message } }` for API surfaces and friendly EJS pages
 *    elsewhere; status code is taken from `AppError.httpStatus`.
 *  - design.md → "Telegram-specific": Telegraf/GramJS errors are wrapped in a
 *    {@link TelegramError} so the queue layer can translate Telegram error
 *    codes into retry / paused / dead-letter decisions.
 *
 * Conventions:
 *  - `code` is a short, stable, snake_case string used by the API and i18n
 *    layer ("validation_error", "quota_exceeded", ...). Treat it as part of
 *    the public contract — do not rename casually.
 *  - `httpStatus` is the response code we serve when the error reaches an
 *    HTTP handler. Workers ignore it.
 *  - `expose` controls whether the error message and details are safe to
 *    return to API callers. Defaults to `true` for `AppError` subclasses
 *    because they describe expected, user-facing failures. Plain `Error`s
 *    are treated as internal and never exposed (see {@link toApiError}).
 *  - `details` carries machine-readable context (e.g. Zod issues, quota
 *    metadata, Telegram error code) and must remain JSON-serializable.
 *  - `cause` mirrors the standard Node.js `Error.cause` semantics and is
 *    propagated to the underlying `Error` constructor when supported.
 */

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * Base class for every operational error in the application.
 *
 * @example
 *   throw new AppError('Bad happened', {
 *     code: 'something_broke',
 *     httpStatus: 500,
 *     expose: false,
 *     details: { hint: 'check logs' },
 *     cause: originalError,
 *   });
 */
class AppError extends Error {
  /**
   * @param {string} message Human-readable, user-facing message. Subclasses
   *   may override the default per error type. Should already be safe to
   *   show to end users (i18n keys are resolved by the caller).
   * @param {object} [opts]
   * @param {string} [opts.code] Stable machine-readable error code.
   * @param {number} [opts.httpStatus] HTTP status code (1xx-5xx).
   * @param {boolean} [opts.expose] Whether `message` / `details` are safe to
   *   return to API clients. Defaults to `true` for AppError.
   * @param {object|null} [opts.details] Machine-readable, JSON-serializable
   *   context. Must never contain secrets.
   * @param {Error|unknown} [opts.cause] Underlying error to wrap.
   */
  constructor(message, opts = {}) {
    const {
      code = 'app_error',
      httpStatus = 500,
      expose = true,
      details = null,
      cause,
    } = opts;

    // Forward `cause` to Error when provided so `err.cause` and stack chain
    // work the same way as native Error semantics on Node ≥ 16.9.
    if (cause !== undefined) {
      super(message, { cause });
    } else {
      super(message);
    }

    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.expose = expose;
    this.details = details;

    // V8-only API; guarded for portability.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

/**
 * Input validation failure (e.g. Zod parse error). The `details` field is
 * expected to carry the array of issues so the caller can render a per-field
 * UI message.
 */
class ValidationError extends AppError {
  /**
   * @param {string} [message]
   * @param {object} [opts]
   * @param {Array<object>|object|null} [opts.details] Typically Zod issues.
   */
  constructor(message = 'Validation failed', opts = {}) {
    super(message, {
      code: 'validation_error',
      httpStatus: 400,
      expose: true,
      ...opts,
    });
  }
}

/**
 * Caller is not authenticated (no session, expired session, bad credentials).
 * Use a generic message at the boundary to avoid leaking which factor failed.
 */
class AuthError extends AppError {
  constructor(message = 'Authentication required', opts = {}) {
    super(message, {
      code: 'unauthenticated',
      httpStatus: 401,
      expose: true,
      ...opts,
    });
  }
}

/**
 * Caller is authenticated but lacks permission for the requested operation
 * (RBAC denial, cross-tenant access, etc.).
 */
class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', opts = {}) {
    super(message, {
      code: 'forbidden',
      httpStatus: 403,
      expose: true,
      ...opts,
    });
  }
}

/**
 * Resource not found, or hidden behind tenancy / RBAC such that the caller
 * must not learn it exists. Prefer this over {@link ForbiddenError} when the
 * existence of the resource is itself sensitive.
 */
class NotFoundError extends AppError {
  constructor(message = 'Not found', opts = {}) {
    super(message, {
      code: 'not_found',
      httpStatus: 404,
      expose: true,
      ...opts,
    });
  }
}

/**
 * Plan / tenant quota would be exceeded by this operation. The middleware
 * refuses the request before any side effect runs.
 *
 * `details` should carry `{ kind, limit, current }` so the UI can render a
 * meaningful upgrade prompt and the API can be queried programmatically.
 */
class QuotaExceededError extends AppError {
  /**
   * @param {string} [message]
   * @param {object} [opts]
   * @param {{ kind?: string, limit?: number, current?: number }|object|null} [opts.details]
   */
  constructor(message = 'Quota exceeded', opts = {}) {
    super(message, {
      code: 'quota_exceeded',
      httpStatus: 403,
      expose: true,
      ...opts,
    });
  }
}

/**
 * Conflict with current resource state (e.g. unique constraint, optimistic
 * concurrency, attempting to start a job that is already running).
 */
class ConflictError extends AppError {
  constructor(message = 'Conflict', opts = {}) {
    super(message, {
      code: 'conflict',
      httpStatus: 409,
      expose: true,
      ...opts,
    });
  }
}

/**
 * Caller has been rate limited. `details.retryAfter` (seconds) should be set
 * when known so the HTTP layer can emit a `Retry-After` header.
 */
class RateLimitError extends AppError {
  /**
   * @param {string} [message]
   * @param {object} [opts]
   * @param {{ retryAfter?: number }|object|null} [opts.details]
   */
  constructor(message = 'Rate limit exceeded', opts = {}) {
    super(message, {
      code: 'rate_limit_exceeded',
      httpStatus: 429,
      expose: true,
      ...opts,
    });
  }
}

/**
 * Wrapper for errors raised by the Telegram Bot API or MTProto. Workers use
 * `details.telegramCode` to decide between retry, pause, or dead-letter (see
 * design.md → "Telegram-specific").
 */
class TelegramError extends AppError {
  /**
   * @param {string} [message]
   * @param {object} [opts]
   * @param {{ telegramCode?: number|string, telegramDescription?: string, retryAfter?: number, raw?: unknown }|object|null} [opts.details]
   */
  constructor(message = 'Telegram API error', opts = {}) {
    super(message, {
      code: 'telegram_error',
      httpStatus: 502,
      expose: true,
      ...opts,
    });
  }
}

/**
 * A non-Telegram external dependency (S3, SMTP, Gemini, webhook target,
 * payment processor, ...) failed in a way the application cannot recover
 * from on this attempt.
 */
class ExternalServiceError extends AppError {
  /**
   * @param {string} [message]
   * @param {object} [opts]
   * @param {{ service?: string, status?: number, raw?: unknown }|object|null} [opts.details]
   */
  constructor(message = 'External service error', opts = {}) {
    super(message, {
      code: 'external_service_error',
      httpStatus: 502,
      expose: true,
      ...opts,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard — true for any error produced by this module (including future
 * subclasses extending {@link AppError}).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isAppError(err) {
  return err instanceof AppError;
}

/**
 * Convert any thrown value into the JSON-safe shape returned by the API layer.
 *
 * Rules:
 *  - {@link AppError} instances with `expose === true` surface their own
 *    `code`, `message`, and `details` (when non-null).
 *  - Any other value (plain `Error`, string, unknown) is replaced with a
 *    generic `internal_error` payload so internals do not leak.
 *
 * The HTTP status code is intentionally NOT included in the returned object;
 * the middleware reads it from `err.httpStatus` directly on the error.
 *
 * @param {unknown} err
 * @returns {{ code: string, message: string, details?: object }}
 */
function toApiError(err) {
  if (isAppError(err) && err.expose) {
    const out = {
      code: err.code,
      message: err.message,
    };
    if (err.details != null) {
      out.details = err.details;
    }
    return out;
  }

  return {
    code: 'internal_error',
    message: 'An unexpected error occurred',
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ConflictError,
  RateLimitError,
  TelegramError,
  ExternalServiceError,
  isAppError,
  toApiError,
};
