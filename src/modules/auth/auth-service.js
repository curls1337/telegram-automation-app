'use strict';

/**
 * Authentication service — registration, login, logout, password reset.
 *
 * Responsibilities:
 *   - Register new users with email + password + name, creating a Tenant
 *     and tenant_member record in a single transaction.
 *   - Login with email + password, verifying bcrypt hash and creating a
 *     Redis-backed session.
 *   - Logout by destroying the session.
 *   - Request password reset (email with time-limited token).
 *   - Reset password using a valid, unexpired token.
 *
 * References:
 *   - requirements.md §1.1–1.8
 *   - design.md "Auth Module"
 */

const { getDb, withTransaction } = require('../../infra/db');
const { getRedis } = require('../../infra/redis');
const { hashPassword, verifyPassword } = require('../../infra/crypto');
const { sendTemplate } = require('../../infra/mailer');
const { getLogger } = require('../../infra/logger');
const { getEnv } = require('../../shared/env');
const { AuthError, ConflictError } = require('../../shared/errors');
const { Email, Password, NonEmptyString, z, parseOrThrow } = require('../../shared/validation');
const { newId, randomToken, sha256Hex } = require('../../shared/ids');
const { now, addMinutes } = require('../../shared/time');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_TTL_SECONDS = 604800; // 7 days
const RESET_TOKEN_EXPIRY_MINUTES = 60;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const RegisterSchema = z.object({
  email: Email,
  password: Password,
  name: NonEmptyString,
});

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Register a new user, create a tenant, and establish a session.
 *
 * @param {{ email: string, password: string, name: string }} input
 * @returns {Promise<{ user: object, tenant: object, sessionId: string }>}
 */
async function register(input) {
  const { email, password, name } = parseOrThrow(RegisterSchema, input);

  const db = getDb();

  // Check email uniqueness
  const existing = await db('users').where('email', email).first();
  if (existing) {
    throw new ConflictError('Email sudah terdaftar');
  }

  const passwordHash = await hashPassword(password);
  const userId = newId();
  const tenantId = newId();

  const result = await withTransaction(async (trx) => {
    const [user] = await trx('users')
      .insert({
        id: userId,
        email,
        password_hash: passwordHash,
        created_at: now(),
        updated_at: now(),
      })
      .returning('*');

    const [tenant] = await trx('tenants')
      .insert({
        id: tenantId,
        name: `${name}'s Workspace`,
        owner_user_id: userId,
        status: 'active',
        created_at: now(),
        updated_at: now(),
      })
      .returning('*');

    await trx('tenant_members').insert({
      tenant_id: tenantId,
      user_id: userId,
      role: 'tenant_owner',
    });

    return { user, tenant };
  });

  // Create session
  const sessionId = newId();
  const sessionData = {
    userId,
    activeTenantId: tenantId,
    createdAt: now().toISOString(),
  };

  const redis = getRedis();
  await redis.set(
    `session:${sessionId}`,
    JSON.stringify(sessionData),
    'EX',
    SESSION_TTL_SECONDS
  );

  return {
    user: result.user,
    tenant: result.tenant,
    sessionId,
  };
}

/**
 * Authenticate a user by email and password, creating a session on success.
 *
 * @param {string} email
 * @param {string} password
 * @param {string} ip - Client IP for rate limiting (handled externally)
 * @returns {Promise<{ session: { id: string, userId: string, activeTenantId: string } }>}
 */
async function login(email, password, ip) {
  const log = getLogger();

  if (!email || !password) {
    throw new AuthError('Email dan password diperlukan');
  }

  const normalizedEmail = email.trim().toLowerCase();

  const db = getDb();
  const user = await db('users').where('email', normalizedEmail).first();

  if (!user) {
    throw new AuthError('Email atau password salah');
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    throw new AuthError('Email atau password salah');
  }

  // Find the user's primary tenant (first tenant_member record)
  const membership = await db('tenant_members')
    .where('user_id', user.id)
    .first();

  const activeTenantId = membership ? membership.tenant_id : null;

  // Create session in Redis
  const sessionId = newId();
  const sessionData = {
    userId: user.id,
    activeTenantId,
    createdAt: now().toISOString(),
  };

  const redis = getRedis();
  await redis.set(
    `session:${sessionId}`,
    JSON.stringify(sessionData),
    'EX',
    SESSION_TTL_SECONDS
  );

  log.info({ userId: user.id, ip }, 'auth: login successful');

  return {
    session: {
      id: sessionId,
      userId: user.id,
      activeTenantId,
    },
  };
}

/**
 * Destroy a session by removing it from Redis.
 *
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function logout(sessionId) {
  if (!sessionId) return;
  const redis = getRedis();
  await redis.del(`session:${sessionId}`);
}

/**
 * Generate a password reset token and send the reset email.
 * Silently succeeds even if the email is not found (to prevent enumeration).
 *
 * @param {string} email
 * @returns {Promise<void>}
 */
async function requestPasswordReset(email) {
  if (!email) return;

  const normalizedEmail = email.trim().toLowerCase();
  const db = getDb();
  const user = await db('users').where('email', normalizedEmail).first();

  if (!user) {
    // Do not reveal whether the email exists
    return;
  }

  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const expiresAt = addMinutes(now(), RESET_TOKEN_EXPIRY_MINUTES);

  await db('password_reset_tokens').insert({
    token_hash: tokenHash,
    user_id: user.id,
    expires_at: expiresAt,
    used_at: null,
  });

  const env = getEnv();
  const resetUrl = `${env.BASE_URL}/reset-password/${token}`;

  await sendTemplate(user.email, 'password_reset', {
    name: user.email,
    reset_url: resetUrl,
    expires_in: '60 minutes',
  });
}

/**
 * Reset a user's password using a valid, unexpired token.
 *
 * @param {string} token - The plaintext token from the reset URL
 * @param {string} newPassword - The new password
 * @returns {Promise<void>}
 */
async function resetPassword(token, newPassword) {
  if (!token || !newPassword) {
    throw new AuthError('Token dan password baru diperlukan');
  }

  // Validate new password
  parseOrThrow(z.object({ password: Password }), { password: newPassword });

  const tokenHash = sha256Hex(token);
  const db = getDb();

  const resetRecord = await db('password_reset_tokens')
    .where('token_hash', tokenHash)
    .first();

  if (!resetRecord) {
    throw new AuthError('Token reset tidak valid');
  }

  if (resetRecord.used_at) {
    throw new AuthError('Token reset sudah digunakan');
  }

  if (new Date(resetRecord.expires_at) < now()) {
    throw new AuthError('Token reset sudah kedaluwarsa');
  }

  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async (trx) => {
    // Update user password
    await trx('users')
      .where('id', resetRecord.user_id)
      .update({
        password_hash: passwordHash,
        updated_at: now(),
      });

    // Mark token as used
    await trx('password_reset_tokens')
      .where('token_hash', tokenHash)
      .update({ used_at: now() });
  });

  // Invalidate all user sessions
  const redis = getRedis();
  const sessionKeys = await redis.keys(`session:*`);
  for (const key of sessionKeys) {
    const data = await redis.get(key);
    if (data) {
      try {
        const session = JSON.parse(data);
        if (session.userId === resetRecord.user_id) {
          await redis.del(key);
        }
      } catch (_e) {
        // skip malformed session data
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  register,
  login,
  logout,
  requestPasswordReset,
  resetPassword,
  SESSION_TTL_SECONDS,
};
