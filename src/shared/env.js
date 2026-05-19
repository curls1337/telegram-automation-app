'use strict';

/**
 * Environment variable validation for Telegram Automation App.
 *
 * Validates every required runtime configuration value at boot via Zod and
 * exits the process with a clear error message when anything is missing or
 * malformed. Loaders that need access to typed values should call
 * `getEnv()` (lazy, validated once) or `loadEnv(rawEnv, options)` for tests.
 *
 * References:
 *  - Requirement 21.2 (requirements.md): the platform reads runtime config
 *    via environment variables.
 *  - Property 31 (design.md): incomplete env => non-zero exit; complete => boot.
 */

const { z } = require('zod');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Zod refinement that requires a string to decode (base64) into a
 * buffer of exactly `expectedBytes` bytes. Used to enforce 32-byte AES keys.
 */
function base64BufferOfLength(expectedBytes) {
  // Strict-ish base64 alphabet with optional padding. `Buffer.from` silently
  // ignores invalid characters, so guard with a regex first.
  const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
  return (val) => {
    if (typeof val !== 'string' || val.length === 0) return false;
    if (!base64Pattern.test(val)) return false;
    let buf;
    try {
      buf = Buffer.from(val, 'base64');
    } catch (_err) {
      return false;
    }
    return buf.length === expectedBytes;
  };
}

const base64Key32Message = (label) =>
  `${label} must be base64-encoded and decode to exactly 32 bytes (256 bits)`;

const isPostgresUrl = (u) => /^postgres(ql)?:\/\//i.test(u);
const isRedisUrl = (u) => /^rediss?:\/\//i.test(u);
const isSmtpUrl = (u) => /^smtps?:\/\//i.test(u);

/**
 * Coerces common truthy strings ('1', 'true', 'yes', 'on') to a boolean.
 * Undefined/empty/anything else becomes `false`.
 */
