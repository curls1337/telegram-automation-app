'use strict';

/**
 * Outbound email (Nodemailer SMTP) with templated, i18n-aware sends.
 *
 * Responsibilities:
 *   - Build and cache a single Nodemailer transporter from `env.SMTP_URL`.
 *     Nodemailer parses the URL (smtp:// or smtps://), picks pool /
 *     secure / port settings from it, and applies sane defaults — no
 *     extra plumbing required here.
 *   - Provide `sendMail({ to, subject, text, html, replyTo })`, the
 *     low-level send used by the rest of the codebase. `from` is always
 *     populated from `env.MAIL_FROM` so callers cannot accidentally spoof
 *     the envelope sender.
 *   - Provide `sendTemplate(to, templateKey, vars, locale)`, the
 *     high-level helper used by features like password reset, member
 *     invitations, and admin notices. It looks up the template by key
 *     in a built-in registry keyed by locale (`id`/`en`), interpolates
 *     `${name}` placeholders against `vars`, and forwards the rendered
 *     payload to `sendMail`.
 *   - Allow the runtime i18n layer (task 4.8) to override the built-in
 *     registry via `setI18n(t)`. When set, `sendTemplate` prefers the
 *     injected `t(key, vars, locale)` function for both subject and body
 *     text, and falls back to the built-in registry only when `t()`
 *     returns a missing/empty string.
 *   - Provide `closeMailer()` so worker / web shutdown can drain the
 *     SMTP pool cleanly.
 *
 * References:
 *   - requirements.md §1.7 — password reset email link.
 *   - requirements.md §2.2 — invitations sent via email.
 *   - design.md "Tech stack" — Nodemailer over SMTP using `SMTP_URL` and
 *     `MAIL_FROM` from env.
 */

const nodemailer = require('nodemailer');

const { getEnv } = require('../shared/env');
const { getLogger } = require('./logger');

// ---------------------------------------------------------------------------
// Built-in template registry
// ---------------------------------------------------------------------------

/**
 * Email templates keyed by template key. Each entry stores the
 * Indonesian (`_id`) and English (`_en`) variants of subject and body
 * text. Body is plain text only — HTML variants can be added when the
 * brand styling layer lands without changing the public API.
 *
 * Placeholders use `${name}` syntax and are resolved against the `vars`
 * object passed to `sendTemplate`. Missing keys render as the empty
 * string so a malformed call cannot leak the literal `${...}` token to
 * the recipient.
 */
const TEMPLATES = Object.freeze({
  password_reset: {
    subject_id: 'Atur ulang kata sandi Anda',
    subject_en: 'Reset your password',
    text_id:
      'Halo ${name},\n\n' +
      'Kami menerima permintaan untuk mengatur ulang kata sandi akun Anda. ' +
      'Klik tautan berikut untuk melanjutkan (berlaku ${expires_in}):\n\n' +
      '${reset_url}\n\n' +
      'Jika Anda tidak meminta ini, abaikan email ini — kata sandi Anda tidak akan berubah.',
    text_en:
      'Hi ${name},\n\n' +
      'We received a request to reset your account password. ' +
      'Click the link below to continue (valid for ${expires_in}):\n\n' +
      '${reset_url}\n\n' +
      'If you did not request this, you can safely ignore this email — your password will not change.',
  },
  invitation: {
    subject_id: 'Anda diundang untuk bergabung di ${workspace}',
    subject_en: 'You are invited to join ${workspace}',
    text_id:
      'Halo,\n\n' +
      '${inviter} mengundang Anda untuk bergabung di workspace "${workspace}" sebagai ${role}. ' +
      'Klik tautan berikut untuk menerima undangan (berlaku ${expires_in}):\n\n' +
      '${accept_url}\n\n' +
      'Jika Anda tidak mengenal pengirim, abaikan email ini.',
    text_en:
      'Hello,\n\n' +
      '${inviter} has invited you to join the "${workspace}" workspace as ${role}. ' +
      'Click the link below to accept (valid for ${expires_in}):\n\n' +
      '${accept_url}\n\n' +
      'If you do not recognise the sender, you can ignore this email.',
  },
  connection_invalid: {
    subject_id: 'Koneksi Telegram "${connection_name}" perlu diperbaiki',
    subject_en: 'Telegram connection "${connection_name}" needs attention',
    text_id:
      'Halo ${name},\n\n' +
      'Koneksi Telegram "${connection_name}" Anda saat ini tidak aktif. ' +
      'Penyebab: ${reason}.\n\n' +
      'Buka dasbor untuk menyambung ulang:\n${dashboard_url}',
    text_en:
      'Hi ${name},\n\n' +
      'Your Telegram connection "${connection_name}" is currently inactive. ' +
      'Reason: ${reason}.\n\n' +
      'Open the dashboard to reconnect:\n${dashboard_url}',
  },
  ai_disabled: {
    subject_id: 'Auto-reply AI dinonaktifkan untuk ${workspace}',
    subject_en: 'AI auto-reply has been disabled for ${workspace}',
    text_id:
      'Halo ${name},\n\n' +
      'Fitur auto-reply berbasis AI pada workspace "${workspace}" telah dinonaktifkan. ' +
      'Penyebab: ${reason}.\n\n' +
      'Anda dapat mengaktifkannya kembali setelah masalah ditangani:\n${dashboard_url}',
    text_en:
      'Hi ${name},\n\n' +
      'AI-powered auto-reply on the "${workspace}" workspace has been disabled. ' +
      'Reason: ${reason}.\n\n' +
      'You can re-enable it once the issue is resolved:\n${dashboard_url}',
  },
});

