'use strict';

/**
 * Migration 0007 — Broadcasts & Broadcast Targets.
 *
 * Creates:
 *   - broadcasts           Batch message campaigns with progress tracking
 *   - broadcast_targets    Per-subscriber delivery status for a broadcast
 *
 * References:
 *   - design.md "Table Specifications" (broadcasts / broadcast_targets)
 *   - requirements.md §9.1 (broadcast creation), §9.3 (delivery tracking)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // broadcasts
  // -------------------------------------------------------------------------
  await knex.schema.createTable('broadcasts', (t) => {
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
    t.jsonb('audience').notNullable();
    t.jsonb('payload').notNullable();
    t.text('status').notNullable().defaultTo('pending');
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.integer('total_targets').notNullable().defaultTo(0);
    t.integer('sent_count').notNullable().defaultTo(0);
    t.integer('failed_count').notNullable().defaultTo(0);
    t.integer('blocked_count').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "status IN ('pending', 'running', 'paused', 'completed', 'cancelled')",
      [],
      'broadcasts_status_check',
    );
  });

  // -------------------------------------------------------------------------
  // broadcast_targets
  // -------------------------------------------------------------------------
  await knex.schema.createTable('broadcast_targets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('broadcast_id')
      .notNullable()
      .references('id')
      .inTable('broadcasts')
      .onDelete('CASCADE');
    t.uuid('subscriber_id')
      .notNullable()
      .references('id')
      .inTable('subscribers')
      .onDelete('CASCADE');
    t.text('status').notNullable().defaultTo('pending');
    t.text('error').nullable();
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "status IN ('pending', 'sent', 'failed', 'blocked', 'deactivated', 'skipped')",
      [],
      'broadcast_targets_status_check',
    );
    t.index(['broadcast_id', 'status'], 'broadcast_targets_broadcast_id_status_index');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('broadcast_targets');
  await knex.schema.dropTableIfExists('broadcasts');
}

module.exports = { up, down };
