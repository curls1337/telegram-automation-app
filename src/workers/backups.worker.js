'use strict';

/**
 * Backups Worker — BullMQ consumer for the backups queue.
 *
 * Handles two job types:
 *   - 'export': stream tenant data, rewrap secrets, pack tar.gz, encrypt,
 *               compute SHA-256, upload to Object Storage.
 *   - 'import': download, decrypt, unpack, validate manifest, INSERT rows
 *               in transaction, rewrap secrets, restart connections.
 *
 * References:
 *   - requirements.md §16.1–16.7 — backup export & import pipeline
 *   - design.md "Backup & Export" — full pipeline, PBKDF2, AES-256-GCM
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { Readable, PassThrough } = require('stream');
const { pipeline } = require('stream/promises');
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const tar = require('tar-stream');

const { QUEUE_NAMES } = require('../infra/queues');
const { buildRedisOptions } = require('../infra/redis');
const { getRedisPublisher } = require('../infra/redis');
const { getDb, tenantQuery, withTransaction } = require('../infra/db');
const {
  encrypt,
  decrypt,
  decryptFromColumns,
  encryptToColumns,
  serializeBlob,
  deserializeBlob,
  encryptWithPassphrase,
  decryptWithPassphrase,
  derivePassphraseKey,
  generatePassphraseSalt,
  PBKDF2_SALT_BYTES,
  IV_BYTES,
  TAG_BYTES,
} = require('../infra/crypto');
const { putObject, getObject } = require('../infra/object-storage');
const { getLogger } = require('../infra/logger');
const { getEnv } = require('../shared/env');
const { nowIso } = require('../shared/time');
const { sha256Hex } = require('../shared/ids');
const auditLogger = require('../modules/audit/audit-logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKUPS_TABLE = 'backups';
const MANIFEST_VERSION = '1.0.0';
const MAX_EXPORT_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

/**
 * Tables to export, in dependency order. Tables with encrypted secrets
 * are marked so the worker knows to rewrap them.
 */
const EXPORT_TABLES = [
  { name: 'telegram_connections', hasSecrets: true, secretColumns: ['encrypted_secret', 'secret_iv', 'secret_tag', 'secret_key_id'] },
  { name: 'subscribers', hasSecrets: false },
  { name: 'tags', hasSecrets: false },
  { name: 'subscriber_tags', hasSecrets: false },
  { name: 'segments', hasSecrets: false },
  { name: 'auto_reply_rules', hasSecrets: false },
  { name: 'ai_settings', hasSecrets: true, secretColumns: ['encrypted_secret', 'secret_iv', 'secret_tag', 'secret_key_id'] },
  { name: 'drip_campaigns', hasSecrets: false },
  { name: 'drip_steps', hasSecrets: false },
  { name: 'forward_rules', hasSecrets: false },
  { name: 'member_rules', hasSecrets: false },
  { name: 'scheduled_posts', hasSecrets: false },
  { name: 'broadcasts', hasSecrets: false },
  { name: 'webhooks', hasSecrets: true, secretColumns: ['secret_encrypted'] },
  { name: 'api_keys', hasSecrets: false },
];

