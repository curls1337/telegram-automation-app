'use strict';

/**
 * Analytics Web UI Routes — dashboard, data endpoints, and export.
 *
 * Mounted at /analytics in the main Express app.
 *
 * Routes:
 *   GET  /analytics           → main dashboard page
 *   GET  /analytics/data      → JSON endpoint for Chart.js (time-series)
 *   GET  /analytics/breakdown → JSON endpoint for breakdown data
 *   POST /analytics/export/csv → trigger CSV export, redirect to download
 *   POST /analytics/export/pdf → trigger PDF export, redirect to download
 *
 * References:
 *   - requirements.md §13.2 — time-series dashboard
 *   - requirements.md §13.3 — breakdown per connection/rule
 *   - requirements.md §13.4 — export CSV/PDF
 */

const { Router } = require('express');

const { requireAuth } = require('../../server/middleware/rbac');
const analyticsService = require('./analytics-service');
const exportService = require('./export-service');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /analytics — main dashboard page
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const range = req.query.range || '7d';
    const metric = req.query.metric || 'message_sent';

    const summary = await analyticsService.getSummary(req.tenant.id, { range });
    const metrics = analyticsService.getAvailableMetrics();

    return res.render('analytics/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('analytics.title') : 'Analytics',
      summary,
      metrics,
      selectedMetric: metric,
      selectedRange: range,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /analytics/data — JSON endpoint for Chart.js
// ---------------------------------------------------------------------------

router.get('/data', requireAuth(), async (req, res, next) => {
  try {
    const { metric, startDate, endDate, range } = req.query;

    const timeSeries = await analyticsService.getTimeSeries(req.tenant.id, {
      metric: metric || 'message_sent',
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      range: range || '7d',
    });

    return res.json({ data: timeSeries });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /analytics/breakdown — JSON endpoint for breakdown data
// ---------------------------------------------------------------------------

router.get('/breakdown', requireAuth(), async (req, res, next) => {
  try {
    const { metric, startDate, endDate, range, groupBy } = req.query;

    const breakdown = await analyticsService.getBreakdown(req.tenant.id, {
      metric: metric || 'message_sent',
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      range: range || '7d',
      groupBy: groupBy || undefined,
    });

    return res.json({ data: breakdown });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /analytics/export/csv — trigger CSV export
// ---------------------------------------------------------------------------

router.post('/export/csv', requireAuth(), async (req, res, next) => {
  const log = getLogger();

  try {
    const { metric, startDate, endDate, range } = req.body;

    const url = await exportService.exportCsv(req.tenant.id, {
      metric: metric || 'message_sent',
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      range: range || '7d',
    });

    log.info(
      { tenantId: req.tenant.id, metric },
      'analytics-routes: CSV export generated'
    );

    return res.redirect(url);
  } catch (err) {
    log.warn({ err }, 'analytics-routes: CSV export failed');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /analytics/export/pdf — trigger PDF export
// ---------------------------------------------------------------------------

router.post('/export/pdf', requireAuth(), async (req, res, next) => {
  const log = getLogger();

  try {
    const { metric, startDate, endDate, range } = req.body;

    const url = await exportService.exportPdf(req.tenant.id, {
      metric: metric || 'message_sent',
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      range: range || '7d',
    });

    log.info(
      { tenantId: req.tenant.id, metric },
      'analytics-routes: PDF export generated'
    );

    return res.redirect(url);
  } catch (err) {
    log.warn({ err }, 'analytics-routes: PDF export failed');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
