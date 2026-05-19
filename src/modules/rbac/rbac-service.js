'use strict';

/**
 * Role-Based Access Control (RBAC) service.
 *
 * Responsibilities:
 *   - Define and enforce the authorization matrix (role × action_kind).
 *   - Invite team members via email with a time-limited token.
 *   - Accept invitations (create or link user, add to tenant_members).
 *   - Revoke member access and invalidate their active sessions.
 *
 * Authorization matrix:
 *   super_admin    → all actions allowed
 *   tenant_owner   → read, write, delete_tenant, manage_billing, manage_members
 *   editor         → read, write
 *   viewer         → read only
 *
 * Action kinds:
 *   'read', 'write', 'delete_tenant', 'manage_billing',
 *   'manage_members', 'super_admin_only'
 *
 * References:
 *   - requirements.md §2.1–2.8
 *   - design.md "RBAC Module"
 */

const { getDb, withTransaction } = require('../../infra/db');
const { getRedis } = require('../../infra/redis');
const { hashPassword } = require('../../infra/crypto');
const { sendTemplate } = require('../../infra/mailer');
const { getEnv } = require('../../shared/env');
const { AuthError, ForbiddenError, NotFoundError, ConflictError } = require('../../shared/errors');
const { newId, randomToken, sha256Hex } = require('../../shared/ids');
const { now, addDays, isExpired } = require('../../shared/time');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVITATION_EXPIRY_DAYS = 7;

const VALID_ROLES = ['super_admin', 'tenant_owner', 'editor', 'viewer'];
const ASSIGNABLE_ROLES = ['editor', 'viewer'];

const ACTION_KINDS = [
  'read',
  'write',
  'delete_tenant',
  'manage_billing',
  'manage_members',
  'super_admin_only',
];

// ---------------------------------------------------------------------------
// Authorization matrix
// ---------------------------------------------------------------------------

/**
 * Matrix defining which roles are allowed which action kinds.
 * super_admin is handled separately (always allowed).
 */
const ROLE_PERMISSIONS = Object.freeze({
  tenant_owner: Object.freeze(['read', 'write', 'delete_tenant', 'manage_billing', 'manage_members']),
  editor: Object.freeze(['read', 'write']),
  viewer: Object.freeze(['read']),
});

/**
 * Check if a role is authorized to perform a given action kind.
 *
 * @param {string} role - The user's role (super_admin, tenant_owner, editor, viewer)
 * @param {string} actionKind - The action kind to check
 * @returns {boolean} true if authorized
 */
function authorize(role, actionKind) {
  if (!role || typeof role !== 'string') return false;
  if (!actionKind || typeof actionKind !== 'string') return false;

  // super_admin can do everything
  if (role === 'super_admin') return true;

  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) return false;

  return permissions.includes(actionKind);
}

// ---------------------------------------------------------------------------
// Invitation flow
// ---------------------------------------------------------------------------

/**
 * Invite a user to a tenant by email with a specific role.
 * Generates a token, stores the sha256 hash in the invitations table,
 * and sends an invitation email.
 *
 * @param {string} tenantId
 * @param {string} email
 * @param {string} role - Must be 'editor' or 'viewer'
 * @param {string} invitedByUserId - The user who is sending the invitation
 * @returns {Promise<{ invitation: object, token: string }>}
 */
async function invite(tenantId, email, role, invitedByUserId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('invite: tenantId is required');
  }
  if (!email || typeof email !== 'string') {
    throw new TypeError('invite: email is required');
  }
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new ForbiddenError(`Invalid role "${role}". Assignable roles: ${ASSIGNABLE_ROLES.join(', ')}`);
  }
  if (!invitedByUserId || typeof invitedByUserId !== 'string') {
    throw new TypeError('invite: invitedByUserId is required');
  }

  const db = getDb();

  // Check if user is already a member of this tenant
  const existingUser = await db('users').where('email', email).first();
  if (existingUser) {
    const existingMembership = await db('tenant_members')
      .where({ tenant_id: tenantId, user_id: existingUser.id })
      .first();
    if (existingMembership) {
      throw new ConflictError('User is already a member of this tenant');
    }
  }

  // Check for pending invitation to same email + tenant
  const existingInvitation = await db('invitations')
    .where({ tenant_id: tenantId, email })
    .whereNull('accepted_at')
    .first();
  if (existingInvitation && !isExpired(new Date(existingInvitation.expires_at))) {
    throw new ConflictError('A pending invitation already exists for this email');
  }

  // Generate token
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const expiresAt = addDays(now(), INVITATION_EXPIRY_DAYS);

  const invitationId = newId();
  const invitation = {
    id: invitationId,
    tenant_id: tenantId,
    email,
    role,
    token_hash: tokenHash,
    invited_by: invitedByUserId,
    expires_at: expiresAt,
    created_at: now(),
  };

  await db('invitations').insert(invitation);

  // Load tenant name and inviter info for the email
  const tenant = await db('tenants').where('id', tenantId).first();
  const inviter = await db('users').where('id', invitedByUserId).first();

  const env = getEnv();
  const acceptUrl = `${env.BASE_URL}/invitations/${token}`;

  // Send invitation email
  await sendTemplate(email, 'invitation', {
    workspace: tenant ? tenant.name : 'Unknown',
    inviter: inviter ? inviter.email : 'A team member',
    role,
    accept_url: acceptUrl,
    expires_in: `${INVITATION_EXPIRY_DAYS} days`,
  }, 'en');

  return { invitation, token };
}

