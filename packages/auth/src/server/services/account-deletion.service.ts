/**
 * @spfn/auth - Account Deletion Service
 *
 * Request / cancel (recovery) / purge for the account deletion lifecycle.
 *
 * Lifecycle of `users.deletion` — `setAccountDeletion` is its one writer:
 *   none --request(step-up, recent auth)--> pending --grace expires(cron)--> deleted (anonymize) | row removed (hard-delete)
 *     ^                                        |
 *     +--cancel(password or one-time code)-----+          immediate = grace period of 0, same pipeline
 *
 * None of the three touches `users.status`: an operator's suspension is a fact
 * of its own, and holds through a request, its cancellation and the purge.
 */

import { ValidationError, NotFoundError } from '@spfn/core/errors';
import { runInTransaction, onAfterCommit } from '@spfn/core/db';
import { sendEmail, sendSMS } from '@spfn/notification/server';

import {
    InvalidCredentialsError,
    InvalidVerificationTokenError,
    RecentAuthenticationRequiredError,
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
    deviceLinksRepository,
    socialAccountsRepository,
    userProfilesRepository,
    userSettingsRepository,
    verificationCodesRepository,
    accountExistsNoticesRepository,
    accountDeletionRequestsRepository,
} from '../repositories';
import type { User } from '../entities/users';
import type { AccountDeletionRequest } from '../entities/account-deletion-requests';
import type { AccountDeletionRequestedBy, PurgeStrategy } from '../types';
import { verifyPassword, getDummyPasswordHash, normalizeEmail } from '../helpers';
import { validateVerificationToken, type VerificationTokenPayload } from './verification.service';
import { revokeAllOAuth2GrantsForUser } from './oauth2-grant.service';
import { setAccountDeletion } from './user.service';
import { assertStepUp } from './mfa.service';
import { proveRecentAuthentication, recentAuthenticationHolds, type RecentAuthenticationProof } from './passkey.service';
import { admissionRefusalError, admitCompletion, sessionKeyOf, type PrincipalCredential } from './admission.service';
import { ROUTE_ENROLMENT } from '../routes/channels';
import { getDeletionConfig } from '../lib/deletion-config';
import { getRecentAuthMs } from '../lib/config';
import { isUniqueViolation } from '../lib/unique-violation';
import { authLogger } from '../logger';
import {
    authDeletionRequestedEvent,
    authDeletionCancelledEvent,
    authDeletionCompletedEvent,
} from '../events';

// ============================================================================
// Shared lookup
// ============================================================================

export interface PendingDeletionInfo
{
    purgeScheduledAt: Date;
}

/**
 * Look up the pending deletion request's `purgeScheduledAt` for an account whose
 * deletion is pending, so a client can surface it beside `AccountPendingDeletionError`.
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
// Proof
// ============================================================================

/** A request from a session, proved before the lock: the credential it came in with, and what satisfied recent authentication. */
interface ProvenRequester
{
    credential: PrincipalCredential;
    proof: RecentAuthenticationProof;
}

/**
 * A request from a session passes the gates every sensitive change does: the
 * second factor re-proved on this device (`assertStepUp` — a no-op for an
 * account without one), and a credential proved recently on it or the password
 * now (`proveRecentAuthentication`). Before the account lock: the second may
 * hash. `requesterStillProven` asks both again under it. An administrator's
 * request proves nothing here.
 *
 * @throws StepUpRequiredError, RecentAuthenticationRequiredError
 */
async function proveRequester(userId: number, params: RequestAccountDeletionParams): Promise<ProvenRequester | null>
{
    if (params.requestedBy !== 'self')
    {
        return null;
    }

    const keyId = sessionKeyOf(params.credential);
    await assertStepUp({ userId, keyId });

    return {
        credential: params.credential,
        proof: await proveRecentAuthentication({ userId, keyId, currentPassword: params.password }, getRecentAuthMs()),
    };
}

/**
 * What the request was decided on, asked again under the account lock: the
 * session still admitted — by the admission, for this route, every step of it
 * (`admitCompletion`) — the step-up still on record, and recent authentication
 * still holding. A transaction that revoked the key, suspended the account,
 * left it enrolment-only, removed the second factor or changed the password
 * while this one waited for the lock ends it here. Nothing hashes.
 *
 * @returns false when the password hash moved since it was verified: the caller verifies again outside the lock
 * @throws the admission's errors, StepUpRequiredError, RecentAuthenticationRequiredError
 */
