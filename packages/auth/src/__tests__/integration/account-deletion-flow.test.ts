/**
 * @spfn/auth - Account Deletion Lifecycle Integration Tests (issue #9)
 *
 * Real HTTP requests against the mounted auth router, plus direct service calls
 * for the purge sweep (so the test controls `purgeScheduledAt` precisely instead
 * of waiting on a cron tick). Covers:
 * - request -> login blocked (401, as a wrong password: #364) -> cancel -> login succeeds
 * - purge sweep, anonymize strategy: PII scrubbed, same email/social account reusable
 * - purge sweep, hard-delete strategy: row physically removed, audit row survives (userId -> null)
 * - B1 regression: cancel-during-sweep — a request already read into a sweep's batch,
 *   but cancelled before that batch item is processed, must not be purged and must
 *   not have its (now 'cancelled') audit row overwritten back to 'completed'
 *
 * The package sends no deletion notice (spfn/spfn#170); the app gets the events
 * and the `onPurge` hook. Each row, and what goes unnoticed without it:
 *
 * | Row | Checks                                                              | Unnoticed without it                              |
 * |-----|---------------------------------------------------------------------|---------------------------------------------------|
 * | N1  | request, cancel, purge (both strategies): zero sendEmail/sendSMS    | a package-sent notice left behind                 |
 * | N2  | `requested.immediate` true for a configured 0 and for `immediate`,  | an app wording "scheduled" for a purge that runs  |
 * |     | false otherwise                                                     | at once                                           |
 * | N3  | `onPurge` called once with the contact read under the lock, both    | a hook given the anonymized address, or none      |
 * |     | strategies                                                          |                                                   |
 * | N4  | inside the hook the claim is made in the purge's transaction, the   | a hook run outside the purge transaction (an      |
 * |     | account not yet touched; its outbox row is there after the commit   | outbox row for a purge that never committed), or  |
 * |     |                                                                     | after the writes it should precede                |
 * | N5  | a throwing hook: account and request stay pending, its write is     | a purge committed without the app's hand-off      |
 * |     | rolled back, no `completed`                                         |                                                   |
 * | N6  | a second purge of the same batch row calls the hook no more         | the notice sent twice                             |
 * | N7  | `completed` carries exactly `{ userPublicId, purgeStrategy }`       | the address added to the event "for convenience"  |
 * | P6  | inside the hook, both strategies, the account and its stored        | a hook moved after the writes: no locale to word  |
 * |     | locale read back through the app's repositories                     | the notice in, the README's advice dead           |
 * | B1  | (extended) a cancel that won the race: the hook is not called       | a notice for an account that was kept             |
 *
 * OAuth-login status gate coverage lives in the unit test
 * `unit/oauth-status-gate.test.ts` (mocked — a full code-exchange OAuth round trip
 * would need to mock an external provider's token endpoint, disproportionate to
 * what that gate needs to prove: `assertActiveForOAuthSession` blocks non-active
 * users before a session is issued).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, desc, sql } from 'drizzle-orm';
import { pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { BaseRepository } from '@spfn/core/db';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { configureChannels } from '@/server/lib/channels-config';
import { verificationCodes, users, accountDeletionRequests } from '@/server/entities';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';

const { sendEmailMock, sendSMSMock } = vi.hoisted(() => ({
    sendEmailMock: vi.fn().mockResolvedValue({ success: true }),
    sendSMSMock: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: sendEmailMock,
        sendSMS: sendSMSMock,
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { defineRouter, registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { __resetDeletionForTests, configureDeletion } = await import('@/server/lib/deletion-config');
const { sweepDuePurges, purgePendingRequest, requestAccountDeletionService } = await import('@/server/services/account-deletion.service');
const { authDeletionRequestedEvent, authDeletionCancelledEvent, authDeletionCompletedEvent } = await import('@/server/events');
const { accountDeletionRequestsRepository, usersRepository, userSettingsRepository } = await import('@/server/repositories');
const { authenticate } = await import('@/server/middleware/authenticate');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Each account its own client address, so the route limiters count no account against another's.
let lastIp = 0;
const nextIp = () => `198.51.100.${++lastIp % 250}`;

/** An app's own outbox, as the README recipe has it: `onPurge` writes here, a job sends from here. */
const noticeOutbox = pgSchema('spfn_auth').table('test_deletion_notice_outbox', {
    id: serial('id').primaryKey(),
    publicId: text('public_id').notNull(),
    email: text('email'),
    phone: text('phone'),
});

