'use strict';

/**
 * Object Storage access layer (S3-compatible: MinIO, Cloudflare R2, AWS S3).
 *
 * Responsibilities:
 *   - Build and cache a single `S3Client` for the entire process,
 *     configured for path-style addressing (`forcePathStyle: true`) so the
 *     same code talks to MinIO in dev (`http://minio:9000/<bucket>/<key>`),
 *     to AWS S3 in prod, and to Cloudflare R2 (which also accepts path
 *     style). The endpoint, region, and credentials all come from env.
 *   - Provide a small, stream-friendly API tailored to this app's use
 *     cases — media library uploads/downloads, encrypted backups, CSV /
 *     PDF report exports, and presigned URLs for short-lived browser
 *     downloads:
 *
 *       putObject({ key, body, contentType, contentLength?, metadata? })
 *       getObject(key) → { body, contentType, contentLength, metadata }
 *       deleteObject(key)
 *       presignedGetUrl(key, ttlSeconds = 300)
 *       objectExists(key)
 *
 *   - All commands accept an optional `{ bucket }` to override the
 *     default bucket from `S3_BUCKET` (used by the per-tenant backup
 *     flow that may target a Tenant-supplied bucket per Requirement 16.8).
 *   - Defer client construction until first use (`getS3Client()`), so
 *     importing this module never opens a socket — boot order stays
 *     deterministic and tests can stub env first.
 *   - Provide `closeS3()` for graceful shutdown and tests.
 *
 * References:
 *   - requirements.md §17.1 — Object key prefixed with `tenant_id`.
 *   - requirements.md §17.4 — Connection_Manager fetches files from
 *     Object_Storage and uploads to Telegram via multipart.
 *   - requirements.md §21.2 — Runtime config sourced from env.
 *   - design.md "Object storage" — `@aws-sdk/client-s3` + presigned URL.
 *
 * NOTE: the project logger (task 2.7) is not built yet, so transient
 * errors are forwarded to `console.error` with a stable `[s3]` prefix.
 * Once `src/shared/logger.js` lands, swap the handler for the structured
 * logger without changing the public API of this file.
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { getEnv } = require('../shared/env');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_PRESIGN_TTL_SECONDS = 300; // 5 minutes — short-lived by default
const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60; // AWS hard cap for SigV4

/**
 * Build the `S3ClientConfig` shared by the singleton. Exported so tests can
 * assert the resolved options without poking at the private client.
 *
 * `forcePathStyle: true` is required for MinIO (which does not implement
 * virtual-hosted-style buckets) and is also accepted by AWS S3 and R2, so
 * we use it unconditionally and let the endpoint URL drive the routing.
 *
 * @param {ReturnType<typeof getEnv>} env
 * @returns {import('@aws-sdk/client-s3').S3ClientConfig}
 */
