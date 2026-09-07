/**
 * @spfn/auth - Account Deletion Service
 *
 * Request / cancel (recovery) / purge for the account deletion lifecycle.
 *
 * Lifecycle:
 *   active --request(reauth)--> pending_deletion --grace expires(cron)--> deleted (anonymize) | row removed (hard-delete)
 *     ^                              |
 *     +-------cancel(reauth)---------+          immediate = grace period of 0, same pipeline
 */

import { ValidationError, NotFoundError } from '@spfn/core/errors';
import { runInTransaction, onAfterCommit } from '@spfn/core/db';
import { sendEmail } from '@spfn/notification/server';

import {
    InvalidCredentialsError,
    InvalidVerificationTokenError,
    VerificationTokenPurposeMismatchError,
    VerificationTokenTargetMismatchError,
    DeletionAlreadyRequestedError,
    DeletionNotRequestedError,
    ImmediateDeletionNotAllowedError,
} from '@spfn/auth/errors';

import {
    usersRepository,
    keysRepository,
    passkeysRepository,
    deviceAuthorizationsRepository,
    socialAccountsRepository,
    userProfilesRepository,
    verificationCodesRepository,
    accountDeletionRequestsRepository,
} from '../repositories';
import type { User } from '../entities/users';
import type { AccountDeletionRequest } from '../entities/account-deletion-requests';
import type { AccountDeletionRequestedBy, PurgeStrategy } from '../types';
import { verifyPassword, getDummyPasswordHash } from '../helpers';
import { validateVerificationToken } from './verification.service';
import { getDeletionConfig } from '../lib/deletion-config';
import { authLogger } from '../logger';
import {
    authDeletionRequestedEvent,
    authDeletionCancelledEvent,
    authDeletionCompletedEvent,
} from '../events';

/**
 * `postgres` driver error code for a unique-constraint violation (23505). Used to
 * detect a concurrent duplicate deletion request racing the partial unique index
 * (`account_deletion_requests_user_pending_unique_idx`) rather than letting it
 * surface as a raw 500.
 */
const POSTGRES_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean
{
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
}

// ============================================================================
// Shared lookup (login / OAuth / authenticate gates)
// ============================================================================

export interface PendingDeletionInfo
{
    purgeScheduledAt: Date;
}

/**
 * Look up the pending deletion request's `purgeScheduledAt` for a `pending_deletion`
 * user, so login/OAuth/authenticate can surface it on `AccountPendingDeletionError`.
 * Returns null if there is no pending row (shouldn't normally happen for a user in
 * that status, but the caller falls back to an error without the date).
 *
 * Reads from the write primary, not a replica — this backs the same status gates
 * that decide whether to grant a session, so a replica-lag window must not let a
 * just-requested deletion go unnoticed.
 */
export async function getPendingDeletionInfo(userId: number): Promise<PendingDeletionInfo | null>
{
    const request = await accountDeletionRequestsRepository.findPendingByUserIdOnPrimary(userId);

    return request ? { purgeScheduledAt: request.purgeScheduledAt } : null;
}

// ============================================================================
// Re-authentication gate
// ============================================================================

interface ReauthParams
{
    password?: string;
    verificationToken?: string;
}

/**
 * Step-up re-auth for a destructive action: password holders confirm with their
 * password, OAuth-only/passwordless users confirm with a fresh verification code
 * (purpose 'account_deletion'). Shared by request (self-service) and cancel.
 */
async function verifyReauthCredential(user: User, params: ReauthParams): Promise<void>
{
    if (user.passwordHash)
    {
        if (!params.password)
        {
            throw new ValidationError({ message: 'Password is required to confirm this action' });
        }

        const valid = await verifyPassword(params.password, user.passwordHash);
        if (!valid)
        {
            throw new InvalidCredentialsError({ message: 'Incorrect password' });
        }

        return;
    }

    if (!params.verificationToken)
    {
        throw new ValidationError({ message: 'A verification code is required to confirm this action' });
    }

    const payload = validateVerificationToken(params.verificationToken);
    if (!payload)
    {
        throw new InvalidVerificationTokenError();
    }

    if (payload.purpose !== 'account_deletion')
    {
        throw new VerificationTokenPurposeMismatchError({ expected: 'account_deletion', actual: payload.purpose });
    }

    const target = user.email ?? user.phone;
    if (!target || payload.target !== target)
    {
        throw new VerificationTokenTargetMismatchError();
    }
}