// Tables to skip when skipMedia is true
const MEDIA_TABLES = ['media_files'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Update backup record fields.
 *
 * @param {string} backupId
 * @param {object} fields
 * @returns {Promise<void>}
 */
async function updateBackup(backupId, fields) {
  const db = getDb();
  await db(BACKUPS_TABLE).where({ id: backupId }).update(fields);
}

/**
 * Rewrap a row's secrets from master key to passphrase-derived key.
 * Used during export.
 *
 * @param {object} row - Database row with encrypted columns
 * @param {object} tableDef - Table definition with secretColumns
 * @param {Buffer} passphraseKey - Derived passphrase key (32 bytes)
 * @returns {object} Row with secrets re-encrypted under passphrase key
 */
function rewrapForExport(row, tableDef, passphraseKey) {
  if (!tableDef.hasSecrets) return row;

  const result = { ...row };

  if (tableDef.name === 'webhooks') {
    // Webhooks store secret as a single concatenated buffer: iv(12) + tag(16) + ciphertext
    if (row.secret_encrypted) {
      const buf = Buffer.isBuffer(row.secret_encrypted)
        ? row.secret_encrypted
        : Buffer.from(row.secret_encrypted);

      const iv = buf.slice(0, 12);
      const tag = buf.slice(12, 28);
      const ciphertext = buf.slice(28);

      // Decrypt with master key
      const { getKeyStore } = require('../infra/crypto');
      const store = getKeyStore();
      const plaintext = decrypt({ keyId: store.activeKeyId, iv, tag, ciphertext });

      // Re-encrypt with passphrase key
      const newIv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', passphraseKey, newIv);
      const newCiphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const newTag = cipher.getAuthTag();

      result.secret_encrypted = Buffer.concat([newIv, newTag, newCiphertext]).toString('base64');
    }
  } else {
    // Standard column-based encryption (telegram_connections, ai_settings)
    if (row.encrypted_secret && row.secret_iv && row.secret_tag && row.secret_key_id) {
      // Decrypt with master key
      const plaintext = decryptFromColumns({
        encrypted_secret: Buffer.isBuffer(row.encrypted_secret) ? row.encrypted_secret : Buffer.from(row.encrypted_secret, 'base64'),
        secret_iv: Buffer.isBuffer(row.secret_iv) ? row.secret_iv : Buffer.from(row.secret_iv, 'base64'),
        secret_tag: Buffer.isBuffer(row.secret_tag) ? row.secret_tag : Buffer.from(row.secret_tag, 'base64'),
        secret_key_id: row.secret_key_id,
      });

      // Re-encrypt with passphrase key
      const newIv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', passphraseKey, newIv);
      const newCiphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const newTag = cipher.getAuthTag();

      result.encrypted_secret = newCiphertext.toString('base64');
      result.secret_iv = newIv.toString('base64');
      result.secret_tag = newTag.toString('base64');
      result.secret_key_id = 'passphrase-derived';
    }
  }

  return result;
}

/**
 * Rewrap a row's secrets from passphrase-derived key to master key.
 * Used during import.
 *
 * @param {object} row - Row from backup with passphrase-encrypted secrets
 * @param {object} tableDef - Table definition with secretColumns
 * @param {Buffer} passphraseKey - Derived passphrase key (32 bytes)
 * @returns {object} Row with secrets re-encrypted under master key
 */
function rewrapForImport(row, tableDef, passphraseKey) {
  if (!tableDef.hasSecrets) return row;

  const result = { ...row };

  if (tableDef.name === 'webhooks') {
    if (row.secret_encrypted) {
      const buf = Buffer.from(row.secret_encrypted, 'base64');
      const iv = buf.slice(0, 12);
      const tag = buf.slice(12, 28);
      const ciphertext = buf.slice(28);

      // Decrypt with passphrase key
      const decipher = crypto.createDecipheriv('aes-256-gcm', passphraseKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      // Re-encrypt with master key
      const blob = encrypt(plaintext);
      result.secret_encrypted = Buffer.concat([blob.iv, blob.tag, blob.ciphertext]);
    }
  } else {
    if (row.encrypted_secret && row.secret_key_id === 'passphrase-derived') {
      const ciphertext = Buffer.from(row.encrypted_secret, 'base64');
      const iv = Buffer.from(row.secret_iv, 'base64');
      const tag = Buffer.from(row.secret_tag, 'base64');

      // Decrypt with passphrase key
      const decipher = crypto.createDecipheriv('aes-256-gcm', passphraseKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      // Re-encrypt with master key
      const cols = encryptToColumns(plaintext);
      result.encrypted_secret = cols.encrypted_secret;
      result.secret_iv = cols.secret_iv;
      result.secret_tag = cols.secret_tag;
      result.secret_key_id = cols.secret_key_id;
    }
  }

  return result;
}

/**
 * Estimate export size by counting rows across all tables.
 * Returns approximate size in bytes (rough estimate: 500 bytes per row).
 *
 * @param {string} tenantId
 * @returns {Promise<number>}
 */
async function estimateExportSize(tenantId) {
  const db = getDb();
  let totalRows = 0;

  for (const tableDef of EXPORT_TABLES) {
    try {
      const [{ count }] = await db(tableDef.name)
        .where('tenant_id', tenantId)
        .count('* as count');
      totalRows += parseInt(count, 10);
    } catch (_err) {
      // Table might not exist yet — skip
    }
  }

  // Rough estimate: 500 bytes per row average (JSON + overhead)
  return totalRows * 500;
}

// ---------------------------------------------------------------------------
// Export pipeline
// ---------------------------------------------------------------------------

/**
 * Process an export job.
 *
 * Pipeline:
 *   1. Update backup status to 'running'
 *   2. Stream data from tables (filter tenant_id)
 *   3. Rewrap secrets (decrypt master → encrypt passphrase-derived key)
 *   4. Build manifest.json
 *   5. Pack all JSON files into tar.gz
 *   6. Encrypt the tar.gz with AES-256-GCM using PBKDF2(passphrase, salt, 200k)
 *   7. Prepend salt (16 bytes) to encrypted output
 *   8. Compute SHA-256 of final encrypted file
 *   9. Upload to Object Storage
 *   10. Update backup record
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processExport(job) {
  const log = getLogger();
  const { tenantId, backupId, passphrase, skipMedia } = job.data;

  log.info({ tenantId, backupId }, 'backups-worker: starting export');

  // 1. Update status to running
  await updateBackup(backupId, { status: 'running' });

  try {
    // Check size limit
    const estimatedSize = await estimateExportSize(tenantId);
    if (estimatedSize > MAX_EXPORT_SIZE_BYTES && !skipMedia) {
      throw new Error(
        'Estimated export size exceeds 1 GB limit. Use skipMedia option for partial export.'
      );
    }

    // 2. Derive passphrase key
    const salt = generatePassphraseSalt();
    const passphraseKey = derivePassphraseKey(passphrase, salt);

    // 3. Stream data from tables and build JSON files
    const db = getDb();
    const tableData = {};
    const tableCounts = {};

    for (const tableDef of EXPORT_TABLES) {
      try {
        const rows = await db(tableDef.name)
          .where('tenant_id', tenantId)
          .select('*');

        // Rewrap secrets for export
        const processedRows = rows.map((row) => {
          // Convert Buffer columns to base64 for JSON serialization
          const serialized = {};
          for (const [key, value] of Object.entries(row)) {
            if (Buffer.isBuffer(value)) {
              serialized[key] = value.toString('base64');
            } else {
              serialized[key] = value;
            }
          }
          return rewrapForExport(serialized, tableDef, passphraseKey);
        });

        tableData[tableDef.name] = processedRows;
        tableCounts[tableDef.name] = processedRows.length;
      } catch (_err) {
        // Table might not exist — skip silently
        tableData[tableDef.name] = [];
        tableCounts[tableDef.name] = 0;
      }
    }

    // 4. Build manifest
    const manifest = {
      version: MANIFEST_VERSION,
      tenantId,
      exportDate: nowIso(),
      tables: tableCounts,
      skipMedia: !!skipMedia,
      salt: salt.toString('base64'),
      iterations: 200000,
    };

    // 5. Pack into tar.gz
    const tarGzBuffer = await packTarGz(manifest, tableData);

    // 6. Encrypt the tar.gz with AES-256-GCM
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', passphraseKey, iv);
    const encryptedContent = Buffer.concat([cipher.update(tarGzBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Final format: salt(16) + iv(12) + tag(16) + ciphertext
    const finalBuffer = Buffer.concat([salt, iv, authTag, encryptedContent]);

    // 7. Compute SHA-256
    const checksum = sha256Hex(finalBuffer);

    // 8. Upload to Object Storage
    const objectKey = `tenants/${tenantId}/backups/${backupId}.enc`;
    await putObject({
      key: objectKey,
      body: finalBuffer,
      contentType: 'application/octet-stream',
      contentLength: finalBuffer.length,
      metadata: {
        'backup-id': backupId,
        'tenant-id': tenantId,
        'sha256': checksum,
      },
    });

    // 9. Update backup record
    await updateBackup(backupId, {
      status: 'completed',
      object_key: objectKey,
      size_bytes: finalBuffer.length,
      sha256: checksum,
    });

    // Audit log
    await auditLogger.write({
      tenantId,
      userId: null,
      action: 'backup.export_completed',
      resourceType: 'backup',
      resourceId: backupId,
      meta: { sizeBytes: finalBuffer.length, checksum },
    });

    log.info(
      { tenantId, backupId, sizeBytes: finalBuffer.length, checksum },
      'backups-worker: export completed'
    );
  } catch (err) {
    const errorMsg = err && err.message ? err.message : String(err);
    await updateBackup(backupId, { status: 'failed', error: errorMsg });
    log.error({ tenantId, backupId, err }, 'backups-worker: export failed');
    throw err;
  }
}

/**
 * Pack manifest and table data into a tar.gz buffer.
 *
 * @param {object} manifest
 * @param {object} tableData - { tableName: rows[] }
 * @returns {Promise<Buffer>}
 */
async function packTarGz(manifest, tableData) {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks = [];

    const gzip = zlib.createGzip();
    gzip.on('data', (chunk) => chunks.push(chunk));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);

    pack.pipe(gzip);

    // Add manifest.json
    const manifestJson = JSON.stringify(manifest, null, 2);
    pack.entry({ name: 'manifest.json' }, manifestJson);

    // Add each table as a JSON file
    for (const [tableName, rows] of Object.entries(tableData)) {
      const tableJson = JSON.stringify(rows);
      pack.entry({ name: `data/${tableName}.json` }, tableJson);
    }

    pack.finalize();
  });
}

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

