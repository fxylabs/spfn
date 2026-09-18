/**
 * @spfn/auth - Invitation Service
 *
 * User invitation management for invite-only registration
 */

import crypto from 'crypto';
import { Invitation } from '../entities/user-invitations';
import {
    invitationsRepository,
    usersRepository,
    rolesRepository,
    keysRepository,
} from '../repositories';
import type { InvitationStatus, KeyAlgorithmType } from '../types';
import { runBeforeRegister } from '../lib/config';
import { assertKeyMatchesAlgorithm, hashPassword } from '../helpers';
import { invitationCreatedEvent, invitationAcceptedEvent } from '../events';
import { emitDeviceRegistered } from './device-registration.service';
import { BadRequestError, NotFoundError, ConflictError } from '@spfn/core/errors';

/**
 * Generate unique invitation token (UUID v4)
 */
function generateInvitationToken(): string
{
    return crypto.randomUUID();
}

/**
 * Calculate expiration date from now
 *
 * @param days - Number of days until expiration (default: 7)
 * @returns Expiration timestamp
 */
function calculateExpiresAt(days: number = 7): Date
{
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    return expiresAt;
}

/**
 * Create a new invitation
 *
 * @param params - Invitation parameters
 * @returns Created invitation
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * const invitation = await createInvitation({
 *   email: 'newuser@example.com',
 *   roleId: 2n,
 *   invitedBy: 1n,
 *   expiresInDays: 7,
 *   metadata: { message: 'Welcome!' }
 * });
 * ```
 */
export async function createInvitation(params: {
    email: string;
    roleId: number;
    invitedBy: number;
    expiresInDays?: number;
    expiresAt?: Date;
    metadata?: Record<string, any>;
}): Promise<Invitation>
{
    const { email, roleId, invitedBy, expiresInDays = 7, expiresAt: expiresAtParam, metadata } = params;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
    {
        throw new BadRequestError({ message: 'Invalid email format' });
    }

    // Check if user already exists
    const existingUser = await usersRepository.findByEmail(email);

    if (existingUser)
    {
        throw new ConflictError({ message: 'User with this email already exists' });
    }

    // Check if there's already a pending invitation for this email
    const existingInvitation = await invitationsRepository.findPendingByEmail(email);

    if (existingInvitation)
    {
        throw new ConflictError({ message: 'Pending invitation already exists for this email' });
    }

    // Verify role exists
    const role = await rolesRepository.findById(roleId);

    if (!role)
    {
        throw new NotFoundError({ message: `Role with id ${roleId} not found`, resource: 'Role' });
    }

    // Verify inviter exists
    const inviter = await usersRepository.findById(invitedBy);

    if (!inviter)
    {
        throw new NotFoundError({ message: `User with id ${invitedBy} not found`, resource: 'User' });
    }

    // Generate unique token
    const token = generateInvitationToken();
    const expiresAt = expiresAtParam ?? calculateExpiresAt(expiresInDays);

    // Create invitation
    const invitation = await invitationsRepository.create({
        email,
        token,
        roleId,
        invitedBy,
        status: 'pending',
        expiresAt,
        metadata: metadata || null,
    });

    // Emit invitation created event
    await invitationCreatedEvent.emit({
        invitationId: String(invitation.id),
        email,
        token,
        roleId,
        invitedBy: String(invitedBy),
        expiresAt: expiresAt.toISOString(),
        isResend: false,
        metadata,
    });

    return invitation;
}

/**
 * Get invitation by token
 *
 * @param token - Invitation token (UUID)
 * @returns Invitation or null if not found
 */
export async function getInvitationByToken(token: string)
{
    return await invitationsRepository.findByToken(token);
}

/**
 * Get invitation with role and inviter details
 *
 * @param token - Invitation token
 * @returns Invitation with joined data or null
 */
export async function getInvitationWithDetails(token: string)
{
    return await invitationsRepository.findByTokenWithDetails(token);
}

