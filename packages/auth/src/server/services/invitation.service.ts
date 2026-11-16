/**
 * @spfn/auth - Invitation Service
 *
 * User invitation management for invite-only registration
 */

import { onAfterCommit } from '@spfn/core/db';
import type { InvitationSummary } from '@spfn/auth';
import {
    invitationsRepository,
    usersRepository,
    rolesRepository,
} from '../repositories';
import { INVITATION_MAX_EXPIRY_DAYS, type InvitationStatus, type KeyAlgorithmType } from '../types';
import { hashCredential, mintCredential } from '../lib/link-credentials';
import { runBeforeRegister } from '../lib/config';
import { assertEmailAllowedForRole } from '../lib/role-email-domains';
import { hashPassword } from '../helpers';
import { invitationCreatedEvent, invitationAcceptedEvent } from '../events';
import { registerPublicKeyService, registeredBinding } from './key.service';
import { BadRequestError, NotFoundError, ConflictError } from '@spfn/core/errors';
import { InvitationChangedError, InvitationNoLongerValidError, InvitationNotFoundError } from '@spfn/auth/errors';
import { secondFactorEnrolmentFields } from './second-factor-policy.service';
import { assertCanChangeRole, roleChangeRefusal, runJudgedTransaction, type RoleChange } from './permission.service';

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
 * The inviter gives the role (`assertCanChangeRole`), and acceptance checks
 * again that they still could.
 *
 * @param params - Invitation parameters
 * @returns The invitation and its link token — the only time the token is returned
 * @throws BadRequestError if `expiresAt` is beyond INVITATION_MAX_EXPIRY_DAYS, or `metadata` is not an object
 * @throws NotFoundError (404) when the role does not exist
 * @throws ConflictError (409) when the role is inactive
 * @throws ForbiddenError (403) when the inviter does not outrank the role
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
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

    // One transaction from the inviter's authority to the row: the authority
    // is resolved inside it, so it is the inviter's as of this write.
    return runJudgedTransaction(async () =>
    {
        await assertAddressFree(email);

        // The inviter gives the role: it must exist, be active, and rank below
        // theirs. Without this, a user:invite holder could invite with the
        // superadmin roleId and self-accept.
        await assertCanChangeRole(invitedBy, { targetUserCurrentRole: null, newRole: roleId });
        const role = (await rolesRepository.findByIdOnPrimary(roleId))!;

        // A pending grant: the domain must already be allowed for the role, while
        // verification waits for acceptance, which is what proves the address.
        assertEmailAllowedForRole({ email, emailVerifiedAt: null }, role.name, { requireVerified: false });

        const expiresAt = expiresAtParam ?? calculateExpiresAt(expiresInDays);
        assertExpiryWithinBound(expiresAt);

        return insertInvitation({ email, roleId, invitedBy, expiresAt, metadata });
    }, { context: 'auth:invitation-create' });
}

/**
 * Refuse an invitation to an address that has an account or a pending invitation
 *
 * @throws ConflictError (409)
 */
async function assertAddressFree(email: string): Promise<void>
{
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
}

/** Store a new invitation with a fresh link token, and mail it once committed. */
async function insertInvitation(params: {
    email: string;
    roleId: number;
    invitedBy: number;
    expiresAt: Date;
    metadata?: Record<string, any>;
}): Promise<IssuedInvitation>
{
    const { email, roleId, invitedBy, expiresAt, metadata } = params;
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
    /** Whether proxy-guard recognised the trusted Next.js proxy (`deviceProvenance`). */
    webProxy?: boolean;
}

/**
 * Accept invitation and create user account
 *
 * @param params - Acceptance parameters
 * @returns Created user info
 * @throws InvitationNotFoundError (404) when the token names no invitation
 * @throws InvitationNoLongerValidError (410) when it can no longer be accepted, including
 *   when a resend, a cancel or another acceptance committed first, and when the
 *   inviter could no longer give its role
 * @throws AuthorityContendedError (409) when the inviter's role changed under the judgement twice
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
    // One transaction from the claim to the key: whatever refuses the
    // acceptance after the claim puts the invitation back to pending. An
    // inviter's role that moved under the judgement runs it all again, from
    // the claim (`runJudgedTransaction`); the stale premise is found before
    // `beforeRegister` runs and the event is after commit, so neither repeats.
    return await runJudgedTransaction(async () =>
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
    }, { context: 'auth:invitation-accept' });
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
 * when the row was locked, not the one the invitation was created under —
 * and so is the inviter's authority (`assertInviterStillAuthorizes`).
 * Accepting verifies the address — the account is created with it verified —
 * so the domain rule is applied to that row.
 */
