/**
 * account-deletion.service.ts — deletion transitions, request gates, immediate-deletion
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
    accountExistsNoticesRepository,
    accountDeletionRequestsRepository,
    verifyPassword,
    getDummyPasswordHash,
    validateVerificationToken,
    runInTransaction,
    revokeAllOAuth2GrantsForUser,
    setAccountDeletion,
    assertStepUp,
    proveRecentAuthentication,
    recentAuthenticationHolds,
    admitCompletion,
} = vi.hoisted(() => ({
    usersRepository: {
        findById: vi.fn(),
        // The account as of its lock: whatever `findById` is set to answer,
        // unless a test makes the two reads disagree.
        lockAccount: vi.fn(),
        // The purge's pre-check reads the primary: the same answer as `findById`.
        findByIdOnPrimary: vi.fn(),
        findByEmailOrPhoneOnPrimary: vi.fn(),
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
    accountExistsNoticesRepository: {
        deleteByTarget: vi.fn(async () => undefined),
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
    runInTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    revokeAllOAuth2GrantsForUser: vi.fn(async () => undefined),
    // The one writer of users.deletion: it writes the deletion and, entering
    // one, revokes every key in the same transaction.
    setAccountDeletion: vi.fn(async (_id: number, _deletion: string | null, _transition: { from: string | null; reason: string }): Promise<'changed' | 'refused'> => 'changed'),
    // The gates every sensitive change passes; each a no-op answer here unless a test refuses it.
    assertStepUp: vi.fn(async (_params: { userId: number; credential: unknown }) => undefined),
    proveRecentAuthentication: vi.fn(async (_params: { userId: number; credential: unknown; currentPassword?: string }, _windowMs?: number): Promise<{ by: 'key' } | { by: 'password'; verifiedHash: string }> => ({ by: 'key' })),
    // The same proof, confirmed under the account lock: it holds unless a test says otherwise.
    recentAuthenticationHolds: vi.fn(async (): Promise<boolean> => true),
    // The session re-admitted under the account lock: admitted unless a test says otherwise.
    admitCompletion: vi.fn(async (_params: unknown): Promise<{ admitted: object } | { refused: { reason: string } }> => ({ admitted: {} })),
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
    accountExistsNoticesRepository,
    accountDeletionRequestsRepository,
}));

vi.mock('../../server/helpers', async (importOriginal) => ({
    normalizeEmail: (await importOriginal<typeof import('../../server/helpers')>()).normalizeEmail,
    verifyPassword,
    getDummyPasswordHash,
}));
vi.mock('../../server/services/verification.service', () => ({ validateVerificationToken }));
vi.mock('../../server/services/oauth2-grant.service', () => ({ revokeAllOAuth2GrantsForUser }));
vi.mock('../../server/services/user.service', () => ({ setAccountDeletion }));
vi.mock('../../server/services/mfa.service', () => ({ assertStepUp }));
vi.mock('../../server/services/passkey.service', () => ({ proveRecentAuthentication, recentAuthenticationHolds }));
vi.mock('../../server/services/admission.service', async importOriginal => ({
    ...await importOriginal<typeof import('../../server/services/admission.service')>(),
    admitCompletion,
    admissionRefusalError: (refusal: { reason: string }) => new Error(refusal.reason),
}));
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
import { __resetDeletionForTests, configureDeletion } from '../../server/lib/deletion-config';
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
    RecentAuthenticationRequiredError,
} from '@spfn/auth/errors';

/** The session a self-service request comes in with. */
const KEY_1 = { kind: 'deviceKey', keyId: 'key-1' } as const;

