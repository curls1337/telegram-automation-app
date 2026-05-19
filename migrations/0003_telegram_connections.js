'use strict';

/**
 * Migration 0003 — Telegram Connections.
 *
 * Creates:
 *   - telegram_connections    Bot and User (MTProto) connections with encrypted secrets
 *
 * References:
 *   - design.md "Table Specifications" (telegram_connections)
 *   - requirements.md §4.1 (bot connection), §4.3 (encryption), §5.1 (user connection), §5.2 (session encryption)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // telegram_connections
  // -------------------------------------------------------------------------
  await knex.schema.createTable('telegram_connections', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('kind').notNullable();
    t.text('display_name').nullable();
    t.text('username').nullable();
    t.bigInteger('telegram_id').nullable();
    t.specificType('encrypted_secret', 'BYTEA').notNullable();
    t.specificType('secret_iv', 'BYTEA').notNullable();
    t.specificType('secret_tag', 'BYTEA').notNullable();
    t.text('secret_key_id').notNullable();
    t.integer('api_id').nullable();
    t.specificType('api_hash_encrypted', 'BYTEA').nullable();
    t.text('phone').nullable();
    t.text('status').notNullable().defaultTo('active');
    t.text('last_error').nullable();
    t.text('mode').nullable();
    t.integer('rate_limit_msgs_per_min').defaultTo(30);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check("kind IN ('bot', 'user')", [], 'telegram_connections_kind_check');
    t.check(
      "status IN ('active', 'invalid', 'disabled')",
      [],
      'telegram_connections_status_check',
    );
    t.check(
      "mode IS NULL OR mode IN ('polling', 'webhook')",
      [],
      'telegram_connections_mode_check',
    );
    t.index(['tenant_id', 'status'], 'telegram_connections_tenant_id_status_index');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('telegram_connections');
}

module.exports = { up, down };
