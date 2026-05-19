'use strict';

/**
 * Analytics Export Service — CSV and PDF report generation.
 *
 * Streams query results to Object Storage and returns a presigned URL.
 *
 * Dependencies:
 *   - fast-csv for CSV generation
 *   - pdfkit for PDF generation
 *
 * References:
 *   - requirements.md §13.4 — export CSV/PDF reports
 *   - design.md "Analytics Module" — stream to Object Storage, presigned URL
 */

const { PassThrough } = require('stream');
const { format: csvFormat } = require('@fast-csv/format');
const PDFDocument = require('pdfkit');

const { putObject, presignedGetUrl } = require('../../infra/object-storage');
const { getLogger } = require('../../infra/logger');
const analyticsService = require('./analytics-service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the Object Storage key for an export file.
 *
 * @param {string} tenantId
 * @param {string} metric
 * @param {string} extension - 'csv' or 'pdf'
 * @returns {string}
 */
function buildExportKey(tenantId, metric, extension) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const timestamp = Date.now();
  return `tenants/${tenantId}/exports/analytics-${metric}-${dateStr}-${timestamp}.${extension}`;
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

/**
 * Export analytics data as CSV, upload to Object Storage, return presigned URL.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string} opts.metric
 * @param {string} [opts.startDate]
 * @param {string} [opts.endDate]
 * @param {string} [opts.range]
 * @returns {Promise<string>} Presigned download URL
 */
async function exportCsv(tenantId, opts = {}) {
  const log = getLogger();
  const metric = opts.metric || 'message_sent';

  // Fetch time-series data
  const timeSeries = await analyticsService.getTimeSeries(tenantId, {
    metric,
    startDate: opts.startDate,
    endDate: opts.endDate,
    range: opts.range,
  });

  // Fetch breakdown data
  const breakdown = await analyticsService.getBreakdown(tenantId, {
    metric,
    startDate: opts.startDate,
    endDate: opts.endDate,
    range: opts.range,
  });

  // Create CSV stream
  const passThrough = new PassThrough();
  const csvStream = csvFormat({ headers: true });

  // Collect buffer chunks
  const chunks = [];
  passThrough.on('data', (chunk) => chunks.push(chunk));

  csvStream.pipe(passThrough);

  // Write time-series section header
  csvStream.write({ Section: 'Time Series', Date: 'Date', Value: 'Value', Subject: '' });
  for (const row of timeSeries) {
    csvStream.write({ Section: '', Date: row.date, Value: String(row.value), Subject: '' });
  }

  // Write breakdown section
  csvStream.write({ Section: 'Breakdown', Date: '', Value: 'Value', Subject: 'Subject ID' });
  for (const row of breakdown) {
    csvStream.write({ Section: '', Date: '', Value: String(row.value), Subject: row.subject_id });
  }

  csvStream.end();

  // Wait for stream to finish
  await new Promise((resolve, reject) => {
    passThrough.on('finish', resolve);
    passThrough.on('error', reject);
  });

  const buffer = Buffer.concat(chunks);
  const key = buildExportKey(tenantId, metric, 'csv');

  // Upload to Object Storage
  await putObject({
    key,
    body: buffer,
    contentType: 'text/csv',
    contentLength: buffer.length,
  });

  // Generate presigned URL (valid for 1 hour)
  const url = await presignedGetUrl(key, 3600);

  log.info({ tenantId, metric, key }, 'export-service: CSV export uploaded');

  return url;
}

// ---------------------------------------------------------------------------
// PDF Export
// ---------------------------------------------------------------------------

/**
 * Export analytics data as PDF, upload to Object Storage, return presigned URL.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string} opts.metric
 * @param {string} [opts.startDate]
 * @param {string} [opts.endDate]
 * @param {string} [opts.range]
 * @returns {Promise<string>} Presigned download URL
 */
async function exportPdf(tenantId, opts = {}) {
  const log = getLogger();
  const metric = opts.metric || 'message_sent';

  // Fetch time-series data
  const timeSeries = await analyticsService.getTimeSeries(tenantId, {
    metric,
    startDate: opts.startDate,
    endDate: opts.endDate,
    range: opts.range,
  });

  // Fetch breakdown data
  const breakdown = await analyticsService.getBreakdown(tenantId, {
    metric,
    startDate: opts.startDate,
    endDate: opts.endDate,
    range: opts.range,
  });

  // Create PDF document
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));

  // Title
  doc.fontSize(18).text('Analytics Report', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Metric: ${metric}`, { align: 'center' });

  const { startDate, endDate } = analyticsService.resolveRange(opts.range || '7d');
  const displayStart = opts.startDate || startDate;
  const displayEnd = opts.endDate || endDate;
  doc.text(`Period: ${displayStart} to ${displayEnd}`, { align: 'center' });
  doc.moveDown(1.5);

  // Time Series Table
  doc.fontSize(14).text('Time Series', { underline: true });
  doc.moveDown(0.5);

  // Table header
  doc.fontSize(10);
  const tableTop = doc.y;
  doc.text('Date', 50, tableTop, { width: 150 });
  doc.text('Value', 200, tableTop, { width: 100 });
  doc.moveDown(0.3);

  // Draw a line
  doc.moveTo(50, doc.y).lineTo(350, doc.y).stroke();
  doc.moveDown(0.3);

  for (const row of timeSeries) {
    if (doc.y > 700) {
      doc.addPage();
    }
    const y = doc.y;
    doc.text(row.date, 50, y, { width: 150 });
    doc.text(String(row.value), 200, y, { width: 100 });
    doc.moveDown(0.3);
  }

  doc.moveDown(1);

  // Breakdown Table
  if (breakdown.length > 0) {
    doc.fontSize(14).text('Breakdown by Subject', { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10);
    const breakdownTop = doc.y;
    doc.text('Subject ID', 50, breakdownTop, { width: 250 });
    doc.text('Value', 300, breakdownTop, { width: 100 });
    doc.moveDown(0.3);

    doc.moveTo(50, doc.y).lineTo(450, doc.y).stroke();
    doc.moveDown(0.3);

    for (const row of breakdown) {
      if (doc.y > 700) {
        doc.addPage();
      }
      const y = doc.y;
      doc.text(row.subject_id, 50, y, { width: 250 });
      doc.text(String(row.value), 300, y, { width: 100 });
      doc.moveDown(0.3);
    }
  }

  // Finalize PDF
  doc.end();

  // Wait for PDF to finish
  await new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  const buffer = Buffer.concat(chunks);
  const key = buildExportKey(tenantId, metric, 'pdf');

  // Upload to Object Storage
  await putObject({
    key,
    body: buffer,
    contentType: 'application/pdf',
    contentLength: buffer.length,
  });

  // Generate presigned URL (valid for 1 hour)
  const url = await presignedGetUrl(key, 3600);

  log.info({ tenantId, metric, key }, 'export-service: PDF export uploaded');

  return url;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  exportCsv,
  exportPdf,
};