async function admitInvitee(invitation: InvitationRecord)
{
    await assertInviterStillAuthorizes(invitation);
    const role = (await rolesRepository.findByIdOnPrimary(invitation.roleId))!;

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
 * Refuse an invitation its inviter could not make now
 *
 * An invitation confers its role on the inviter's authority, so that
 * authority is read again at acceptance (`resolveAuthority`): an inviter
 * demoted, suspended or deleted since — or a role deactivated since — and the
 * invitation no longer gives anything. The refusal rolls the claim back; the
 * invitation stays pending, and accepting it works again once the inviter's
 * authority is restored or another manager resends it.
 *
 * @throws InvitationNoLongerValidError (410)
 */
async function assertInviterStillAuthorizes(invitation: InvitationRecord): Promise<void>
{
    const refusal = await roleChangeRefusal(invitation.invitedBy, givesRole(invitation.roleId));

    if (refusal !== null)
    {
        throw new InvitationNoLongerValidError({
            message: 'This invitation can no longer be accepted: whoever sent it no longer has the authority to give its role',
        });
    }
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

    // Through the one function every key row is written by, in this
    // transaction: the user row it belongs to is visible to it here, and a key
    // refused there (a reused keyId, a fingerprint that is not the key's hash, a
    // key of the wrong type) rolls the account and the acceptance back with it.
    // A brand-new account has nothing enrolled, so this never steps up.
    registeredBinding(await registerPublicKeyService({
        userId: newUser.id,
        keyId: params.keyId,
        publicKey: params.publicKey,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        channel: 'invitation',
        ip: params.ip,
        userAgent: params.userAgent,
        webProxy: params.webProxy,
    }));

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
 * Resend and cancel each change who may become the invitee, so they are role
 * changes on the caller's authority (`assertCanChangeRole`): a resend gives
 * the invitation's role again, a cancel takes it away. The token hash comes
 * with it for the conditional write that follows and goes no further than
 * this service.
 *
 * @param id - Invitation ID
 * @param callerId - User performing the action
 * @param change - The role change the action makes, given the invitation's role
 * @throws NotFoundError (404) when no invitation has the ID
 * @throws ForbiddenError (403) when the caller does not outrank the invitation's role
 * @throws ConflictError (409) when a resend would give an inactive role
 */
async function findManagedInvitation(id: number, callerId: number, change: (roleId: number) => RoleChange)
{
    const invitation = await invitationsRepository.findByIdWithTokenHash(id);

    if (!invitation)
    {
        throw new NotFoundError({ message: 'Invitation not found', resource: 'Invitation' });
    }

    await assertCanChangeRole(callerId, change(invitation.roleId));

    return invitation;
}

/** A resend gives the invitation's role again. */
function givesRole(roleId: number): RoleChange
{
    return { targetUserCurrentRole: null, newRole: roleId };
}

/** A cancel takes the invitation's role away, before anyone holds it. */
function takesRole(roleId: number): RoleChange
{
    return { targetUserCurrentRole: roleId, newRole: null };
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
 * @throws ForbiddenError (403) when the caller does not outrank the invitation's role
 * @throws ConflictError (409) when the invitation is not pending
 * @throws InvitationChangedError (409) when it stopped being pending while this ran
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 */
export async function cancelInvitation(
    id: number,
    cancelledBy: number,
    reason?: string,
)
{
    await runJudgedTransaction(async () =>
    {
        const invitation = await findManagedInvitation(id, cancelledBy, takesRole);

        if (invitation.status !== 'pending')
        {
            throw new ConflictError({ message: `Cannot cancel ${invitation.status} invitation` });
        }

        if (!await invitationsRepository.cancel(id, cancelledBy, reason))
        {
            throw new InvitationChangedError();
        }

        console.log(`[Auth] ⚠️  Invitation cancelled: ${invitation.email} (reason: ${reason || 'none'})`);
    }, { context: 'auth:invitation-cancel' });
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
 * @throws ForbiddenError (403) when the caller does not outrank the invitation's role
 * @throws ConflictError (409) when the invitation's role is inactive, or it was accepted or cancelled
 * @throws InvitationChangedError (409) when another request reissued, accepted or
 *   cancelled it while this ran — the token minted here was never stored
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
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

    return runJudgedTransaction(async () =>
    {
        const invitation = await findManagedInvitation(id, resentBy, givesRole);

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

        announceResend(invitation, token, newExpiresAt);

        return { invitation: updated, token };
    }, { context: 'auth:invitation-resend' });
}

/** Mail a resent invitation's new link once the resend commits, like its first link. */
function announceResend(invitation: InvitationRecord, token: string, expiresAt: Date): void
{
    onAfterCommit(() => invitationCreatedEvent.emit({
        invitationId: String(invitation.id),
        email: invitation.email,
        token,
        roleId: Number(invitation.roleId),
        invitedBy: String(invitation.invitedBy),
        expiresAt: expiresAt.toISOString(),
        isResend: true,
        metadata: invitation.metadata as Record<string, unknown> | undefined,
    }));
}
