'use strict';

/**
 * i18n middleware — locale resolution and translation helper attachment.
 *
 * This is a thin wrapper around the i18n-service's `getI18nMiddlewareHelper`
 * that additionally checks `req.user.language` (set by tenantContextMiddleware)
 * for locale resolution.
 *
 * Locale resolution order:
 *   1. req.user.language (user profile preference, if user is loaded)
 *   2. Accept-Language header
 *   3. Fallback to 'en'
 *
 * References:
 *   - requirements.md §18.3 — locale from user profile → Accept-Language → fallback
 *   - design.md "i18n" — middleware picks locale from user pref → header → 'en'
 */

const { t, SUPPORTED_LANGUAGES, FALLBACK_LANGUAGE } = require('../../modules/i18n/i18n-service');

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that resolves the locale and attaches the translation
 * helper `t()` to `res.locals` for EJS templates and to `req` for handlers.
 *
 * Unlike the base i18n-service middleware, this version also checks
 * `req.user.language` which is populated by the tenant-context middleware
 * when the user is authenticated.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function i18nMiddleware(req, res, next) {
  let locale = FALLBACK_LANGUAGE;

  // 1. User profile preference (set by tenantContextMiddleware)
  if (req.user && req.user.language && SUPPORTED_LANGUAGES.includes(req.user.language)) {
    locale = req.user.language;
  }
  // 2. Accept-Language header
  else if (req.headers && req.headers['accept-language']) {
    const acceptLang = req.headers['accept-language'];
    // Simple parsing: take the first language tag's primary subtag
    const primary = acceptLang.split(',')[0].split(';')[0].trim().split('-')[0].toLowerCase();
    if (SUPPORTED_LANGUAGES.includes(primary)) {
      locale = primary;
    }
  }
  // 3. Fallback is already set to 'en'

  // Attach locale and translation function to res.locals for EJS
  res.locals.locale = locale;
  res.locals.t = function localT(key, vars) {
    return t(key, vars, locale);
  };

  // Also attach to req for use in route handlers
  req.locale = locale;
  req.t = res.locals.t;

  next();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  i18nMiddleware,
};
