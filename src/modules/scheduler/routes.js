'use strict';

/**
 * Scheduled Posts routes — CRUD for scheduled posts.
 *
 * Mounted at /posts in the main Express app.
 *
 * Routes:
 *   GET  /posts          → list scheduled posts for tenant
 *   GET  /posts/new      → form to create a new scheduled post
 *   POST /posts          → create a scheduled post
 *   GET  /posts/:id      → post detail page (status, error, attempts)
 *   POST /posts/:id/cancel → cancel a scheduled post
 *
 * All routes require authentication. Write operations require 'write' action.
 *
 * References:
 *   - requirements.md §6.1 — create scheduled post.
 *   - requirements.md §6.7 — cancel scheduled post.
 *   - design.md "Scheduler" — UI routes.
 */

const { Router } = require('express');

const { requireAuth, requireAction } = require('../../server/middleware/rbac');
const schedulerService = require('./scheduler-service');
const { tenantQuery } = require('../../infra/db');
const { getLogger } = require('../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// GET /posts — list scheduled posts
// ---------------------------------------------------------------------------

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { page, status } = req.query;
    const result = await schedulerService.list(req.tenant.id, {
      page,
      pageSize: 25,
      status,
    });

    return res.render('posts/index', {
      layout: 'layouts/main',
      title: req.t ? req.t('posts.list.title') : 'Scheduled Posts',
      posts: result.data,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: Math.ceil(result.total / result.pageSize),
      query: req.query,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /posts/new — new scheduled post form
// ---------------------------------------------------------------------------

router.get('/new', requireAuth(), requireAction('write'), async (req, res, next) => {
  try {
    // Load connections for the dropdown
    const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
      .where({ status: 'active' })
      .orderBy('display_name', 'asc');

    return res.render('posts/new', {
      layout: 'layouts/main',
      title: req.t ? req.t('posts.new.title') : 'New Scheduled Post',
      connections,
      error: null,
      formData: {},
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /posts — create scheduled post
// ---------------------------------------------------------------------------

router.post('/', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();
  const { target_chat, message_text, run_at, repeat_type, connection_id, media_ids } = req.body;

  // Build payload
  const payload = {
    text: message_text || '',
    media_ids: media_ids ? (Array.isArray(media_ids) ? media_ids : [media_ids]).filter(Boolean) : [],
  };

  // Build repeat config
  let repeat = null;
  if (repeat_type && repeat_type !== 'none') {
    repeat = { type: repeat_type };
  }

  const input = {
    targetChat: target_chat,
    payload,
    runAt: run_at,
    repeat,
    connectionId: connection_id,
  };

  try {
    await schedulerService.createScheduledPost(req.tenant.id, input);

    if (req.flash) req.flash('success', req.t ? req.t('posts.created') : 'Post scheduled successfully');
    return res.redirect('/posts');
  } catch (err) {
    log.warn({ err }, 'posts: failed to create scheduled post');

    // Re-render form with error
    try {
      const connections = await tenantQuery(req.tenant.id, 'telegram_connections')
        .where({ status: 'active' })
        .orderBy('display_name', 'asc');

      return res.status(err.httpStatus || 400).render('posts/new', {
        layout: 'layouts/main',
        title: req.t ? req.t('posts.new.title') : 'New Scheduled Post',
        connections,
        error: err.message || 'Failed to create scheduled post',
        formData: req.body,
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /posts/:id — post detail
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const post = await schedulerService.getById(req.tenant.id, req.params.id);

    if (!post) {
      return res.status(404).render('posts/detail', {
        layout: 'layouts/main',
        title: 'Post Not Found',
        post: null,
        error: req.t ? req.t('posts.notFound') : 'Scheduled post not found',
        csrfToken: req.csrfToken ? req.csrfToken() : '',
      });
    }

    return res.render('posts/detail', {
      layout: 'layouts/main',
      title: req.t ? req.t('posts.detail.title') : 'Post Detail',
      post,
      error: null,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /posts/:id/cancel — cancel a scheduled post
// ---------------------------------------------------------------------------

router.post('/:id/cancel', requireAuth(), requireAction('write'), async (req, res, next) => {
  const log = getLogger();

  try {
    await schedulerService.cancelScheduledPost(req.params.id, req.tenant.id);

    if (req.flash) req.flash('success', req.t ? req.t('posts.cancelled') : 'Post cancelled successfully');
    return res.redirect('/posts');
  } catch (err) {
    log.warn({ err, postId: req.params.id }, 'posts: failed to cancel post');
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
