'use strict';

/**
 * Migration 0005 — Auto-Reply Rules & AI Settings.
 *
 * Creates:
 *   - auto_reply_rules    Keyword/regex/exact match rules with priority
 *   - ai_settings         Per-tenant AI provider configuration (Gemini)
 *   - ai_usage_log        Token usage tracking for AI calls
 *
 * References:
 *   - design.md "Table Specifications" (auto_reply_rules / ai_settings / ai_usage_log)
 *   - requirements.md §7.1 (auto-reply rules), §8.1 (AI settings), §8.6 (usage tracking)
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // auto_reply_rules
  // -------------------------------------------------------------------------
  await knex.schema.createTable('auto_reply_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('connection_id')
      .nullable()
      .references('id')
      .inTable('telegram_connections')
      .onDelete('SET NULL');
    t.integer('priority').notNullable().defaultTo(0);
    t.text('trigger_kind').notNullable();
    t.text('trigger_value').notNullable();
    t.boolean('case_sensitive').notNullable().defaultTo(false);
    t.jsonb('response').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check(
      "trigger_kind IN ('exact', 'contains', 'regex')",
      [],
      'auto_reply_rules_trigger_kind_check',
    );
    t.index(
      ['tenant_id', 'connection_id', 'priority'],
      'auto_reply_rules_tenant_conn_priority_index',
    );
  });

  // -------------------------------------------------------------------------
  // ai_settings
  // -------------------------------------------------------------------------
  await knex.schema.createTable('ai_settings', (t) => {
    t.uuid('tenant_id')
      .primary()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.text('provider').notNullable().defaultTo('gemini');
    t.specificType('api_key_encrypted', 'BYTEA').nullable();
    t.specificType('api_key_iv', 'BYTEA').nullable();
    t.specificType('api_key_tag', 'BYTEA').nullable();
    t.text('api_key_key_id').nullable();
    t.text('system_prompt').nullable();
    t.boolean('is_enabled').notNullable().defaultTo(false);
    t.integer('daily_token_limit').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check("provider IN ('gemini')", [], 'ai_settings_provider_check');
  });

  // -------------------------------------------------------------------------
  // ai_usage_log
  // -------------------------------------------------------------------------
  await knex.schema.createTable('ai_usage_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('connection_id')
      .nullable()
      .references('id')
      .inTable('telegram_connections')
      .onDelete('SET NULL');
    t.integer('tokens_in').notNullable().defaultTo(0);
    t.integer('tokens_out').notNullable().defaultTo(0);
    t.integer('cost_estimate_cents').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['tenant_id', 'created_at'], 'ai_usage_log_tenant_id_created_at_index');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  await knex.schema.dropTableIfExists('ai_usage_log');
  await knex.schema.dropTableIfExists('ai_settings');
  await knex.schema.dropTableIfExists('auto_reply_rules');
}

module.exports = { up, down };