/**
 * Process an import job.
 *
 * Pipeline:
 *   1. Download encrypted file from Object Storage
 *   2. Extract salt (first 16 bytes), derive key via PBKDF2
 *   3. Decrypt AES-256-GCM (verify auth tag)
 *   4. Unpack tar.gz
 *   5. Parse manifest.json, validate schema version
 *   6. BEGIN TRANSACTION
 *   7. For each table: parse JSON, rewrap secrets, INSERT rows
 *   8. COMMIT
 *   9. Publish connection-events 'start' for restored connections
 *   10. Update backup record status
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processImport(job) {
  const log = getLogger();
  const { tenantId, backupId, objectKey, passphrase } = job.data;

  log.info({ tenantId, backupId, objectKey }, 'backups-worker: starting import');

  // Update status to running
  await updateBackup(backupId, { status: 'running' });

  try {
    // 1. Download encrypted file
    const { body: downloadStream } = await getObject(objectKey);
    const encryptedBuffer = await streamToBuffer(downloadStream);

    // 2. Extract salt, iv, tag, ciphertext
    if (encryptedBuffer.length < PBKDF2_SALT_BYTES + IV_BYTES + TAG_BYTES) {
      throw new Error('Invalid backup file: too small');
    }

    const salt = encryptedBuffer.slice(0, PBKDF2_SALT_BYTES);
    const iv = encryptedBuffer.slice(PBKDF2_SALT_BYTES, PBKDF2_SALT_BYTES + IV_BYTES);
    const authTag = encryptedBuffer.slice(PBKDF2_SALT_BYTES + IV_BYTES, PBKDF2_SALT_BYTES + IV_BYTES + TAG_BYTES);
    const ciphertext = encryptedBuffer.slice(PBKDF2_SALT_BYTES + IV_BYTES + TAG_BYTES);

    // Derive key from passphrase
    const passphraseKey = derivePassphraseKey(passphrase, salt);

    // 3. Decrypt (verify auth tag)
    let tarGzBuffer;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', passphraseKey, iv);
      decipher.setAuthTag(authTag);
      tarGzBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (_err) {
      throw new Error('Invalid passphrase or corrupted file');
    }

    // 4. Unpack tar.gz
    const files = await unpackTarGz(tarGzBuffer);

    // 5. Parse and validate manifest
    const manifestRaw = files.get('manifest.json');
    if (!manifestRaw) {
      throw new Error('Invalid backup: missing manifest.json');
    }

    const manifest = JSON.parse(manifestRaw.toString('utf8'));
    validateManifest(manifest);

    // 6-8. Transaction: insert rows
    const restoredConnectionIds = [];

    await withTransaction(async (trx) => {
      for (const tableDef of EXPORT_TABLES) {
        const fileKey = `data/${tableDef.name}.json`;
        const fileData = files.get(fileKey);
        if (!fileData) continue;

        const rows = JSON.parse(fileData.toString('utf8'));
        if (!Array.isArray(rows) || rows.length === 0) continue;

        // Rewrap secrets from passphrase key to master key
        const processedRows = rows.map((row) => {
          const rewrapped = rewrapForImport(row, tableDef, passphraseKey);

          // Convert base64 strings back to Buffers for binary columns
          if (tableDef.hasSecrets) {
            if (tableDef.name === 'webhooks') {
              if (rewrapped.secret_encrypted && Buffer.isBuffer(rewrapped.secret_encrypted)) {
                // Already a buffer from rewrapForImport
              } else if (rewrapped.secret_encrypted && typeof rewrapped.secret_encrypted === 'string') {
                rewrapped.secret_encrypted = Buffer.from(rewrapped.secret_encrypted, 'base64');
              }
            } else {
              if (rewrapped.encrypted_secret && typeof rewrapped.encrypted_secret === 'string' && !Buffer.isBuffer(rewrapped.encrypted_secret)) {
                rewrapped.encrypted_secret = Buffer.from(rewrapped.encrypted_secret, 'base64');
              }
              if (rewrapped.secret_iv && typeof rewrapped.secret_iv === 'string' && !Buffer.isBuffer(rewrapped.secret_iv)) {
                rewrapped.secret_iv = Buffer.from(rewrapped.secret_iv, 'base64');
              }
              if (rewrapped.secret_tag && typeof rewrapped.secret_tag === 'string' && !Buffer.isBuffer(rewrapped.secret_tag)) {
                rewrapped.secret_tag = Buffer.from(rewrapped.secret_tag, 'base64');
              }
            }
          }

          // Ensure tenant_id matches target tenant
          rewrapped.tenant_id = tenantId;
          return rewrapped;
        });

        // Track connection IDs for restart
        if (tableDef.name === 'telegram_connections') {
          for (const row of processedRows) {
            if (row.id && row.status === 'active') {
              restoredConnectionIds.push(row.id);
            }
          }
        }

        // INSERT with ON CONFLICT DO NOTHING to avoid duplicates
        // Process in batches to avoid exceeding query size limits
        const BATCH_SIZE = 100;
        for (let i = 0; i < processedRows.length; i += BATCH_SIZE) {
          const batch = processedRows.slice(i, i + BATCH_SIZE);
          await trx(tableDef.name)
            .insert(batch)
            .onConflict('id')
            .ignore();
        }
      }
    });

    // 9. Restart connections for restored telegram_connections
    if (restoredConnectionIds.length > 0) {
      const publisher = getRedisPublisher();
      for (const connectionId of restoredConnectionIds) {
        await publisher.publish('connection-events', JSON.stringify({
          type: 'start',
          connectionId,
        }));
      }
      log.info(
        { tenantId, connectionCount: restoredConnectionIds.length },
        'backups-worker: published start events for restored connections'
      );
    }

    // 10. Update backup record
    await updateBackup(backupId, { status: 'completed' });

    // Audit log
    await auditLogger.write({
      tenantId,
      userId: null,
      action: 'backup.import_completed',
      resourceType: 'backup',
      resourceId: backupId,
      meta: { objectKey, tablesRestored: Object.keys(manifest.tables || {}).length },
    });

    log.info({ tenantId, backupId }, 'backups-worker: import completed');
  } catch (err) {
    const errorMsg = err && err.message ? err.message : String(err);
    await updateBackup(backupId, { status: 'failed', error: errorMsg });
    log.error({ tenantId, backupId, err }, 'backups-worker: import failed');
    throw err;
  }
}

/**
 * Validate manifest schema version (semver compatibility check).
 *
 * @param {object} manifest
 * @throws {Error} if manifest is invalid or incompatible
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: not an object');
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('Invalid manifest: missing version');
  }

  // Simple semver major version check
  const [major] = manifest.version.split('.');
  const [currentMajor] = MANIFEST_VERSION.split('.');

  if (parseInt(major, 10) > parseInt(currentMajor, 10)) {
    throw new Error(
      `Incompatible backup version: ${manifest.version} (current: ${MANIFEST_VERSION})`
    );
  }
}

/**
 * Unpack a tar.gz buffer into a Map of filename → Buffer.
 *
 * @param {Buffer} tarGzBuffer
 * @returns {Promise<Map<string, Buffer>>}
 */