// ============================================================================
// Notifications (best-effort — never blocks the lifecycle transition)
// ============================================================================

async function sendDeletionEmail(
    to: string,
    subject: string,
    text: string,
): Promise<void>
{
    const result = await sendEmail({ to, subject, text });

    if (!result.success)
    {
        authLogger.email.error('Failed to send account deletion email', { to, subject, error: result.error });
    }
}

async function notifyDeletionRequested(user: User, purgeScheduledAt: Date): Promise<void>
{
    if (!getDeletionConfig().sendNotifications || !user.email)
    {
        return;
    }

    await sendDeletionEmail(
        user.email,
        'Account deletion requested',
        `We received a request to delete your account. It is scheduled for permanent deletion on `
        + `${purgeScheduledAt.toISOString()}. If this wasn't you, sign in before that date to cancel it.`,
    );
}

async function notifyDeletionCancelled(user: User): Promise<void>
{
    if (!getDeletionConfig().sendNotifications || !user.email)
    {
        return;
    }

    await sendDeletionEmail(
        user.email,
        'Account deletion cancelled',
        'Your account deletion request was cancelled and your account is active again.',
    );
}

async function notifyPurgeFinal(email: string): Promise<void>
{
    if (!getDeletionConfig().sendNotifications)
    {
        return;
    }

    await sendDeletionEmail(
        email,
        'Your account has been deleted',
        'Your account and associated data have now been permanently deleted, as requested.',
    );
}

// ============================================================================
// Request
// ============================================================================

export interface RequestAccountDeletionParams
{
    /** Who initiated this — 'self' requires re-auth via password/verificationToken; 'admin' does not. */
    requestedBy: AccountDeletionRequestedBy;
    password?: string;
    verificationToken?: string;
    reason?: string;
    /** Skip the grace period and purge inline. Self-service requires `deletion.allowSelfImmediate`. */
    immediate?: boolean;
}

export interface RequestAccountDeletionResult
{
    requestId: number;
    purgeScheduledAt: Date;
}

function addDays(date: Date, days: number): Date
{
    const result = new Date(date);
    result.setDate(result.getDate() + days);

    return result;
}

/**
 * Request account deletion (self-service re-auth gate, or trusted admin/DSR call).
 *
 * Sets status -> 'pending_deletion', records the request, revokes every active
 * session key, and (after commit) emits `auth.deletion.requested` and sends the
 * request-received notice. With a zero grace period (explicit `immediate: true`,
 * gated for self-service by `allowSelfImmediate`), purges inline instead of
 * waiting for the cron sweep.
 */
export async function requestAccountDeletionService(
    userId: number,
    params: RequestAccountDeletionParams,
): Promise<RequestAccountDeletionResult>
{
    const { requestedBy, password, verificationToken, reason, immediate } = params;

    const user = await usersRepository.findById(userId);
    if (!user)
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    if (user.status === 'pending_deletion' || user.status === 'deleted')
    {
        throw new DeletionAlreadyRequestedError();
    }

    if (requestedBy === 'self')
    {
        await verifyReauthCredential(user, { password, verificationToken });
    }

    const config = getDeletionConfig();
    const wantsImmediate = immediate === true;

    if (wantsImmediate && requestedBy === 'self' && !config.allowSelfImmediate)
    {
        throw new ImmediateDeletionNotAllowedError();
    }

    const gracePeriodDays = wantsImmediate ? 0 : config.gracePeriodDays;
    const requestedAt = new Date();
    const purgeScheduledAt = addDays(requestedAt, gracePeriodDays);

    await usersRepository.updateById(user.id, { status: 'pending_deletion' });

    // A concurrent duplicate request racing the partial unique index
    // (one pending row per user) surfaces here as a raw Postgres unique-violation —
    // convert it to the same typed 409 a sequential duplicate request gets above.
    let request: AccountDeletionRequest;
    try
    {
        request = await accountDeletionRequestsRepository.create({
            userId: user.id,
            userPublicId: user.publicId,
            requestedAt,
            purgeScheduledAt,
            status: 'pending',
            requestedBy,
            reason: reason ?? null,
        });
    }
    catch (error)
    {
        if (isUniqueViolation(error))
        {
            throw new DeletionAlreadyRequestedError();
        }

        throw error;
    }

    await keysRepository.revokeAllActiveByUserId(user.id, 'Account deletion requested');

    // Device-code requests the user had in flight are refused in the same breath.
    // An approved-but-uncollected one outlives the key revocation above, and the
    // poll that collects it registers a key created *after* this revoke-all — so
    // cancelling the deletion later would restore an account with a signing key
    // nothing in the deletion path ever saw.
    await deviceAuthorizationsRepository.denyAllActiveByUserId(user.id);

    // Deferred to after commit: event subscribers and the outbound email must not
    // observe (or be triggered by) a request that ultimately rolls back, and an
    // external I/O call (email provider) must not run while a DB transaction/row
    // lock is held.
    onAfterCommit(() =>
        authDeletionRequestedEvent.emit({
            userId: String(user.id),
            userPublicId: user.publicId,
            purgeScheduledAt: purgeScheduledAt.toISOString(),
            requestedBy,
        }));
    onAfterCommit(() => notifyDeletionRequested(user, purgeScheduledAt));

    if (gracePeriodDays === 0)
    {
        await purgePendingRequest(request);
    }

    return { requestId: request.id, purgeScheduledAt };
}

