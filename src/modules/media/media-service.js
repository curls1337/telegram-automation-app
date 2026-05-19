'use strict';

/**
 * Media Service — upload, download, delete, and Telegram file_id caching.
 *
 * Responsibilities:
 *   - Upload media files with MIME validation and size enforcement.
 *   - Generate presigned download URLs.
 *   - Delete media and propagate media_missing to unexecuted references.
 *   - Cache and resolve Telegram file_id per connection to avoid re-uploads.
 *
 * References:
 *   - requirements.md §17.1 — Object key prefixed with tenant_id.
 *   - requirements.md §17.2 — Size limits (50MB Bot, 2GB MTProto).
 *   - requirements.md §17.3 — MIME validation, reject executable/script.
 *   - requirements.md §17.5 — Cache Telegram file_id after first send.
 *   - requirements.md §17.6 — Delete propagates media_missing flag.
 *   - design.md "Media Storage" — MediaService interface.
 */

const { fromBuffer: fileTypeFromBuffer } = require('file-type');

const { getDb, tenantQuery, tenantInsert } = require('../../infra/db');
const { putObject, deleteObject, presignedGetUrl } = require('../../infra/object-storage');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const { newId } = require('../../shared/ids');
const { nowIso } = require('../../shared/time');
const { getLogger } = require('../../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max file size: 50 MB (Bot API limit). */
const MAX_SIZE_BOT = 50 * 1024 * 1024;

/** Max file size for MTProto: 2 GB. */
const MAX_SIZE_MTPROTO = 2 * 1024 * 1024 * 1024;

/** MIME types that are always rejected (executables, scripts). */
const BLOCKED_MIMES = [
  'application/x-executable',
  'application/x-msdos-program',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-msi',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
];

/** MIME prefix patterns that are blocked. */
const BLOCKED_MIME_PREFIXES = [
  'text/x-script',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the media kind from a MIME type.
 *
 * @param {string} mime
 * @returns {'image'|'video'|'audio'|'document'}
 */
function kindFromMime(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Check if a MIME type is blocked.
 *
 * @param {string} mime
 * @returns {boolean}
 */
function isMimeBlocked(mime) {
  if (BLOCKED_MIMES.includes(mime)) return true;
  for (const prefix of BLOCKED_MIME_PREFIXES) {
    if (mime.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Extract extension from file-type result or original filename.
 *
 * @param {object|undefined} ftResult - file-type detection result
 * @param {string} originalName - original filename
 * @returns {string}
 */
function resolveExtension(ftResult, originalName) {
  if (ftResult && ftResult.ext) return ftResult.ext;
  if (originalName && originalName.includes('.')) {
    const parts = originalName.split('.');
    return parts[parts.length - 1].toLowerCase();
  }
  return 'bin';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a media file from a request buffer.
 *
 * @param {string} tenantId
 * @param {Buffer} fileBuffer - The raw file bytes.
 * @param {object} meta
 * @param {string} meta.originalName - Original filename.
 * @param {number} meta.size - File size in bytes.
 * @param {string} meta.userId - Uploader user ID.
 * @param {number} [meta.maxSize] - Max allowed size in bytes (default: 50MB).
 * @returns {Promise<object>} The created media_files record.
 */
async function uploadFromRequest(tenantId, fileBuffer, meta) {
  const log = getLogger();
  const { originalName, size, userId, maxSize } = meta;
  const effectiveMaxSize = maxSize || MAX_SIZE_BOT;

  // Validate size
  if (!size || size <= 0) {
    throw new ValidationError('File size must be greater than zero');
  }
  if (size > effectiveMaxSize) {
    const limitMB = Math.round(effectiveMaxSize / (1024 * 1024));
    throw new ValidationError(`File size exceeds the ${limitMB} MB limit`, {
      details: { maxBytes: effectiveMaxSize, actualBytes: size },
    });
  }

  // Detect MIME type from buffer
  const ftResult = await fileTypeFromBuffer(fileBuffer);
  const mime = (ftResult && ftResult.mime) || 'application/octet-stream';

  // Reject blocked MIME types
  if (isMimeBlocked(mime)) {
    throw new ValidationError('File type not allowed: executable or script files are rejected', {
      details: { mime },
    });
  }

  // Determine kind and extension
  const kind = kindFromMime(mime);
  const ext = resolveExtension(ftResult, originalName);

  // Build object key
  const fileId = newId();
  const objectKey = `tenants/${tenantId}/media/${fileId}.${ext}`;

  // Upload to Object Storage
  await putObject({
    key: objectKey,
    body: fileBuffer,
    contentType: mime,
    contentLength: size,
  });

  // Insert record into database
  const now = nowIso();
  const record = {
    id: fileId,
    uploader_user_id: userId,
    object_key: objectKey,
    mime,
    size_bytes: size,
    original_name: originalName || null,
    kind,
    created_at: now,
    updated_at: now,
  };

  const [inserted] = await tenantInsert(tenantId, 'media_files', record, {
    returning: '*',
  });

  log.info({ mediaId: fileId, tenantId, mime, size, kind }, 'media: file uploaded');

  return inserted;
}

/**
 * Get a presigned download URL for a media file.
 *
 * @param {string} tenantId
 * @param {string} mediaId
 * @returns {Promise<string>} Presigned URL valid for 300 seconds.
 */
async function getDownloadUrl(tenantId, mediaId) {
  const rows = await tenantQuery(tenantId, 'media_files')
    .where({ id: mediaId })
    .limit(1);

  if (!rows || rows.length === 0) {
    throw new NotFoundError('Media file not found');
  }

  const media = rows[0];
  return presignedGetUrl(media.object_key, 300);
}

/**
 * Delete a media file: remove from Object Storage, mark references as
 * media_missing in unexecuted scheduled_posts and broadcasts, then delete
 * the database record.
 *
 * @param {string} tenantId
 * @param {string} mediaId
 * @returns {Promise<void>}
 */
async function deleteMedia(tenantId, mediaId) {
  const log = getLogger();

  // Load media record and verify tenant ownership
  const rows = await tenantQuery(tenantId, 'media_files')
    .where({ id: mediaId })
    .limit(1);

  if (!rows || rows.length === 0) {
    throw new NotFoundError('Media file not found');
  }

  const media = rows[0];
  const db = getDb();

  // Delete from Object Storage
  await deleteObject(media.object_key);

  // Mark references in scheduled_posts that are not yet executed
  // Update payload JSONB to add media_missing flag where media_id is referenced
  await db('scheduled_posts')
    .where('tenant_id', tenantId)
    .whereIn('status', ['scheduled', 'pending'])
    .whereRaw("payload::text LIKE ?", [`%${mediaId}%`])
    .update({
      payload: db.raw("jsonb_set(payload, '{media_missing}', 'true'::jsonb)"),
      updated_at: nowIso(),
    });

  // Mark references in broadcasts that are not yet completed
  await db('broadcasts')
    .where('tenant_id', tenantId)
    .whereIn('status', ['pending', 'running', 'paused'])
    .whereRaw("payload::text LIKE ?", [`%${mediaId}%`])
    .update({
      payload: db.raw("jsonb_set(payload, '{media_missing}', 'true'::jsonb)"),
      updated_at: nowIso(),
    });

  // Delete the media_telegram_cache entries
  await db('media_telegram_cache')
    .where({ media_id: mediaId })
    .del();

  // Delete the media_files record
  await tenantQuery(tenantId, 'media_files')
    .where({ id: mediaId })
    .del();

  log.info({ mediaId, tenantId, objectKey: media.object_key }, 'media: file deleted');
}

/**
 * Resolve a cached Telegram file_id for a media file + connection pair.
 * Returns null if no valid cache entry exists (caller should upload and cache).
 *
 * @param {string} mediaId
 * @param {string} connectionId
 * @returns {Promise<string|null>}
 */
async function resolveTelegramFileId(mediaId, connectionId) {
  const db = getDb();

  const rows = await db('media_telegram_cache')
    .where({ media_id: mediaId, connection_id: connectionId })
    .limit(1);

  if (!rows || rows.length === 0) {
    return null;
  }

  const entry = rows[0];

  // Check expiry if set
  if (entry.expires_at) {
    const expiresAt = new Date(entry.expires_at);
    if (expiresAt < new Date()) {
      return null;
    }
  }

  return entry.telegram_file_id;
}

/**
 * Cache a Telegram file_id for a media file + connection pair.
 * Uses INSERT ... ON CONFLICT DO UPDATE to upsert.
 *
 * @param {string} mediaId
 * @param {string} connectionId
 * @param {string} fileId - The Telegram file_id to cache.
 * @returns {Promise<void>}
 */
async function cacheTelegramFileId(mediaId, connectionId, fileId) {
  const db = getDb();
  const now = nowIso();

  await db('media_telegram_cache')
    .insert({
      media_id: mediaId,
      connection_id: connectionId,
      telegram_file_id: fileId,
      created_at: now,
      updated_at: now,
    })
    .onConflict(['media_id', 'connection_id'])
    .merge({
      telegram_file_id: fileId,
      updated_at: now,
    });
}

/**
 * List media files for a tenant.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=25]
 * @param {string} [opts.kind] - Filter by kind (image, video, audio, document).
 * @returns {Promise<{ data: object[], total: number, page: number, pageSize: number }>}
 */
async function list(tenantId, opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(opts.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;

  let query = tenantQuery(tenantId, 'media_files');
  let countQuery = tenantQuery(tenantId, 'media_files');

  if (opts.kind) {
    query = query.where({ kind: opts.kind });
    countQuery = countQuery.where({ kind: opts.kind });
  }

  const [{ count }] = await countQuery.count('* as count');
  const data = await query
    .orderBy('created_at', 'desc')
    .limit(pageSize)
    .offset(offset);

  return {
    data,
    total: parseInt(count, 10),
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  uploadFromRequest,
  getDownloadUrl,
  deleteMedia,
  resolveTelegramFileId,
  cacheTelegramFileId,
  list,
  // Exported for testing
  MAX_SIZE_BOT,
  MAX_SIZE_MTPROTO,
  kindFromMime,
  isMimeBlocked,
};
