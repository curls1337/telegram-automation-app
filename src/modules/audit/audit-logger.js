'use strict';

/**
 * Audit log service — append-only logging of significant user actions.
 *
 * Responsibilities:
 *   - Write audit entries to the `audit_logs` table (INSERT only).
 *   - Query audit logs with filters (tenant, date range, user, action).
 *   - No update or delete methods are exposed (append-only by design).
 *
 * References:
 *   - requirements.md §19.1–19.4
 *   - design.md "Audit Log" — append-only, no update/delete, retention 365 days
 */

const { getDb } = require('../../infra/db');
const { newId } = require('../../shared/ids');
const { now } = require('../../shared/time');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'audit_logs';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write an audit log entry. This is the only write operation exposed —
 * no update or delete methods exist by design.
 *
 * @param {object} entry
 * @param {string} entry.tenantId - Tenant ID (nullable for super_admin actions)
 * @param {string} entry.userId - User who performed the action (nullable for system actions)
 * @param {string} entry.action - Action identifier (e.g. 'user.login', 'connection.create')
 * @param {string} [entry.resourceType] - Type of resource affected (e.g. 'telegram_connection')
 * @param {string} [entry.resourceId] - ID of the affected resource
 * @param {string} [entry.ip] - Client IP address
 * @param {object} [entry.meta] - Additional metadata (JSON-serializable)
 * @returns {Promise<object>} The inserted audit log row
 */
async function write({ tenantId, userId, action, resourceType, resourceId, ip, meta } = {}) {
  if (!action) {
    throw new TypeError('audit.write: action is required');
  }

  const db = getDb();

  const row = {
    id: newId(),
    tenant_id: tenantId || null,
    user_id: userId || null,
    action,
    resource_type: resourceType || null,
    resource_id: resourceId || null,
    ip_address: ip || null,
    meta: meta ? JSON.stringify(meta) : null,
    created_at: now(),
  };

  const [inserted] = await db(TABLE).insert(row).returning('*');
  return inserted;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Query audit logs with optional filters, ordered by created_at DESC.
 *
 * @param {object} filters
 * @param {string} [filters.tenantId] - Filter by tenant
 * @param {Date|string} [filters.dateFrom] - Start of date range (inclusive)
 * @param {Date|string} [filters.dateTo] - End of date range (inclusive)
 * @param {string} [filters.userId] - Filter by user
 * @param {string} [filters.action] - Filter by action
 * @param {number} [filters.page=1] - Page number (1-indexed)
 * @param {number} [filters.pageSize=50] - Items per page (max 200)
 * @returns {Promise<{ data: object[], total: number, page: number, pageSize: number }>}
 */
async function query({ tenantId, dateFrom, dateTo, userId, action, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const db = getDb();

  // Clamp page size
  const effectivePageSize = Math.min(Math.max(1, pageSize || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const effectivePage = Math.max(1, page || 1);
  const offset = (effectivePage - 1) * effectivePageSize;

  // Build base query
  let baseQuery = db(TABLE);

  if (tenantId) {
    baseQuery = baseQuery.where('tenant_id', tenantId);
  }
  if (userId) {
    baseQuery = baseQuery.where('user_id', userId);
  }
  if (action) {
    baseQuery = baseQuery.where('action', action);
  }
  if (dateFrom) {
    baseQuery = baseQuery.where('created_at', '>=', dateFrom);
  }
  if (dateTo) {
    baseQuery = baseQuery.where('created_at', '<=', dateTo);
  }

  // Get total count
  const [{ count }] = await baseQuery.clone().count('* as count');
  const total = parseInt(count, 10);

  // Get paginated data
  const data = await baseQuery
    .clone()
    .orderBy('created_at', 'desc')
    .limit(effectivePageSize)
    .offset(offset);

  return {
    data,
    total,
    page: effectivePage,
    pageSize: effectivePageSize,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  write,
  query,
};
