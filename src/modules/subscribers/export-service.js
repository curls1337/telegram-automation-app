'use strict';

/**
 * Export service — stream subscribers to CSV and upload to Object Storage.
 *
 * References:
 *   - requirements.md §10.7 — export subscriber list as CSV, tenant-scoped
 *   - design.md "Subscriber & Segmentation" — CSV export via Object Storage
 */

const { Readable } = require('stream');
const { tenantQuery } = require('../../infra/db');
const { putObject, presignedGetUrl } = require('../../infra/object-storage');
const segmentService = require('./segment-service');

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'id',
  'telegram_user_id',
  'username',
  'first_name',
  'last_name',
  'language_code',
  'status',
  'first_seen_at',
  'last_active_at',
];

/**
 * Escape a CSV field value. Wraps in quotes if it contains comma, quote, or newline.
 *
 * @param {*} value
 * @returns {string}
 */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert a subscriber row to a CSV line.
 *
 * @param {object} row
 * @returns {string}
 */
function rowToCsvLine(row) {
  return CSV_HEADERS.map((header) => escapeCsvField(row[header])).join(',');
}

// ---------------------------------------------------------------------------
// exportCsv
// ---------------------------------------------------------------------------

/**
 * Export subscribers to CSV, upload to Object Storage, return presigned URL.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {string} [opts.connectionId] - Filter by connection
 * @param {string} [opts.segmentId] - Filter by segment
 * @returns {Promise<{ url: string, key: string }>}
 */
async function exportCsv(tenantId, opts = {}) {
  let subscribers;

  if (opts.segmentId) {
    // Use segment service to get members
    subscribers = await segmentService.members(tenantId, opts.segmentId);
  } else {
    // Query subscribers directly
    let query = tenantQuery(tenantId, 'subscribers');
    if (opts.connectionId) {
      query = query.where('connection_id', opts.connectionId);
    }
    subscribers = await query.orderBy('last_active_at', 'desc');
  }

  // Build CSV content
  const lines = [CSV_HEADERS.join(',')];
  for (const row of subscribers) {
    lines.push(rowToCsvLine(row));
  }
  const csvContent = lines.join('\n') + '\n';

  // Upload to Object Storage
  const timestamp = Date.now();
  const key = `tenants/${tenantId}/exports/subscribers_${timestamp}.csv`;

  await putObject({
    key,
    body: Buffer.from(csvContent, 'utf-8'),
    contentType: 'text/csv',
  });

  // Generate presigned URL (5 min TTL)
  const url = await presignedGetUrl(key, 300);

  return { url, key };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  exportCsv,
};
