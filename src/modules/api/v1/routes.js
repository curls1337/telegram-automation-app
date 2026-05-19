'use strict';

/**
 * REST API v1 Routes — CRUD endpoints for core resources.
 *
 * All routes are prefixed with /api/v1 (mounted by index.web.js).
 * Authentication via Bearer token (api-auth-middleware).
 * Rate limited at 100 req/min per API key (api-rate-limit).
 *
 * Endpoints:
 *   - GET/POST /subscribers, GET/PATCH/DELETE /subscribers/:id
 *   - GET/POST /tags, DELETE /tags/:id
 *   - GET/POST /auto-reply-rules, GET/PATCH/DELETE /auto-reply-rules/:id
 *   - GET/POST /scheduled-posts, GET/DELETE /scheduled-posts/:id, POST /scheduled-posts/:id/cancel
 *   - GET/POST /broadcasts, GET /broadcasts/:id
 *
 * References:
 *   - requirements.md §14.4 — REST CRUD endpoints
 */

const { Router } = require('express');

const { apiAuthMiddleware } = require('./api-auth-middleware');
const { apiRateLimitMiddleware } = require('./api-rate-limit');
const subscriberService = require('../../subscribers/subscriber-service');
const tagService = require('../../subscribers/tag-service');
const ruleService = require('../../auto-reply/rule-service');
const schedulerService = require('../../scheduler/scheduler-service');
const broadcastService = require('../../broadcasts/broadcast-service');
const { NotFoundError, ValidationError } = require('../../../shared/errors');
const { getLogger } = require('../../../infra/logger');

const router = Router();

// ---------------------------------------------------------------------------
// Global middleware for all API v1 routes
// ---------------------------------------------------------------------------

router.use(apiAuthMiddleware);
router.use(apiRateLimitMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap async route handlers to catch errors and return JSON.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * API error handler — returns JSON error responses.
 */
function apiErrorHandler(err, _req, res, _next) {
  const log = getLogger();

  if (err && err.code === 'not_found') {
    return res.status(404).json({ error: { code: 'not_found', message: err.message } });
  }

  if (err && err.code === 'validation_error') {
    return res.status(400).json({
      error: { code: 'validation_error', message: err.message, details: err.details || null },
    });
  }

  if (err && err.httpStatus) {
    return res.status(err.httpStatus).json({
      error: { code: err.code || 'error', message: err.expose ? err.message : 'An error occurred' },
    });
  }

  log.error({ err }, 'api-v1: unhandled error');
  return res.status(500).json({
    error: { code: 'internal_error', message: 'An unexpected error occurred' },
  });
}

// ---------------------------------------------------------------------------
// SUBSCRIBERS
// ---------------------------------------------------------------------------

router.get('/subscribers', asyncHandler(async (req, res) => {
  const { page, pageSize, status, search, connectionId } = req.query;
  const result = await subscriberService.list(req.tenant.id, {
    page: page ? parseInt(page, 10) : 1,
    pageSize: pageSize ? parseInt(pageSize, 10) : 25,
    status,
    search,
    connectionId,
  });
  return res.json({ data: result.data, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
}));

router.get('/subscribers/:id', asyncHandler(async (req, res) => {
  const subscriber = await subscriberService.getById(req.tenant.id, req.params.id);
  return res.json({ data: subscriber });
}));

router.patch('/subscribers/:id', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) {
    throw new ValidationError('status is required');
  }
  const updated = await subscriberService.updateStatus(req.tenant.id, req.params.id, status);
  return res.json({ data: updated });
}));

router.delete('/subscribers/:id', asyncHandler(async (req, res) => {
  // Update status to deactivated (soft delete)
  await subscriberService.updateStatus(req.tenant.id, req.params.id, 'deactivated');
  return res.status(204).end();
}));

// ---------------------------------------------------------------------------
// TAGS
// ---------------------------------------------------------------------------

router.get('/tags', asyncHandler(async (req, res) => {
  const tags = await tagService.list(req.tenant.id);
  return res.json({ data: tags });
}));

