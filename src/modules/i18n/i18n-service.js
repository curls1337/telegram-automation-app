'use strict';

/**
 * Internationalization service using i18next with filesystem backend.
 *
 * Responsibilities:
 *   - Initialize i18next with locale files from `locales/` directory.
 *   - Provide a `t(key, vars, locale)` translation helper.
 *   - Provide middleware helper that attaches `t()` to `res.locals` for EJS.
 *
 * Supported languages: 'id' (Bahasa Indonesia), 'en' (English)
 * Fallback language: 'en'
 *
 * References:
 *   - requirements.md §18.1–18.4
 *   - design.md "i18n" — i18next + i18next-fs-backend, resource files per locale
 */

const path = require('path');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_LANGUAGES = ['id', 'en'];
const FALLBACK_LANGUAGE = 'en';
const LOCALES_PATH = path.join(__dirname, '..', '..', '..', 'locales');

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/** @type {boolean} */
let initialized = false;

/**
 * Initialize i18next with the filesystem backend.
 * Must be called once at application startup before using `t()`.
 *
 * @returns {Promise<void>}
 */
async function initI18n() {
  if (initialized) return;

  await i18next.use(Backend).init({
    // Supported languages
    lng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: FALLBACK_LANGUAGE,

    // Namespace configuration
    ns: ['translation'],
    defaultNS: 'translation',

    // Backend options — load JSON files from locales/
    backend: {
      loadPath: path.join(LOCALES_PATH, '{{lng}}.json'),
    },

    // Interpolation settings
    interpolation: {
      escapeValue: false, // EJS handles escaping
      prefix: '{{',
      suffix: '}}',
    },

    // Do not try to detect language from headers here — middleware handles that
    detection: false,

    // Preload both languages at init time
    preload: SUPPORTED_LANGUAGES,

    // Return key if translation is missing (useful for debugging)
    returnNull: false,
    returnEmptyString: false,
  });

  initialized = true;
}

// ---------------------------------------------------------------------------
// Translation helper
// ---------------------------------------------------------------------------

/**
 * Translate a key with optional interpolation variables and locale override.
 *
 * @param {string} key - Translation key (dot-notation, e.g. 'auth.login_title')
 * @param {Record<string, unknown>} [vars] - Interpolation variables
 * @param {string} [locale] - Override locale (defaults to i18next current language)
 * @returns {string} Translated string, or the key itself if not found
 */
function t(key, vars, locale) {
  if (!key || typeof key !== 'string') return '';

  const options = {};

  if (vars && typeof vars === 'object') {
    Object.assign(options, vars);
  }

  if (locale && typeof locale === 'string') {
    options.lng = locale;
  }

  return i18next.t(key, options);
}

// ---------------------------------------------------------------------------
// Middleware helper
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware function that attaches the translation
 * helper `t()` to `res.locals` so EJS templates can use it directly.
 *
 * The locale is determined from:
 *   1. `req.session.language` (user preference stored in session)
 *   2. `req.query.lang` (URL override for testing)
 *   3. `Accept-Language` header
 *   4. Fallback to 'en'
 *
 * Usage in EJS: `<%= t('auth.login_title') %>`
 *
 * @returns {function} Express middleware
 */
function getI18nMiddlewareHelper() {
  return function i18nMiddleware(req, res, next) {
    // Determine locale
    let locale = FALLBACK_LANGUAGE;

    // 1. User preference from session
    if (req.session && req.session.language && SUPPORTED_LANGUAGES.includes(req.session.language)) {
      locale = req.session.language;
    }
    // 2. Query parameter override
    else if (req.query && req.query.lang && SUPPORTED_LANGUAGES.includes(req.query.lang)) {
      locale = req.query.lang;
    }
    // 3. Accept-Language header
    else if (req.headers && req.headers['accept-language']) {
      const acceptLang = req.headers['accept-language'];
      // Simple parsing: take the first language tag
      const primary = acceptLang.split(',')[0].split(';')[0].trim().split('-')[0].toLowerCase();
      if (SUPPORTED_LANGUAGES.includes(primary)) {
        locale = primary;
      }
    }

    // Attach locale and translation function to res.locals for EJS
    res.locals.locale = locale;
    res.locals.t = function localT(key, vars) {
      return t(key, vars, locale);
    };

    // Also attach to req for use in route handlers
    req.locale = locale;
    req.t = res.locals.t;

    next();
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  initI18n,
  t,
  getI18nMiddlewareHelper,
  SUPPORTED_LANGUAGES,
  FALLBACK_LANGUAGE,
};
