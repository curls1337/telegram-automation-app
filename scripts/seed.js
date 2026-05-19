'use strict';

/**
 * Seed script — populates the database with default plans and a super_admin user.
 *
 * Inserts:
 *   - 3 plans: Free, Starter, Pro (with quota limits)
 *   - 1 super_admin user from env (SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD)
 *   - 1 tenant "Admin" owned by the super_admin
 *   - 1 tenant_member linking super_admin to the Admin tenant as tenant_owner
 *
 * Idempotent: uses ON CONFLICT DO NOTHING so re-running is safe.
 *
 * Usage:
 *   node scripts/seed.js
 *
 * References:
 *   - requirements.md §2.6 (super_admin role), §15.1 (plan management)
 *   - design.md "Table Specifications" (plans / users / tenants / tenant_members)
 */

const { getEnv } = require('../src/shared/env');
const { getDb, closeDb } = require('../src/infra/db');
const { hashPassword } = require('../src/infra/crypto');
const { newId } = require('../src/shared/ids');

// ---------------------------------------------------------------------------
// Plan definitions
// ---------------------------------------------------------------------------

const PLANS = [
  {
    id: newId(),
    name: 'Free',
    price_cents: 0,
    duration_months: 1,
    max_bot_connections: 1,
    max_user_connections: 0,
    max_subscribers: 100,
    max_broadcasts_per_month: 10,
    max_auto_reply_rules: 5,
    is_active: true,
  },
  {
    id: newId(),
    name: 'Starter',
    price_cents: 0,
    duration_months: 1,
    max_bot_connections: 3,
    max_user_connections: 1,
    max_subscribers: 1000,
    max_broadcasts_per_month: 100,
    max_auto_reply_rules: 20,
    is_active: true,
  },
  {
    id: newId(),
    name: 'Pro',
    price_cents: 0,
    duration_months: 1,
    max_bot_connections: 10,
    max_user_connections: 5,
    max_subscribers: 10000,
    max_broadcasts_per_month: 1000,
    max_auto_reply_rules: 100,
    is_active: true,
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = getEnv();
  const db = getDb();

  // --- Plans ---------------------------------------------------------------
  for (const plan of PLANS) {
    await db('plans')
      .insert({
        ...plan,
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      })
      .onConflict('name')
      .ignore();
  }

  // --- Super Admin User ----------------------------------------------------
  const superAdminId = newId();
  const passwordHash = await hashPassword(env.SUPER_ADMIN_PASSWORD);

  await db('users')
    .insert({
      id: superAdminId,
      email: env.SUPER_ADMIN_EMAIL,
      password_hash: passwordHash,
      language: 'id',
      is_super_admin: true,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict('email')
    .ignore();

  // Retrieve the actual user id (may already exist from a previous run)
  const [existingUser] = await db('users')
    .select('id')
    .where('email', env.SUPER_ADMIN_EMAIL)
    .limit(1);

  const userId = existingUser ? existingUser.id : superAdminId;

  // --- Admin Tenant --------------------------------------------------------
  const tenantId = newId();

  await db('tenants')
    .insert({
      id: tenantId,
      name: 'Admin',
      owner_user_id: userId,
      status: 'active',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict()
    .ignore();

  // Retrieve the actual tenant (may already exist)
  const [existingTenant] = await db('tenants')
    .select('id')
    .where('owner_user_id', userId)
    .where('name', 'Admin')
    .limit(1);

  const actualTenantId = existingTenant ? existingTenant.id : tenantId;

  // --- Tenant Member -------------------------------------------------------
  await db('tenant_members')
    .insert({
      tenant_id: actualTenantId,
      user_id: userId,
      role: 'tenant_owner',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict(['tenant_id', 'user_id'])
    .ignore();

  console.log('Seed completed successfully.');
  console.log(`  Plans: ${PLANS.map((p) => p.name).join(', ')}`);
  console.log(`  Super admin: ${env.SUPER_ADMIN_EMAIL}`);
  console.log(`  Admin tenant: ${actualTenantId}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
