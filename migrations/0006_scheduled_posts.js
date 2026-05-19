'use strict';

/**
 * Migration 0006 — Scheduled Posts.
 *
 * Creates:
 *   - scheduled_posts    Posts scheduled for future delivery via BullMQ
 *
 * Includes a partial index on (status, run_at) WHERE status = 'scheduled'
 * for efficient pending-job queries.
 *
 * References:
 *   - design.md "Table Specifications" (scheduled_posts)
 *   - requirements.md §6.1 (scheduled posting)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // scheduled_posts
  // -------------------------------------------------------------------------
  await knex.schema.createTable('scheduled_posts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('connection_id')
      .notNullable()
      .references('id')
      .inTable('telegram_connections')
      .onDelete('CASCADE');
    t.text('target_chat').notNullable();
    t.jsonb('payload').notNullable();
    t.timestamp('run_at', { useTz: true }).notNullable();
    t.jsonb('repeat').nullable();
    t.text('status').notNullable().defaultTo('scheduled');
    t.text('last_error').nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('bullmq_job_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "status IN ('scheduled', 'running', 'success', 'failed', 'cancelled')",
      [],
      'scheduled_posts_status_check',
    );
  });

  // Partial index for efficient pending-job lookup
  await knex.raw(`
    CREATE INDEX scheduled_posts_pending
    ON scheduled_posts (status, run_at)
    WHERE status = 'scheduled'
  `);
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('scheduled_posts');
}

module.exports = { up, down };
