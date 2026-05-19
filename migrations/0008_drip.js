'use strict';

/**
 * Migration 0008 — Drip Campaigns, Steps & Enrollments.
 *
 * Creates:
 *   - drip_campaigns      Campaign definitions with trigger and exit conditions
 *   - drip_steps          Ordered sequence of messages within a campaign
 *   - drip_enrollments    Per-subscriber state within a campaign
 *
 * References:
 *   - design.md "Table Specifications" (drip_campaigns / drip_steps / drip_enrollments)
 *   - requirements.md §11.1 (campaign creation), §11.2 (step scheduling)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // drip_campaigns
  // -------------------------------------------------------------------------
  await knex.schema.createTable('drip_campaigns', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('name').notNullable();
    t.uuid('connection_id')
      .references('id')
      .inTable('telegram_connections')
      .onDelete('CASCADE');
    t.text('trigger_kind').notNullable();
    t.jsonb('trigger_config').nullable();
    t.jsonb('exit_conditions').nullable();
    t.text('status').notNullable().defaultTo('draft');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "trigger_kind IN ('subscribe', 'tag_added', 'manual')",
      [],
      'drip_campaigns_trigger_kind_check',
    );
    t.check(
      "status IN ('draft', 'active', 'paused', 'archived')",
      [],
      'drip_campaigns_status_check',
    );
  });

  // -------------------------------------------------------------------------
  // drip_steps
  // -------------------------------------------------------------------------
  await knex.schema.createTable('drip_steps', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id')
      .notNullable()
      .references('id')
      .inTable('drip_campaigns')
      .onDelete('CASCADE');
    t.integer('step_index').notNullable();
    t.integer('delay_seconds').notNullable();
    t.jsonb('payload').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['campaign_id', 'step_index'], { indexName: 'drip_steps_campaign_id_step_index_unique' });
  });

  // -------------------------------------------------------------------------
  // drip_enrollments
  // -------------------------------------------------------------------------
  await knex.schema.createTable('drip_enrollments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id')
      .notNullable()
      .references('id')
      .inTable('drip_campaigns')
      .onDelete('CASCADE');
    t.uuid('subscriber_id')
      .notNullable()
      .references('id')
      .inTable('subscribers')
      .onDelete('CASCADE');
    t.integer('current_step').notNullable().defaultTo(0);
    t.timestamp('next_run_at', { useTz: true }).nullable();
    t.text('status').notNullable().defaultTo('pending');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['campaign_id', 'subscriber_id'], { indexName: 'drip_enrollments_campaign_subscriber_unique' });
    t.check(
      "status IN ('pending', 'running', 'completed', 'paused', 'stopped_blocked', 'exited')",
      [],
      'drip_enrollments_status_check',
    );
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('drip_enrollments');
  await knex.schema.dropTableIfExists('drip_steps');
  await knex.schema.dropTableIfExists('drip_campaigns');
}

module.exports = { up, down };