async function requesterStillProven(user: User, requester: ProvenRequester): Promise<boolean>
{
    const admission = await admitCompletion({
        userId: user.id,
        credential: requester.credential,
        enrolment: ROUTE_ENROLMENT.requestAccountDeletion,
    });

    if ('refused' in admission)
    {
        throw admissionRefusalError(admission.refused);
    }

    const params = { userId: user.id, keyId: sessionKeyOf(requester.credential) };
    await assertStepUp(params);

    return await recentAuthenticationHolds(params, requester.proof, user, getRecentAuthMs());
}

/**
 * What proved a cancel: the password and the hash it was verified against, to
 * be confirmed under the lock, or a verification token still to be spent there.
 */
type CancelProof = { kind: 'password'; verifiedHash: string } | { kind: 'token'; token: VerificationTokenPayload };

/** The account a cancel named, and what proved its holder asked. */
interface ProvenHolder
{
    user: User;
    proof: CancelProof;
}

/**
 * Prove the person behind a cancel holds the account — its password, or a
 * verification token (purpose `account_deletion`) for its e-mail or its phone.
 * Either is accepted whether or not the account has a password, so a person
 * who forgot it recovers with a code. The token names the address it proves
 * and its kind; it proves this account when that is the account's own address
 * of that kind.
 *
 * Answers a missing account as it answers a wrong credential, at the same cost.
 *
 * @throws ValidationError, InvalidCredentialsError, InvalidVerificationTokenError,
 *   VerificationTokenPurposeMismatchError, VerificationTokenTargetMismatchError
 */
async function proveAccountHolder(user: User | null, params: CancelAccountDeletionParams): Promise<ProvenHolder>
{
    if (params.verificationToken)
    {
        const token = deletionToken(params.verificationToken);
        if (!user || addressOf(user, token.targetType) !== token.target)
        {
            throw new VerificationTokenTargetMismatchError();
        }

        return { user, proof: { kind: 'token', token } };
    }

    if (!params.password)
    {
        throw new ValidationError({ message: 'A password or a verification code is required to confirm this action' });
    }

    const matched = await verifyPassword(params.password, user?.passwordHash ?? await getDummyPasswordHash());
    if (!user?.passwordHash || !matched)
    {
        throw new InvalidCredentialsError();
    }

    return { user, proof: { kind: 'password', verifiedHash: user.passwordHash } };
}

/** A verification token minted for an account deletion. */
function deletionToken(verificationToken: string): VerificationTokenPayload
{
    const token = validateVerificationToken(verificationToken);
    if (!token)
    {
        throw new InvalidVerificationTokenError();
    }

    if (token.purpose !== 'account_deletion')
    {
        throw new VerificationTokenPurposeMismatchError({ expected: 'account_deletion', actual: token.purpose });
    }

    return token;
}

