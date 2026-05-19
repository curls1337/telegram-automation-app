'use strict';

/**
 * Backup Service — export & import tenant data as encrypted archives.
 *
 * Responsibilities:
 *   - Request export: validate passphrase, create backup record, enqueue job
 *   - Request import: enqueue import job
 *   - List backups for a tenant
 *   - Get single backup with download URL
 *   - Schedule automatic backups (optional)
 *
 * References:
 *   - requirements.md §16.1 — tenant owner requests export with passphrase
 *   - requirements.md §16.4 — import pipeline
 *   - requirements.md §16.7 — 1 GB size limit
 *   - requirements.md §16.8 — scheduled backup (optional)
 *   - design.md "Backup & Export" — full pipeline description
 */

const { getDb, tenantQuery, tenantInsert } = require('../../infra/db');
const { getQueue, QUEUE_NAMES } = require('../../infra/queues');
const { presignedGetUrl } = require('../../infra/object-storage');
const { getLogger } = require('../../infra/logger');
const { newId } = require('../../shared/ids');
const { nowIso } = require('../../shared/time');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const auditLogger = require('../audit/audit-logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'backups';
const MIN_PASSPHRASE_LENGTH = 8;
const PRESIGN_TTL_SECONDS = 600; // 10 minutes

// ---------------------------------------------------------------------------
// requestExport
// ---------------------------------------------------------------------------

/**
 * Request a backup export. Validates passphrase, creates a backup record
 * with status=pending, and enqueues an export job to the backups queue.
 *
 * @param {string} tenantId
 * @param {string} passphrase - User-supplied passphrase (min 8 chars)
 * @param {object} opts
 * @param {string} opts.userId - User requesting the export
 * @param {boolean} [opts.skipMedia=false] - Skip media history for partial export
 * @returns {Promise<object>} The created backup record
 */
async function requestExport(tenantId, passphrase, { userId, skipMedia = false } = {}) {
  const log = getLogger();

  // Validate passphrase
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ValidationError(
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`
    );
  }

  const backupId = newId();
  const timestamp = nowIso();

  // Create backup record
  const [backup] = await tenantInsert(tenantId, TABLE, {
    id: backupId,
    requested_by_user_id: userId || null,
    object_key: null,
    size_bytes: null,
    sha256: null,
    status: 'pending',
    error: null,
    created_at: timestamp,
  }, { returning: '*' });

  // Enqueue export job
  const queue = getQueue(QUEUE_NAMES.BACKUPS);
  await queue.add('export', {
    tenantId,
    backupId,
    passphrase,
    skipMedia,
  });

  // Audit log
  await auditLogger.write({
    tenantId,
    userId,
    action: 'backup.export_requested',
    resourceType: 'backup',
    resourceId: backupId,
    meta: { skipMedia },
  });

  log.info({ tenantId, backupId, userId }, 'backup-service: export requested');

  return backup;
}

// ---------------------------------------------------------------------------
// requestImport
// ---------------------------------------------------------------------------

/**
 * Request a backup import. Enqueues an import job to the backups queue.
 *
 * @param {string} tenantId
 * @param {string} objectKey - Object storage key of the backup file
 * @param {string} passphrase - Passphrase used to encrypt the backup
 * @param {object} opts
 * @param {string} opts.userId - User requesting the import
 * @returns {Promise<object>} The created backup record
 */
async function requestImport(tenantId, objectKey, passphrase, { userId } = {}) {
  const log = getLogger();

  if (!objectKey || typeof objectKey !== 'string') {
    throw new ValidationError('Object key is required');
  }

  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ValidationError(
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`
    );
  }

  const backupId = newId();
  const timestamp = nowIso();

  // Create backup record for import tracking
  const [backup] = await tenantInsert(tenantId, TABLE, {
    id: backupId,
    requested_by_user_id: userId || null,
    object_key: objectKey,
    size_bytes: null,
    sha256: null,
    status: 'pending',
    error: null,
    created_at: timestamp,
  }, { returning: '*' });

  // Enqueue import job
  const queue = getQueue(QUEUE_NAMES.BACKUPS);
  await queue.add('import', {
    tenantId,
    backupId,
    objectKey,
    passphrase,
  });

  // Audit log
  await auditLogger.write({
    tenantId,
    userId,
    action: 'backup.import_requested',
    resourceType: 'backup',
    resourceId: backupId,
    meta: { objectKey },
  });

  log.info({ tenantId, backupId, userId }, 'backup-service: import requested');

  return backup;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * List all backups for a tenant, ordered by created_at DESC.
 *
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function list(tenantId) {
  return tenantQuery(tenantId, TABLE)
    .select('id', 'requested_by_user_id', 'object_key', 'size_bytes', 'sha256', 'status', 'error', 'created_at')
    .orderBy('created_at', 'desc');
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Get a single backup by ID.
 *
 * @param {string} tenantId
 * @param {string} backupId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getById(tenantId, backupId) {
  const backup = await tenantQuery(tenantId, TABLE)
    .where({ id: backupId })
    .first();

  if (!backup) {
    throw new NotFoundError('Backup not found');
  }

  return backup;
}

// ---------------------------------------------------------------------------
// getDownloadUrl
// ---------------------------------------------------------------------------

/**
 * Generate a presigned download URL for a completed backup.
 *
 * @param {string} tenantId
 * @param {string} backupId
 * @returns {Promise<string>} Presigned URL
 * @throws {NotFoundError}
 * @throws {ValidationError}
 */
async function getDownloadUrl(tenantId, backupId) {
  const backup = await getById(tenantId, backupId);

  if (backup.status !== 'completed') {
    throw new ValidationError('Backup is not yet completed');
  }

  if (!backup.object_key) {
    throw new ValidationError('Backup has no associated file');
  }

  return presignedGetUrl(backup.object_key, PRESIGN_TTL_SECONDS);
}

// ---------------------------------------------------------------------------
// scheduleAutoBackup (OPT — simplified stub)
// ---------------------------------------------------------------------------

/**
 * Schedule automatic backups for a tenant.
 * TODO: Full implementation — store schedule config, register cron job.
 *
 * @param {string} tenantId
 * @param {object} config
 * @param {string} config.frequency - 'daily' or 'weekly'
 * @param {object} [config.s3Config] - Tenant-supplied S3 credentials
 * @param {string} [config.passphrase] - Passphrase for automatic backups
 * @returns {Promise<object>}
 */
async function scheduleAutoBackup(tenantId, { frequency, s3Config, passphrase } = {}) {
  // TODO: Implement full scheduled backup with tenant S3 credentials
  // For now, store the configuration intent and return it
  const log = getLogger();
  log.info({ tenantId, frequency }, 'backup-service: auto-backup schedule requested (stub)');

  return {
    tenantId,
    frequency,
    hasS3Config: !!s3Config,
    status: 'configured',
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  requestExport,
  requestImport,
  list,
  getById,
  getDownloadUrl,
  scheduleAutoBackup,
  // Constants exported for testing
  MIN_PASSPHRASE_LENGTH,
  PRESIGN_TTL_SECONDS,
};
