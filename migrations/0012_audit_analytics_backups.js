'use strict';

/**
 * Migration 0012 — Audit Logs, Analytics Events, Analytics Daily & Backups.
 *
 * Creates:
 *   - audit_logs          Append-only action log (future: partitioned monthly)
 *   - analytics_events    Raw event stream (future: partitioned daily)
 *   - analytics_daily     Pre-aggregated daily rollup table
 *   - backups             Backup job tracking
 *
 * NOTE: For MVP, actual Postgres partitioning is skipped due to complexity.
 * Tables are created as regular tables with comments noting future partitioning.
 * Partitioning can be added later via a dedicated migration when scale demands it.
 *
 * References:
 *   - design.md "Table Specifications" (audit_logs / analytics_events /
 *     analytics_daily / backups)
 *   - requirements.md §13.1 (analytics), §16.1 (backup), §19.1 (audit log)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // audit_logs
  // -------------------------------------------------------------------------
  // Future: PARTITION BY RANGE (created_at) monthly
  await knex.schema.createTable('audit_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .nullable()
      .references('id')
      .inTable('tenants')
      .onDelete('SET NULL');
    t.uuid('user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    t.text('action').notNullable();
    t.text('resource_type').nullable();
    t.text('resource_id').nullable();
    t.specificType('ip_address', 'INET').nullable();
    t.jsonb('meta').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['tenant_id', 'created_at'], 'audit_logs_tenant_id_created_at_index');
  });

  await knex.raw("COMMENT ON TABLE audit_logs IS 'Future: partition by RANGE(created_at) monthly for retention management'");

  // -------------------------------------------------------------------------
  // analytics_events
  // -------------------------------------------------------------------------
  // Future: PARTITION BY RANGE (occurred_at) daily
  await knex.schema.createTable('analytics_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('kind').notNullable();
    t.text('subject_id').nullable();
    t.integer('metric_value').notNullable().defaultTo(1);
    t.jsonb('meta').nullable();
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['tenant_id', 'kind', 'occurred_at'], 'analytics_events_tenant_kind_occurred_at_index');
  });

  await knex.raw("COMMENT ON TABLE analytics_events IS 'Future: partition by RANGE(occurred_at) daily for retention and query performance'");

  // -------------------------------------------------------------------------
  // analytics_daily
  // -------------------------------------------------------------------------
  await knex.schema.createTable('analytics_daily', (t) => {
    t.uuid('tenant_id').notNullable();
    t.text('metric').notNullable();
    t.date('date').notNullable();
    t.bigInteger('value').notNullable().defaultTo(0);
    t.jsonb('breakdown').nullable();

    t.primary(['tenant_id', 'metric', 'date'], { constraintName: 'analytics_daily_pkey' });
  });

  // -------------------------------------------------------------------------
  // backups
  // -------------------------------------------------------------------------
  await knex.schema.createTable('backups', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('requested_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    t.text('object_key').nullable();
    t.bigInteger('size_bytes').nullable();
    t.text('sha256').nullable();
    t.text('status').notNullable().defaultTo('pending');
    t.text('error').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "status IN ('pending', 'running', 'completed', 'failed')",
      [],
      'backups_status_check',
    );
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('backups');
  await knex.schema.dropTableIfExists('analytics_daily');
  await knex.schema.dropTableIfExists('analytics_events');
  await knex.schema.dropTableIfExists('audit_logs');
}

module.exports = { up, down };
