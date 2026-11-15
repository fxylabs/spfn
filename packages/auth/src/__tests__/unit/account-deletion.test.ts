/**
 * account-deletion.service.ts — status transitions, re-auth gate, immediate-deletion
 * gate, anonymize placeholder email, error/status-code consistency, and the
 * concurrency/ordering fixes from PR #11 review (issue #9):
 *
 * - B1: purge re-verifies pending status on the primary/tx connection immediately
 *   before destructive DML, and the `markCompleted` claim fails closed (0 rows) if
 *   the request was cancelled or already completed concurrently.
 * - m1: cancelAccountDeletionService verifies the credential before distinguishing
 *   "no such account" / "not pending" (account-enumeration posture).
 * - m2: a duplicate deletion request racing the partial unique index converts to
 *   DeletionAlreadyRequestedError (409) instead of a raw constraint-violation 500.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    usersRepository,
    keysRepository,
    passkeysRepository,
    deviceAuthorizationsRepository,
    deviceLinksRepository,
    socialAccountsRepository,
    userProfilesRepository,
    userSettingsRepository,
    verificationCodesRepository,
    accountDeletionRequestsRepository,
    verifyPassword,
    getDummyPasswordHash,
    validateVerificationToken,
    sendEmail,
    runInTransaction,
    revokeAllOAuth2GrantsForUser,
    setAccountStatus,
} = vi.hoisted(() => ({
    usersRepository: {
        findById: vi.fn(),
        // The account as of its lock: whatever `findById` is set to answer,
        // unless a test makes the two reads disagree.
        lockAccount: vi.fn(),
        // The purge's pre-check reads the primary: the same answer as `findById`.
        findByIdOnPrimary: vi.fn(),
        findByEmailOrPhone: vi.fn(),
        updateById: vi.fn(async (_id: number, _data: Record<string, unknown>): Promise<unknown> => undefined),
        deleteById: vi.fn(async () => undefined),
    },
    keysRepository: {
        revokeAllActiveByUserId: vi.fn(async () => []),
        deleteAllByUserId: vi.fn(async () => 0),
    },
    passkeysRepository: {
        deleteAllByUserId: vi.fn(async () => 0),
    },
    deviceAuthorizationsRepository: {
        denyAllActiveByUserId: vi.fn(async () => []),
    },
    deviceLinksRepository: {
        expireAllLiveByUserId: vi.fn(async () => []),
    },
    socialAccountsRepository: {
        deleteAllByUserId: vi.fn(async () => 0),
    },
    userProfilesRepository: {
        updateByUserId: vi.fn(async () => undefined),
    },
    userSettingsRepository: {
        deleteAllByUserId: vi.fn(async () => undefined),
    },
    verificationCodesRepository: {
        deleteByTarget: vi.fn(async () => 0),
    },
    accountDeletionRequestsRepository: {
        create: vi.fn(),
        findPendingByUserId: vi.fn(),
        findPendingByUserIdOnPrimary: vi.fn(),
        findDueForPurge: vi.fn(async (): Promise<Array<{ id: number; userId: number; userPublicId: string }>> => []),
        markCancelled: vi.fn(),
        markCompleted: vi.fn(),
    },
    verifyPassword: vi.fn(async () => true),
    getDummyPasswordHash: vi.fn(async () => '$2b$12$dummydummydummydummydummydummydummydummydummydummydu'),
    validateVerificationToken: vi.fn(),
    sendEmail: vi.fn(async () => ({ success: true })),
    runInTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    revokeAllOAuth2GrantsForUser: vi.fn(async () => undefined),
    // The one writer of users.status: it writes the status and, for every
    // status but active, revokes every key in the same transaction.
    setAccountStatus: vi.fn(async (_id: number, _status: string, _transition: { from: string; reason: string }): Promise<'changed' | 'refused'> => 'changed'),
}));

vi.mock('../../server/repositories', () => ({
    usersRepository,
    keysRepository,
    passkeysRepository,
    deviceAuthorizationsRepository,
    deviceLinksRepository,
    socialAccountsRepository,
    userProfilesRepository,
    userSettingsRepository,
    verificationCodesRepository,
    accountDeletionRequestsRepository,
}));

vi.mock('../../server/helpers', () => ({ verifyPassword, getDummyPasswordHash }));
vi.mock('../../server/services/verification.service', () => ({ validateVerificationToken }));
vi.mock('../../server/services/oauth2-grant.service', () => ({ revokeAllOAuth2GrantsForUser }));
vi.mock('../../server/services/user.service', () => ({ setAccountStatus }));
vi.mock('@spfn/notification/server', () => ({ sendEmail }));
vi.mock('@spfn/core/db', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/core/db')>();

    return { ...actual, runInTransaction };
});

import {
    requestAccountDeletionService,
    cancelAccountDeletionService,
    purgeUserService,
    sweepDuePurges,
    getPendingDeletionInfo,
    purgePendingRequest,
} from '../../server/services/account-deletion.service';
import { configureDeletion } from '../../server/lib/deletion-config';
// Imported the same way account-deletion.service.ts imports them (package
// specifier, not the relative source path) — otherwise this resolves a second,
// distinct module instance and `instanceof` fails even for the "same" class.
import {
    AccountPendingDeletionError,
    AccountDisabledError,
    DeletionAlreadyRequestedError,
    DeletionNotRequestedError,
    ImmediateDeletionNotAllowedError,
    InvalidCredentialsError,
} from '@spfn/auth/errors';

function makeUser(overrides: Record<string, unknown> = {})
{
    return {
        id: 7,
        publicId: '11111111-1111-1111-1111-111111111111',
        email: 'user@example.com',
        phone: null,
        username: 'someone',
        passwordHash: '$2b$12$hash',
        status: 'active',
        ...overrides,
    };
}

/** A successful conditional-claim/cancel result — the repo returns the updated row. */
function claimedRow(overrides: Record<string, unknown> = {})
{
    return { id: 5, status: 'completed', ...overrides };
}