function makeUser(overrides: Record<string, unknown> = {})
{
    return {
        id: 7,
        publicId: '11111111-1111-1111-1111-111111111111',
        email: 'user@example.com',
        phone: null,
        username: 'someone',
        passwordHash: '$2b$12$hash',
        keyEpoch: 0,
        status: 'active',
        deletion: null as string | null,
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
        __resetDeletionForTests();
        accountDeletionRequestsRepository.create.mockImplementation(async (data: any) => ({ id: 99, ...data }));
        // Default: conditional claim/cancel succeeds (repo returns the updated row).
        // Individual tests override this to simulate the "0 rows matched" race.
        accountDeletionRequestsRepository.markCompleted.mockResolvedValue(claimedRow());
        accountDeletionRequestsRepository.markCancelled.mockResolvedValue(claimedRow({ status: 'cancelled' }));
    });

    describe('requestAccountDeletionService — self, step-up and recent authentication', () =>
    {
        it('moves the deletion, records the request, and revokes sessions', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            const result = await requestAccountDeletionService(user.id, {
                requestedBy: 'self',
                credential: KEY_1,
                password: 'correct-password',
            });

            expect(assertStepUp).toHaveBeenCalledWith({ userId: user.id, credential: KEY_1 });
            // Under the lock, the session is asked of the admission again, for this route.
            expect(admitCompletion).toHaveBeenCalledWith({
                userId: user.id,
                credential: KEY_1,
                enrolment: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
            });
            expect(proveRecentAuthentication).toHaveBeenCalledWith(
                { userId: user.id, credential: KEY_1, currentPassword: 'correct-password' },
                expect.any(Number),
            );
            expect(setAccountDeletion).toHaveBeenCalledWith(user.id, 'pending', { from: null, reason: expect.any(String) });
            expect(accountDeletionRequestsRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ userId: user.id, userPublicId: user.publicId, status: 'pending' }),
            );
            // The keys are revoked by setAccountDeletion, with the deletion, not beside it.
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
        });

        it('a refused recent authentication moves nothing', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);
            proveRecentAuthentication.mockRejectedValueOnce(new RecentAuthenticationRequiredError());

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', credential: KEY_1, password: 'wrong' }),
            ).rejects.toBeInstanceOf(RecentAuthenticationRequiredError);

            expect(setAccountDeletion).not.toHaveBeenCalled();
            expect(accountDeletionRequestsRepository.create).not.toHaveBeenCalled();
        });
    });

    describe('requestAccountDeletionService — the proof confirmed under the account lock', () =>
    {
        it('a password hash that moved since it was verified is verified again outside the lock, and the request runs once more', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);
            recentAuthenticationHolds.mockResolvedValueOnce(false);

            await requestAccountDeletionService(user.id, { requestedBy: 'self', credential: KEY_1, password: 'correct-password' });

            expect(proveRecentAuthentication).toHaveBeenCalledTimes(2);
            expect(usersRepository.lockAccount).toHaveBeenCalledTimes(2);
            expect(setAccountDeletion).toHaveBeenCalledTimes(1);
            expect(accountDeletionRequestsRepository.create).toHaveBeenCalledTimes(1);
        });

        it('a hash that moves again is refused, with nothing moved', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);
            recentAuthenticationHolds.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', credential: KEY_1, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(RecentAuthenticationRequiredError);

            expect(setAccountDeletion).not.toHaveBeenCalled();
            expect(accountDeletionRequestsRepository.create).not.toHaveBeenCalled();
        });
    });

    describe('requestAccountDeletionService — duplicate request / admin / immediate gate', () =>
    {
        it('rejects a second request while one is already pending', async () =>
        {
            const user = makeUser({ deletion: 'pending' });
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', credential: KEY_1, password: 'x' }),
            ).rejects.toBeInstanceOf(DeletionAlreadyRequestedError);
        });

        it('N-2: decides on the deletion read under the account lock, not on a lagging read before it', async () =>
        {
            // The replica still shows the deletion this account just cancelled;
            // the primary, read under the lock, has none.
            const user = makeUser();
            usersRepository.findById.mockResolvedValue({ ...user, deletion: 'pending' });
            usersRepository.lockAccount.mockResolvedValue(user);

            await requestAccountDeletionService(user.id, { requestedBy: 'admin' });

            expect(setAccountDeletion).toHaveBeenCalledWith(user.id, 'pending', { from: null, reason: expect.any(String) });
            expect(usersRepository.lockAccount.mock.invocationCallOrder[0])
                .toBeLessThan(setAccountDeletion.mock.invocationCallOrder[0]!);
        });

        it('rejects a request for an already-deleted account', async () =>
        {
            const user = makeUser({ deletion: 'deleted' });
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'admin' }),
            ).rejects.toBeInstanceOf(DeletionAlreadyRequestedError);
        });

        it('admin requests skip the self gates', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            await requestAccountDeletionService(user.id, { requestedBy: 'admin' });

            expect(assertStepUp).not.toHaveBeenCalled();
            expect(proveRecentAuthentication).not.toHaveBeenCalled();
            expect(setAccountDeletion).toHaveBeenCalledWith(user.id, 'pending', { from: null, reason: expect.any(String) });
        });

        it('rejects self-service immediate deletion unless allowSelfImmediate is enabled', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', credential: KEY_1, password: 'x', immediate: true }),
            ).rejects.toBeInstanceOf(ImmediateDeletionNotAllowedError);
        });

        it('allows self-service immediate deletion once allowSelfImmediate is enabled, and purges once the request commits', async () =>
        {
            configureDeletion({ allowSelfImmediate: true });
            // A mutable fixture: purgePendingRequest's own re-checks (B1) require
            // deletion='pending' by the time it re-reads the user, so the mock must
            // reflect the transition requestAccountDeletionService itself performs —
            // a static fixture with no deletion would (correctly) make the purge's
            // re-check abort.
            let currentUser = makeUser();
            usersRepository.findById.mockImplementation(async () => currentUser);
            setAccountDeletion.mockImplementation(async (_id: number, deletion: string | null) =>
            {
                currentUser = { ...currentUser, deletion };

                return 'changed';
            });
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue(null);

            const result = await requestAccountDeletionService(currentUser.id, {
                requestedBy: 'self',
                credential: KEY_1,
                password: 'x',
                immediate: true,
            });

            // grace period 0 -> purgeScheduledAt ~= now, and the purge ran after
            // the commit (at once here, with no transaction around the call),
            // never under the request's account lock: `onBeforePurge` is app I/O.
            expect(Math.abs(result.purgeScheduledAt.getTime() - Date.now())).toBeLessThan(5000);
            await vi.waitFor(() => expect(accountDeletionRequestsRepository.markCompleted).toHaveBeenCalled());
            expect(currentUser.deletion).toBe('deleted');
            expect(currentUser.status).toBe('active');
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
                requestAccountDeletionService(user.id, { requestedBy: 'self', credential: KEY_1, password: 'x' }),
            ).rejects.toBeInstanceOf(DeletionAlreadyRequestedError);
        });

        it('re-throws a non-unique-violation error from create() unchanged', async () =>
        {
            const user = makeUser();
            usersRepository.findById.mockResolvedValue(user);

            const otherError = new Error('connection reset');
            accountDeletionRequestsRepository.create.mockRejectedValueOnce(otherError);

            await expect(
                requestAccountDeletionService(user.id, { requestedBy: 'self', credential: KEY_1, password: 'x' }),
            ).rejects.toBe(otherError);
        });
    });

    describe('cancelAccountDeletionService', () =>
    {
        it('clears a pending deletion, claiming the request row before touching users', async () =>
        {
            const user = makeUser({ deletion: 'pending' });
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
            usersRepository.findById.mockResolvedValue(user);
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });

            await cancelAccountDeletionService({ email: user.email, password: 'correct-password' });

            expect(accountDeletionRequestsRepository.markCancelled).toHaveBeenCalledWith(5);
            expect(setAccountDeletion).toHaveBeenCalledWith(user.id, null, { from: 'pending', reason: expect.any(String) });
            // The deletion changes through the one writer, never a column update.
            expect(usersRepository.updateById).not.toHaveBeenCalled();

            // The account lock first, then the claim (request row), then the users
            // reactivation — the purge takes the same lock first.
            expect(usersRepository.lockAccount.mock.invocationCallOrder[0])
                .toBeLessThan(accountDeletionRequestsRepository.findPendingByUserId.mock.invocationCallOrder[0]!);
            const claimOrder = accountDeletionRequestsRepository.markCancelled.mock.invocationCallOrder[0];
            const reactivateOrder = setAccountDeletion.mock.invocationCallOrder[0];
            expect(claimOrder).toBeLessThan(reactivateOrder);
        });

        it('a password whose hash moved before the lock is verified again against the primary, and the cancel claims once more', async () =>
        {
            const user = makeUser({ deletion: 'pending' });
            const rehashed = { ...user, passwordHash: '$2b$12$rehashed' };
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
            usersRepository.findByIdOnPrimary.mockResolvedValue(rehashed);
            usersRepository.lockAccount.mockResolvedValue(rehashed);
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });

            await cancelAccountDeletionService({ email: user.email, password: 'correct-password' });

            expect(verifyPassword).toHaveBeenNthCalledWith(2, 'correct-password', rehashed.passwordHash);
            expect(accountDeletionRequestsRepository.markCancelled).toHaveBeenCalledTimes(1);
            expect(setAccountDeletion).toHaveBeenCalledTimes(1);
        });

        it('a password whose hash moves again is refused, with nothing claimed', async () =>
        {
            const user = makeUser({ deletion: 'pending' });
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
            usersRepository.findByIdOnPrimary.mockResolvedValue({ ...user, passwordHash: '$2b$12$changed' });
            usersRepository.lockAccount.mockResolvedValue({ ...user, passwordHash: '$2b$12$changed-again' });

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(InvalidCredentialsError);

            expect(accountDeletionRequestsRepository.markCancelled).not.toHaveBeenCalled();
            expect(setAccountDeletion).not.toHaveBeenCalled();
        });

        it('clears only a deletion still pending under the account lock: a purge that committed after cancel read the account is kept, and nothing is claimed', async () =>
        {
            // Cancel read `pending`; the purge committed before the cancel took
            // the account lock, which reads it.
            const user = makeUser({ deletion: 'pending' });
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
            usersRepository.lockAccount.mockResolvedValue({ ...user, deletion: 'deleted' });
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });

            // A purged account is not active: a password is answered as a wrong one (#364).
            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(InvalidCredentialsError);

            expect(accountDeletionRequestsRepository.markCancelled).not.toHaveBeenCalled();
            expect(setAccountDeletion).not.toHaveBeenCalled();
        });

        it('a refused reactivation throws inside the claim\'s transaction, so the claim is rolled back with it', async () =>
        {
            const user = makeUser({ deletion: 'pending' });
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
            usersRepository.findById.mockResolvedValue(user);
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });
            setAccountDeletion.mockResolvedValueOnce('refused');

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(DeletionNotRequestedError);

            const cancelTransaction = runInTransaction.mock.invocationCallOrder[0];
            expect(cancelTransaction).toBeLessThan(accountDeletionRequestsRepository.markCancelled.mock.invocationCallOrder[0]!);
        });

        it('rejects when the account has no pending deletion request (after verifying the credential)', async () =>
        {
            const user = makeUser();
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
            usersRepository.findById.mockResolvedValue(user);

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(DeletionNotRequestedError);
            expect(verifyPassword).toHaveBeenCalledWith('correct-password', user.passwordHash);
        });

        it('B1 (cancel side): when the purge already won the race and claimed the request row, cancel throws DeletionNotRequestedError and never reactivates the (already-purged) user', async () =>
        {
            // The user row has already been anonymized by a purge that committed
            // between our credential check and this claim attempt — the
            // request row's claim below is what proves the clearing is never
            // even called; the real defense is the request-row claim below.
            const user = makeUser({ deletion: 'pending' });
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
            accountDeletionRequestsRepository.findPendingByUserId.mockResolvedValue({ id: 5 });
            // The conditional UPDATE (WHERE status='pending') matches 0 rows because
            // the purge's own claim already flipped this row to 'completed'.
            accountDeletionRequestsRepository.markCancelled.mockResolvedValue(null);

            await expect(
                cancelAccountDeletionService({ email: user.email, password: 'correct-password' }),
            ).rejects.toBeInstanceOf(DeletionNotRequestedError);

            expect(setAccountDeletion).not.toHaveBeenCalled();
            expect(usersRepository.updateById).not.toHaveBeenCalled();
        });

        it('m1: a wrong credential on a non-pending account fails with InvalidCredentialsError, not DeletionNotRequestedError', async () =>
        {
            const user = makeUser();
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(user);
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
            usersRepository.findByEmailOrPhoneOnPrimary.mockResolvedValue(null);

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

    describe('purge — anonymize placeholder + deletion transitions', () =>
    {
        it('anonymizes the user with a deleted-invalid placeholder address and scrubs child rows', async () =>
        {
            const user = makeUser({ deletion: 'pending' });
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
            expect(setAccountDeletion).toHaveBeenCalledWith(user.id, 'deleted', { from: 'pending', reason: expect.any(String) });
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
            const user = makeUser({ deletion: 'pending' });
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
            const failing = makeUser({ id: 1, deletion: 'pending' });
            const ok = makeUser({ id: 2, publicId: '22222222-2222-2222-2222-222222222222', deletion: 'pending' });

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
            usersRepository.findById.mockResolvedValue({ ...user, deletion: null });
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
            const user = makeUser({ deletion: 'pending' });
            const recovered = { ...user, deletion: null };

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
            const user = makeUser({ deletion: 'pending' });
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
            const cancelledUser = makeUser({ id: 50 }); // recovered before we processed it
            const okUser = makeUser({ id: 51, publicId: '33333333-3333-3333-3333-333333333333' });

            accountDeletionRequestsRepository.findDueForPurge.mockResolvedValue([
                { id: 20, userId: cancelledUser.id, userPublicId: cancelledUser.publicId },
                { id: 21, userId: okUser.id, userPublicId: okUser.publicId },
            ]);
            usersRepository.findById.mockImplementation(async (id: number) =>
                (id === cancelledUser.id ? cancelledUser : { ...okUser, deletion: 'pending' }));

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