// ============================================================================
// Cancel (recovery)
// ============================================================================

export interface CancelAccountDeletionParams
{
    email?: string;
    phone?: string;
    password?: string;
    verificationToken?: string;
}

export interface CancelAccountDeletionResult
{
    userId: string;
}

/**
 * Cancel a pending deletion (recovery). All sessions were revoked at request
 * time, so this is credential-based (no Bearer token) rather than auth-context-based.
 *
 * Credential verification always runs before the caller learns whether the
 * account exists / is pending deletion — otherwise this endpoint could be used
 * to enumerate accounts or probe deletion status without a valid credential,
 * the same posture `loginService` takes for missing accounts.
 *
 * Claims the `account_deletion_requests` row (conditional `WHERE status =
 * 'pending'`) before touching `users` — see the comment at that claim below for
 * why the `users` row must not move until the claim succeeds.
 */
export async function cancelAccountDeletionService(
    params: CancelAccountDeletionParams,
): Promise<CancelAccountDeletionResult>
{
    const { email, phone, password, verificationToken } = params;

    if (!email && !phone)
    {
        throw new ValidationError({ message: 'Either email or phone must be provided' });
    }

    const user = await usersRepository.findByEmailOrPhone(email, phone);
    if (!user)
    {
        // No real hash to check against — burn roughly the same time a real
        // (wrong-password) attempt would, mirroring loginService's dummy-hash
        // equalization, so "no such account" isn't distinguishable by timing.
        if (password)
        {
            await verifyPassword(password, await getDummyPasswordHash());
        }

        throw new InvalidCredentialsError();
    }

    if (user.status !== 'pending_deletion')
    {
        // Still verify the credential before revealing "not pending" — a caller
        // without the right password/code must see the same InvalidCredentialsError
        // as a wrong guess against a genuinely pending account, not a distinguishing
        // 404 up front.
        await verifyReauthCredential(user, { password, verificationToken });
        throw new DeletionNotRequestedError();
    }

    await verifyReauthCredential(user, { password, verificationToken });

    // Claim-first, in the same row order the purge job locks in (B1): the
    // account_deletion_requests row before the users row. Reactivating `users`
    // first (the previous ordering) raced the purge — if the purge's own claim +
    // destructive DML committed in the gap between our credential check and our
    // (unconditional) users UPDATE, this would revive an already-anonymized row
    // (status='deleted', PII scrubbed, passwordHash null) back to 'active': a
    // "zombie" account, and a recovery success response for an account that was
    // actually just destroyed. Claiming the request row first — with the same
    // conditional `WHERE status = 'pending'` markCompleted uses — means whichever
    // of cancel/purge locks this row first wins; the loser sees a row already
    // moved off 'pending' and backs off before touching `users` at all.
    const pendingRequest = await accountDeletionRequestsRepository.findPendingByUserId(user.id);
    if (!pendingRequest)
    {
        throw new DeletionNotRequestedError();
    }

    const claimed = await accountDeletionRequestsRepository.markCancelled(pendingRequest.id);
    if (!claimed)
    {
        // The purge won the race and already claimed/completed this row — same
        // surface as retrying cancel after the account was actually purged.
        throw new DeletionNotRequestedError();
    }

    // Only now touch `users` — the claim above guarantees the purge did not win.
    // Conditional on status='pending_deletion' too, defensively (belt-and-suspenders
    // alongside the request-row claim, not a race this alone needs to close).
    await usersRepository.reactivateFromPendingDeletion(user.id);

    onAfterCommit(() =>
        authDeletionCancelledEvent.emit({
            userId: String(user.id),
            userPublicId: user.publicId,
        }));
    onAfterCommit(() => notifyDeletionCancelled(user));

    return { userId: String(user.id) };
}