describe('account-deletion.service', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        usersRepository.lockAccount.mockReset();
        usersRepository.lockAccount.mockImplementation((id: number) => usersRepository.findById(id));
        usersRepository.findByIdOnPrimary.mockImplementation((id: number) => usersRepository.findById(id));
        configureDeletion(); // reset to defaults between tests
        accountDeletionRequestsRepository.create.mockImplementation(async (data: any) => ({ id: 99, ...data }));
        // Default: conditional claim/cancel succeeds (repo returns the updated row).
        // Individual tests override this to simulate the "0 rows matched" race.
        accountDeletionRequestsRepository.markCompleted.mockResolvedValue(claimedRow());
        accountDeletionRequestsRepository.markCancelled.mockResolvedValue(claimedRow({ status: 'cancelled' }));
    });

    describe('requestAccountDeletionService — self, password re-auth', () =>
    {
        it('transitions status, records the request, and revokes sessions', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            const result = await requestAccountDeletionService(user.id, {
                requestedBy: 'self',
                password: 'correct-password',
            });

            expect(verifyPassword).toHaveBeenCalledWith('correct-password', user.passwordHash);
            expect(setAccountStatus).toHaveBeenCalledWith(user.id, 'pending_deletion', { from: 'active', reason: expect.any(String) });
            expect(accountDeletionRequestsRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ userId: user.id, userPublicId: user.publicId, status: 'pending' }),
            );
            // The keys are revoked by setAccountStatus, with the status, not beside it.
            expect(keysRepository.revokeAllActiveByUserId).not.toHaveBeenCalled();

            // Device-code requests in flight go with them. One that was already
            // approved outlives the key revocation, and the poll that collects it
            // registers a key created after this point — so cancelling the
            // deletion later would restore an account holding a signing
            // credential the deletion path never saw.
            expect(deviceAuthorizationsRepository.denyAllActiveByUserId).toHaveBeenCalledWith(user.id);

            // And the OAuth grants, for the same reason one step further out: a
            // grant carries a refresh token, so a CLI holding one would sign
            // itself back in during the grace period.
            expect(revokeAllOAuth2GrantsForUser).toHaveBeenCalledWith(user.id);

            expect(result.requestId).toBe(99);

            // Default grace period is 30 days.
            const diffDays = (result.purgeScheduledAt.getTime() - Date.now()) / 86_400_000;
            expect(diffDays).toBeGreaterThan(29);
            expect(diffDays).toBeLessThan(31);

            // Event + notification are deferred via onAfterCommit — outside a real
            // transaction that runs immediately (see @spfn/core/db docs), so still
            // observable synchronously-ish here; this asserts the wiring fires at all.
            await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled());
        });

        it('rejects an incorrect password without transitioning status', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);
            verifyPassword.mockResolvedValueOnce(false);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', password: 'wrong' }),
            ).rejects.toBeInstanceOf(InvalidCredentialsError);

            expect(usersRepository.updateById).not.toHaveBeenCalled();
        });
    });

    describe('requestAccountDeletionService — self, verification-code re-auth (passwordless)', () =>
    {
        it('accepts a valid account_deletion-purpose token matching the user target', async () =>
        {
            const user = makeUser({ passwordHash: null });
            usersRepository.findById.mockResolvedValue(user);
            validateVerificationToken.mockReturnValue({
                target: user.email,
                targetType: 'email',
                purpose: 'account_deletion',
                codeId: 1,
            });

            await requestAccountDeletionService(user.id, {
                requestedBy: 'self',
                verificationToken: 'tok',
            });

            expect(setAccountStatus).toHaveBeenCalledWith(user.id, 'pending_deletion', { from: 'active', reason: expect.any(String) });
        });

        it('rejects a token issued for a different purpose', async () =>
        {
            const user = makeUser({ passwordHash: null });
            usersRepository.findById.mockResolvedValue(user);
            validateVerificationToken.mockReturnValue({
                target: user.email,
                targetType: 'email',
                purpose: 'password_reset',
                codeId: 1,
            });

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', verificationToken: 'tok' }),
            ).rejects.toThrow(/account_deletion/);
        });

        it('requires a password or verification token', async () =>
        {
            const user = makeUser({ passwordHash: null });
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self' }),
            ).rejects.toThrow(/verification code is required/i);
        });
    });

    describe('requestAccountDeletionService — duplicate request / admin / immediate gate', () =>
    {
        it('rejects a second request while one is already pending_deletion', async () =>
        {
            const user = makeUser({ status: 'pending_deletion' });
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', password: 'x' }),
            ).rejects.toBeInstanceOf(DeletionAlreadyRequestedError);
        });

        it('N-2: decides on the status read under the account lock, not on a lagging read before it', async () =>
        {
            // The replica still shows the deletion this account just cancelled;
            // the primary, read under the lock, has it active again.
            const user = makeUser();
            usersRepository.findById.mockResolvedValue({ ...user, status: 'pending_deletion' });
            usersRepository.lockAccount.mockResolvedValue(user);

            await requestAccountDeletionService(user.id, { requestedBy: 'admin' });

            expect(setAccountStatus).toHaveBeenCalledWith(user.id, 'pending_deletion', { from: 'active', reason: expect.any(String) });
            expect(usersRepository.lockAccount.mock.invocationCallOrder[0])
                .toBeLessThan(setAccountStatus.mock.invocationCallOrder[0]!);
        });

        it('rejects a request for an already-deleted account', async () =>
        {
            const user = makeUser({ status: 'deleted' });
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'admin' }),
            ).rejects.toBeInstanceOf(DeletionAlreadyRequestedError);
        });

        it('admin requests skip the self re-auth gate', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            await requestAccountDeletionService(user.id, { requestedBy: 'admin' });

            expect(verifyPassword).not.toHaveBeenCalled();
            expect(setAccountStatus).toHaveBeenCalledWith(user.id, 'pending_deletion', { from: 'active', reason: expect.any(String) });
        });

        it('rejects self-service immediate deletion unless allowSelfImmediate is enabled', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', password: 'x', immediate: true }),
            ).rejects.toBeInstanceOf(ImmediateDeletionNotAllowedError);
        });

        it('allows self-service immediate deletion once allowSelfImmediate is enabled, and purges once the request commits', async () =>
        {
            configureDeletion({ allowSelfImmediate: true });
            // A mutable fixture: purgePendingRequest's own re-checks (B1) require
            // status='pending_deletion' by the time it re-reads the user, so the
            // mock must reflect the status transition requestAccountDeletionService
            // itself performs — a static fixture stuck at 'active' would (correctly)
            // make the purge's re-check abort.
            let currentUser = makeUser();
            usersRepository.findById.mockImplementation(async () => currentUser);
            setAccountStatus.mockImplementation(async (_id: number, status: string) =>
            {
                currentUser = { ...currentUser, status };

                return 'changed';
            });
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue(null);

            const result = await requestAccountDeletionService(currentUser.id, {
                requestedBy: 'self',
                password: 'x',
                immediate: true,
            });

            // grace period 0 -> purgeScheduledAt ~= now, and the purge ran after
            // the commit (at once here, with no transaction around the call),
            // never under the request's account lock: `onBeforePurge` is app I/O.
            expect(Math.abs(result.purgeScheduledAt.getTime() - Date.now())).toBeLessThan(5000);
            await vi.waitFor(() => expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalled());
            expect(currentUser.status).toBe('deleted');
        });

        it('m2: converts a concurrent duplicate-request unique-violation into DeletionAlreadyRequestedError (409)', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            const pgUniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), {
                code: '23505',
            });
            accountDeletionRequestsRepository.create.mockRejectedValueOnce(pgUniqueViolation);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', password: 'x' }),
            ).rejects.toBeInstanceOf(DeletionAlreadyRequestedError);
        });

        it('re-throws a non-unique-violation error from create() unchanged', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            const otherError = new Error('connection reset');
            accountDeletionRequestsRepository.create.mockRejectedValueOnce(otherError);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', password: 'x' }),
            ).rejects.toBe(otherError);
        });
    });

    describe('cancelAccountDeletionService', () =>
    {
        it('recovers a pending_deletion account back to active, claiming the request row before touching users', async () =>
        {
            const user = makeUser({ status: 'pending_deletion' });
            usersRepository.findByEmailOrPhone.mockResolvedValue(user);
            usersRepository.findById.mockResolvedValue(user);
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });

            await cancelAccountDeletionService({ email: user.email, password: 'correct-password' });

            expect(accountDeletionRequestsRepository.markCancelled).toHaveBeenCalledWith(5);
            expect(setAccountStatus).toHaveBeenCalledWith(user.id, 'active', { from: 'pending_deletion', reason: expect.any(String) });
            // The status changes through the one writer, never a column update.
            expect(usersRepository.updateById).not.toHaveBeenCalled();

            // The account lock first, then the claim (request row), then the users
            // reactivation — the purge takes the same lock first.
            expect(usersRepository.lockAccount.mock.invocationCallOrder[0])
                .toBeLessThan(accountDeletionRequestsRepository.findPendingByUserId.mock.invocationCallOrder[0]!);
            const claimOrder = accountDeletionRequestsRepository.markCancelled.mock.invocationCallOrder[0];
            const reactivateOrder = setAccountStatus.mock.invocationCallOrder[0];
            expect(claimOrder).toBeLessThan(reactivateOrder);
        });

        it('reactivates only from pending_deletion read under the account lock: a status another writer committed after cancel read the account is kept, and nothing is claimed', async () =>
        {
            // Cancel read `pending_deletion`; an operator's suspension committed
            // before the cancel took the account lock, which reads it.
            const user = makeUser({ status: 'pending_deletion' });
            usersRepository.findByEmailOrPhone.mockResolvedValue(user);
            usersRepository.lockAccount.mockResolvedValue({ ...user, status: 'suspended' });
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(DeletionNotRequestedError);

            expect(accountDeletionRequestsRepository.markCancelled).not.toHaveBeenCalled();
            expect(setAccountStatus).not.toHaveBeenCalled();
        });

        it('a refused reactivation throws inside the claim\'s transaction, so the claim is rolled back with it', async () =>
        {
            const user = makeUser({ status: 'pending_deletion' });
            usersRepository.findByEmailOrPhone.mockResolvedValue(user);
            usersRepository.findById.mockResolvedValue(user);
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });
            setAccountStatus.mockResolvedValueOnce('refused');

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(DeletionNotRequestedError);

            const cancelTransaction = runInTransaction.mock.invocationCallOrder[0];
            expect(cancelTransaction).toBeLessThan(accountDeletionRequestsRepository.markCancelled.mock.invocationCallOrder[0]!);
        });

        it('rejects when the account has no pending deletion request (after verifying the credential)', async () =>
        {
            const user = makeUser({ status: 'active' });
            usersRepository.findByEmailOrPhone.mockResolvedValue(user);

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(DeletionNotRequestedError);
            expect(verifyPassword).toHaveBeenCalledWith('correct-password', user.passwordHash);
        });

        it('B1 (cancel side): when the purge already won the race and claimed the request row, cancel throws DeletionNotRequestedError and never reactivates the (already-purged) user', async () =>
        {
            // The user row has already been anonymized by a purge that committed
            // between our credential check and this claim attempt — status is
            // 'deleted' here purely to prove the reactivation is never
            // even called; the real defense is the request-row claim below.
            const user = makeUser({ status: 'pending_deletion' });
            usersRepository.findByEmailOrPhone.mockResolvedValue(user);
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });
            // The conditional UPDATE (WHERE status='pending') matches 0 rows because
            // the purge's own claim already flipped this row to 'completed'.
            accountDeletionRequestsRepository.markCancelled.mockResolvedValue(null);

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(DeletionNotRequestedError);

            expect(setAccountStatus).not.toHaveBeenCalled();
            expect(usersRepository.updateById).not.toHaveBeenCalled();
        });

        it('m1: a wrong credential on a non-pending account fails with InvalidCredentialsError, not DeletionNotRequestedError', async () =>
        {
            const user = makeUser({ status: 'active' });
            usersRepository.findByEmailOrPhone.mockResolvedValue(user);
            verifyPassword.mockResolvedValueOnce(false);

            // Credential is checked before the "not pending" branch is allowed to
            // distinguish itself — a bad guess must look the same whether or not
            // the account is actually pending deletion (account-enumeration guard).
            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'wrong' }),
            ).rejects.toBeInstanceOf(InvalidCredentialsError);
        });

        it('does not distinguish a missing account from a bad credential, and equalizes timing via the dummy hash', async () =>
        {
            usersRepository.findByEmailOrPhone.mockResolvedValue(null);

            await expect(
                cancelAccountDeletionService({ email: 'nope@example.com', password: 'x' }),
            ).rejects.toBeInstanceOf(InvalidCredentialsError);

            expect(getDummyPasswordHash).toHaveBeenCalled();
            expect(verifyPassword).toHaveBeenCalledWith('x', await getDummyPasswordHash());
        });
    });

    describe('getPendingDeletionInfo', () =>
    {
        it('reads from the write primary, not a replica (m4)', async () =>
        {
            const purgeScheduledAt = new Date('2030-06-01T00:00:00.000Z');
            accountDeletionRequestsRepository.findPendingByUserIdOnPrimary.mockResolvedValue({ purgeScheduledAt });

            const result = await getPendingDeletionInfo(42);

            expect(accountDeletionRequestsRepository.findPendingByUserIdOnPrimary).toHaveBeenCalledWith(42);
            expect(accountDeletionRequestsRepository.findPendingByUserId).not.toHaveBeenCalled();
            expect(result).toEqual({ purgeScheduledAt });
        });
    });

    describe('purge — anonymize placeholder + status transitions', () =>
    {
        it('anonymizes the user with a deleted-invalid placeholder address and scrubs child rows', async () =>
        {
            const user = makeUser({ status: 'pending_deletion' });
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({
                id: 5,
                userId: user.id,
                userPublicId: user.publicId,
            });
            usersRepository.findById.mockResolvedValue(user);

            const result = await purgeUserService(user.id);

            expect(result.outcome).toBe('purged');
            expect(usersRepository.updateById).toHaveBeenCalledWith(
                user.id,
                expect.objectContaining({
                    email: `deleted-${user.publicId}@deleted.invalid`,
                    phone: null,
                    username: null,
                    passwordHash: null,
                }),
            );
            expect(setAccountStatus).toHaveBeenCalledWith(user.id, 'deleted', { from: 'pending_deletion', reason: expect.any(String) });
            expect(socialAccountsRepository.deleteAllByUserId).toHaveBeenCalledWith(user.id);
            expect(keysRepository.deleteAllByUserId).toHaveBeenCalledWith(user.id);
            // Passkeys go with the other credentials — an anonymized row must
            // not keep one that still names this account to an authenticator.
            expect(passkeysRepository.deleteAllByUserId).toHaveBeenCalledWith(user.id);
            // Settings go with the profile fields the anonymization clears (#161).
            expect(userSettingsRepository.deleteAllByUserId).toHaveBeenCalledWith(user.id);
            expect(verificationCodesRepository.deleteByTarget).toHaveBeenCalledWith(user.email);
            expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalledWith(5, 'anonymize');
        });

        it('hard-deletes the row instead when purgeStrategy is hard-delete', async () =>
        {
            configureDeletion({ purgeStrategy: 'hard-delete' });
            const user = makeUser({ status: 'pending_deletion' });
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5, userId: user.id });
            usersRepository.findById.mockResolvedValue(user);

            await purgeUserService(user.id);

            expect(usersRepository.deleteById).toHaveBeenCalledWith(user.id);
            expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalledWith(5, 'hard-delete');
        });

        it('throws when there is no pending request to purge', async () =>
        {
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue(null);

            await expect(purgeUserService(123)).rejects.toBeInstanceOf(DeletionNotRequestedError);
        });

        it('skips (does not complete) a user whose onBeforePurge hook throws, and the sweep continues', async () =>
        {
            const failing = makeUser({ id: 1, status: 'pending_deletion' });
            const ok = makeUser({ id: 2, publicId: '22222222-2222-2222-2222-222222222222', status: 'pending_deletion' });

            configureDeletion({
                onBeforePurge: async (u) =>
                {
                    if (u.id === 1)
                    {
                        throw new Error('app data cleanup failed');
                    }
                },
            });

            accountDeletionRequestsRepository.findDueForPurge.mockResolvedValue([
                { id: 10, userId: 1, userPublicId: failing.publicId },
                { id: 11, userId: 2, userPublicId: ok.publicId },
            ]);
            usersRepository.findById.mockImplementation(async (id: number) => (id === 1 ? failing : ok));

            const result = await sweepDuePurges();

            expect(result).toEqual({ processed: 2, purged: 1, skipped: 1 });
            expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalledTimes(1);
            expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalledWith(11, 'anonymize');
        });
    });

    describe('B1 — purge re-verifies pending status before destructive DML', () =>
    {
        it('pre-check gate: aborts (no destructive DML, no onBeforePurge call) when the user is already recovered before any DB transaction opens', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue({ ...user, status: 'active' });
            const onBeforePurge = vi.fn();
            configureDeletion({ onBeforePurge });

            const result = await purgePendingRequest({ id: 5, userId: user.id, userPublicId: user.publicId } as any);

            expect(result.outcome).toBe('skipped');
            expect(onBeforePurge).not.toHaveBeenCalled();
            expect(usersRepository.updateById).not.toHaveBeenCalled();
            expect(usersRepository.deleteById).not.toHaveBeenCalled();
            expect(socialAccountsRepository.deleteAllByUserId).not.toHaveBeenCalled();
            expect(accountDeletionRequestsRepository.markCompleted).not.toHaveBeenCalled();
        });

        it('cancel-during-sweep: the primary/tx re-check (not the earlier pre-check) catches a recovery that committed in between, before any destructive DML', async () =>
        {
            const user = makeUser({ status: 'pending_deletion' });
            const recovered = { ...user, status: 'active' };

            // First call = the pre-check (before onBeforePurge/tx) — still pending,
            // so the hook runs and the transaction opens. Every call after that
            // (the transaction's own re-read) sees the concurrent recovery.
            usersRepository.findById.mockResolvedValueOnce(user).mockResolvedValue(recovered);

            const result = await purgePendingRequest({ id: 5, userId: user.id, userPublicId: user.publicId } as any);

            expect(result.outcome).toBe('skipped');
            expect(usersRepository.updateById).not.toHaveBeenCalled();
            expect(usersRepository.deleteById).not.toHaveBeenCalled();
            expect(socialAccountsRepository.deleteAllByUserId).not.toHaveBeenCalled();
            expect(accountDeletionRequestsRepository.markCompleted).not.toHaveBeenCalled();
        });

        it('aborts via the conditional markCompleted claim when the request row was already moved off "pending" concurrently', async () =>
        {
            const user = makeUser({ status: 'pending_deletion' });
            usersRepository.findById.mockResolvedValue(user);
            // Simulates the conditional UPDATE matching 0 rows (WHERE status='pending')
            // — e.g. a cancel committed between our primary re-read and this claim.
            accountDeletionRequestsRepository.markCompleted.mockResolvedValue(null);

            const result = await purgePendingRequest({ id: 5, userId: user.id, userPublicId: user.publicId } as any);

            expect(result.outcome).toBe('skipped');
            // The claim was attempted (and rejected) — but no destructive DML followed.
            expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalledWith(5, 'anonymize');
            expect(usersRepository.updateById).not.toHaveBeenCalled();
            expect(usersRepository.deleteById).not.toHaveBeenCalled();
            expect(socialAccountsRepository.deleteAllByUserId).not.toHaveBeenCalled();
        });

        it('sweepDuePurges: a cancelled-mid-sweep request is not purged and is not overwritten back to completed', async () =>
        {
            const cancelledUser = makeUser({ id: 50, status: 'active' }); // recovered before we processed it
            const okUser = makeUser({ id: 51, publicId: '33333333-3333-3333-3333-333333333333' });

            accountDeletionRequestsRepository.findDueForPurge.mockResolvedValue([
                { id: 20, userId: cancelledUser.id, userPublicId: cancelledUser.publicId },
                { id: 21, userId: okUser.id, userPublicId: okUser.publicId },
            ]);
            usersRepository.findById.mockImplementation(async (id: number) =>
                (id === cancelledUser.id ? cancelledUser : { ...okUser, status: 'pending_deletion' }));

            const result = await sweepDuePurges();

            expect(result).toEqual({ processed: 2, purged: 1, skipped: 1 });
            expect(accountDeletionRequestsRepository.markCompleted).not.toHaveBeenCalledWith(20, expect.anything());
            expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalledWith(21, 'anonymize');
        });
    });

    describe('error/status-code consistency', () =>
    {
        it('AccountPendingDeletionError matches AccountDisabledError\'s status code (403)', async () =>
        {
            const disabled = new AccountDisabledError({ status: 'suspended' });
            const pending = new AccountPendingDeletionError({ purgeScheduledAt: new Date().toISOString() });

            expect(pending.statusCode).toBe(disabled.statusCode);
            expect(pending.statusCode).toBe(403);
            expect(pending.details).toMatchObject({ status: 'pending_deletion' });
        });
    });
});