/**
 * Validate invitation
 *
 * Checks if invitation is valid for acceptance
 *
 * @param token - Invitation token
 * @returns Validation result
 */
export async function validateInvitation(token: string): Promise<{
    valid: boolean;
    invitation?: Invitation;
    error?: string;
}>
{
    const invitation = await getInvitationByToken(token);

    if (!invitation)
    {
        return { valid: false, error: 'Invitation not found' };
    }

    if (invitation.status === 'accepted')
    {
        return { valid: false, error: 'Invitation already accepted', invitation };
    }

    if (invitation.status === 'cancelled')
    {
        return { valid: false, error: 'Invitation was cancelled', invitation };
    }

    if (invitation.status === 'expired')
    {
        return { valid: false, error: 'Invitation has expired', invitation };
    }

    // Check if expired by time
    if (new Date() > new Date(invitation.expiresAt))
    {
        return { valid: false, error: 'Invitation has expired', invitation };
    }

    return { valid: true, invitation };
}

/**
 * Accept invitation and create user account
 *
 * @param params - Acceptance parameters
 * @returns Created user info
 * @throws Error if invitation is invalid or user creation fails
 *
 * @example
 * ```typescript
 * const user = await acceptInvitation({
 *   token: 'uuid-v4',
 *   password: 'SecurePass123!',
 *   publicKey: 'base64-der...',
 *   keyId: 'uuid-v4',
 *   fingerprint: 'sha256-hex',
 *   algorithm: 'ES256'
 * });
 * ```
 */
export async function acceptInvitation(params: {
    token: string;
    password: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm: KeyAlgorithmType;
    /** Client address of the request, from `deviceProvenance` at the route. */
    ip?: string;
    /** `user-agent` of the request, already truncated at the route. */
    userAgent?: string;
}) 
{
    const { token, password, publicKey, keyId, fingerprint, algorithm } = params;

    // This is the one key-storing path that does not go through
    // registerPublicKeyService, so the check the other paths inherit is stated
    // here. It runs before the account exists: a key that could never sign for
    // its declared algorithm must not consume the invitation.
    assertKeyMatchesAlgorithm(publicKey, algorithm);

    // Validate invitation
    const validation = await validateInvitation(token);

    if (!validation.valid || !validation.invitation)
    {
        throw new BadRequestError({ message: validation.error || 'Invalid invitation' });
    }

    const invitation = validation.invitation;

    // Get role details
    const role = await rolesRepository.findById(invitation.roleId);

    if (!role)
    {
        throw new NotFoundError({ message: 'Role not found', resource: 'Role' });
    }

    // App-level pre-registration policy gate — throws to reject
    // metadata 컬럼은 nullable — SQL NULL을 계약 타입(Record | undefined)에 맞게 정규화
    await runBeforeRegister({
        channel: 'invitation',
        email: invitation.email,
        metadata: (invitation.metadata ?? undefined) as Record<string, unknown> | undefined,
    });

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const newUser = await usersRepository.create({
        email: invitation.email,
        passwordHash,
        roleId: invitation.roleId,
        emailVerifiedAt: new Date(), // Auto-verify invited users
        passwordChangeRequired: false,
        status: 'active',
    });

    // Create public key for asymmetric JWT
    const key = await keysRepository.create({
        userId: newUser.id,
        keyId,
        publicKey,
        algorithm,
        fingerprint,
        registeredIp: params.ip ?? null,
        registeredUserAgent: params.userAgent ?? null,
        isActive: true,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
    });

    // The second of the two emission points, and the reason there are two: the
    // key above is written before the account it belongs to exists anywhere but
    // this transaction, so it cannot go through `registerPublicKeyService`. The
    // helper still defers to after the commit, so an invitation that fails later
    // announces nothing.
    await emitDeviceRegistered(key, 'invitation');

    // Update invitation status
    await invitationsRepository.updateStatus(
        invitation.id,
        'accepted',
        new Date(),
    );

    // Emit invitation accepted event
    await invitationAcceptedEvent.emit({
        invitationId: String(invitation.id),
        email: invitation.email,
        userId: String(newUser.id),
        roleId: Number(invitation.roleId),
        invitedBy: String(invitation.invitedBy),
        metadata: invitation.metadata as Record<string, unknown> | undefined,
    });

    return {
        userId: newUser.id,
        email: newUser.email!,
        role: role.name,
    };
}

