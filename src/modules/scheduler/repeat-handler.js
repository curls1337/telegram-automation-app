'use strict';

/**
 * Repeat Handler — schedule the next occurrence of a repeating post.
 *
 * After a scheduled post executes successfully, this module checks if it has
 * a repeat configuration and, if so, creates a new scheduled_post record
 * with the next run_at and schedules it.
 *
 * Repeat types:
 *   - daily: +24 hours
 *   - weekly: +7 days
 *   - monthly: +1 calendar month
 *   - cron: next occurrence from cron expression (simplified)
 *
 * References:
 *   - requirements.md §6.3 — repeat (daily, weekly, monthly, cron).
 *   - design.md "Scheduler" — repeat option after successful execution.
 */

const { getDb, tenantInsert } = require('../../infra/db');
const { newId } = require('../../shared/ids');
const { nowIso, addDays, addHours } = require('../../shared/time');
const { getLogger } = require('../../infra/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = 'scheduled_posts';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// ---------------------------------------------------------------------------
// Next run_at calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the next run_at based on repeat configuration.
 *
 * @param {Date} lastRunAt - The last execution time.
 * @param {object} repeat - Repeat configuration.
 * @param {string} repeat.type - One of: daily, weekly, monthly, cron.
 * @param {string} [repeat.value] - Cron expression (for type=cron).
 * @returns {Date} The next run_at time.
 */
function calculateNextRunAt(lastRunAt, repeat) {
  const baseTime = new Date(lastRunAt);

  switch (repeat.type) {
    case 'daily':
      return new Date(baseTime.getTime() + MS_PER_DAY);

    case 'weekly':
      return new Date(baseTime.getTime() + MS_PER_WEEK);

    case 'monthly': {
      // Add one calendar month
      const next = new Date(baseTime);
      next.setMonth(next.getMonth() + 1);
      return next;
    }

    case 'cron': {
      // Simplified cron: for MVP, just add 24h as fallback.
      // A full cron parser (like cron-parser) can be added later.
      // For now, treat cron as daily if no proper parser is available.
      return new Date(baseTime.getTime() + MS_PER_DAY);
    }

    default:
      // Unknown repeat type — default to daily
      return new Date(baseTime.getTime() + MS_PER_DAY);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle repeat scheduling after a successful post execution.
 *
 * Creates a new scheduled_post record with the next run_at and schedules it
 * via the scheduler service (lazy-required to avoid circular dependency).
 *
 * @param {object} post - The completed scheduled_post record.
 * @returns {Promise<object|null>} The new post record, or null if no repeat.
 */
async function handleRepeat(post) {
  const log = getLogger();

  // Parse repeat config
  const repeat = typeof post.repeat === 'string' ? JSON.parse(post.repeat) : post.repeat;

  if (!repeat || !repeat.type) {
    return null;
  }

  // Calculate next run_at
  const lastRunAt = post.run_at ? new Date(post.run_at) : new Date();
  const nextRunAt = calculateNextRunAt(lastRunAt, repeat);

  // Ensure next run is in the future
  if (nextRunAt.getTime() <= Date.now()) {
    // If calculated time is in the past (e.g., long delay), use now + interval
    const now = new Date();
    const adjustedNext = calculateNextRunAt(now, repeat);
    nextRunAt.setTime(adjustedNext.getTime());
  }

  // Create new post record
  const newPostId = newId();
  const now = nowIso();

  const record = {
    id: newPostId,
    tenant_id: post.tenant_id,
    connection_id: post.connection_id,
    target_chat: post.target_chat,
    payload: typeof post.payload === 'string' ? post.payload : JSON.stringify(post.payload),
    run_at: nextRunAt.toISOString(),
    repeat: typeof post.repeat === 'string' ? post.repeat : JSON.stringify(repeat),
    status: 'scheduled',
    last_error: null,
    attempts: 0,
    bullmq_job_id: null,
    created_at: now,
    updated_at: now,
  };

  const [inserted] = await tenantInsert(post.tenant_id, TABLE, record, {
    returning: '*',
  });

  // Schedule the new post (lazy require to avoid circular dependency)
  const { scheduleScheduledPost } = require('./scheduler-service');
  await scheduleScheduledPost(inserted);

  log.info(
    { originalPostId: post.id, newPostId, nextRunAt: nextRunAt.toISOString(), repeatType: repeat.type },
    'repeat-handler: next occurrence scheduled'
  );

  return inserted;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleRepeat,
  calculateNextRunAt,
};