router.post('/tags', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('name is required');
  }
  const tag = await tagService.create(req.tenant.id, name);
  return res.status(201).json({ data: tag });
}));

router.delete('/tags/:id', asyncHandler(async (req, res) => {
  await tagService.remove(req.tenant.id, req.params.id);
  return res.status(204).end();
}));

// ---------------------------------------------------------------------------
// AUTO-REPLY RULES
// ---------------------------------------------------------------------------

router.get('/auto-reply-rules', asyncHandler(async (req, res) => {
  const { page, pageSize } = req.query;
  const result = await ruleService.list(req.tenant.id, {
    page: page ? parseInt(page, 10) : 1,
    pageSize: pageSize ? parseInt(pageSize, 10) : 25,
  });
  return res.json({ data: result.data, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
}));

router.post('/auto-reply-rules', asyncHandler(async (req, res) => {
  const rule = await ruleService.create(req.tenant.id, req.body);
  return res.status(201).json({ data: rule });
}));

router.get('/auto-reply-rules/:id', asyncHandler(async (req, res) => {
  const rule = await ruleService.getById(req.tenant.id, req.params.id);
  return res.json({ data: rule });
}));

router.patch('/auto-reply-rules/:id', asyncHandler(async (req, res) => {
  const rule = await ruleService.update(req.tenant.id, req.params.id, req.body);
  return res.json({ data: rule });
}));

router.delete('/auto-reply-rules/:id', asyncHandler(async (req, res) => {
  await ruleService.remove(req.tenant.id, req.params.id);
  return res.status(204).end();
}));

// ---------------------------------------------------------------------------
// SCHEDULED POSTS
// ---------------------------------------------------------------------------

router.get('/scheduled-posts', asyncHandler(async (req, res) => {
  const { page, pageSize, status } = req.query;
  const result = await schedulerService.list(req.tenant.id, {
    page: page ? parseInt(page, 10) : 1,
    pageSize: pageSize ? parseInt(pageSize, 10) : 25,
    status,
  });
  return res.json({ data: result.data, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
}));

router.post('/scheduled-posts', asyncHandler(async (req, res) => {
  const post = await schedulerService.createScheduledPost(req.tenant.id, req.body);
  return res.status(201).json({ data: post });
}));

router.get('/scheduled-posts/:id', asyncHandler(async (req, res) => {
  const post = await schedulerService.getById(req.tenant.id, req.params.id);
  if (!post) {
    throw new NotFoundError('Scheduled post not found');
  }
  return res.json({ data: post });
}));

router.delete('/scheduled-posts/:id', asyncHandler(async (req, res) => {
  await schedulerService.cancelScheduledPost(req.params.id, req.tenant.id);
  return res.status(204).end();
}));

router.post('/scheduled-posts/:id/cancel', asyncHandler(async (req, res) => {
  await schedulerService.cancelScheduledPost(req.params.id, req.tenant.id);
  return res.json({ data: { status: 'cancelled' } });
}));

// ---------------------------------------------------------------------------
// BROADCASTS
// ---------------------------------------------------------------------------

router.get('/broadcasts', asyncHandler(async (req, res) => {
  const { page, pageSize, status } = req.query;
  const result = await broadcastService.list(req.tenant.id, {
    page: page ? parseInt(page, 10) : 1,
    pageSize: pageSize ? parseInt(pageSize, 10) : 25,
    status,
  });
  return res.json({ data: result.data, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
}));

router.post('/broadcasts', asyncHandler(async (req, res) => {
  const broadcast = await broadcastService.create(req.tenant.id, req.body);
  return res.status(201).json({ data: broadcast });
}));

router.get('/broadcasts/:id', asyncHandler(async (req, res) => {
  const broadcast = await broadcastService.getById(req.tenant.id, req.params.id);
  return res.json({ data: broadcast });
}));

// ---------------------------------------------------------------------------
// Error handler (must be last)
// ---------------------------------------------------------------------------

router.use(apiErrorHandler);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
