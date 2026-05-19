'use strict';

/**
 * Subscriber/Member routes — subscribers, tags, segments CRUD + export.
 *
 * Mounted at /subscribers (or /members) in the main Express app.
 *
 * References:
 *   - requirements.md §10.2, §10.3, §10.7
 *   - design.md "Subscriber & Segmentation"
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const subscriberService = require('./subscriber-service');
const tagService = require('./tag-service');
const segmentService = require('./segment-service');
const exportService = require('./export-service');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /subscribers — list subscribers
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { page, connectionId, status, search } = req.query;
    const result = await subscriberService.list(req.tenant.id, {
      page,
      pageSize: 25,
      connectionId,
      status,
      search,
    });

    return res.render('members/subscribers', {
      layout: 'layouts/main',
      title: req.t ? req.t('subscribers.title') : 'Subscribers',
      subscribers: result.data,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: Math.ceil(result.total / result.pageSize),
      query: req.query,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /subscribers/export — trigger CSV export
// ---------------------------------------------------------------------------

router.get('/export', requireAuth(), async (req, res, next) => {
  try {
    const { connectionId, segmentId } = req.query;
    const result = await exportService.exportCsv(req.tenant.id, {
      connectionId,
      segmentId,
    });

    return res.json({ url: result.url, key: result.key });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /subscribers/tags — list tags
// ---------------------------------------------------------------------------

router.get('/tags', requireAuth(), async (req, res, next) => {
  try {
    const tags = await tagService.list(req.tenant.id);

    return res.render('members/tags', {
      layout: 'layouts/main',
      title: req.t ? req.t('tags.title') : 'Tags',
      tags,
      error: null,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /subscribers/tags — create tag
// ---------------------------------------------------------------------------

router.post('/tags', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { name } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    try {
      const tags = await tagService.list(req.tenant.id);
      return res.render('members/tags', {
        layout: 'layouts/main',
        title: req.t ? req.t('tags.title') : 'Tags',
        tags,
        error: req.t ? req.t('tags.nameRequired') : 'Tag name is required',
      });
    } catch (err) {
      return next(err);
    }
  }

  try {
    await tagService.create(req.tenant.id, name);
    if (req.flash) req.flash('success', req.t ? req.t('tags.created') : 'Tag created successfully');
    return res.redirect('/subscribers/tags');
  } catch (err) {
    log.warn({ err }, 'subscribers: failed to create tag');
    try {
      const tags = await tagService.list(req.tenant.id);
      return res.render('members/tags', {
        layout: 'layouts/main',
        title: req.t ? req.t('tags.title') : 'Tags',
        tags,
        error: err.message || 'Failed to create tag',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /subscribers/tags/:id/delete — delete tag
// ---------------------------------------------------------------------------

router.post('/tags/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await tagService.remove(req.tenant.id, req.params.id);
    if (req.flash) req.flash('success', req.t ? req.t('tags.deleted') : 'Tag deleted successfully');
    return res.redirect('/subscribers/tags');
  } catch (err) {
    log.warn({ err, tagId: req.params.id }, 'subscribers: failed to delete tag');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /subscribers/segments — list segments
// ---------------------------------------------------------------------------

router.get('/segments', requireAuth(), async (req, res, next) => {
  try {
    const segments = await segmentService.list(req.tenant.id);

    return res.render('members/segments', {
      layout: 'layouts/main',
      title: req.t ? req.t('segments.title') : 'Segments',
      segments,
      error: null,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /subscribers/segments — create segment
// ---------------------------------------------------------------------------

router.post('/segments', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { name, predicate } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    try {
      const segments = await segmentService.list(req.tenant.id);
      return res.render('members/segments', {
        layout: 'layouts/main',
        title: req.t ? req.t('segments.title') : 'Segments',
        segments,
        error: req.t ? req.t('segments.nameRequired') : 'Segment name is required',
      });
    } catch (err) {
      return next(err);
    }
  }

  try {
    // Parse predicate from form data
    let parsedPredicate;
    if (typeof predicate === 'string') {
      parsedPredicate = JSON.parse(predicate);
    } else if (typeof predicate === 'object' && predicate !== null) {
      parsedPredicate = predicate;
    } else {
      parsedPredicate = { conditions: [], logic: 'and' };
    }

    await segmentService.create(req.tenant.id, { name, predicate: parsedPredicate });
    if (req.flash) req.flash('success', req.t ? req.t('segments.created') : 'Segment created successfully');
    return res.redirect('/subscribers/segments');
  } catch (err) {
    log.warn({ err }, 'subscribers: failed to create segment');
    try {
      const segments = await segmentService.list(req.tenant.id);
      return res.render('members/segments', {
        layout: 'layouts/main',
        title: req.t ? req.t('segments.title') : 'Segments',
        segments,
        error: err.message || 'Failed to create segment',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /subscribers/segments/:id — update segment
// ---------------------------------------------------------------------------

router.post('/segments/:id', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { name, predicate } = req.body;

  try {
    let parsedPredicate;
    if (typeof predicate === 'string' && predicate.trim().length > 0) {
      parsedPredicate = JSON.parse(predicate);
    } else if (typeof predicate === 'object' && predicate !== null) {
      parsedPredicate = predicate;
    }

    await segmentService.update(req.tenant.id, req.params.id, {
      name: name || undefined,
      predicate: parsedPredicate,
    });

    if (req.flash) req.flash('success', req.t ? req.t('segments.updated') : 'Segment updated successfully');
    return res.redirect('/subscribers/segments');
  } catch (err) {
    log.warn({ err, segmentId: req.params.id }, 'subscribers: failed to update segment');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /subscribers/segments/:id/delete — delete segment
// ---------------------------------------------------------------------------

router.post('/segments/:id/delete', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await segmentService.remove(req.tenant.id, req.params.id);
    if (req.flash) req.flash('success', req.t ? req.t('segments.deleted') : 'Segment deleted successfully');
    return res.redirect('/subscribers/segments');
  } catch (err) {
    log.warn({ err, segmentId: req.params.id }, 'subscribers: failed to delete segment');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
