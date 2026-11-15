/**
 * @spfn/auth - Invitation Service
 *
 * User invitation management for invite-only registration
 */

import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import type { InvitationSummary } from '@spfn/auth';
import {
    invitationsRepository,
    usersRepository,
    rolesRepository,
    keysRepository,
} from '../repositories';
import { INVITATION_MAX_EXPIRY_DAYS, type InvitationStatus, type KeyAlgorithmType } from '../types';
import { hashCredential, mintCredential } from '../lib/link-credentials';
import { runBeforeRegister } from '../lib/config';
import { assertEmailAllowedForRole } from '../lib/role-email-domains';
import { assertKeyMatchesAlgorithm, hashPassword } from '../helpers';
import { invitationCreatedEvent, invitationAcceptedEvent } from '../events';
import { emitDeviceRegistered } from './device-registration.service';
import { BadRequestError, NotFoundError, ConflictError } from '@spfn/core/errors';
import { InvitationChangedError, InvitationNoLongerValidError, InvitationNotFoundError } from '@spfn/auth/errors';
import { secondFactorEnrolmentFields } from './second-factor-policy.service';
import { assertCanAssignRole } from './permission.service';

/**
 * An invitation row as the repository returns it — every column but the token hash
 */
type InvitationRecord = NonNullable<Awaited<ReturnType<typeof invitationsRepository.findById>>>;

/**
 * An invitation and the link token minted for it
 *
 * Returned by `createInvitation` and `resendInvitation`, the two moments the
 * token exists; only its hash is stored, so no later call can return it.
 */
export interface IssuedInvitation
{
    invitation: InvitationRecord;
    token: string;
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
 * Refuse an explicit expiry later than the bound `expiresInDays` has
 *
 * @throws BadRequestError when `expiresAt` is more than INVITATION_MAX_EXPIRY_DAYS away
 */
function assertExpiryWithinBound(expiresAt: Date): void
{
    if (expiresAt > calculateExpiresAt(INVITATION_MAX_EXPIRY_DAYS))
    {
        throw new BadRequestError({ message: `expiresAt must be within ${INVITATION_MAX_EXPIRY_DAYS} days` });
    }
}

/**
 * Refuse metadata that is not a JSON object
 *
 * Cancel merges its reason into the stored metadata, which only an object can
 * take: jsonb `||` appends to an array instead. The route's schema refuses the
 * rest; this is for callers of the service.
 *
 * @throws BadRequestError when `metadata` is given and is not a plain object
 */
function assertMetadataIsObject(metadata: unknown): void
{
    if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata)))
    {
        throw new BadRequestError({ message: 'metadata must be a JSON object' });
    }
}

/**
 * Create a new invitation
 *
 * @param params - Invitation parameters
 * @returns The invitation and its link token — the only time the token is returned
 * @throws BadRequestError if `expiresAt` is beyond INVITATION_MAX_EXPIRY_DAYS, or `metadata` is not an object
 *
 * @example
 * ```typescript
 * const { invitation, token } = await createInvitation({
 *   email: 'newuser@example.com',
 *   roleId: 2,
 *   invitedBy: 1,
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
}): Promise<IssuedInvitation>
{
    const { email, roleId, invitedBy, expiresInDays = 7, expiresAt: expiresAtParam, metadata } = params;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
    {
        throw new BadRequestError({ message: 'Invalid email format' });
    }

    assertMetadataIsObject(metadata);

    // Check if user already exists — an address stored in another case counts
    if ((await usersRepository.findByFoldedEmail(email)).kind !== 'none')
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

    // A pending grant: the domain must already be allowed for the role, while
    // verification waits for acceptance, which is what proves the address.
    assertEmailAllowedForRole({ email, emailVerifiedAt: null }, role.name, { requireVerified: false });

    // Verify inviter exists
    const inviter = await usersRepository.findById(invitedBy);

    if (!inviter)
    {
        throw new NotFoundError({ message: `User with id ${invitedBy} not found`, resource: 'User' });
    }

    const expiresAt = expiresAtParam ?? calculateExpiresAt(expiresInDays);
    assertExpiryWithinBound(expiresAt);

    const { secret: token, hash: tokenHash } = mintCredential();

    const invitation = await invitationsRepository.create({
        email,
        tokenHash,
        roleId,
        invitedBy,
        status: 'pending',
        expiresAt,
        metadata: metadata || null,
    });

    // After the commit, like the password-reset link: an invitation a caller's
    // transaction rolls back must not be mailed.
    onAfterCommit(() => invitationCreatedEvent.emit({
        invitationId: String(invitation.id),
        email,
        token,
        roleId,
        invitedBy: String(invitedBy),
        expiresAt: expiresAt.toISOString(),
        isResend: false,
        metadata,
    }));

    return { invitation, token };
}

/**
 * Get invitation by token
 *
 * @param token - The presented invitation token; it is hashed before the lookup
 * @returns Invitation (without its token hash) or null if not found
 */