// ============================================================================
// Purge
// ============================================================================

export interface PurgeUserResult
{
    outcome: 'purged' | 'skipped' | 'not-found';
}

/**
 * Anonymize a user in place: scrub PII, drop child rows that would otherwise
 * block re-registration (social accounts, public keys), keep the row for referential
 * integrity/audit. `status` -> 'deleted', `deletedAt`/`deletedBy` set (softDelete()).
 *
 * Must run inside the same transaction as the `markCompleted` claim (caller's
 * responsibility) — this function itself does not re-check pending status.
 */
async function anonymizeUser(user: User): Promise<void>
{
    await usersRepository.updateById(user.id, {
        email: `deleted-${user.publicId}@deleted.invalid`,
        phone: null,
        username: null,
        passwordHash: null,
        status: 'deleted',
        deletedAt: new Date(),
        deletedBy: 'system:auth.deletion.purge',
    });

    await socialAccountsRepository.deleteAllByUserId(user.id);
    await keysRepository.deleteAllByUserId(user.id);
    // Passkeys go with the other credentials: an anonymized row keeping one
    // would leave a credential that still names this account to an
    // authenticator, and reserve its credential id for a user nobody can be.
    await passkeysRepository.deleteAllByUserId(user.id);
    await userProfilesRepository.updateByUserId(user.id, {
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
        bio: null,
        dateOfBirth: null,
        gender: null,
        website: null,
        location: null,
        company: null,
        jobTitle: null,
        metadata: null,
    });
}

/**
 * Purge a single user for a given (already fetched) request row. Shared by the
 * immediate inline path, the standalone admin/DSR entry point, and the cron sweep.
 *
 * Ordering (deliberate — see PR review B1/M1/M2):
 * 1. A pre-check read (replica is fine — only gates whether the hook below runs)
 *    so a request already recovered before we even got here skips the hook.
 * 2. `onBeforePurge` runs BEFORE any DB transaction is opened — it's arbitrary
 *    app I/O and must not hold a DB row lock or run inside our transaction.
 * 3. Only then does the transaction open, and the *only* things inside it are:
 *    a primary re-read of the user (closes the replica-lag/TOCTOU window against
 *    `findDueForPurge`'s replica read and the pre-check above), the conditional
 *    `markCompleted` claim (fails closed — 0 rows — if the request was cancelled
 *    or already completed concurrently), and the destructive DML itself. Nothing
 *    proceeds to destructive DML unless both re-checks pass.
 * 4. Notifications and the `auth.deletion.completed` event are deferred to
 *    `onAfterCommit` — they must never fire for a purge that ultimately aborted
 *    or rolled back, and the email send must not run with a transaction open.
 */