const booleanFlag = z
  .union([z.string(), z.boolean(), z.undefined(), z.null()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (v == null) return false;
    return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
  });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z
  .object({
    // ---- Runtime ----------------------------------------------------------
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce
      .number({ invalid_type_error: 'PORT must be a number' })
      .int()
      .min(1)
      .max(65535)
      .default(8080),
    BASE_URL: z
      .string()
      .min(1, 'BASE_URL is required')
      .url('BASE_URL must be a valid URL'),
    TRUST_PROXY: z.string().min(1).default('loopback'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // ---- Database --------------------------------------------------------
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(isPostgresUrl, 'DATABASE_URL must start with postgres:// or postgresql://'),
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(2),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(20),

    // ---- Redis -----------------------------------------------------------
    REDIS_URL: z
      .string()
      .min(1, 'REDIS_URL is required')
      .refine(isRedisUrl, 'REDIS_URL must start with redis:// or rediss://'),

    // ---- Session ---------------------------------------------------------
    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters'),

    // ---- AES-256-GCM master keys -----------------------------------------
    APP_MASTER_KEY: z
      .string()
      .min(1, 'APP_MASTER_KEY is required')
      .refine(
        base64BufferOfLength(32),
        base64Key32Message('APP_MASTER_KEY')
      ),
    APP_MASTER_KEY_PREV: z
      .string()
      .optional()
      .refine(
        (v) => v == null || v === '' || base64BufferOfLength(32)(v),
        base64Key32Message('APP_MASTER_KEY_PREV')
      ),
    APP_MASTER_KEY_ID: z.string().min(1).default('v1'),

    // ---- Object Storage (S3-compatible) ----------------------------------
    S3_ENDPOINT: z
      .string()
      .min(1, 'S3_ENDPOINT is required')
      .url('S3_ENDPOINT must be a valid URL'),
    S3_REGION: z.string().min(1, 'S3_REGION is required'),
    S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY is required'),
    S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY is required'),
    S3_BUCKET: z.string().min(1, 'S3_BUCKET is required'),

    // ---- Email (SMTP) ----------------------------------------------------
    SMTP_URL: z
      .string()
      .min(1, 'SMTP_URL is required')
      .refine(isSmtpUrl, 'SMTP_URL must start with smtp:// or smtps://'),
    MAIL_FROM: z
      .string()
      .min(1, 'MAIL_FROM is required')
      .email('MAIL_FROM must be a valid email address'),

    // ---- AI provider (optional) ------------------------------------------
    GEMINI_API_KEY: z
      .string()
      .optional()
      .transform((v) => (v === '' ? undefined : v)),
    GEMINI_DEFAULT_MODEL: z.string().min(1).default('gemini-1.5-flash'),

    // ---- Super admin bootstrap (used by seed script) ---------------------
    SUPER_ADMIN_EMAIL: z
      .string()
      .min(1, 'SUPER_ADMIN_EMAIL is required')
      .email('SUPER_ADMIN_EMAIL must be a valid email address'),
    SUPER_ADMIN_PASSWORD: z
      .string()
      .min(8, 'SUPER_ADMIN_PASSWORD must be at least 8 characters'),

    // ---- Concurrency & limits --------------------------------------------
    WEB_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    WORKER_CONCURRENCY_DEFAULT: z.coerce.number().int().min(1).default(5),
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(5),
    BACKUP_PASSPHRASE_PBKDF2_ITERS: z.coerce
      .number()
      .int()
      .min(50000, 'BACKUP_PASSPHRASE_PBKDF2_ITERS must be ≥ 50000')
      .default(200000),

    // ---- Observability ---------------------------------------------------
    METRICS_ENABLED: booleanFlag,
  })
  .superRefine((data, ctx) => {
    if (data.DATABASE_POOL_MAX < data.DATABASE_POOL_MIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_POOL_MAX must be greater than or equal to DATABASE_POOL_MIN',
        path: ['DATABASE_POOL_MAX'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Format Zod issues as a human-readable, developer-friendly string.
 */
function formatIssues(issues) {
  return issues
    .map((issue) => {
      const path = issue.path && issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  • ${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Validate environment variables and return the parsed object.
 *
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [rawEnv=process.env]
 * @param {{ exitOnError?: boolean }} [options]
 *   When `exitOnError` is true (default), invalid env causes a clear message on
 *   stderr and `process.exit(1)`. When false, throws an Error with `.issues`.
 * @returns {object} validated env, augmented with `appMasterKey` /
 *   `appMasterKeyPrev` Buffers for convenience.
 */
function loadEnv(rawEnv = process.env, options = {}) {
  const { exitOnError = true } = options;
  const result = schema.safeParse(rawEnv);

  if (!result.success) {
    const message =
      'Invalid or missing environment variables — refusing to boot.\n' +
      `${formatIssues(result.error.issues)}\n` +
      '\nSee .env.example for the full list of required variables.\n';

    if (exitOnError) {
      // Avoid logger dependency: write straight to stderr so the message is
      // visible even when nothing else is wired up yet.
      process.stderr.write(`\n[env] ${message}\n`);
      // eslint-disable-next-line n/no-process-exit
      process.exit(1);
    }

    const err = new Error('Environment validation failed');
    err.issues = result.error.issues;
    err.formatted = message;
    throw err;
  }

  const env = result.data;

  // Decoded buffers used by the crypto module (task 2.5). Cached on the
  // returned object so callers do not re-decode on every access.
  Object.defineProperty(env, 'appMasterKey', {
    value: Buffer.from(env.APP_MASTER_KEY, 'base64'),
    enumerable: false,
  });
  Object.defineProperty(env, 'appMasterKeyPrev', {
    value:
      env.APP_MASTER_KEY_PREV && env.APP_MASTER_KEY_PREV.length > 0
        ? Buffer.from(env.APP_MASTER_KEY_PREV, 'base64')
        : null,
    enumerable: false,
  });

  return env;
}

let cached;

/**
 * Lazily validate `process.env` once and return the cached result.
 * The first call performs validation; subsequent calls return the same object.
 */
function getEnv() {
  if (!cached) {
    cached = loadEnv(process.env);
  }
  return cached;
}

/**
 * Reset the memoised env. Intended for tests that mutate process.env.
 */
function resetEnvCache() {
  cached = undefined;
}

module.exports = {
  schema,
  loadEnv,
  getEnv,
  resetEnvCache,
};