export async function getInvitationByToken(token: string)
{
    return await invitationsRepository.findByTokenHash(hashCredential(token));
}

/**
 * Get invitation with role and inviter details
 *
 * @param token - The presented invitation token; it is hashed before the lookup
 * @returns Invitation with joined data or null
 */
export async function getInvitationWithDetails(token: string)
{
    return await invitationsRepository.findByTokenHashWithDetails(hashCredential(token));
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
    invitation?: InvitationRecord;
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
 * The invitation a presented token names, if it can still be accepted
 *
 * @param token - The presented invitation token
 * @throws InvitationNotFoundError (404) when the token names no invitation
 * @throws InvitationNoLongerValidError (410) when it was accepted, cancelled or has expired
 */
async function requireAcceptableInvitation(token: string): Promise<InvitationRecord>
{
    const validation = await validateInvitation(token);

    if (!validation.invitation)
    {
        throw new InvitationNotFoundError();
    }

    if (!validation.valid)
    {
        throw new InvitationNoLongerValidError({ message: validation.error });
    }

    return validation.invitation;
}

/**
 * What the invitee's acceptance page shows
 *
 * @param token - The presented invitation token
 * @returns The invited address, the role, the inviter and the expiry
 * @throws InvitationNotFoundError (404) when the token names no invitation
 * @throws InvitationNoLongerValidError (410) when it can no longer be accepted
 */
export async function describeInvitation(token: string)
{
    await requireAcceptableInvitation(token);

    const invitation = await getInvitationWithDetails(token);

    if (!invitation)
    {
        throw new InvitationNotFoundError();
    }

    return {
        email: invitation.email,
        role: invitation.role.name,
        roleDisplayName: invitation.role.displayName,
        invitedBy: invitation.inviter.email || 'Unknown',
        expiresAt: invitation.expiresAt.toISOString(),
        metadata: invitation.metadata || undefined,
    };
}

/**
 * What an invitee presents to accept
 */
interface AcceptInvitationParams
{
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
}

/**
 * Accept invitation and create user account
 *
 * @param params - Acceptance parameters
 * @returns Created user info
 * @throws InvitationNotFoundError (404) when the token names no invitation
 * @throws InvitationNoLongerValidError (410) when it can no longer be accepted, including
 *   when a resend, a cancel or another acceptance committed first
 *
 * @example
 * ```typescript
 * const user = await acceptInvitation({
 *   token: tokenFromTheInvitationLink,
 *   password: 'SecurePass123!',
 *   publicKey: 'base64-der...',
 *   keyId: 'uuid-v4',
 *   fingerprint: 'sha256-hex',
 *   algorithm: 'ES256'
 * });
 * ```
 */
export async function acceptInvitation(params: AcceptInvitationParams)
{
    // This is the one key-storing path that does not go through
    // registerPublicKeyService, so the check the other paths inherit is stated
    // here. It runs before the account exists: a key that could never sign for
    // its declared algorithm must not consume the invitation.
    assertKeyMatchesAlgorithm(params.publicKey, params.algorithm);

    // One transaction from the claim to the key: whatever refuses the
    // acceptance after the claim puts the invitation back to pending.
    return await runInTransaction(async () =>
    {
        const invitation = await claimInvitation(params.token);
        const { role, emailVerifiedAt } = await admitInvitee(invitation);
        const newUser = await createInvitedAccount(invitation, params, emailVerifiedAt);

        // After the commit, like the device event: the account must be
        // readable by the time a subscriber hears of it.
        onAfterCommit(() => invitationAcceptedEvent.emit({
            invitationId: String(invitation.id),
            email: invitation.email,
            userId: String(newUser.id),
            roleId: Number(invitation.roleId),
            invitedBy: String(invitation.invitedBy),
            metadata: invitation.metadata as Record<string, unknown> | undefined,
        }));

        return {
            userId: newUser.id,
            email: newUser.email!,
            role: role.name,
            ...await secondFactorEnrolmentFields(newUser.id),
        };
    });
}

/**
 * Mark the invitation a presented token names accepted, or refuse
 *
 * The claim comes first and is one conditional statement, so of an acceptance
 * and a resend, a cancel or another acceptance, exactly one wins: the loser
 * matches no row and is refused here, before any account exists.
 *
 * @throws InvitationNotFoundError (404) when the token names no invitation
 * @throws InvitationNoLongerValidError (410) when it was accepted, cancelled or has expired
 */
async function claimInvitation(token: string): Promise<InvitationRecord>
{
    const claimed = await invitationsRepository.claimPendingByTokenHash(hashCredential(token));

    if (claimed)
    {
        return claimed;
    }

    // Nothing matched; the lookup a stale token gets says why.
    await requireAcceptableInvitation(token);

    throw new InvitationNoLongerValidError();
}

/**
 * The role a claimed invitation grants, once the policy in force admits the invitee
 *
 * Read after the claim, so the configuration consulted is the one in force
 * when the row was locked, not the one the invitation was created under.
 * Accepting verifies the address — the account is created with it verified —
 * so the domain rule is applied to that row.
 */
async function admitInvitee(invitation: InvitationRecord)
{
    const role = await rolesRepository.findById(invitation.roleId);

    if (!role)
    {
        throw new NotFoundError({ message: 'Role not found', resource: 'Role' });
    }

    const emailVerifiedAt = new Date();
    assertEmailAllowedForRole({ email: invitation.email, emailVerifiedAt }, role.name);

    // App-level pre-registration policy gate — throws to reject
    // metadata 컬럼은 nullable — SQL NULL을 계약 타입(Record | undefined)에 맞게 정규화
    await runBeforeRegister({
        channel: 'invitation',
        email: invitation.email,
        metadata: (invitation.metadata ?? undefined) as Record<string, unknown> | undefined,
    });

    return { role, emailVerifiedAt };
}

/**
 * The invitee's account and its public key
 */
async function createInvitedAccount(
    invitation: InvitationRecord,
    params: AcceptInvitationParams,
    emailVerifiedAt: Date,
)
{
    const newUser = await usersRepository.create({
        email: invitation.email,
        passwordHash: await hashPassword(params.password),
        roleId: invitation.roleId,
        emailVerifiedAt, // Auto-verify invited users
        passwordChangeRequired: false,
        status: 'active',
    });

    const key = await keysRepository.create({
        userId: newUser.id,
        keyId: params.keyId,
        publicKey: params.publicKey,
        algorithm: params.algorithm,
        fingerprint: params.fingerprint,
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

    return newUser;
}

type InvitationListRow = Awaited<ReturnType<typeof invitationsRepository.list>>['invitations'][number];

/**
 * The declared shape of a listed invitation
 *
 * Picks each field by name, so a column added to the query does not reach the
 * response without being added here — the way the token once did.
 */
function toInvitationSummary(row: InvitationListRow): InvitationSummary
{
    return {
        id: row.id,
        email: row.email,
        roleId: row.roleId,
        invitedBy: row.invitedBy,
        status: row.status,
        expiresAt: row.expiresAt,
        acceptedAt: row.acceptedAt,
        cancelledAt: row.cancelledAt,
        metadata: row.metadata,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        role: { id: row.role.id, name: row.role.name, displayName: row.role.displayName },
        inviter: { id: row.inviter.id, email: row.inviter.email },
    };
}

/**
 * List invitations with filtering and pagination
 *
 * @param params - Query parameters
 * @returns Paginated invitations, none carrying a token or its hash
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
    const result = await invitationsRepository.list(params);

    return { ...result, invitations: result.invitations.map(toInvitationSummary) };
}

/**
 * The invitation a manager acts on, once their authority over it is established
 *
 * Resend and cancel each change who may become the invitee, so they take the
 * authority creating the invitation took: the right to assign its role. The
 * token hash comes with it for the conditional write that follows and goes no
 * further than this service.
 *
 * @param id - Invitation ID
 * @param callerId - User performing the action
 * @throws NotFoundError (404) when no invitation has the ID
 * @throws ForbiddenError (403) when the caller may not assign the invitation's role
 */
async function findManagedInvitation(id: number, callerId: number)
{
    const invitation = await invitationsRepository.findByIdWithTokenHash(id);

    if (!invitation)
    {
        throw new NotFoundError({ message: 'Invitation not found', resource: 'Invitation' });
    }

    await assertCanAssignRole(callerId, invitation.roleId);

    return invitation;
}

/**
 * Cancel invitation
 *
 * Only pending invitations can be cancelled
 *
 * @param id - Invitation ID
 * @param cancelledBy - User ID who cancelled
 * @param reason - Optional cancellation reason
 * @throws NotFoundError (404) when no invitation has the ID
 * @throws ForbiddenError (403) when the caller may not assign the invitation's role
 * @throws ConflictError (409) when the invitation is not pending
 * @throws InvitationChangedError (409) when it stopped being pending while this ran
 */
export async function cancelInvitation(
    id: number,
    cancelledBy: number,
    reason?: string,
)
{
    const invitation = await findManagedInvitation(id, cancelledBy);

    if (invitation.status !== 'pending')
    {
        throw new ConflictError({ message: `Cannot cancel ${invitation.status} invitation` });
    }

    if (!await invitationsRepository.cancel(id, cancelledBy, reason))
    {
        throw new InvitationChangedError();
    }

    console.log(`[Auth] ⚠️  Invitation cancelled: ${invitation.email} (reason: ${reason || 'none'})`);
}

/**
 * Delete invitation
 *
 * Permanently removes invitation record
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
 * Mints a new link token and replaces the stored hash, so the link mailed
 * before stops working; an expired invitation is reissued with the new link,
 * never revived with its old one.
 *
 * @param params.id - Invitation ID
 * @param params.resentBy - User performing the resend
 * @param params.expiresInDays - New expiration period (default: 7)
 * @returns The invitation and its new link token — the only time that token is returned
 * @throws BadRequestError when the new expiry is beyond INVITATION_MAX_EXPIRY_DAYS
 * @throws NotFoundError (404) when no invitation has the ID
 * @throws ForbiddenError (403) when the caller may not assign the invitation's role
 * @throws ConflictError (409) when the invitation was accepted or cancelled
 * @throws InvitationChangedError (409) when another request reissued, accepted or
 *   cancelled it while this ran — the token minted here was never stored
 */
export async function resendInvitation(params: {
    id: number;
    resentBy: number;
    expiresInDays?: number;
}): Promise<IssuedInvitation>
{
    const { id, resentBy, expiresInDays = 7 } = params;
    const newExpiresAt = calculateExpiresAt(expiresInDays);
    assertExpiryWithinBound(newExpiresAt);

    const invitation = await findManagedInvitation(id, resentBy);

    // Can only resend pending or expired invitations
    if (!['pending', 'expired'].includes(invitation.status))
    {
        throw new ConflictError({ message: `Cannot resend ${invitation.status} invitation` });
    }

    const { secret: token, hash: tokenHash } = mintCredential();
    const updated = await invitationsRepository.resend(id, invitation, tokenHash, newExpiresAt);

    if (!updated)
    {
        throw new InvitationChangedError();
    }

    // After the commit, like the invitation's first link
    onAfterCommit(() => invitationCreatedEvent.emit({
        invitationId: String(invitation.id),
        email: invitation.email,
        token,
        roleId: Number(invitation.roleId),
        invitedBy: String(invitation.invitedBy),
        expiresAt: newExpiresAt.toISOString(),
        isResend: true,
        metadata: invitation.metadata as Record<string, unknown> | undefined,
    }));

    return { invitation: updated, token };
}
