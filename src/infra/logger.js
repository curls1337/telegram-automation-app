'use strict';

/**
 * Structured logging (Pino → stdout JSON) with secret redaction.
 *
 * Responsibilities:
 *   - Build and cache a single Pino root logger for the whole process,
 *     emitting newline-delimited JSON on stdout at the level taken from
 *     `env.LOG_LEVEL`.
 *   - Apply a comprehensive redaction list so credentials, session
 *     strings, tokens, API keys, passwords, passphrases, encrypted
 *     payloads, and inbound HTTP `Authorization` / `Cookie` headers are
 *     replaced with the literal string `'[REDACTED]'` before anything is
 *     written. Pino's redact mechanism walks the object once at log
 *     time, so structured fields under those paths never reach stdout
 *     and never get persisted by the log pipeline.
 *   - Provide `createRequestLogger(req)`, a per-request child logger
 *     with stable bindings (`reqId`, `method`, `url`) so every line
 *     emitted while serving a single HTTP request can be correlated.
 *     `reqId` is taken from `req.id` when present (compatible with
 *     `pino-http` and similar middleware), otherwise generated via
 *     `crypto.randomUUID()` (RFC 4122 v4).
 *
 * References:
 *   - requirements.md §21.6 — structured JSON logs with reqId, redaction
 *     of secrets/tokens/session strings.
 *   - design.md Property 30 — sensitive fields must never appear in
 *     log output regardless of where they sit in the payload.
 *
 * Notes:
 *   - Pino redact paths support a single wildcard segment (`*`) at any
 *     position (e.g. `*.token` matches `req.body.token` and
 *     `payload.token`, but not `req.body.user.token`). To cover deeper
 *     nesting we list the most common shapes explicitly. Callers that
 *     log secret-bearing payloads should still pass the secret under
 *     one of these well-known keys.
 *   - `pino-pretty` is intentionally not a dependency — production
 *     consumers (Loki/Grafana, Sevalla log drains, plain `journalctl`)
 *     prefer raw JSON, and dev-time pretty printing can be enabled
 *     downstream via `node ... | pino-pretty` if desired.
 */

const { randomUUID } = require('node:crypto');

const pino = require('pino');

const { getEnv } = require('../shared/env');

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Paths whose values must be replaced before serialization. Pino accepts a
 * mix of literal dotted paths and single-wildcard segments; we list every
 * shape we actually emit (or are likely to emit) instead of relying on a
 * deep-wildcard syntax that pino does not support.
 *
 * Keep this list in sync with the security review checklist in
 * design.md — adding a new credential-bearing field anywhere in the
 * codebase should mean adding the relevant key here too.
 */
const REDACT_PATHS = Object.freeze([
  // HTTP request headers (Express / pino-http shape)
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',

  // Outbound HTTP response headers
  'res.headers["set-cookie"]',

  // Request body / query / params one level deep — covers most route
  // handlers and middleware logging the parsed payload directly.
  'req.body.token',
  'req.body.password',
  'req.body.passphrase',
  'req.body.api_key',
  'req.body.apiKey',
  'req.body.session',
  'req.body.session_string',
  'req.body.secret',
  'req.body.authorization',
  'req.body.botToken',
  'req.body.api_hash',
  'req.body.encrypted_secret',
  'req.query.token',
  'req.query.api_key',
  'req.query.apiKey',

  // Generic single-wildcard catch-all for our own structured payloads.
  // Pino expands `*.field` to "any direct child of the root object whose
  // own property is `field`" — so `logger.info({ user: { password } })`
  // is covered by `*.password` too.
  '*.token',
  '*.tokens',
  '*.password',
  '*.passphrase',
  '*.api_key',
  '*.apiKey',
  '*.secret',
  '*.session',
  '*.session_string',
  '*.authorization',
  '*.botToken',
  '*.api_hash',
  '*.encrypted_secret',
]);

const REDACT_CENSOR = '[REDACTED]';

// ---------------------------------------------------------------------------
// Root logger (lazy singleton)
// ---------------------------------------------------------------------------

/** @type {import('pino').Logger|undefined} */
let rootLogger;

/**
 * Build the pino root logger options object. Exported via the module's
 * shape only indirectly (tests can re-import after `resetLoggerCache`),
 * so we keep it as a private helper and inline its result.
 *
 * @param {ReturnType<typeof getEnv>} env
 * @returns {import('pino').LoggerOptions}
 */