class NoticeOutboxRepository extends BaseRepository
{
    async add(account: { publicId: string; email: string | null; phone: string | null }): Promise<void>
    {
        await this.db.insert(noticeOutbox).values({ publicId: account.publicId, email: account.email, phone: account.phone });
    }

    /** The account and its request as this repository's connection sees them — the purge's transaction, inside `onPurge`. */
    async deletionOf(userId: number): Promise<{ deletion: string | null; email: string | null; request: string } | undefined>
    {
        const [row] = await this.db.select({ deletion: users.deletion, email: users.email, request: accountDeletionRequests.status })
            .from(users)
            .innerJoin(accountDeletionRequests, eq(accountDeletionRequests.userId, users.id))
            .where(eq(users.id, userId));

        return row;
    }
}

const noticeOutboxRepository = new NoticeOutboxRepository();

describe.skipIf(!dbAvailable)('Account Deletion Lifecycle Integration', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        // selfDeletion is off unless the app states it (#475).
        configureChannels({ selfDeletion: true });
        await getTestDb().execute(sql`CREATE TABLE spfn_auth.test_deletion_notice_outbox (id serial PRIMARY KEY, public_id text NOT NULL, email text, phone text)`);
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';

        app = new Hono();
        // Mirror a real consuming app: mount mainAuthRouter as a package and apply
        // `authenticate` globally, so `getAuth(c)` is populated for the (authenticated)
        // deletion-request route — api-flow.test.ts's bare `registerRoutes(app,
        // mainAuthRouter)` never applies global auth, which is fine for the public
        // routes it covers but leaves `getAuth(c)` undefined here.
        const appRouter = defineRouter({}).packages([mainAuthRouter]).use([authenticate]);
        registerRoutes(app, appRouter);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await getTestDb().execute(sql`DROP TABLE IF EXISTS spfn_auth.test_deletion_notice_outbox`);
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        await db.execute(sql`TRUNCATE spfn_auth.test_deletion_notice_outbox`);
        __resetDeletionForTests();
        sendEmailMock.mockClear();
        sendSMSMock.mockClear();
        vi.spyOn(authDeletionRequestedEvent, 'emit');
        vi.spyOn(authDeletionCancelledEvent, 'emit');
        vi.spyOn(authDeletionCompletedEvent, 'emit');
    });

    afterEach(() =>
    {
        for (const event of [authDeletionRequestedEvent, authDeletionCancelledEvent, authDeletionCompletedEvent])
        {
            vi.mocked(event.emit).mockRestore();
        }
    });

    /** Register a user through the full verification flow with a real key pair. */
    async function registerViaFlow(email: string, password: string): Promise<{ userId: string; key: KeyPair }>
    {
        const key = generateKeyPair('ES256');
        const headers = { ...JSON_HEADERS, 'x-forwarded-for': nextIp() };

        await app.request('/_auth/codes', {
            method: 'POST',
            headers,
            body: JSON.stringify({ target: email, targetType: 'email', purpose: 'registration' }),
        });

        const db = getTestDb();
        const [codeRow] = await db.select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);

        const verifyRes = await app.request('/_auth/codes/verify', {
            method: 'POST',
            headers,
            body: JSON.stringify({ target: email, targetType: 'email', code: codeRow.code, purpose: 'registration' }),
        });
        const { verificationToken } = await verifyRes.json();

        const response = await app.request('/_auth/register', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                email,
                verificationToken,
                password,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        const { userId } = await response.json();

        return { userId, key };
    }

    /** Sign a client Bearer token for `key`, matching what the Next.js client does. */
    function bearerFor(key: KeyPair): string
    {
        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, key.algorithm, { issuer: 'spfn-client' });

        return `Bearer ${token}`;
    }

    async function loginAttempt(email: string, password: string)
    {
        const key = generateKeyPair('ES256');

        return app.request('/_auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email,
                password,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });
    }

    it('request -> login blocked (401, as a wrong password) -> cancel -> login succeeds again', async () =>
    {
        const email = 'roundtrip@example.com';
        const password = 'SecurePassword123!';
        const { key } = await registerViaFlow(email, password);

        // Request deletion (authenticated, password re-auth)
        const requestRes = await app.request('/_auth/deletion/request', {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: bearerFor(key) },
            body: JSON.stringify({ password }),
        });
        expect(requestRes.status).toBe(200);
        const { purgeScheduledAt } = await requestRes.json();
        expect(new Date(purgeScheduledAt).getTime()).toBeGreaterThan(Date.now());

        // Login is now blocked, answered as a wrong password (#364)
        const blockedLogin = await loginAttempt(email, password);
        expect(blockedLogin.status).toBe(401);
        const blockedBody = await blockedLogin.json();
        expect(blockedBody.__type).toBe('InvalidCredentialsError');

        // Cancel (recovery) — credential-based, no Bearer token needed
        const cancelRes = await app.request('/_auth/deletion/cancel', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ email, password }),
        });
        expect(cancelRes.status).toBe(204);

        // Login succeeds again
        const restoredLogin = await loginAttempt(email, password);
        expect(restoredLogin.status).toBe(200);
    });

    it('rejects a duplicate deletion request while one is pending', async () =>
    {
        const email = 'dup@example.com';
        const password = 'SecurePassword123!';
        const { userId, key } = await registerViaFlow(email, password);

        const first = await app.request('/_auth/deletion/request', {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: bearerFor(key) },
            body: JSON.stringify({ password }),
        });
        expect(first.status).toBe(200);

        // Sessions are revoked on request, so a second self-service call needs a
        // fresh login — but the account is pending_deletion, so login is blocked
        // too (confirms the request is a dead end without cancelling first).
        // Exercise the service directly, as an admin/DSR caller would, to assert
        // the duplicate-request guard itself.
        const { requestAccountDeletionService } = await import('@/server/services/account-deletion.service');
        await expect(
            requestAccountDeletionService(Number(userId), { requestedBy: 'admin' }),
        ).rejects.toMatchObject({ name: 'DeletionAlreadyRequestedError' });
    });

    it('answers a request that lost the race to the pending-request index with DeletionAlreadyRequestedError', async () =>
    {
        const { userId } = await registerViaFlow('race@example.com', 'SecurePassword123!');

        // The state the loser of two concurrent requests meets: it read the
        // account as active, and the winner's pending row has committed since.
        await accountDeletionRequestsRepository.create({
            userId: Number(userId),
            userPublicId: 'race-winner',
            requestedAt: new Date(),
            purgeScheduledAt: new Date(Date.now() + 86_400_000),
            status: 'pending',
            requestedBy: 'self',
            reason: null,
        });

        const { requestAccountDeletionService } = await import('@/server/services/account-deletion.service');
        await expect(
            requestAccountDeletionService(Number(userId), { requestedBy: 'admin' }),
        ).rejects.toMatchObject({ name: 'DeletionAlreadyRequestedError' });
    });

    it('purge sweep (anonymize): scrubs PII, keeps the row, frees the email for re-registration', async () =>
    {
        const email = 'anonymize@example.com';
        const password = 'SecurePassword123!';
        const { userId, key } = await registerViaFlow(email, password);

        const requestRes = await app.request('/_auth/deletion/request', {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: bearerFor(key) },
            body: JSON.stringify({ password }),
        });
        expect(requestRes.status).toBe(200);

        // Backdate the grace period so the sweep picks this request up now.
        const db = getTestDb();
        await db.update(accountDeletionRequests)
            .set({ purgeScheduledAt: new Date(Date.now() - 1000) })
            .where(eq(accountDeletionRequests.userId, Number(userId)));

        const result = await sweepDuePurges();
        expect(result).toMatchObject({ processed: 1, purged: 1, skipped: 0 });

        const [row] = await db.select().from(users).where(eq(users.id, Number(userId))).limit(1);
        expect(row.deletion).toBe('deleted');
        expect(row.email).toBe(`deleted-${row.publicId}@deleted.invalid`);
        expect(row.phone).toBeNull();
        expect(row.passwordHash).toBeNull();
        expect(row.deletedAt).not.toBeNull();

        // A second sweep tick must not re-process an already-completed request —
        // findDueForPurge only matches status='pending'.
        const secondSweep = await sweepDuePurges();
        expect(secondSweep).toEqual({ processed: 0, purged: 0, skipped: 0 });

        // The original email is free again — same-email re-registration succeeds.
        const reRegistered = await registerViaFlow(email, 'AnotherPassword123!');
        expect(reRegistered.userId).toBeDefined();
        expect(reRegistered.userId).not.toBe(userId);
    });

    it('B1: cancel-during-sweep — a request cancelled after the sweep read its batch is not purged, and its audit row is not overwritten back to completed', async () =>
    {
        const email = 'cancel-during-sweep@example.com';
        const password = 'SecurePassword123!';
        const { userId, key } = await registerViaFlow(email, password);

        const requestRes = await app.request('/_auth/deletion/request', {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: bearerFor(key) },
            body: JSON.stringify({ password }),
        });
        expect(requestRes.status).toBe(200);

        const db = getTestDb();
        await db.update(accountDeletionRequests)
            .set({ purgeScheduledAt: new Date(Date.now() - 1000) })
            .where(eq(accountDeletionRequests.userId, Number(userId)));

        // Simulate the sweep having already read its batch (a stale reference)...
        const staleBatch = await accountDeletionRequestsRepository.findDueForPurge(new Date());
        expect(staleBatch).toHaveLength(1);

        // ...then the user cancels (recovers) before the sweep processes that row.
        const cancelRes = await app.request('/_auth/deletion/cancel', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ email, password }),
        });
        expect(cancelRes.status).toBe(204);

        // The sweep now processes the STALE row it already had in hand.
        const onPurge = vi.fn(async () => undefined);
        configureDeletion({ onPurge });
        const purgeResult = await purgePendingRequest(staleBatch[0]);
        expect(purgeResult.outcome).not.toBe('purged');
        // The account was kept: the app is not handed a purge to tell anyone of.
        expect(onPurge).not.toHaveBeenCalled();

        const [userRow] = await db.select().from(users).where(eq(users.id, Number(userId)));
        expect(userRow.deletion).toBeNull();   // recovered, not purged
        expect(userRow.email).toBe(email);     // not anonymized
        expect(userRow.deletedAt).toBeNull();

        const [requestRow] = await db.select().from(accountDeletionRequests)
            .where(eq(accountDeletionRequests.id, staleBatch[0].id));
        expect(requestRow.status).toBe('cancelled'); // not overwritten back to 'completed'
        expect(requestRow.purgeStrategy).toBeNull();
    });

    it('purge sweep (hard-delete): removes the row; the audit request row survives with userId -> null', async () =>
    {
        configureDeletion({ purgeStrategy: 'hard-delete' });

        const email = 'harddelete@example.com';
        const password = 'SecurePassword123!';
        const { userId, key } = await registerViaFlow(email, password);

        const requestRes = await app.request('/_auth/deletion/request', {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: bearerFor(key) },
            body: JSON.stringify({ password }),
        });
        expect(requestRes.status).toBe(200);

        const db = getTestDb();
        await db.update(accountDeletionRequests)
            .set({ purgeScheduledAt: new Date(Date.now() - 1000) })
            .where(eq(accountDeletionRequests.userId, Number(userId)));

        const result = await sweepDuePurges();
        expect(result).toMatchObject({ processed: 1, purged: 1, skipped: 0 });

        const rows = await db.select().from(users).where(eq(users.id, Number(userId)));
        expect(rows).toHaveLength(0);

        // The audit row survives the hard-delete (FK is `set null`, not cascade).
        const [completed] = await db.select().from(accountDeletionRequests)
            .where(eq(accountDeletionRequests.status, 'completed'));
        expect(completed).toBeDefined();
        expect(completed.userId).toBeNull();
        expect(completed.purgeStrategy).toBe('hard-delete');
    });
    /** An account with a deletion request past its grace period, as the sweep finds it. */
    async function dueAccount(email: string, phone: string | null = null): Promise<{ userId: number; publicId: string }>
    {
        const password = 'SecurePassword123!';
        const { userId, key } = await registerViaFlow(email, password);
        const db = getTestDb();
        await db.update(users).set({ phone }).where(eq(users.id, Number(userId)));

        const requestRes = await app.request('/_auth/deletion/request', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': nextIp(), Authorization: bearerFor(key) },
            body: JSON.stringify({ password }),
        });
        expect(requestRes.status).toBe(200);

        await db.update(accountDeletionRequests)
            .set({ purgeScheduledAt: new Date(Date.now() - 1000) })
            .where(eq(accountDeletionRequests.userId, Number(userId)));
        const [row] = await db.select({ publicId: users.publicId }).from(users).where(eq(users.id, Number(userId)));

        return { userId: Number(userId), publicId: row.publicId };
    }

    async function deletionState(userId: number): Promise<{ deletion: string | null; email: string | null; request: string }>
    {
        const db = getTestDb();
        const [user] = await db.select({ deletion: users.deletion, email: users.email }).from(users).where(eq(users.id, userId));
        const [request] = await db.select({ status: accountDeletionRequests.status }).from(accountDeletionRequests)
            .where(eq(accountDeletionRequests.userId, userId));

        return { deletion: user.deletion, email: user.email, request: request.status };
    }

    async function outboxRows()
    {
        return getTestDb().select({ publicId: noticeOutbox.publicId, email: noticeOutbox.email, phone: noticeOutbox.phone }).from(noticeOutbox);
    }

    const sends = () => sendEmailMock.mock.calls.length + sendSMSMock.mock.calls.length;

    it.each(['anonymize', 'hard-delete'] as const)('N1 (%s): a request, a cancel and a purge send no e-mail and no SMS', async (purgeStrategy) =>
    {
        configureDeletion({ purgeStrategy });
        const email = `n1-${purgeStrategy}@example.com`;
        const password = 'SecurePassword123!';
        const { userId, key } = await registerViaFlow(email, password);
        // The registration code is the package's to send: it carries a credential.
        await vi.waitFor(() => expect(sendEmailMock).toHaveBeenCalledTimes(1));
        sendEmailMock.mockClear();

        const ip = nextIp();
        const requestRes = await app.request('/_auth/deletion/request', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': ip, Authorization: bearerFor(key) },
            body: JSON.stringify({ password }),
        });
        expect(requestRes.status).toBe(200);
        await vi.waitFor(() => expect(authDeletionRequestedEvent.emit).toHaveBeenCalledTimes(1));

        const cancelRes = await app.request('/_auth/deletion/cancel', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': ip },
            body: JSON.stringify({ email, password }),
        });
        expect(cancelRes.status).toBe(204);
        await vi.waitFor(() => expect(authDeletionCancelledEvent.emit).toHaveBeenCalledTimes(1));

        await requestAccountDeletionService(Number(userId), { requestedBy: 'admin' });
        await getTestDb().update(accountDeletionRequests)
            .set({ purgeScheduledAt: new Date(Date.now() - 1000) })
            .where(and(eq(accountDeletionRequests.userId, Number(userId)), eq(accountDeletionRequests.status, 'pending')));
        expect(await sweepDuePurges()).toMatchObject({ purged: 1 });
        await vi.waitFor(() => expect(authDeletionCompletedEvent.emit).toHaveBeenCalledTimes(1));

        // Every after-commit callback of the three steps has started by now:
        // each step's event was emitted, and a send would have started beside it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(sends()).toBe(0);
    });

    it('N2: requested carries immediate — true for a configured grace period of 0 and for an immediate request, false otherwise', async () =>
    {
        const scheduled = await dueAccount('n2-scheduled@example.com');
        expect(vi.mocked(authDeletionRequestedEvent.emit).mock.calls[0]![0]).toMatchObject({ userPublicId: scheduled.publicId, immediate: false });

        configureDeletion({ gracePeriodDays: 0 });
        const configured = await dueAccount('n2-configured@example.com');
        await vi.waitFor(() => expect(authDeletionCompletedEvent.emit).toHaveBeenCalledTimes(1));
        expect(vi.mocked(authDeletionRequestedEvent.emit).mock.calls[1]![0]).toMatchObject({ userPublicId: configured.publicId, immediate: true });

        __resetDeletionForTests();
        const { userId } = await registerViaFlow('n2-asked@example.com', 'SecurePassword123!');
        await requestAccountDeletionService(Number(userId), { requestedBy: 'admin', immediate: true });
        await vi.waitFor(() => expect(authDeletionCompletedEvent.emit).toHaveBeenCalledTimes(2));
        expect(vi.mocked(authDeletionRequestedEvent.emit).mock.calls[2]![0]).toMatchObject({ userId: String(userId), immediate: true });
    });

    it.each(['anonymize', 'hard-delete'] as const)('N3 (%s): onPurge is called once with the contact read under the lock', async (purgeStrategy) =>
    {
        const onPurge = vi.fn(async () => undefined);
        configureDeletion({ purgeStrategy, onPurge });
        const email = `n3-${purgeStrategy}@example.com`;
        const phone = purgeStrategy === 'anonymize' ? '+15550100001' : '+15550100002';
        const { publicId } = await dueAccount(email, phone);

        expect(await sweepDuePurges()).toMatchObject({ purged: 1 });

        expect(onPurge).toHaveBeenCalledTimes(1);
        expect(onPurge).toHaveBeenCalledWith({ publicId, email, phone, purgeStrategy });
    });

    it('N4: onPurge runs in the purge transaction past the claim and before the account is touched, and its outbox row is there after the commit', async () =>
    {
        const seen: Array<{ inTransaction: unknown; outside: unknown }> = [];
        configureDeletion({
            onPurge: async (account) =>
            {
                const [outside] = await getTestDb().select({ request: accountDeletionRequests.status }).from(accountDeletionRequests)
                    .where(eq(accountDeletionRequests.userPublicId, account.publicId));
                seen.push({ inTransaction: await noticeOutboxRepository.deletionOf(userId), outside: outside?.request });
                await noticeOutboxRepository.add(account);
                expect(await outboxRows()).toEqual([]);
            },
        });
        const email = 'n4@example.com';
        const { userId, publicId } = await dueAccount(email);

        expect(await sweepDuePurges()).toMatchObject({ purged: 1 });

        expect(seen).toEqual([{ inTransaction: { deletion: 'pending', email, request: 'completed' }, outside: 'pending' }]);
        expect(await outboxRows()).toEqual([{ publicId, email, phone: null }]);
    });

    it('N5: a throwing onPurge rolls the purge back — account and request pending, its write gone, no completed', async () =>
    {
        configureDeletion({
            onPurge: async (account) =>
            {
                await noticeOutboxRepository.add(account);
                throw new Error('outbox unavailable');
            },
        });
        const email = 'n5@example.com';
        const { userId } = await dueAccount(email);

        expect(await sweepDuePurges()).toEqual({ processed: 1, purged: 0, skipped: 1 });

        expect(await deletionState(userId)).toEqual({ deletion: 'pending', email, request: 'pending' });
        expect(await outboxRows()).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(authDeletionCompletedEvent.emit).not.toHaveBeenCalled();
    });

    it('N6: a second purge of the same batch row, and a later sweep, do not call onPurge again', async () =>
    {
        const onPurge = vi.fn(async () => undefined);
        configureDeletion({ onPurge });
        const { userId } = await dueAccount('n6@example.com');
        const [batchRow] = await accountDeletionRequestsRepository.findDueForPurge(new Date());

        expect((await purgePendingRequest(batchRow!)).outcome).toBe('purged');
        // Another instance's sweep read the same batch before the first committed.
        expect((await purgePendingRequest(batchRow!)).outcome).not.toBe('purged');
        expect(await sweepDuePurges()).toEqual({ processed: 0, purged: 0, skipped: 0 });

        expect(onPurge).toHaveBeenCalledTimes(1);
        expect((await deletionState(userId)).request).toBe('completed');
    });

    it.each(['anonymize', 'hard-delete'] as const)('P6 (%s): inside onPurge the account and its stored locale are still readable', async (purgeStrategy) =>
    {
        const seen: Array<{ email: string | null | undefined; locale: string | null }> = [];
        configureDeletion({
            purgeStrategy,
            onPurge: async (account) =>
            {
                const user = await usersRepository.findByPublicId(account.publicId);
                seen.push({ email: user?.email, locale: user ? await userSettingsRepository.findLocaleByUserId(user.id) : null });
            },
        });
        const email = `p6-${purgeStrategy}@example.com`;
        const { userId } = await dueAccount(email);
        await userSettingsRepository.upsert(userId, 'locale', 'ko', userId);

        expect(await sweepDuePurges()).toMatchObject({ purged: 1 });

        expect(seen).toEqual([{ email, locale: 'ko' }]);
    });

    it.each(['anonymize', 'hard-delete'] as const)('N7 (%s): completed carries exactly { userPublicId, purgeStrategy }', async (purgeStrategy) =>
    {
        configureDeletion({ purgeStrategy });
        const { publicId } = await dueAccount(`n7-${purgeStrategy}@example.com`, '+15550100007');

        expect(await sweepDuePurges()).toMatchObject({ purged: 1 });

        await vi.waitFor(() => expect(authDeletionCompletedEvent.emit).toHaveBeenCalledTimes(1));
        const [payload] = vi.mocked(authDeletionCompletedEvent.emit).mock.calls[0]!;
        expect(payload).toStrictEqual({ userPublicId: publicId, purgeStrategy });
    });
});
