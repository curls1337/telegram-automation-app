'use strict';

/**
 * Migration 0009 — Forward Rules & Member Rules.
 *
 * Creates:
 *   - forward_rules    Auto-forwarding configuration between chats
 *   - member_rules     Welcome, auto-kick, anti-spam automation rules
 *
 * References:
 *   - design.md "Table Specifications" (forward_rules / member_rules)
 *   - requirements.md §10.4–10.6 (member management), §12.1 (forwarding)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // forward_rules
  // -------------------------------------------------------------------------
  await knex.schema.createTable('forward_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('connection_id')
      .references('id')
      .inTable('telegram_connections')
      .onDelete('CASCADE');
    t.text('source_chat').notNullable();
    t.jsonb('destinations').notNullable();
    t.jsonb('filters').nullable();
    t.boolean('remove_header').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // -------------------------------------------------------------------------
  // member_rules
  // -------------------------------------------------------------------------
  await knex.schema.createTable('member_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('connection_id')
      .references('id')
      .inTable('telegram_connections')
      .onDelete('CASCADE');
    t.text('kind').notNullable();
    t.jsonb('config').notNullable().defaultTo('{}');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "kind IN ('welcome', 'auto_kick_inactive', 'anti_spam')",
      [],
      'member_rules_kind_check',
    );
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('member_rules');
  await knex.schema.dropTableIfExists('forward_rules');
}

module.exports = { up, down };