function buildLoggerOptions(env) {
  return {
    level: env.LOG_LEVEL,
    // Emit ISO-8601 timestamps so log aggregators (Loki, ELK, the
    // Sevalla log drain) parse them as real datetimes instead of
    // millisecond integers.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      // Standard service-identifying bindings on every line. Hostname is
      // disabled (`base: { ... }` overrides pino's default which would
      // also include `hostname` and `pid`) — the orchestrator already
      // labels each container, and pid leaks process information that
      // is not useful in aggregated logs.
      service: 'telegram-automation-app',
      env: env.NODE_ENV,
    },
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
      // Remove == false so the censored value still shows up; that way
      // operators can see "this field existed but was scrubbed" instead
      // of being unable to tell the field was present at all.
      remove: false,
    },
    // Pino formats Error instances via this hook by default when
    // `serializers.err` is set; pino's stdSerializers handles message,
    // stack, and `cause` chains.
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  };
}

/**
 * Return the lazily-constructed root logger. The first call validates env
 * (via `getEnv()`) and creates the underlying pino instance writing JSON
 * to stdout; subsequent calls return the same instance.
 *
 * @returns {import('pino').Logger}
 */
function getLogger() {
  if (!rootLogger) {
    const env = getEnv();
    // `pino.destination(1)` writes to file descriptor 1 (stdout) in
    // sync, line-buffered mode — the safest choice for containerised
    // Node processes whose stdout is consumed by the runtime.
    rootLogger = pino(buildLoggerOptions(env), pino.destination(1));
  }
  return rootLogger;
}

/**
 * Drop the cached root logger. Intended for tests that mutate env and
 * need a fresh logger instance with the new configuration.
 */
function resetLoggerCache() {
  rootLogger = undefined;
}

// ---------------------------------------------------------------------------
// Per-request child logger
// ---------------------------------------------------------------------------

/**
 * Pull the request id from common middleware shapes, falling back to a
 * freshly generated UUID v4. Accepts a missing/partial request object so
 * worker code can `createRequestLogger({})` for synthetic correlation.
 *
 * @param {{ id?: string, reqId?: string, headers?: Record<string,string|string[]> }} [req]
 * @returns {string}
 */
function resolveRequestId(req) {
  if (!req || typeof req !== 'object') return randomUUID();
  if (typeof req.id === 'string' && req.id.length > 0) return req.id;
  if (typeof req.reqId === 'string' && req.reqId.length > 0) return req.reqId;
  const headerVal = req.headers && (req.headers['x-request-id'] || req.headers['X-Request-Id']);
  if (typeof headerVal === 'string' && headerVal.length > 0) return headerVal;
  return randomUUID();
}

/**
 * Build a child logger bound to a single inbound HTTP request. Every line
 * emitted through the returned logger inherits `{ reqId, method, url }`,
 * which is the minimum context needed to reconstruct a request timeline
 * from the aggregated log stream.
 *
 *   const log = createRequestLogger(req);
 *   log.info({ outcome: 'ok' }, 'authenticated');
 *   // → {"level":30,"time":"…","reqId":"…","method":"POST","url":"/login","outcome":"ok","msg":"authenticated"}
 *
 * @param {object} [req] Express-style request (or any object with `id`,
 *   `method`, `url`, `originalUrl`).
 * @returns {import('pino').Logger}
 */
function createRequestLogger(req) {
  const safeReq = req && typeof req === 'object' ? req : {};
  const bindings = {
    reqId: resolveRequestId(safeReq),
    method: typeof safeReq.method === 'string' ? safeReq.method : undefined,
    // Prefer `originalUrl` (Express keeps the pre-router path there) and
    // fall back to `url`. Either way we strip undefined values below so
    // the output stays clean for non-HTTP callers.
    url:
      typeof safeReq.originalUrl === 'string'
        ? safeReq.originalUrl
        : typeof safeReq.url === 'string'
          ? safeReq.url
          : undefined,
  };
  // Drop undefined keys so worker-side callers that pass `{}` do not get
  // `"method":null,"url":null` noise on every line.
  for (const key of Object.keys(bindings)) {
    if (bindings[key] === undefined) delete bindings[key];
  }
  return getLogger().child(bindings);
}

module.exports = {
  // primary API
  getLogger,
  createRequestLogger,
  // test / advanced helpers
  resetLoggerCache,
  // exported for documentation/tests — not part of the runtime API
  REDACT_PATHS,
  REDACT_CENSOR,
};
