/**
 * Account status and deletion are separate facts (audit bundle 7, w-dtd81).
 *
 * `users.status` says whether an operator lets the account in; `users.deletion`
 * says where it is in its deletion. Writing one never changes the other.
 *
 * | Row | Checks                                                                                           | Unnoticed without it                         |
 * |-----|--------------------------------------------------------------------------------------------------|----------------------------------------------|
 * | T1  | status {active, inactive, suspended} × deletion {none, pending, after cancel} → the answer of an | a sanction being lifted in one combination   |
 * |     | authenticated request, sign-in, a deletion request and cancel, and the status after all four    |                                              |
 * | T2  | suspend → an administrator schedules deletion → the person cancels → sign-in refused, status     | recurrence of au4-A2                         |
 * |     | still `suspended`, deletion cleared                                                              |                                              |
 * | T3  | an account with a second factor, step-up window expired, asks for deletion with its password →  | recurrence of au4-A3                         |
 * |     | 403 STEP_UP_REQUIRED, keys intact, nothing scheduled                                             |                                              |
 * | T4  | a pending account that has a password cancels with an e-mail verification token; the same token  | the recovery path closing again; token reuse |
 * |     | again is refused; a phone-delivered token on an account with both targets is accepted           |                                              |
 * | T5  | the migration on seeded pre-upgrade rows: `pending_deletion` and `deleted` land in the new       | a scheduled deletion vanishing or a deleted  |
 * |     | representation with their purge dates, and nobody can sign in who could not before              | account reviving at deploy                   |
 * | T6  | a request passes the gates and waits on the account lock; the key's step-up record is removed    | a deletion scheduled on a step-up, key or    |
 * |     | while it waits → 403 STEP_UP_REQUIRED, nothing scheduled, the key live                           | password that no longer holds (PR #320 F1)   |
 * | T7  | a recently authenticated session presents the wrong password → 403 RECENT_AUTH_REQUIRED, nothing | a failed proof read as an absent one (F2)    |
 * |     | scheduled                                                                                        |                                              |
 * | T8  | removed (#170): the package sends no deletion notice; account-deletion-flow pins zero sends       |                                              |
 * | T9  | a code verified, `deleteExpired` past the code's expiry inside the token's lifetime → the token  | a scheduled sweep breaking a valid cancel    |
 * |     | cancels (204); a verified row past its token's lifetime is swept                                 | token (F4)                                   |
 * | T10 | a session of an application-registered profile asks with the correct password → 200, deletion    | the check under the lock refusing a          |
 * |     | pending, one request row                                                                         | credential the admission admits (review P1)  |
 * | T11 | a request waits on the account lock while its device key is revoked → 401, nothing scheduled     | a deletion scheduled by a revoked session    |
 * | T12 | a request waits on the account lock while the account falls under the enrolment-only rule (its   | the second-factor step of the admission      |
 * |     | factor removed under a policy that requires one) → 403 SECOND_FACTOR_ENROLMENT_REQUIRED, nothing | skipped under the lock                       |
 * |     | scheduled                                                                                        |                                              |
 *
 * Every row enters through the HTTP routes as a server mounts them (T5: the
 * migration files the migrator applies, then sign-in over HTTP). T1 writes the
 * starting state straight to the row, as the one-admission-point T1 does: the
 * writers would end the session the row needs to ask with.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { authMigrations } from '../helpers/migrations';
import { createTestUser, mountAuthApp, resetMemoryRateLimitStore, TEST_PASSWORD } from '../helpers/oauth2';
import { accountDeletionRequests, mfaTotp, mfaVerifications, userPublicKeys, users, verificationCodes } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { setAccountStatus } from '@/server/services/user.service';
import { requestAccountDeletionService } from '@/server/services/account-deletion.service';
import { usersRepository, verificationCodesRepository } from '@/server/repositories';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';
import { configureSecondFactor, __resetSecondFactorPolicyForTests } from '@/server/lib/second-factor-policy';
import type { UserStatus } from '@/server/types';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { sendEmail, sendSMS } = await import('@spfn/notification/server');
const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { __resetDeletionForTests } = await import('@/server/lib/deletion-config');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
const PURGE_AT = new Date('2031-03-04T05:06:07.000Z');
/** The keyring second-factor enrolment encrypts the TOTP secret with (T3). */
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
/** An application-registered auth profile (T10): its verifier reads the account from a header. */
const APP_PROFILE = 'deletionT10AppProfileV1';
const APP_PROFILE_USER_HEADER = 'x-t10-account';

