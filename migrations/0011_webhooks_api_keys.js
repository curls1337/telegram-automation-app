'use strict';

/**
 * Migration 0011 — Webhooks, Webhook Deliveries & API Keys.
 *
 * Creates:
 *   - webhooks              Outbound webhook registrations per tenant
 *   - webhook_deliveries    Delivery attempt history (retention 30 days)
 *   - api_keys              Bearer tokens for REST API access
 *
 * References:
 *   - design.md "Table Specifications" (webhooks / webhook_deliveries / api_keys)
 *   - requirements.md §14.1 (API key creation), §14.5 (webhook registration)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // webhooks
  // -------------------------------------------------------------------------
  await knex.schema.createTable('webhooks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('url').notNullable();
    t.specificType('secret_encrypted', 'BYTEA').nullable();
    t.specificType('secret_iv', 'BYTEA').nullable();
    t.specificType('secret_tag', 'BYTEA').nullable();
    t.text('secret_key_id').nullable();
    t.specificType('events', 'TEXT[]').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('last_failure_at', { useTz: true }).nullable();
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "status IN ('active', 'disabled')",
      [],
      'webhooks_status_check',
    );
  });

  // -------------------------------------------------------------------------
  // webhook_deliveries
  // -------------------------------------------------------------------------
  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('webhook_id')
      .notNullable()
      .references('id')
      .inTable('webhooks')
      .onDelete('CASCADE');
    t.text('event').notNullable();
    t.jsonb('payload').notNullable();
    t.integer('status_code').nullable();
    t.integer('attempt').notNullable().defaultTo(1);
    t.timestamp('delivered_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['webhook_id'], 'webhook_deliveries_webhook_id_index');
  });

  // -------------------------------------------------------------------------
  // api_keys
  // -------------------------------------------------------------------------
  await knex.schema.createTable('api_keys', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('token_hash').notNullable();
    t.specificType('scopes', 'TEXT[]').notNullable().defaultTo('{}');
    t.timestamp('last_used_at', { useTz: true }).nullable();
    t.timestamp('revoked_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['token_hash'], { indexName: 'api_keys_token_hash_unique' });
    t.index(['tenant_id'], 'api_keys_tenant_id_index');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('api_keys');
  await knex.schema.dropTableIfExists('webhook_deliveries');
  await knex.schema.dropTableIfExists('webhooks');
}

module.exports = { up, down };
