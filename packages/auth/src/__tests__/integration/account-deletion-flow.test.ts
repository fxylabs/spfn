/**
 * @spfn/auth - Account Deletion Lifecycle Integration Tests (issue #9)
 *
 * Real HTTP requests against the mounted auth router, plus direct service calls
 * for the purge sweep (so the test controls `purgeScheduledAt` precisely instead
 * of waiting on a cron tick). Covers:
 * - request -> login blocked (403, AccountPendingDeletionError) -> cancel -> login succeeds
 * - purge sweep, anonymize strategy: PII scrubbed, same email/social account reusable
 * - purge sweep, hard-delete strategy: row physically removed, audit row survives (userId -> null)
 * - B1 regression: cancel-during-sweep — a request already read into a sweep's batch,
 *   but cancelled before that batch item is processed, must not be purged and must
 *   not have its (now 'cancelled') audit row overwritten back to 'completed'
 *
 * OAuth-login status gate coverage lives in the unit test
 * `unit/oauth-status-gate.test.ts` (mocked — a full code-exchange OAuth round trip
 * would need to mock an external provider's token endpoint, disproportionate to
 * what that gate needs to prove: `assertActiveForOAuthSession` blocks non-active
 * users before a session is issued).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { verificationCodes, users, accountDeletionRequests } from '@/server/entities';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';

const { sendEmailMock } = vi.hoisted(() => ({
    sendEmailMock: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: sendEmailMock,
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { defineRouter, registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { configureDeletion } = await import('@/server/lib/deletion-config');
const { sweepDuePurges, purgePendingRequest } = await import('@/server/services/account-deletion.service');
const { accountDeletionRequestsRepository } = await import('@/server/repositories');
const { authenticate } = await import('@/server/middleware/authenticate');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe.skipIf(!dbAvailable)('Account Deletion Lifecycle Integration', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
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
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        configureDeletion(); // reset to defaults between tests
        sendEmailMock.mockClear();
    });

    /** Register a user through the full verification flow with a real key pair. */
    async function registerViaFlow(email: string, password: string): Promise<{ userId: string; key: KeyPair }>
    {
        const key = generateKeyPair('ES256');

        await app.request('/_auth/codes', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ target: email, targetType: 'email', purpose: 'registration' }),
        });

        const db = getTestDb();
        const [codeRow] = await db.select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);

        const verifyRes = await app.request('/_auth/codes/verify', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ target: email, targetType: 'email', code: codeRow.code, purpose: 'registration' }),
        });
        const { verificationToken } = await verifyRes.json();

        const response = await app.request('/_auth/register', {
            method: 'POST',
            headers: JSON_HEADERS,
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

    it('request -> login blocked (403, purgeScheduledAt) -> cancel -> login succeeds again', async () =>
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

        // Login is now blocked with the dedicated pending-deletion error
        const blockedLogin = await loginAttempt(email, password);
        expect(blockedLogin.status).toBe(403);
        const blockedBody = await blockedLogin.json();
        expect(blockedBody.__type).toBe('AccountPendingDeletionError');
        expect(blockedBody.details?.purgeScheduledAt).toBeDefined();

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
        expect(row.status).toBe('deleted');
        expect(row.email).toBe(`deleted-${row.publicId}@deleted.invalid`);
        expect(row.phone).toBeNull();
        expect(row.passwordHash).toBeNull();
        expect(row.deletedAt).not.toBeNull();

        // m3: the final-notice email was sent, only after the purge actually
        // committed. `onAfterCommit` callbacks are fire-and-forget (not awaited by
        // the transaction helper), so poll rather than assert synchronously.
        // 3 calls total by this point: the registration-flow verification code,
        // the "requested" notice from the request step above, and this "final" one
        // (call count, not content, is asserted).
        const emailCallsAfterFirstPurge = 3;
        await vi.waitFor(() => expect(sendEmailMock).toHaveBeenCalledTimes(emailCallsAfterFirstPurge));

        // A second sweep tick must not re-process (or re-notify) an already-completed
        // request — findDueForPurge only matches status='pending'. Nothing async is
        // queued on this path (0 due requests), so this is safe to assert synchronously.
        const secondSweep = await sweepDuePurges();
        expect(secondSweep).toEqual({ processed: 0, purged: 0, skipped: 0 });
        expect(sendEmailMock).toHaveBeenCalledTimes(emailCallsAfterFirstPurge);

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
        const purgeResult = await purgePendingRequest(staleBatch[0]);
        expect(purgeResult.outcome).not.toBe('purged');

        const [userRow] = await db.select().from(users).where(eq(users.id, Number(userId)));
        expect(userRow.status).toBe('active'); // recovered, not purged
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
});