function buildS3Config(env) {
  return {
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

/** @type {import('@aws-sdk/client-s3').S3Client|undefined} */
let client;

/**
 * Return the lazily-constructed `S3Client` singleton. Subsequent calls
 * return the same instance.
 *
 * @returns {import('@aws-sdk/client-s3').S3Client}
 */
function getS3Client() {
  if (!client) {
    const env = getEnv();
    client = new S3Client(buildS3Config(env));
  }
  return client;
}

/**
 * Destroy the cached `S3Client`. Idempotent — safe to call from shutdown
 * handlers and from tests that want to recycle the singleton between
 * cases. Per AWS SDK v3 docs, `destroy()` releases the underlying HTTPS
 * agent's sockets but is not async.
 *
 * @returns {Promise<void>}
 */
async function closeS3() {
  if (!client) return;
  const current = client;
  client = undefined;
  try {
    current.destroy();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[s3] destroy failed: ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the bucket to use for a request. Falls back to `S3_BUCKET` when
 * the caller does not pass an explicit override.
 *
 * @param {string} [override]
 * @returns {string}
 */
function resolveBucket(override) {
  if (typeof override === 'string' && override.length > 0) return override;
  return getEnv().S3_BUCKET;
}

/**
 * Validate that `key` is a non-empty string. Object keys are user-facing
 * (they are persisted in the database and surfaced via presigned URLs),
 * so we want a single, clear error rather than a deep SDK error.
 *
 * @param {unknown} key
 * @param {string} fnName
 */
function assertKey(key, fnName) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError(`${fnName}: key must be a non-empty string`);
  }
}

// ---------------------------------------------------------------------------
// Public API — putObject
// ---------------------------------------------------------------------------

/**
 * Upload an object. `body` may be:
 *   - a `Buffer` (small, in-memory payloads — typically <5 MB),
 *   - a `Readable` stream (large media files, encrypted backups, CSV
 *     exports — anything we want to keep out of memory).
 *
 * Buffers go through a single `PutObjectCommand` (one HTTP request, the
 * cheapest path). Streams go through `@aws-sdk/lib-storage`'s `Upload`
 * helper, which transparently uses S3 multipart uploads with parallel
 * part uploads — required for files that can exceed a few MB and that
 * we cannot length-prefix in advance.
 *
 * @param {object} params
 * @param {string} params.key                    object key (e.g. `tenants/<tid>/media/<uuid>.jpg`)
 * @param {Buffer|NodeJS.ReadableStream} params.body
 * @param {string} [params.contentType]          MIME type (recommended; surfaces in presigned URL responses)
 * @param {number} [params.contentLength]        byte length when known (lets S3 short-circuit)
 * @param {Record<string,string>} [params.metadata]  user metadata (`x-amz-meta-*`)
 * @param {string} [params.bucket]               override default bucket
 * @returns {Promise<{ key: string, bucket: string, etag: string|undefined }>}
 */
async function putObject({ key, body, contentType, contentLength, metadata, bucket } = {}) {
  assertKey(key, 'putObject');
  if (body == null) {
    throw new TypeError('putObject: body is required');
  }

  const Bucket = resolveBucket(bucket);
  const s3 = getS3Client();
  const isBuffer = Buffer.isBuffer(body);

  const baseParams = {
    Bucket,
    Key: key,
    Body: body,
  };
  if (contentType) baseParams.ContentType = contentType;
  if (typeof contentLength === 'number' && contentLength >= 0) {
    baseParams.ContentLength = contentLength;
  }
  if (metadata && typeof metadata === 'object') {
    baseParams.Metadata = metadata;
  }

  let etag;
  if (isBuffer) {
    // Single-shot PUT for buffers — fewer round trips than the multipart
    // path, and S3 verifies Content-Length for us.
    const result = await s3.send(new PutObjectCommand(baseParams));
    etag = result.ETag;
  } else {
    // Stream path: lib-storage `Upload` handles multipart, retries, and
    // backpressure. `partSize` defaults to 5 MB which is the S3 minimum;
    // queueSize 4 keeps memory bounded while still saturating the link.
    const upload = new Upload({
      client: s3,
      params: baseParams,
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
      leavePartsOnError: false,
    });
    const result = await upload.done();
    etag = result && result.ETag;
  }

  return { key, bucket: Bucket, etag };
}

// ---------------------------------------------------------------------------
// Public API — getObject
// ---------------------------------------------------------------------------

/**
 * Download an object. Returns the response body as a `Readable` stream
 * along with the headers we care about — the caller is responsible for
 * piping or consuming the stream.
 *
 *   const { body, contentType, contentLength } = await getObject(key);
 *   await pipeline(body, res);   // example: forward to an HTTP response
 *
 * @param {string} key
 * @param {{ bucket?: string }} [opts]
 * @returns {Promise<{
 *   body: NodeJS.ReadableStream,
 *   contentType: string|undefined,
 *   contentLength: number|undefined,
 *   etag: string|undefined,
 *   metadata: Record<string,string>|undefined,
 * }>}
 */
async function getObject(key, opts = {}) {
  assertKey(key, 'getObject');
  const Bucket = resolveBucket(opts.bucket);
  const s3 = getS3Client();
  const result = await s3.send(new GetObjectCommand({ Bucket, Key: key }));

  return {
    body: /** @type {NodeJS.ReadableStream} */ (result.Body),
    contentType: result.ContentType,
    contentLength:
      typeof result.ContentLength === 'number' ? result.ContentLength : undefined,
    etag: result.ETag,
    metadata: result.Metadata,
  };
}

// ---------------------------------------------------------------------------
// Public API — deleteObject
// ---------------------------------------------------------------------------

/**
 * Delete an object. Idempotent — S3 returns success even if the key does
 * not exist, so callers can use this in cleanup paths without first
 * checking for existence (matches Requirement 17.6 — deletion drives
 * the `media_missing` flag, not the precondition for setting it).
 *
 * @param {string} key
 * @param {{ bucket?: string }} [opts]
 * @returns {Promise<void>}
 */
async function deleteObject(key, opts = {}) {
  assertKey(key, 'deleteObject');
  const Bucket = resolveBucket(opts.bucket);
  const s3 = getS3Client();
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

// ---------------------------------------------------------------------------
// Public API — presignedGetUrl
// ---------------------------------------------------------------------------

/**
 * Generate a presigned GET URL for `key`, valid for `ttlSeconds`.
 *
 * Used by the media library (`MediaService.getDownloadUrl`), backup
 * downloads (Requirement 16), and CSV/PDF report exports — anywhere we
 * need to hand the browser a direct, short-lived link to Object Storage
 * without proxying bytes through the web process.
 *
 * @param {string} key
 * @param {number} [ttlSeconds=300]
 * @param {{ bucket?: string }} [opts]
 * @returns {Promise<string>}
 */
async function presignedGetUrl(key, ttlSeconds = DEFAULT_PRESIGN_TTL_SECONDS, opts = {}) {
  assertKey(key, 'presignedGetUrl');
  if (
    typeof ttlSeconds !== 'number' ||
    !Number.isFinite(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_PRESIGN_TTL_SECONDS
  ) {
    throw new RangeError(
      `presignedGetUrl: ttlSeconds must be a positive number ≤ ${MAX_PRESIGN_TTL_SECONDS}`
    );
  }

  const Bucket = resolveBucket(opts.bucket);
  const s3 = getS3Client();
  const command = new GetObjectCommand({ Bucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn: ttlSeconds });
}

// ---------------------------------------------------------------------------
// Public API — objectExists
// ---------------------------------------------------------------------------

/**
 * Cheap existence check via `HEAD`. Returns `true` when the object is
 * found, `false` for `NotFound` / `404` and any AWS error explicitly
 * tagged `NoSuchKey`. Other errors propagate so callers can distinguish
 * "missing" from "transient outage".
 *
 * @param {string} key
 * @param {{ bucket?: string }} [opts]
 * @returns {Promise<boolean>}
 */
async function objectExists(key, opts = {}) {
  assertKey(key, 'objectExists');
  const Bucket = resolveBucket(opts.bucket);
  const s3 = getS3Client();
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return true;
  } catch (err) {
    // AWS SDK v3 surfaces missing-object responses with several different
    // shapes depending on the backend (S3 / MinIO / R2). Treat any of:
    //   - HTTP 404
    //   - error name `NotFound`
    //   - error name / code `NoSuchKey`
    // as a clean negative answer.
    const status =
      (err && err.$metadata && err.$metadata.httpStatusCode) ||
      (err && err.statusCode) ||
      undefined;
    const name = (err && err.name) || (err && err.Code) || (err && err.code) || '';
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
      return false;
    }
    throw err;
  }
}

module.exports = {
  // builder / config (exported for tests)
  buildS3Config,
  // singleton
  getS3Client,
  // commands
  putObject,
  getObject,
  deleteObject,
  presignedGetUrl,
  objectExists,
  // lifecycle
  closeS3,
};