/**
 * List invitations with filtering and pagination
 *
 * @param params - Query parameters
 * @returns Paginated invitations
 *
 * @example
 * ```typescript
 * const result = await listInvitations({
 *   status: 'pending',
 *   invitedBy: 1n,
 *   page: 1,
 *   limit: 20
 * });
 * ```
 */
export async function listInvitations(params: {
    status?: InvitationStatus;
    invitedBy?: number;
    page?: number;
    limit?: number;
}) 
{
    return await invitationsRepository.list(params);
}

/**
 * Cancel invitation
 *
 * Only pending invitations can be cancelled
 *
 * @param id - Invitation ID
 * @param cancelledBy - User ID who cancelled
 * @param reason - Optional cancellation reason
 * @throws Error if invitation cannot be cancelled
 */
export async function cancelInvitation(
    id: number,
    cancelledBy: number,
    reason?: string,
) 
{
    // Get invitation
    const invitation = await invitationsRepository.findById(id);

    if (!invitation)
    {
        throw new NotFoundError({ message: 'Invitation not found', resource: 'Invitation' });
    }

    if (invitation.status !== 'pending')
    {
        throw new ConflictError({ message: `Cannot cancel ${invitation.status} invitation` });
    }

    // Cancel invitation with metadata
    await invitationsRepository.cancel(id, cancelledBy, reason, invitation.metadata);

    console.log(`[Auth] ⚠️  Invitation cancelled: ${invitation.email} (reason: ${reason || 'none'})`);
}

/**
 * Delete invitation
 *
 * Permanently removes invitation record
 * Typically only for superadmin cleanup
 *
 * @param id - Invitation ID
 */
export async function deleteInvitation(id: number)
{
    await invitationsRepository.deleteById(id);

    console.log(`[Auth] 🗑️  Invitation deleted: ${id}`);
}

/**
 * Expire old invitations (cron job)
 *
 * Updates status of expired pending invitations
 *
 * @returns Number of invitations expired
 */
export async function expireOldInvitations()
{
    const count = await invitationsRepository.updateExpiredInvitations();

    if (count > 0)
    {
        console.log(`[Auth] ⏰ Expired ${count} old invitations`);
    }

    return count;
}

/**
 * Resend invitation email
 *
 * Extends expiration and triggers email resend
 *
 * @param id - Invitation ID
 * @param expiresInDays - New expiration period (default: 7)
 * @returns Updated invitation
 * @throws Error if invitation cannot be resent
 */
export async function resendInvitation(
    id: number,
    expiresInDays: number = 7,
) 
{
    // Get invitation
    const invitation = await invitationsRepository.findById(id);

    if (!invitation)
    {
        throw new NotFoundError({ message: 'Invitation not found', resource: 'Invitation' });
    }

    // Can only resend pending or expired invitations
    if (!['pending', 'expired'].includes(invitation.status))
    {
        throw new ConflictError({ message: `Cannot resend ${invitation.status} invitation` });
    }

    // Update expiration and status
    const newExpiresAt = calculateExpiresAt(expiresInDays);

    const updated = await invitationsRepository.resend(id, newExpiresAt);

    if (!updated)
    {
        throw new Error('Failed to update invitation');
    }

    // Emit invitation created event (isResend: true)
    await invitationCreatedEvent.emit({
        invitationId: String(invitation.id),
        email: invitation.email,
        token: invitation.token,
        roleId: Number(invitation.roleId),
        invitedBy: String(invitation.invitedBy),
        expiresAt: newExpiresAt.toISOString(),
        isResend: true,
        metadata: invitation.metadata as Record<string, unknown> | undefined,
    });

    return updated;
}
