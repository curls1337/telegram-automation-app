'use strict';

/**
 * Migration 0001 — Initial schema for identity & tenancy.
 *
 * Creates the foundational tables that everything else depends on:
 *
 *   - users                  Platform identities (super_admin or member of tenants)
 *   - tenants                Customer accounts (the multi-tenancy unit)
 *   - tenant_members         Many-to-many between users and tenants with a role
 *   - password_reset_tokens  Time-bounded single-use tokens for password reset
 *   - invitations            Time-bounded single-use tokens to join a tenant
 *
 * Extensions:
 *   - pgcrypto  required for `gen_random_uuid()` (UUID v4 default values)
 *   - citext    case-insensitive text type used for email columns so that
 *               UNIQUE on email behaves correctly regardless of casing
 *
 * References:
 *   - design.md "Table Specifications" (users / tenants / tenant_members /
 *     password_reset_tokens / invitations)
 *   - requirements.md §1.1 (user account + tenant bootstrap), §2.1 (roles),
 *     §2.3 (invitation flow), §3.1 (tenant_id on every domain row)
 *
 * Down migration drops tables in reverse FK order. Extensions are not dropped
 * because other migrations in this project depend on them; dropping
 * extensions in a rollback is also dangerous in shared databases.
 */

/**
 * @param {import('knex').Knex} knex
 */
async function up(knex) {
  // -------------------------------------------------------------------------
  // Extensions
  // -------------------------------------------------------------------------
  // pgcrypto provides gen_random_uuid(); citext provides case-insensitive
  // text. Both are idempotent with IF NOT EXISTS.
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "citext"');

  // -------------------------------------------------------------------------
  // users
  // -------------------------------------------------------------------------
  // CITEXT email is declared via raw because Knex's column builder has no
  // native CITEXT helper. UNIQUE constraint on email is added via a unique
  // index so the index is explicit and named predictably.
  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.specificType('email', 'CITEXT').notNullable();
    t.text('password_hash').notNullable();
    t.text('language').notNullable().defaultTo('id');
    t.boolean('is_super_admin').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['email'], { indexName: 'users_email_unique' });
  });

  // -------------------------------------------------------------------------
  // tenants
  // -------------------------------------------------------------------------
  // owner_user_id is the bootstrap owner (the user who registered the
  // tenant). Membership and authorisation live in tenant_members; this
  // column is informational and used for the "primary contact" semantics.
  await knex.schema.createTable('tenants', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable();
    t.uuid('owner_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('RESTRICT');
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.check("status IN ('active', 'suspended')", [], 'tenants_status_check');
  });

  // -------------------------------------------------------------------------
  // tenant_members
  // -------------------------------------------------------------------------
  // Composite primary key (tenant_id, user_id) — a user can belong to a
  // tenant at most once. role is an enumerated text column; super_admin is
  // a property of users, not a tenant_members role.
  await knex.schema.createTable('tenant_members', (t) => {
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.uuid('user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.text('role').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.primary(['tenant_id', 'user_id'], { constraintName: 'tenant_members_pkey' });
    t.check(
      "role IN ('tenant_owner', 'editor', 'viewer')",
      [],
      'tenant_members_role_check',
    );
    t.index(['user_id'], 'tenant_members_user_id_index');
  });

  // -------------------------------------------------------------------------
  // password_reset_tokens
  // -------------------------------------------------------------------------
  // We never store the raw token — only its hash — so a leaked DB cannot be
  // used to reset passwords. token_hash is therefore the natural primary
  // key. used_at NULL means the token is still consumable.
  await knex.schema.createTable('password_reset_tokens', (t) => {
    t.text('token_hash').primary();
    t.uuid('user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['user_id'], 'password_reset_tokens_user_id_index');
  });

  // -------------------------------------------------------------------------
  // invitations
  // -------------------------------------------------------------------------
  // Email is CITEXT so invitation lookups match regardless of casing the
  // recipient uses when signing up. token_hash UNIQUE so a token can be
  // claimed at most once.
  await knex.schema.createTable('invitations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    t.specificType('email', 'CITEXT').notNullable();
    t.text('role').notNullable();
    t.text('token_hash').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('accepted_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['token_hash'], { indexName: 'invitations_token_hash_unique' });
    t.check(
      "role IN ('tenant_owner', 'editor', 'viewer')",
      [],
      'invitations_role_check',
    );
    t.index(['tenant_id'], 'invitations_tenant_id_index');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
async function down(knex) {
  // Drop in reverse order of creation so foreign keys never block the drop.
  // Extensions (pgcrypto, citext) are intentionally NOT dropped — they are
  // shared across the schema and a rollback should be safely re-runnable.
  await knex.schema.dropTableIfExists('invitations');
  await knex.schema.dropTableIfExists('password_reset_tokens');
  await knex.schema.dropTableIfExists('tenant_members');
  await knex.schema.dropTableIfExists('tenants');
  await knex.schema.dropTableIfExists('users');
}

module.exports = { up, down };