async function purgePendingRequest(request: AccountDeletionRequest): Promise<PurgeUserResult>
{
    if (request.userId === null)
    {
        // Already orphaned (e.g. user row removed through another path) — close out
        // the audit row so it stops showing up in the due-for-purge sweep. If it's
        // no longer 'pending' (already handled), this is a harmless no-op.
        await accountDeletionRequestsRepository.markCompleted(request.id, 'hard-delete');

        return { outcome: 'not-found' };
    }

    const userId = request.userId;

    const precheckUser = await usersRepository.findById(userId);
    if (!precheckUser || precheckUser.status !== 'pending_deletion')
    {
        // Recovered (or otherwise gone) before we got here — no hook call, no
        // transaction, nothing to undo.
        return { outcome: 'skipped' };
    }

    const config = getDeletionConfig();

    if (config.onBeforePurge)
    {
        try
        {
            await config.onBeforePurge({
                id: precheckUser.id,
                publicId: precheckUser.publicId,
                email: precheckUser.email,
                phone: precheckUser.phone,
            });
        }
        catch (error)
        {
            authLogger.service.warn('[account-deletion] onBeforePurge threw — skipping this sweep, will retry', {
                userId: precheckUser.id,
                error: error instanceof Error ? error.message : String(error),
            });

            return { outcome: 'skipped' };
        }
    }

    const purgeStrategy: PurgeStrategy = config.purgeStrategy;
    let purgedUser: User | null = null;

    await runInTransaction(async () =>
    {
        // Re-read on the primary/tx connection — the authoritative check. Closes
        // the window between findDueForPurge (replica)/the pre-check above and
        // this transaction: a cancel that committed in between must be honored.
        const user = await usersRepository.findById(userId);
        if (!user || user.status !== 'pending_deletion')
        {
            return;
        }

        // Conditional claim: fails closed (returns null) if the request row was
        // moved off 'pending' concurrently (cancelled, or claimed by another purge
        // attempt). The UPDATE's row lock also serializes concurrent purge/cancel
        // attempts on this same row. Only past this point do we touch `users`.
        const claimed = await accountDeletionRequestsRepository.markCompleted(request.id, purgeStrategy);
        if (!claimed)
        {
            return;
        }

        if (purgeStrategy === 'hard-delete')
        {
            await usersRepository.deleteById(user.id);
        }
        else
        {
            await anonymizeUser(user);
        }

        // verificationCodes has no userId FK (target-keyed) — clean up regardless
        // of strategy so leftover codes don't linger for a reused email/phone.
        if (user.email)
        {
            await verificationCodesRepository.deleteByTarget(user.email);
        }
        if (user.phone)
        {
            await verificationCodesRepository.deleteByTarget(user.phone);
        }

        purgedUser = user;
    });

    if (!purgedUser)
    {
        return { outcome: 'skipped' };
    }

    const { email, publicId } = purgedUser;

    // Final notice is sent after the purge actually committed — never before, and
    // never if the transaction aborted/rolled back (so a retried sweep can't send
    // it twice). This holds for hard-delete too: the address is captured above,
    // before the row is gone, and the notice still goes out post-commit.
    if (email)
    {
        onAfterCommit(() => notifyPurgeFinal(email));
    }
    onAfterCommit(() =>
        authDeletionCompletedEvent.emit({
            userPublicId: publicId,
            purgeStrategy,
        }));

    return { outcome: 'purged' };
}

/**
 * Purge a user's pending deletion request immediately, ignoring `purgeScheduledAt`.
 * Admin/GDPR-response entry point — the route (if any) belongs to the app.
 *
 * @throws DeletionNotRequestedError if the user has no pending request
 */
export async function purgeUserService(userId: number): Promise<PurgeUserResult>
{
    const request = await accountDeletionRequestsRepository.findPendingByUserId(userId);
    if (!request)
    {
        throw new DeletionNotRequestedError();
    }

    return purgePendingRequest(request);
}

export interface SweepDuePurgesResult
{
    processed: number;
    purged: number;
    skipped: number;
}

/**
 * Sweep every request whose grace period has elapsed and purge it. Called by the
 * `auth.deletion.purge` cron job. One user's failure (thrown error, not just an
 * `onBeforePurge` skip) is logged and does not stop the rest of the sweep — it
 * stays `pending` and is retried on the next tick.
 */
export async function sweepDuePurges(now: Date = new Date()): Promise<SweepDuePurgesResult>
{
    const dueRequests = await accountDeletionRequestsRepository.findDueForPurge(now);

    let purged = 0;
    let skipped = 0;

    for (const request of dueRequests)
    {
        try
        {
            const result = await purgePendingRequest(request);
            if (result.outcome === 'purged')
            {
                purged++;
            }
            else
            {
                skipped++;
            }
        }
        catch (error)
        {
            skipped++;
            authLogger.service.error('[account-deletion] purge failed, will retry next sweep', {
                requestId: request.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { processed: dueRequests.length, purged, skipped };
}

// Exposed for tests exercising the exact stale-batch race the purge sweep must
// handle (a request read into a batch, then cancelled before it's processed —
// see integration/account-deletion-flow.test.ts). Not part of the documented
// public API surface (services/index.ts re-exports the rest, not this one).
export { purgePendingRequest };