interface Account
{
    id: number;
    email: string;
    ip: string;
}

interface Session
{
    keyId: string;
    authorization: string;
}

function gate(): { open: () => void; opened: Promise<void> }
{
    let open!: () => void;
    const opened = new Promise<void>((resolve) =>
    {
        open = resolve;
    });

    return { open, opened };
}

/** Until some backend of this database waits on a lock. */
async function someoneWaitsOnALock(): Promise<void>
{
    for (let i = 0; i < 200; i++)
    {
        const rows = await getTestDb().execute(sql`
            SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND a.datname = current_database()`);
        if (Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0)
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no lock wait observed');
}

/** The deletion a T1 cell starts in: none, pending, or pending and then cancelled over HTTP. */
type DeletionCell = 'none' | 'pending' | 'after cancel';

describe.skipIf(!dbAvailable)('account status and deletion are separate facts (T1-T12)', () =>
{
    let app: Hono;
    let counter = 0;
    let previousTokenSecret: string | undefined;
    let previousKeyring: string | undefined;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        previousTokenSecret = process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET;
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = VERIFICATION_TOKEN_SECRET;
        previousKeyring = process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        registerAuthProfile(APP_PROFILE, {
            verify: async (c) => ({ userId: c.req.header(APP_PROFILE_USER_HEADER)!, keyId: 'app-profile-key', scheme: APP_PROFILE }),
        });
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        restoreEnv('SPFN_AUTH_VERIFICATION_TOKEN_SECRET', previousTokenSecret);
        restoreEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', previousKeyring);
        __resetDeletionForTests();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        __resetDeletionForTests();
        vi.mocked(sendEmail).mockClear();
        vi.mocked(sendSMS).mockClear();
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.useRealTimers();
        __resetSecondFactorPolicyForTests();
    });

    function restoreEnv(name: string, value: string | undefined): void
    {
        if (value === undefined)
        {
            delete process.env[name];
        }
        else
        {
            process.env[name] = value;
        }
    }

    // ========================================================================
    // Requests
    // ========================================================================

    async function send(method: string, path: string, account: Account, body?: unknown, authorization?: string): Promise<Response>
    {
        return await sendWith(method, path, account, body, authorization ? { Authorization: authorization } : {});
    }

    async function sendWith(method: string, path: string, account: Account, body: unknown, headers: Record<string, string>): Promise<Response>
    {
        return await app.request(path, {
            method,
            headers: { ...JSON_HEADERS, 'x-forwarded-for': account.ip, ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    async function expectError(response: Response, status: number, code: string): Promise<void>
    {
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
    }

    /** An account of the row's own, on an address of its own: sign-in is rate limited by both. */
    async function newAccount(): Promise<Account>
    {
        counter += 1;
        const email = `deletion-${counter}@test.com`;

        return { id: await createTestUser(email, (await getRoleByName('user'))!.id), email, ip: `198.51.100.${counter}` };
    }

    async function login(account: Account): Promise<{ response: Response; session: Session }>
    {
        const key = generateKeyPair('ES256');
        const response = await send('POST', '/_auth/login', account, {
            email: account.email,
            password: TEST_PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });
        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { response, session: { keyId: key.keyId, authorization: `Bearer ${token}` } };
    }

    async function signIn(account: Account): Promise<Session>
    {
        const { response, session } = await login(account);

        expect(response.status).toBe(200);

        return session;
    }

    const requestDeletion = (account: Account, session: Session) =>
        send('POST', '/_auth/deletion/request', account, { password: TEST_PASSWORD }, session.authorization);

    const cancel = (account: Account, body: Record<string, string>) =>
        send('POST', '/_auth/deletion/cancel', account, { email: account.email, ...body });

    /** A verification token for `target`, through `/_auth/codes` and `/_auth/codes/verify`. */
    async function deletionToken(account: Account, target: string, targetType: 'email' | 'phone'): Promise<string>
    {
        expect((await send('POST', '/_auth/codes', account, { target, targetType, purpose: 'account_deletion' })).status).toBe(200);
        const [row] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, target), eq(verificationCodes.purpose, 'account_deletion')))
            .orderBy(desc(verificationCodes.id))
            .limit(1);
        const verified = await send('POST', '/_auth/codes/verify', account, { target, targetType, code: row!.code, purpose: 'account_deletion' });

        expect(verified.status).toBe(200);

        return (await verified.json()).verificationToken as string;
    }

    // ========================================================================
    // Rows
    // ========================================================================

    async function stateOf(account: Account)
    {
        const [row] = await getTestDb().select({ status: users.status, deletion: users.deletion })
            .from(users).where(eq(users.id, account.id));

        return row!;
    }

    async function requestRows(account: Account)
    {
        return await getTestDb().select({ status: accountDeletionRequests.status, requestedBy: accountDeletionRequests.requestedBy })
            .from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, account.id));
    }

    /** A pending deletion, as a request leaves it, written to the rows so the session stays live. */
    async function writePending(account: Account): Promise<void>
    {
        await getTestDb().insert(accountDeletionRequests).values({
            userId: account.id,
            userPublicId: String(account.id),
            purgeScheduledAt: PURGE_AT,
            requestedBy: 'admin',
        });
        await getTestDb().update(users).set({ deletion: 'pending' }).where(eq(users.id, account.id));
    }

    /** What every surface that admits the person answers in a cell. */
    async function expectCellAnswer(response: Response, status: UserStatus, pending: boolean, admitted: number): Promise<void>
    {
        if (pending)
        {
            await expectError(response, 403, 'AccountPendingDeletionError');
        }
        else if (status !== 'active')
        {
            await expectError(response, 403, 'AccountDisabledError');
        }
        else
        {
            expect(response.status).toBe(admitted);
        }
    }

    /** What password sign-in answers in a cell: a refused account as a wrong password (#364). */
    async function expectPasswordAnswer(response: Response, status: UserStatus, pending: boolean): Promise<void>
    {
        if (pending || status !== 'active')
        {
            await expectError(response, 401, 'InvalidCredentialsError');
        }
        else
        {
            expect(response.status).toBe(200);
        }
    }

    const CELLS = (['active', 'inactive', 'suspended'] as const)
        .flatMap((status) => (['none', 'pending', 'after cancel'] as const).map((deletion) => ({ status, deletion })));

    it.each(CELLS)('T1 status $status, deletion $deletion: each surface answers by both facts, and the status survives all of them', async ({ status, deletion }: { status: UserStatus; deletion: DeletionCell }) =>
    {
        const account = await newAccount();
        const session = await signIn(account);

        await getTestDb().update(users).set({ status }).where(eq(users.id, account.id));
        if (deletion !== 'none')
        {
            await writePending(account);
        }
        if (deletion === 'after cancel')
        {
            expect((await cancel(account, { password: TEST_PASSWORD })).status).toBe(204);
            expect(await stateOf(account)).toEqual({ status, deletion: null });
        }
        const pending = deletion === 'pending';

        await expectCellAnswer(await send('GET', '/_auth/session', account, undefined, session.authorization), status, pending, 200);
        await expectPasswordAnswer((await login(account)).response, status, pending);
        await expectCellAnswer(await requestDeletion(account, session), status, pending, 200);
        const scheduled = !pending && status === 'active';

        const cancelled = await cancel(account, { password: TEST_PASSWORD });

        if (pending || scheduled)
        {
            expect(cancelled.status).toBe(204);
        }
        else
        {
            // Not active, nothing pending: answered as a wrong password (#364).
            await expectError(cancelled, 401, 'InvalidCredentialsError');
        }
        expect(await stateOf(account)).toEqual({ status, deletion: null });
    });

    it('T2 suspended, then scheduled for deletion by an administrator, then cancelled by the person: still suspended, deletion cleared', async () =>
    {
        const account = await newAccount();
        await setAccountStatus(account.id, 'suspended', { from: 'any', reason: 'T2 suspension' });
        await requestAccountDeletionService(account.id, { requestedBy: 'admin', reason: 'T2 DSR' });

        expect(await stateOf(account)).toEqual({ status: 'suspended', deletion: 'pending' });
        expect((await cancel(account, { password: TEST_PASSWORD })).status).toBe(204);

        await expectError((await login(account)).response, 401, 'InvalidCredentialsError');
        expect(await stateOf(account)).toEqual({ status: 'suspended', deletion: null });
        expect(await requestRows(account)).toEqual([{ status: 'cancelled', requestedBy: 'admin' }]);
    });

    /** A TOTP second factor, enrolled and confirmed on `session`: the confirm is its step-up. */
    async function enrolTotp(account: Account, session: Session): Promise<void>
    {
        const enrolled = await send('POST', '/_auth/mfa/totp/enroll', account, {}, session.authorization);
        const secret = (await enrolled.json()).secret as string;
        const code = hotp(decodeBase32(secret), totpStep(Date.now()));

        expect((await send('POST', '/_auth/mfa/totp/confirm', account, { code }, session.authorization)).status).toBe(200);
        expect(await getTestDb().select().from(mfaTotp).where(eq(mfaTotp.userId, account.id))).toHaveLength(1);
    }

    async function liveKeys(account: Account)
    {
        return await getTestDb().select({ isActive: userPublicKeys.isActive })
            .from(userPublicKeys).where(eq(userPublicKeys.userId, account.id));
    }

    it('T3 an account with a second factor whose step-up window passed: deletion request 403 STEP_UP_REQUIRED, keys intact, nothing scheduled', async () =>
    {
        const account = await newAccount();
        const session = await signIn(account);
        await enrolTotp(account, session);
        await getTestDb().update(mfaVerifications)
            .set({ verifiedAt: new Date(Date.now() - 24 * 60 * 60_000) })
            .where(eq(mfaVerifications.userId, account.id));

        const refused = await requestDeletion(account, session);

        expect(refused.status).toBe(403);
        expect((await refused.json()).error.code).toBe('StepUpRequiredError');
        expect((await send('GET', '/_auth/session', account, undefined, session.authorization)).status).toBe(200);
        expect(await liveKeys(account)).toEqual([{ isActive: true }]);
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });
        expect(await requestRows(account)).toEqual([]);
    });

    it('T4 a password account cancels with an e-mail token; the same token is refused the second time; a phone token on an account with both is accepted', async () =>
    {
        const account = await newAccount();
        const phone = `+1555010${String(counter).padStart(4, '0')}`;
        await getTestDb().update(users).set({ phone }).where(eq(users.id, account.id));

        expect((await requestDeletion(account, await signIn(account))).status).toBe(200);
        const emailToken = await deletionToken(account, account.email, 'email');

        expect((await cancel(account, { verificationToken: emailToken })).status).toBe(204);
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });

        expect((await requestDeletion(account, await signIn(account))).status).toBe(200);
        await expectError(await cancel(account, { verificationToken: emailToken }), 400, 'InvalidVerificationTokenError');
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: 'pending' });

        const phoneToken = await deletionToken(account, phone, 'phone');

        expect((await cancel(account, { verificationToken: phoneToken })).status).toBe(204);
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });
    });

    /**
     * Send `request` while another transaction holds the account lock, run
     * `meanwhile` once the request has passed its gates and reached for the
     * lock, then release it: what `meanwhile` commits is what the request
     * finds under the lock.
     */
    async function whileWaitingOnTheLock(
        account: Account,
        request: () => Promise<Response>,
        meanwhile: () => Promise<unknown>,
    ): Promise<Response>
    {
        const held = gate();
        const release = gate();
        const reached = gate();

        const holder = runInTransaction(async () =>
        {
            await usersRepository.lockAccount(account.id);
            held.open();
            await release.opened;
        }, { context: 'test:held-account-lock' });
        await held.opened;

        const lockAccount = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementation(async (id) =>
        {
            reached.open();

            return await lockAccount(id);
        });

        const response = request();
        await reached.opened;
        await meanwhile();
        await someoneWaitsOnALock().finally(release.open);

        return (await Promise.all([response, holder]))[0];
    }

    it('T6 a request that passed the gates waits on the account lock while its step-up record is removed: 403 STEP_UP_REQUIRED, nothing scheduled', async () =>
    {
        const account = await newAccount();
        const session = await signIn(account);
        await enrolTotp(account, session);

        const response = await whileWaitingOnTheLock(account, () => requestDeletion(account, session), () =>
            getTestDb().delete(mfaVerifications).where(eq(mfaVerifications.keyId, session.keyId)));

        await expectError(response, 403, 'StepUpRequiredError');
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });
        expect(await requestRows(account)).toEqual([]);
        expect(await liveKeys(account)).toEqual([{ isActive: true }]);
    }, 20_000);

    it('T7 a recently authenticated session that presents the wrong password is refused, and nothing is scheduled', async () =>
    {
        const account = await newAccount();
        const session = await signIn(account);

        const refused = await send('POST', '/_auth/deletion/request', account, { password: 'not-the-password' }, session.authorization);

        await expectError(refused, 403, 'RecentAuthenticationRequiredError');
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });
        expect(await requestRows(account)).toEqual([]);
        expect(await liveKeys(account)).toEqual([{ isActive: true }]);
    });

    it('T9 a verified code outlives its own expiry for its token\'s lifetime: the sweep keeps it, the token cancels; past the token\'s lifetime it is swept', async () =>
    {
        const account = await newAccount();
        expect((await requestDeletion(account, await signIn(account))).status).toBe(200);
        const verifiedAt = Date.now();
        const token = await deletionToken(account, account.email, 'email');

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(verifiedAt + 6 * 60_000);
        await verificationCodesRepository.deleteExpired();

        expect((await cancel(account, { verificationToken: token })).status).toBe(204);
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });

        vi.useRealTimers();
        const unspentAt = Date.now();
        await deletionToken(account, account.email, 'email');
        const codeRows = () => getTestDb().select().from(verificationCodes).where(eq(verificationCodes.target, account.email));
        expect(await codeRows()).toHaveLength(1);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(unspentAt + 16 * 60_000);
        await verificationCodesRepository.deleteExpired();

        expect(await codeRows()).toEqual([]);
    });

    it('T10 an application-profile session that presents the correct password: 200, deletion pending, one request row', async () =>
    {
        const account = await newAccount();

        const response = await sendWith('POST', '/_auth/deletion/request', account, { password: TEST_PASSWORD }, {
            [CLIENT_PROOF_HEADERS.profile]: APP_PROFILE,
            [APP_PROFILE_USER_HEADER]: String(account.id),
        });

        expect(response.status).toBe(200);
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: 'pending' });
        expect(await requestRows(account)).toEqual([{ status: 'pending', requestedBy: 'self' }]);
    });

    it('T11 a request that waits on the account lock while its device key is revoked: 401, nothing scheduled', async () =>
    {
        const account = await newAccount();
        const session = await signIn(account);

        const response = await whileWaitingOnTheLock(account, () => requestDeletion(account, session), () =>
            getTestDb().update(userPublicKeys).set({ isActive: false }).where(eq(userPublicKeys.keyId, session.keyId)));

        expect(response.status).toBe(401);
        expect((await response.json()).error.message).toBe('Invalid or revoked key');
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });
        expect(await requestRows(account)).toEqual([]);
    }, 20_000);

    it('T12 a request that waits on the account lock while the account falls under the enrolment-only rule: 403 SECOND_FACTOR_ENROLMENT_REQUIRED, nothing scheduled', async () =>
    {
        configureSecondFactor({ required: true, methods: ['totp'], recoveryCodes: false });
        const account = await newAccount();
        const session = await signIn(account);
        await enrolTotp(account, session);

        const response = await whileWaitingOnTheLock(account, () => requestDeletion(account, session), () =>
            getTestDb().delete(mfaTotp).where(eq(mfaTotp.userId, account.id)));

        await expectError(response, 403, 'SecondFactorEnrolmentRequiredError');
        expect(await stateOf(account)).toEqual({ status: 'active', deletion: null });
        expect(await requestRows(account)).toEqual([]);
        expect(await liveKeys(account)).toEqual([{ isActive: true }]);
    }, 20_000);

    // ========================================================================
    // T5 — the upgrade. Last in the file: it rebuilds the schema from the
    // migrations, and leaves it fully migrated.
    // ========================================================================

    /** Every migration, in order, split at the one that adds `users.deletion`. */
    function migrationsAroundThisChange(): { before: string[][]; from: string[][] }
    {
        const migrations = authMigrations().map((migration) => migration.statements);
        const index = migrations.findIndex((statements) => statements.some((statement) => statement.includes('ADD COLUMN "deletion"')));

        expect(index).toBeGreaterThan(0);

        return { before: migrations.slice(0, index), from: migrations.slice(index) };
    }

    async function apply(migrations: string[][]): Promise<void>
    {
        for (const statement of migrations.flat())
        {
            await getTestDb().execute(sql.raw(statement));
        }
    }

    /**
     * The role the seeded accounts hold, as the release before this one stored
     * it — in SQL, as the accounts are: the entities, and the boot that writes
     * through them, may name columns a later migration adds, which this schema
     * lacks. The boot runs once the schema is fully migrated.
     */
    async function seedPreUpgradeRole(): Promise<number>
    {
        const [row] = await getTestDb().execute<{ id: number }>(sql`
            INSERT INTO spfn_auth.roles (name, display_name) VALUES ('user', 'User') RETURNING id`);

        return Number(row!.id);
    }

    /**
     * A user row as the release before this one stored it, and its request row —
     * in SQL: the entity already names `users.deletion`, which this schema lacks.
     */
    async function seedPreUpgrade(roleId: number, email: string, status: string, requestStatus: 'pending' | 'completed' | null): Promise<Account>
    {
        const passwordHash = await hashPassword(TEST_PASSWORD);
        const [row] = await getTestDb().execute<{ id: number }>(sql`
            INSERT INTO spfn_auth.users (email, password_hash, role_id, status, email_verified_at)
            VALUES (${email}, ${passwordHash}, ${roleId}, ${status}, now())
            RETURNING id`);
        const id = Number(row!.id);

        if (requestStatus)
        {
            await getTestDb().execute(sql`
                INSERT INTO spfn_auth.account_deletion_requests (user_id, user_public_id, purge_scheduled_at, status)
                VALUES (${id}, ${email}, ${PURGE_AT.toISOString()}, ${requestStatus})`);
        }
        counter += 1;

        return { id, email, ip: `203.0.113.${counter}` };
    }

    it('T5 upgrade: pending_deletion and deleted rows keep their purge dates and land in users.deletion; nobody signs in who could not', async () =>
    {
        const { before, from } = migrationsAroundThisChange();
        await getTestDb().execute(sql`DROP SCHEMA IF EXISTS spfn_auth CASCADE`);
        await apply(before);
        const roleId = await seedPreUpgradeRole();

        const pending = await seedPreUpgrade(roleId, 't5-pending@test.com', 'pending_deletion', 'pending');
        const deleted = await seedPreUpgrade(roleId, 't5-deleted@test.com', 'deleted', 'completed');
        const suspended = await seedPreUpgrade(roleId, 't5-suspended@test.com', 'suspended', null);
        const active = await seedPreUpgrade(roleId, 't5-active@test.com', 'active', null);

        await apply(from);
        await initializeAuth();

        expect(await stateOf(pending)).toEqual({ status: 'active', deletion: 'pending' });
        expect(await stateOf(deleted)).toEqual({ status: 'inactive', deletion: 'deleted' });
        expect(await stateOf(suspended)).toEqual({ status: 'suspended', deletion: null });
        expect(await stateOf(active)).toEqual({ status: 'active', deletion: null });
        const requests = await getTestDb().select({ userId: accountDeletionRequests.userId, status: accountDeletionRequests.status, purgeScheduledAt: accountDeletionRequests.purgeScheduledAt })
            .from(accountDeletionRequests).orderBy(accountDeletionRequests.id);
        expect(requests).toEqual([
            { userId: pending.id, status: 'pending', purgeScheduledAt: PURGE_AT },
            { userId: deleted.id, status: 'completed', purgeScheduledAt: PURGE_AT },
        ]);

        await expectError((await login(pending)).response, 401, 'InvalidCredentialsError');
        await expectError((await login(deleted)).response, 401, 'InvalidCredentialsError');
        await expectError((await login(suspended)).response, 401, 'InvalidCredentialsError');
        expect((await login(active)).response.status).toBe(200);
    });
});