/** The account's address of a kind, in the form a verification token carries it. */
function addressOf(user: User, targetType: VerificationTokenPayload['targetType']): string | null
{
    return targetType === 'email' ? user.email && normalizeEmail(user.email) : user.phone;
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

async function sendDeletionSMS(to: string, message: string): Promise<void>
{
    const result = await sendSMS({ to, message });

    if (!result.success)
    {
        authLogger.sms.error('Failed to send account deletion SMS', { to, error: result.error });
    }
}

/**
 * The notice is the one place the person learns the purge date and that a
 * code cancels it — a pending account is not reset — so it goes to the
 * channel the account has: e-mail when it has an address, otherwise SMS
 * through the sender verification codes use.
 */
async function notifyDeletionRequested(user: User, purgeScheduledAt: Date): Promise<void>
{
    if (!getDeletionConfig().sendNotifications)
    {
        return;
    }

    if (user.email)
    {
        await sendDeletionEmail(
            user.email,
            'Account deletion requested',
            `We received a request to delete your account. It is scheduled for permanent deletion on `
            + `${purgeScheduledAt.toISOString()}. To cancel it before then, confirm with your password or with a `
            + `verification code sent to this address — no password needed.`,
        );
    }
    else if (user.phone)
    {
        await sendDeletionSMS(
            user.phone,
            `Your account is scheduled for deletion on ${purgeScheduledAt.toISOString().slice(0, 10)}. `
            + `To cancel, confirm with a verification code sent to this number.`,
        );
    }
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
        'Your account deletion request was cancelled.',
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

/**
 * Who asks, and with what. The person (`'self'`, from a session) passes the
 * step-up and recent-authentication gates; an administrator's call (`'admin'`)
 * is the app's to authorize, and is recorded as such on the request row.
 */
export type RequestAccountDeletionParams = (
    | {
        requestedBy: Extract<AccountDeletionRequestedBy, 'self'>;
        /** The credential the session came in with (`getAuth(c).credential`): admitted again under the account lock, and its key's step-up and recent-authentication windows are the ones asked. */
        credential: PrincipalCredential;
        /** The account password, for a session that did not prove a credential recently. */
        password?: string;
    }
    | { requestedBy: Extract<AccountDeletionRequestedBy, 'admin'> }
) & {
    reason?: string;
    /** Skip the grace period: purge as soon as the request commits. Self-service requires `deletion.allowSelfImmediate`. */
    immediate?: boolean;
};

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
 * Request account deletion (self-service, gated as every sensitive change is, or
 * a trusted admin/DSR call).
 *
 * Moves the account's deletion to `pending` and leaves its status — a suspended
 * account stays suspended — records the request, revokes every active
 * session key, and (after commit) emits `auth.deletion.requested` and sends the
 * request-received notice. With a zero grace period (explicit `immediate: true`,
 * gated for self-service by `allowSelfImmediate`), purges once the request commits instead of
 * waiting for the cron sweep.
 */
export async function requestAccountDeletionService(
    userId: number,
    params: RequestAccountDeletionParams,
): Promise<RequestAccountDeletionResult>
{
    const { requestedBy, immediate } = params;

    // The proof is checked before the account lock (the check hashes), and
    // confirmed under it with whether the account may be deleted, on the primary.
    const requester = await proveRequester(userId, params);

    const config = getDeletionConfig();
    const wantsImmediate = immediate === true;

    if (wantsImmediate && requestedBy === 'self' && !config.allowSelfImmediate)
    {
        throw new ImmediateDeletionNotAllowedError();
    }

    const gracePeriodDays = wantsImmediate ? 0 : config.gracePeriodDays;
    const record = (proven: ProvenRequester | null) => runInTransaction(
        () => recordDeletionRequest(userId, params, gracePeriodDays, proven),
        { context: 'auth:deletion-request' },
    );
    // A password hash that moved since it was verified makes the proof stale,
    // not wrong: verified again against what is stored now — outside the lock,
    // since verifying is the slow step — and the locked step runs once more.
    const request = await record(requester) ?? await record(await proveRequester(userId, params));
    if (!request)
    {
        throw new RecentAuthenticationRequiredError();
    }

    // After the commit, not inside it: the purge runs `onBeforePurge` — the
    // app's own I/O — before it opens its transaction, which must not happen
    // under this one's account lock. A purge that fails here is the sweep's to
    // retry: the request is due at once.
    if (gracePeriodDays === 0)
    {
        onAfterCommit(() => purgePendingRequest(request).then(() => undefined));
    }

    return { requestId: request.id, purgeScheduledAt: request.purgeScheduledAt };
}

/**
 * Refuse an account that is gone, or already on its way out.
 *
 * @throws NotFoundError, DeletionAlreadyRequestedError
 */
function assertDeletable(user: User | null): asserts user is User
{
    if (!user)
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    if (user.deletion !== null)
    {
        throw new DeletionAlreadyRequestedError();
    }
}

/**
 * Lock the account (`usersRepository.lockAccount`), read its deletion under the
 * lock, confirm a person's proof under it (`requesterStillProven`), and move
 * the deletion to `pending` from none — the deletion, the end of every session
 * and the request row in one transaction. The status is not written: whatever
 * an operator set holds.
 *
 * The deletion is read on the primary under the lock, so a replica that has
 * not caught up cannot refuse a request falsely, and a request that committed
 * meanwhile makes this one a duplicate.
 *
 * @returns null, with nothing written, when the password hash the proof was verified against moved
 */
async function recordDeletionRequest(
    userId: number,
    params: RequestAccountDeletionParams,
    gracePeriodDays: number,
    requester: ProvenRequester | null,
): Promise<AccountDeletionRequest | null>
{
    const user = await usersRepository.lockAccount(userId);
    assertDeletable(user);

    if (requester && !await requesterStillProven(user, requester))
    {
        return null;
    }

    // `setAccountDeletion` revokes the account's keys (their streams close after
    // commit) as part of moving it to `pending`.
    const moved = await setAccountDeletion(user.id, 'pending', {
        from: null,
        reason: 'Account deletion requested',
    });
    if (moved === 'refused')
    {
        throw new DeletionAlreadyRequestedError();
    }

    const requestedAt = new Date();
    const request = await createDeletionRequest({
        userId: user.id,
        userPublicId: user.publicId,
        requestedAt,
        purgeScheduledAt: addDays(requestedAt, gracePeriodDays),
        status: 'pending',
        requestedBy: params.requestedBy,
        reason: params.reason ?? null,
    });

    await endWaysBackIn(user.id);
    announceDeletionRequested(user, request);

    return request;
}

/**
 * The request row. A concurrent duplicate racing the partial unique index (one
 * pending row per user) surfaces as a raw Postgres unique-violation — converted
 * to the same typed 409 a sequential duplicate request gets.
 */
async function createDeletionRequest(
    data: Parameters<typeof accountDeletionRequestsRepository.create>[0],
): Promise<AccountDeletionRequest>
{
    return await accountDeletionRequestsRepository.create(data).catch((error: unknown) =>
        Promise.reject(isUniqueViolation(error) ? new DeletionAlreadyRequestedError() : error));
}

/** Every way a device could sign itself back in after the revocation. */
async function endWaysBackIn(userId: number): Promise<void>
{
    // Device-code requests the user had in flight are refused in the same breath.
    // An approved-but-uncollected one outlives the key revocation above, and the
    // poll that collects it registers a key created *after* this revoke-all — so
    // cancelling the deletion later would restore an account with a signing key
    // nothing in the deletion path ever saw.
    await deviceAuthorizationsRepository.denyAllActiveByUserId(userId);

    // Device links the account issued go with them, for the same reason: an
    // approved link nobody has collected would register a key after this.
    await deviceLinksRepository.expireAllLiveByUserId(userId);

    // A grant the user gave a CLI carries a refresh token, so a client holding
    // one signs itself back in within the hour — which is exactly the client a
    // global revocation is aimed at. Revoked alongside the device codes, and for
    // the reason they are.
    await revokeAllOAuth2GrantsForUser(userId);
}

/**
 * Deferred to after commit: event subscribers and the outbound email must not
 * observe (or be triggered by) a request that ultimately rolls back, and an
 * external I/O call (email provider) must not run while a DB transaction/row
 * lock is held.
 */
function announceDeletionRequested(user: User, request: AccountDeletionRequest): void
{
    onAfterCommit(() =>
        authDeletionRequestedEvent.emit({
            userId: String(user.id),
            userPublicId: user.publicId,
            purgeScheduledAt: request.purgeScheduledAt.toISOString(),
            requestedBy: request.requestedBy,
        }));
    onAfterCommit(() => notifyDeletionRequested(user, request.purgeScheduledAt));
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
 * time, so this is credential-based (no Bearer token) rather than auth-context-based
 * — the one door that lets a person whose deletion is pending act on the account.
 *
 * The credential is proved before the caller learns whether the account exists
 * or is pending deletion — otherwise this endpoint could be used to enumerate
 * accounts or probe deletion status without a valid credential, the same
 * posture `loginService` takes for missing accounts.
 *
 * Clears the account's deletion and nothing else: a cancelled deletion of a
 * suspended account leaves it suspended, whoever asked for the deletion.
 */
export async function cancelAccountDeletionService(
    params: CancelAccountDeletionParams,
): Promise<CancelAccountDeletionResult>
{
    const { email, phone } = params;

    if (!email && !phone)
    {
        throw new ValidationError({ message: 'Either email or phone must be provided' });
    }

    const claim = (holder: ProvenHolder) => runInTransaction(() => claimCancellation(holder), { context: 'auth:deletion-cancel' });
    const { user, proof } = await proveAccountHolder(await usersRepository.findByEmailOrPhone(email, phone), params);

    // A password hash that moved since it was verified (read on a replica, or
    // re-encoded by a sign-in) is verified again against the primary's, outside
    // the lock, and claimed once more.
    if (!await claim({ user, proof })
        && !await claim(await proveAccountHolder(await usersRepository.findByIdOnPrimary(user.id), params)))
    {
        throw new InvalidCredentialsError();
    }

    onAfterCommit(() =>
        authDeletionCancelledEvent.emit({
            userId: String(user.id),
            userPublicId: user.publicId,
        }));
    onAfterCommit(() => notifyDeletionCancelled(user));

    return { userId: String(user.id) };
}

/**
 * Spend the proof, claim the pending request, then clear the account's
 * deletion — one transaction, so a refusal at any step leaves all three as
 * they were.
 *
 * The account is locked first (`usersRepository.lockAccount`) and its deletion
 * read again under the lock, because the read cancel decided on was taken
 * before this ran. A password is confirmed here — the hash it was verified
 * against still the one stored — and a verification token is spent here,
 * conditionally, so it cancels once. The claim guarantees the purge did not win (claim-first: the
 * purge also locks the account, and whichever gets the lock first wins; the
 * loser sees a request already moved off `pending` and backs off). The
 * account's keys stay revoked: the person signs in anew.
 *
 * @throws DeletionNotRequestedError when the account's deletion is not pending
 *   or there is no pending request to claim; InvalidVerificationTokenError
 *   when the token was spent already
 * @returns false, with nothing written, when the password hash moved since it was verified
 */
async function claimCancellation({ user, proof }: ProvenHolder): Promise<boolean>
{
    const locked = await usersRepository.lockAccount(user.id);
    if (locked?.deletion !== 'pending')
    {
        throw new DeletionNotRequestedError();
    }

    if (proof.kind === 'password' && locked.passwordHash !== proof.verifiedHash)
    {
        return false;
    }

    if (proof.kind === 'token' && !await verificationCodesRepository.spendToken(proof.token.codeId, proof.token.target, 'account_deletion'))
    {
        throw new InvalidVerificationTokenError();
    }

    const pendingRequest = await accountDeletionRequestsRepository.findPendingByUserId(user.id);
    if (!pendingRequest || !await accountDeletionRequestsRepository.markCancelled(pendingRequest.id))
    {
        throw new DeletionNotRequestedError();
    }

    const moved = await setAccountDeletion(user.id, null, {
        from: 'pending',
        reason: 'Account deletion cancelled',
    });
    if (moved === 'refused')
    {
        throw new DeletionNotRequestedError();
    }

    return true;
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
 * integrity/audit. `deletion` -> 'deleted' (the status is left as it was),
 * `deletedAt`/`deletedBy` set (softDelete()).
 *
 * Must run inside the same transaction as the `markCompleted` claim (caller's
 * responsibility) — this function itself does not re-check pending status.
 */
async function anonymizeUser(user: User): Promise<void>
{
    // Conditional on `pending`, though the caller read it under the account
    // lock: the throw rolls the claim back.
    const moved = await setAccountDeletion(user.id, 'deleted', {
        from: 'pending',
        reason: 'Account deleted',
    });
    if (moved === 'refused')
    {
        throw new DeletionNotRequestedError();
    }

    await usersRepository.updateById(user.id, {
        email: `deleted-${user.publicId}@deleted.invalid`,
        phone: null,
        username: null,
        passwordHash: null,
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
    // How the person used the app goes with who they were: an app may keep
    // anything in a setting, and nothing reads it for an account nobody can be.
    await userSettingsRepository.deleteAllByUserId(user.id);
}

/**
 * Purge a single user for a given (already fetched) request row. Shared by the
 * immediate path (after the request commits), the standalone admin/DSR entry point, and the cron sweep.
 *
 * Ordering (deliberate — see PR review B1/M1/M2):
 * 1. A pre-check read on the primary, so a request already recovered before we
 *    got here skips the hook. On the primary because the immediate path runs it
 *    the moment the request commits: a replica one commit behind still reads
 *    the account `active` and would skip a purge that was asked for. A skip is
 *    logged with why.
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

    const precheckUser = await usersRepository.findByIdOnPrimary(userId);
    if (!precheckUser || precheckUser.deletion !== 'pending')
    {
        // Recovered (or otherwise gone) before we got here — no hook call, no
        // transaction, nothing to undo.
        authLogger.service.info('[account-deletion] purge skipped', {
            userId,
            reason: precheckUser ? `account deletion is ${precheckUser.deletion ?? 'none'}, not pending` : 'account not found',
        });

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
        // The account lock (`usersRepository.lockAccount`) first, and the status
        // read under it — the authoritative check. Closes the window between
        // findDueForPurge (replica)/the pre-check above and this transaction: a
        // cancel that committed in between must be honored.
        const user = await usersRepository.lockAccount(userId);
        if (!user || user.deletion !== 'pending')
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

        // Codes and account-exists notice windows have no userId FK (target-keyed)
        // — clean up regardless of strategy so neither lingers for a reused
        // email/phone.
        for (const target of [user.email, user.phone].filter((value): value is string => !!value))
        {
            await verificationCodesRepository.deleteByTarget(target);
            await accountExistsNoticesRepository.deleteByTarget(target);
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
