'use strict';

/**
 * Migration 0002 — Plans & Subscriptions.
 *
 * Creates:
 *   - plans            Available subscription plans with quota limits
 *   - subscriptions    Tenant subscription to a plan with status tracking
 *
 * References:
 *   - design.md "Table Specifications" (plans / subscriptions)
 *   - requirements.md §15.1 (plan management), §15.2 (subscription lifecycle)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // plans
  // -------------------------------------------------------------------------
  await knex.schema.createTable('plans', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable();
    t.integer('price_cents').notNullable().defaultTo(0);
    t.integer('duration_months').notNullable().defaultTo(1);
    t.integer('max_bot_connections').notNullable().defaultTo(1);
    t.integer('max_user_connections').notNullable().defaultTo(0);
    t.integer('max_subscribers').notNullable().defaultTo(100);
    t.integer('max_broadcasts_per_month').notNullable().defaultTo(10);
    t.integer('max_auto_reply_rules').notNullable().defaultTo(5);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // -------------------------------------------------------------------------
  // subscriptions
  // -------------------------------------------------------------------------
  await knex.schema.createTable('subscriptions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('plan_id')
      .notNullable()
      .references('id')
      .inTable('plans')
      .onDelete('RESTRICT');
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('started_at', { useTz: true }).notNullable();
    t.timestamp('ends_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check("status IN ('active', 'expired')", [], 'subscriptions_status_check');
    t.index(['tenant_id', 'status'], 'subscriptions_tenant_id_status_index');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('subscriptions');
  await knex.schema.dropTableIfExists('plans');
}

module.exports = { up, down };