/**
 * Accept an invitation using the plaintext token.
 * Creates a user if one doesn't exist, or links an existing user.
 * Adds the user to tenant_members with the invited role.
 *
 * @param {string} token - The plaintext invitation token
 * @param {string} password - Password for new user (ignored if user exists)
 * @returns {Promise<{ user: object, tenantId: string }>}
 */
async function acceptInvitation(token, password) {
  if (!token || typeof token !== 'string') {
    throw new TypeError('acceptInvitation: token is required');
  }

  const db = getDb();
  const tokenHash = sha256Hex(token);

  // Lookup invitation by hash
  const invitation = await db('invitations')
    .where('token_hash', tokenHash)
    .first();

  if (!invitation) {
    throw new NotFoundError('Invitation not found or invalid');
  }

  // Check if already accepted
  if (invitation.accepted_at) {
    throw new ConflictError('Invitation has already been accepted');
  }

  // Check expiry
  if (isExpired(new Date(invitation.expires_at))) {
    throw new AuthError('Invitation has expired');
  }

  const result = await withTransaction(async (trx) => {
    // Check if user already exists
    let user = await trx('users').where('email', invitation.email).first();

    if (!user) {
      // Create new user
      if (!password || typeof password !== 'string' || password.length < 8) {
        throw new AuthError('Password is required for new users (min 8 characters)');
      }

      const passwordHash = await hashPassword(password);
      const userId = newId();

      [user] = await trx('users')
        .insert({
          id: userId,
          email: invitation.email,
          password_hash: passwordHash,
          created_at: now(),
          updated_at: now(),
        })
        .returning('*');
    }

    // Check if already a member (race condition guard)
    const existingMembership = await trx('tenant_members')
      .where({ tenant_id: invitation.tenant_id, user_id: user.id })
      .first();

    if (!existingMembership) {
      // Add to tenant_members
      await trx('tenant_members').insert({
        tenant_id: invitation.tenant_id,
        user_id: user.id,
        role: invitation.role,
      });
    }

    // Mark invitation as accepted
    await trx('invitations')
      .where('id', invitation.id)
      .update({ accepted_at: now() });

    return { user, tenantId: invitation.tenant_id };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Member revocation
// ---------------------------------------------------------------------------

/**
 * Revoke a member's access to a tenant.
 * Removes from tenant_members and invalidates all their active sessions
 * for that tenant within 60 seconds (per requirement 2.8).
 *
 * @param {string} tenantId
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function revokeMember(tenantId, userId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('revokeMember: tenantId is required');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('revokeMember: userId is required');
  }

  const db = getDb();

  // Delete from tenant_members
  const deleted = await db('tenant_members')
    .where({ tenant_id: tenantId, user_id: userId })
    .del();

  if (deleted === 0) {
    throw new NotFoundError('Member not found in this tenant');
  }

  // Invalidate active sessions for this user+tenant
  // Scan Redis for session keys and delete those matching userId + tenantId
  const redis = getRedis();
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
    cursor = nextCursor;

    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;

      try {
        const sessionData = JSON.parse(raw);
        if (sessionData.userId === userId && sessionData.activeTenantId === tenantId) {
          await redis.del(key);
        }
      } catch (_e) {
        // Malformed session data — skip
      }
    }
  } while (cursor !== '0');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Authorization
  authorize,
  // Invitation flow
  invite,
  acceptInvitation,
  // Member management
  revokeMember,
  // Constants (exported for testing / middleware)
  VALID_ROLES,
  ASSIGNABLE_ROLES,
  ACTION_KINDS,
  ROLE_PERMISSIONS,
  INVITATION_EXPIRY_DAYS,
};
