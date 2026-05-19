'use strict';

/**
 * Migration 0010 — Media Files & Telegram File ID Cache.
 *
 * Creates:
 *   - media_files            Uploaded media metadata (object key, MIME, size)
 *   - media_telegram_cache   Cached Telegram file_id per media per connection
 *
 * References:
 *   - design.md "Table Specifications" (media_files / media_telegram_cache)
 *   - requirements.md §17.1 (media upload), §17.5 (file_id caching)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // media_files
  // -------------------------------------------------------------------------
  await knex.schema.createTable('media_files', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('uploader_user_id')
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    t.text('object_key').notNullable();
    t.text('mime').notNullable();
    t.bigInteger('size_bytes').notNullable();
    t.text('original_name').nullable();
    t.text('kind').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "kind IN ('image', 'video', 'document', 'audio')",
      [],
      'media_files_kind_check',
    );
  });

  // -------------------------------------------------------------------------
  // media_telegram_cache
  // -------------------------------------------------------------------------
  await knex.schema.createTable('media_telegram_cache', (t) => {
    t.uuid('media_id')
      .notNullable()
      .references('id')
      .inTable('media_files')
      .onDelete('CASCADE');
    t.uuid('connection_id')
      .notNullable()
      .references('id')
      .inTable('telegram_connections')
      .onDelete('CASCADE');
    t.text('telegram_file_id').notNullable();
    t.timestamp('expires_at', { useTz: true }).nullable();

    t.primary(['media_id', 'connection_id'], { constraintName: 'media_telegram_cache_pkey' });
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('media_telegram_cache');
  await knex.schema.dropTableIfExists('media_files');
}

module.exports = { up, down };
