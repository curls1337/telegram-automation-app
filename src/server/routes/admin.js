'use strict';

/**
 * Super Admin routes — consolidated admin panel routes.
 *
 * All routes under /admin/* are protected by requireRole('super_admin').
 * Provides:
 *   - GET /admin/tenants — list all tenants with status, plan, member count
 *   - GET /admin/audit — global audit log with filters
 *   - GET /admin/system-config — health status and env audit
 *
 * The existing plan/subscription admin routes (admin-routes.js) are mounted
 * separately but also protected by requireRole('super_admin').
 *
 * References:
 *   - requirements.md §2.6 — super_admin access
 *   - requirements.md §19.4 — global audit log
 *   - requirements.md §21.3 — health-check / system status
 */

const { Router } = require('express');
const { requireRole } = require('../middleware/rbac');
const { getDb } = require('../../infra/db');
const { pingRedis } = require('../../infra/redis');
const { QUEUE_NAMES, getQueue } = require('../../infra/queues');
const auditLogger = require('../../modules/audit/audit-logger');

const router = Router();

// All admin routes require super_admin role
router.use(requireRole('super_admin'));

// ---------------------------------------------------------------------------
// GET /admin/tenants — List all tenants
// ---------------------------------------------------------------------------

router.get('/tenants', async (req, res, next) => {
  try {
    const db = getDb();

    const tenants = await db('tenants')
      .leftJoin('subscriptions', function () {
        this.on('subscriptions.tenant_id', '=', 'tenants.id')
          .andOn('subscriptions.status', '=', db.raw("'active'"));
      })
      .leftJoin('plans', 'subscriptions.plan_id', 'plans.id')
      .leftJoin(
        db('tenant_members')
          .select('tenant_id')
          .count('* as member_count')
          .groupBy('tenant_id')
          .as('mc'),
        'mc.tenant_id',
        'tenants.id'
      )
      .select(
        'tenants.id',
        'tenants.name',
        'tenants.status',
        'tenants.created_at',
        'plans.name as plan_name',
        'subscriptions.status as subscription_status',
        'mc.member_count'
      )
      .orderBy('tenants.created_at', 'desc');

    res.render('admin/tenants', {
      layout: 'layouts/main',
      title: 'Tenants',
      tenants,
      success: req.query.success || null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/audit — Global audit log
// ---------------------------------------------------------------------------

router.get('/audit', async (req, res, next) => {
  try {
    const db = getDb();

    // Build filters from query params
    const filters = {
      tenantId: req.query.tenant_id || undefined,
      userId: req.query.user_id || undefined,
      action: req.query.action || undefined,
      dateFrom: req.query.date_from || undefined,
      dateTo: req.query.date_to || undefined,
    };

    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = 50;

    // Query audit logs
    const result = await auditLogger.query({
      ...filters,
      page,
      pageSize,
    });

    // Get tenants for filter dropdown
    const tenants = await db('tenants').select('id', 'name').orderBy('name');

    // Get distinct actions for filter dropdown
    const actionsResult = await db('audit_logs')
      .distinct('action')
      .orderBy('action');
    const actions = actionsResult.map((r) => r.action);

    const totalPages = Math.ceil(result.total / pageSize);

    res.render('admin/audit', {
      layout: 'layouts/main',
      title: 'Audit Log',
      logs: result.data,
      tenants,
      actions,
      filters,
      page,
      totalPages,
      total: result.total,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/system-config — Health status and env audit
// ---------------------------------------------------------------------------

router.get('/system-config', async (req, res, next) => {
  try {
    const db = getDb();

    // Check PostgreSQL health
    let pgHealthy = false;
    try {
      await db.raw('SELECT 1');
      pgHealthy = true;
    } catch (_err) {
      pgHealthy = false;
    }

    // Check Redis health
    const redisHealthy = await pingRedis();

    // Get queue depths
    const queueDepths = {};
    for (const qName of Object.values(QUEUE_NAMES)) {
      try {
        const queue = getQueue(qName);
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        queueDepths[qName] = counts.waiting + counts.active + counts.delayed;
      } catch (_err) {
        queueDepths[qName] = -1; // indicates error
      }
    }

    // Environment variable audit (names only, never values)
    const envVarNames = [
      'NODE_ENV',
      'PORT',
      'BASE_URL',
      'DATABASE_URL',
      'REDIS_URL',
      'SESSION_SECRET',
      'APP_MASTER_KEY',
      'APP_MASTER_KEY_ID',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'S3_BUCKET',
      'SMTP_URL',
      'MAIL_FROM',
      'GEMINI_API_KEY',
      'SUPER_ADMIN_EMAIL',
      'SUPER_ADMIN_PASSWORD',
      'METRICS_ENABLED',
    ];

    const envVars = envVarNames.map((name) => ({
      name,
      isSet: process.env[name] != null && process.env[name] !== '',
    }));

    res.render('admin/system-config', {
      layout: 'layouts/main',
      title: 'System Configuration',
      health: {
        postgres: pgHealthy,
        redis: redisHealthy,
        queues: queueDepths,
      },
      envVars,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
