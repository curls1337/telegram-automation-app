'use strict';

/**
 * Reusable Zod schemas + parse helpers for the Telegram Automation App.
 *
 * The goal of this module is to centralize the small, frequently-reused input
 * shapes (emails, passwords, UUIDs, slugs, ...) so that every module — HTTP
 * routes, queue jobs, REST API, EJS form handlers — validates the same way.
 *
 * Design references:
 *  - design.md → "Shared utilities" lists `src/shared/validation.js` as the
 *    home of cross-cutting Zod schemas.
 *  - design.md → "Error Handling" expects validation failures to surface as
 *    {@link ValidationError} so that the HTTP error middleware can render a
 *    400 with field-level messages.
 *
 * Conventions:
 *  - Schemas exported here are PrimitiveSchemas — small building blocks that
 *    feature modules compose into larger object schemas (e.g. login form,
 *    create-bot form).
 *  - Helpers (`parseOrThrow`, `formatZodIssues`) are framework-agnostic and
 *    must not reference Express, Jest, or any module-specific concept.
 */

const { z } = require('zod');
const { ValidationError } = require('./errors');

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/**
 * Trimmed, lowercased RFC-5321-ish email address. We trust Zod's built-in
 * email check and additionally normalize the case so that uniqueness lookups
 * in the database remain stable.
 */
const Email = z
  .string({ required_error: 'Email is required' })
  .trim()
  .min(1, 'Email is required')
  .max(254, 'Email is too long')
  .email('Email is invalid')
  .transform((v) => v.toLowerCase());

/**
 * Account password. Minimum 8 characters with at least one letter and one
 * digit. Stronger checks (breach lists, entropy) live in the auth module —
 * this schema is the absolute floor enforced everywhere.
 *
 * Note: the schema deliberately does NOT trim — leading/trailing spaces are
 * legitimate password characters.
 */
const Password = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(256, 'Password is too long')
  .refine((v) => /[A-Za-z]/.test(v), {
    message: 'Password must contain at least one letter',
  })
  .refine((v) => /\d/.test(v), {
    message: 'Password must contain at least one digit',
  });

/**
 * Canonical RFC-4122 v4 UUID. We accept lowercase only because every
 * generator in this codebase emits lowercase (see `src/shared/ids.js`).
 */
const Uuid = z
  .string({ required_error: 'UUID is required' })
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'UUID is invalid'
  );

/**
 * Non-empty trimmed string. Useful for fields that are optional in the schema
 * sense but, when present, must contain visible characters.
 */
const NonEmptyString = z
  .string()
  .trim()
  .min(1, 'Value must not be empty');

/**
 * URL-friendly slug: lowercase alphanumerics separated by single hyphens,
 * no leading/trailing hyphens, no double hyphens. Length 1..64.
 */
const Slug = z
  .string({ required_error: 'Slug is required' })
  .min(1, 'Slug is required')
  .max(64, 'Slug is too long')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug must be lowercase alphanumerics separated by single hyphens'
  );

/**
 * ISO-8601 date-time string. Zod's built-in `.datetime()` enforces RFC-3339,
 * which is the subset we use for all serialized timestamps.
 */
const IsoDateTime = z
  .string({ required_error: 'Timestamp is required' })
  .datetime({ offset: true, message: 'Timestamp must be ISO-8601' });

/**
 * Telegram bot token, as returned by @BotFather: `<bot_id>:<secret>`.
 *
 * The secret part is base64url-ish (letters, digits, `_`, `-`). Real tokens
 * are typically 35 characters, but Telegram has not published a strict
 * length contract, so we accept 30..50 characters of valid alphabet to stay
 * forward-compatible while still rejecting obvious garbage. Total length
 * lands around 46 characters in practice.
 */
const BotToken = z
  .string({ required_error: 'Bot token is required' })
  .trim()
  .regex(
    /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/,
    'Bot token must look like "<bot_id>:<secret>"'
  );

/**
 * Phone number in E.164 format: leading `+`, 1–15 digits, no spaces or
 * separators. Used for MTProto user-account login.
 */
const PhoneE164 = z
  .string({ required_error: 'Phone number is required' })
  .trim()
  .regex(
    /^\+[1-9]\d{1,14}$/,
    'Phone number must be in E.164 format, e.g. +6281234567890'
  );

/**
 * Supported UI locale. Keep in sync with `locales/*` resource bundles.
 */
const Locale = z.enum(['id', 'en'], {
  required_error: 'Locale is required',
  invalid_type_error: 'Locale must be one of: id, en',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Zod issue array into the JSON-safe `{ path, message }` shape that
 * we attach to {@link ValidationError.details} and render in form UIs.
 *
 * @param {Array<import('zod').ZodIssue>} issues
 * @returns {Array<{ path: string, message: string }>}
 */
function formatZodIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    path:
      issue && Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join('.')
        : '',
    message: issue && issue.message ? issue.message : 'Invalid value',
  }));
}

/**
 * Parse `input` against `schema`. Returns the validated value on success and
 * throws a {@link ValidationError} with `details = [{ path, message }, ...]`
 * on failure. The caller does not need to know about Zod internals.
 *
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} input
 * @param {{ message?: string }} [opts]
 * @returns {T}
 */
function parseOrThrow(schema, input, opts = {}) {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const issues = formatZodIssues(result.error.issues);
  const message = opts.message || 'Validation failed';
  throw new ValidationError(message, { details: issues });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // primitives
  Email,
  Password,
  Uuid,
  NonEmptyString,
  Slug,
  IsoDateTime,
  BotToken,
  PhoneE164,
  Locale,
  // helpers
  parseOrThrow,
  formatZodIssues,
  // re-export the underlying Zod instance for callers that need to compose
  // these schemas into larger ones (e.g. z.object({ email: Email, ... })).
  z,
};