async function unpackTarGz(tarGzBuffer) {
  return new Promise((resolve, reject) => {
    const files = new Map();
    const extract = tar.extract();

    extract.on('entry', (header, stream, next) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        files.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });

    extract.on('finish', () => resolve(files));
    extract.on('error', reject);

    // Gunzip then extract
    const gunzip = zlib.createGunzip();
    gunzip.on('error', reject);

    const source = Readable.from(tarGzBuffer);
    source.pipe(gunzip).pipe(extract);
  });
}

/**
 * Collect a readable stream into a single Buffer.
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<Buffer>}
 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Job router
// ---------------------------------------------------------------------------

/**
 * Route jobs to the appropriate handler based on job name.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processJob(job) {
  const log = getLogger();

  switch (job.name) {
    case 'export':
      return processExport(job);
    case 'import':
      return processImport(job);
    default:
      log.warn({ jobName: job.name, jobId: job.id }, 'backups-worker: unknown job type');
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/** @type {import('bullmq').Worker|null} */
let worker = null;

/**
 * Start the backups worker.
 *
 * @returns {import('bullmq').Worker}
 */
function start() {
  const log = getLogger();
  const env = getEnv();

  const connection = new Redis(env.REDIS_URL, buildRedisOptions('worker:backups'));

  worker = new Worker(
    QUEUE_NAMES.BACKUPS,
    processJob,
    {
      connection,
      concurrency: 1, // Only one backup at a time
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id, jobName: job.name }, 'backups-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job ? job.id : 'unknown', jobName: job ? job.name : 'unknown', err: err && err.message },
      'backups-worker: job failed'
    );
  });

  worker.on('error', (err) => {
    log.error({ err }, 'backups-worker: worker error');
  });

  log.info('backups-worker: started');

  return worker;
}

/**
 * Stop the worker gracefully.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  start,
  stop,
  processJob,
  processExport,
  processImport,
  // Exported for testing
  rewrapForExport,
  rewrapForImport,
  packTarGz,
  unpackTarGz,
  validateManifest,
  estimateExportSize,
  streamToBuffer,
  EXPORT_TABLES,
  MANIFEST_VERSION,
  MAX_EXPORT_SIZE_BYTES,
};
