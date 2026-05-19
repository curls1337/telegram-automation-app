'use strict';

/**
 * Migration 0004 — Subscribers, Tags, Subscriber Tags, Segments.
 *
 * Creates:
 *   - subscribers        Telegram users tracked per connection per tenant
 *   - tags              Tenant-scoped labels for subscribers
 *   - subscriber_tags   Many-to-many between subscribers and tags
 *   - segments          Dynamic audience segments with JSON predicates
 *
 * References:
 *   - design.md "Table Specifications" (subscribers / tags / subscriber_tags / segments)
 *   - requirements.md §10.1 (subscriber tracking), §10.2 (tags), §10.3 (segments)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // subscribers
  // -------------------------------------------------------------------------
  await knex.schema.createTable('subscribers', (t) => {
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
    t.bigInteger('telegram_user_id').notNullable();
    t.text('username').nullable();
    t.text('first_name').nullable();
    t.text('last_name').nullable();
    t.text('language_code').nullable();
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_active_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "status IN ('active', 'blocked', 'deactivated')",
      [],
      'subscribers_status_check',
    );
    t.unique(
      ['tenant_id', 'connection_id', 'telegram_user_id'],
      { indexName: 'subscribers_tenant_connection_tg_user_unique' },
    );
  });

  // -------------------------------------------------------------------------
  // tags
  // -------------------------------------------------------------------------
  await knex.schema.createTable('tags', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('name').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['tenant_id', 'name'], { indexName: 'tags_tenant_id_name_unique' });
  });

  // -------------------------------------------------------------------------
  // subscriber_tags
  // -------------------------------------------------------------------------
  await knex.schema.createTable('subscriber_tags', (t) => {
    t.uuid('subscriber_id')
      .notNullable()
      .references('id')
      .inTable('subscribers')
      .onDelete('CASCADE');
    t.uuid('tag_id')
      .notNullable()
      .references('id')
      .inTable('tags')
      .onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.primary(['subscriber_id', 'tag_id'], { constraintName: 'subscriber_tags_pkey' });
  });

  // -------------------------------------------------------------------------
  // segments
  // -------------------------------------------------------------------------
  await knex.schema.createTable('segments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('name').notNullable();
    t.jsonb('predicate').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('segments');
  await knex.schema.dropTableIfExists('subscriber_tags');
  await knex.schema.dropTableIfExists('tags');
  await knex.schema.dropTableIfExists('subscribers');
}

module.exports = { up, down };