const SUPPORTED_LOCALES = Object.freeze(['id', 'en']);
const DEFAULT_LOCALE = 'en';

/**
 * Normalise an arbitrary locale tag (`id`, `id-ID`, `en`, `en-US`, …) to
 * one of the locales the registry actually carries. Anything unknown
 * falls back to `DEFAULT_LOCALE` so callers cannot end up with an
 * untranslated subject line.
 *
 * @param {string|undefined|null} locale
 * @returns {'id'|'en'}
 */
function normaliseLocale(locale) {
  if (typeof locale !== 'string' || locale.length === 0) return DEFAULT_LOCALE;
  const head = locale.toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(head) ? head : DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERN = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * Replace `${name}` placeholders in `template` with values from `vars`.
 * Missing keys (or non-stringifiable values like `undefined`/`null`)
 * render as the empty string so the recipient never sees the literal
 * placeholder. Numbers and booleans are coerced via `String(...)`.
 *
 * The implementation uses `String.prototype.replace` with a callback so
 * we do not have to worry about regex-special characters in the
 * variable name (the pattern itself is a fixed regex).
 *
 * @param {string} template
 * @param {Record<string, unknown>} [vars]
 * @returns {string}
 */
function interpolate(template, vars) {
  if (typeof template !== 'string' || template.length === 0) return '';
  const safeVars = vars && typeof vars === 'object' ? vars : {};
  return template.replace(PLACEHOLDER_PATTERN, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(safeVars, key)) return '';
    const value = safeVars[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

// ---------------------------------------------------------------------------
// i18n hook
// ---------------------------------------------------------------------------

/**
 * Optional translation function injected by the i18n module (task 4.8).
 * Signature: `t(key, vars, locale) => string`.
 *
 * `sendTemplate` calls `t()` for two derived keys per template:
 *   - `email.<templateKey>.subject`
 *   - `email.<templateKey>.body`
 * If `t()` returns a non-empty string, that value wins. Otherwise we
 * fall back to the built-in registry so password resets keep working
 * even before i18n is wired up.
 *
 * @type {((key: string, vars: Record<string, unknown>, locale: string) => string|undefined|null) | null}
 */
let translateFn = null;

/**
 * Register / clear the i18n translation function. Pass `null` (or omit)
 * to revert to the built-in registry — useful for tests.
 *
 * @param {((key: string, vars: Record<string, unknown>, locale: string) => string|undefined|null) | null} [fn]
 */
function setI18n(fn) {
  if (fn === undefined || fn === null) {
    translateFn = null;
    return;
  }
  if (typeof fn !== 'function') {
    throw new TypeError('setI18n: translate function must be a function or null');
  }
  translateFn = fn;
}

/**
 * Try the injected `t()` first, fall back to the built-in registry. The
 * built-in lookup uses `${locale}` suffix on the registry entry keys
 * (e.g. `subject_id`, `text_en`). Returns the empty string when nothing
 * is found so callers can decide how to handle missing translations.
 *
 * @param {string} templateKey
 * @param {'subject'|'body'} part
 * @param {Record<string, unknown>} vars
 * @param {'id'|'en'} locale
 * @returns {string}
 */
function resolveTemplateString(templateKey, part, vars, locale) {
  if (translateFn) {
    try {
      const translated = translateFn(`email.${templateKey}.${part}`, vars, locale);
      if (typeof translated === 'string' && translated.length > 0) {
        // i18n libraries (e.g. i18next) typically interpolate themselves,
        // but our registry uses `${name}` placeholders. To stay
        // predictable, we pass through `interpolate` so either source
        // ends up with the same substitution semantics. Calling
        // `interpolate` on a fully-resolved string is a no-op.
        return interpolate(translated, vars);
      }
    } catch (err) {
      getLogger().warn(
        { err, templateKey, part, locale },
        'mailer: i18n translateFn threw, falling back to built-in registry'
      );
    }
  }

  const entry = TEMPLATES[templateKey];
  if (!entry) return '';
  const registryKey = part === 'subject' ? `subject_${locale}` : `text_${locale}`;
  const fallbackKey = part === 'subject' ? `subject_${DEFAULT_LOCALE}` : `text_${DEFAULT_LOCALE}`;
  const raw =
    typeof entry[registryKey] === 'string' && entry[registryKey].length > 0
      ? entry[registryKey]
      : entry[fallbackKey];
  return interpolate(raw, vars);
}

// ---------------------------------------------------------------------------
// Transporter (lazy singleton)
// ---------------------------------------------------------------------------

/** @type {import('nodemailer').Transporter|undefined} */
let transporter;

/**
 * Build the SMTP transporter on first use. `nodemailer.createTransport`
 * accepts the SMTP URL directly and infers `secure`, `port`, and auth
 * from it. We do not enable connection pooling explicitly because the
 * URL already encodes the policy (e.g. `?pool=true`) when operators
 * want it; the default unpooled transport is the safer choice for
 * mixed-traffic SMTP relays.
 *
 * @returns {import('nodemailer').Transporter}
 */
function getTransporter() {
  if (!transporter) {
    const env = getEnv();
    transporter = nodemailer.createTransport(env.SMTP_URL);
  }
  return transporter;
}

/**
 * Tear down the cached transporter. Idempotent — calling it twice (or
 * before any send happened) is a no-op. Used by graceful-shutdown
 * handlers and by tests that recycle the module.
 */
function closeMailer() {
  if (!transporter) return;
  try {
    // `close()` is synchronous on the SMTP transport and tears down any
    // pool connections. Wrap in try/catch so a partial setup cannot
    // throw out of a shutdown handler.
    transporter.close();
  } catch (err) {
    getLogger().warn(
      { err },
      'mailer: transporter.close() threw during shutdown — continuing'
    );
  } finally {
    transporter = undefined;
  }
}

// ---------------------------------------------------------------------------
// Send primitives
// ---------------------------------------------------------------------------

/**
 * Low-level send. The envelope `from` is always taken from
 * `env.MAIL_FROM` so individual call sites cannot accidentally forge
 * the sender; pass `replyTo` instead when a reply destination differs.
 *
 * @param {object} payload
 * @param {string|string[]} payload.to       Recipient address(es).
 * @param {string} payload.subject           Subject line (already localised).
 * @param {string} [payload.text]            Plain-text body.
 * @param {string} [payload.html]            Optional HTML body.
 * @param {string} [payload.replyTo]         Optional Reply-To header.
 * @returns {Promise<import('nodemailer/lib/smtp-transport').SentMessageInfo>}
 */
async function sendMail({ to, subject, text, html, replyTo } = {}) {
  if (!to || (typeof to !== 'string' && !Array.isArray(to))) {
    throw new TypeError('sendMail: "to" must be a string or array of addresses');
  }
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new TypeError('sendMail: "subject" must be a non-empty string');
  }
  if (text === undefined && html === undefined) {
    throw new TypeError('sendMail: at least one of "text" or "html" is required');
  }

  const env = getEnv();
  const message = {
    from: env.MAIL_FROM,
    to,
    subject,
  };
  if (typeof text === 'string') message.text = text;
  if (typeof html === 'string') message.html = html;
  if (typeof replyTo === 'string' && replyTo.length > 0) message.replyTo = replyTo;

  const log = getLogger();
  try {
    const info = await getTransporter().sendMail(message);
    log.info(
      {
        to,
        subject,
        messageId: info && info.messageId,
        accepted: info && info.accepted,
        rejected: info && info.rejected,
      },
      'mailer: message sent'
    );
    return info;
  } catch (err) {
    log.error({ err, to, subject }, 'mailer: send failed');
    throw err;
  }
}

/**
 * Render and send a templated email.
 *
 *   await sendTemplate('user@example.com', 'password_reset', {
 *     name: 'Alex',
 *     reset_url: 'https://app.example.com/reset?token=…',
 *     expires_in: '1 hour',
 *   }, 'id');
 *
 * Locale falls back to `'en'` when unsupported, and any unknown
 * template key throws a clear `Error` so misconfigured call sites are
 * caught at integration test time rather than silently dropping mail.
 *
 * @param {string|string[]} to
 * @param {keyof typeof TEMPLATES | string} templateKey
 * @param {Record<string, unknown>} [vars]
 * @param {string} [locale='en']
 * @returns {Promise<import('nodemailer/lib/smtp-transport').SentMessageInfo>}
 */
async function sendTemplate(to, templateKey, vars = {}, locale = DEFAULT_LOCALE) {
  if (typeof templateKey !== 'string' || templateKey.length === 0) {
    throw new TypeError('sendTemplate: "templateKey" must be a non-empty string');
  }
  // When no i18n function is registered we require a known built-in
  // template; with i18n the consumer is free to introduce new keys
  // outside the registry as long as `t()` resolves them.
  if (!translateFn && !TEMPLATES[templateKey]) {
    throw new Error(`sendTemplate: unknown template key "${templateKey}"`);
  }

  const safeLocale = normaliseLocale(locale);
  const safeVars = vars && typeof vars === 'object' ? vars : {};

  const subject = resolveTemplateString(templateKey, 'subject', safeVars, safeLocale);
  const text = resolveTemplateString(templateKey, 'body', safeVars, safeLocale);

  if (subject.length === 0 || text.length === 0) {
    throw new Error(
      `sendTemplate: template "${templateKey}" rendered to empty subject or body for locale "${safeLocale}"`
    );
  }

  return sendMail({ to, subject, text });
}

module.exports = {
  // primary API
  getTransporter,
  closeMailer,
  sendMail,
  sendTemplate,
  setI18n,
  // exported for tests / advanced callers
  TEMPLATES,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  interpolate,
  normaliseLocale,
};
