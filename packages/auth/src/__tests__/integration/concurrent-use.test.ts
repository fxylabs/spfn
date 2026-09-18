/**
 * @spfn/auth - the concurrent-use signal (design #97 v2, case table 6f)
 *
 * One `it` per row. Every row is about one statement — `updateLastUsedById` —
 * and what it does with the address the request resolved to, so the rows are
 * driven by making real authenticated requests from chosen addresses and reading
 * the key row back.
 *
 * The statement is deliberately the same one that already stamps `lastUsedAt`,
 * throttle and all, so two of the rows are about the throttle rather than about
 * the signal: a second sighting inside the minute writes nothing, and an address
 * that changed writes immediately whether or not the throttle would have.
 *
 * `getClientIp` answers the literal string `'unknown'` when nothing resolves.
 * That never reaches the column — it is stored as NULL and compared as "no
 * observation", which is the difference between "this key was in two places" and
 * "we could not tell where this key was".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import { CONCURRENT_USE_WINDOW_MS } from '@/server/lib/key-policy';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const ADDRESS_A = '203.0.113.10';
const ADDRESS_B = '198.51.100.20';
/** Where the key was registered — the one address `listKeys` may show. */
const REGISTERED_FROM = '192.0.2.30';
const MINUTE_MS = 60_000;

interface Session
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('the concurrent-use signal (case table 6f)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

        app = new Hono();
        // A route behind optionalAuth, so the row about it asks the middleware
        // that actually serves those routes rather than a stand-in.
        app.get('/_test/optional', optionalAuth.handler, async (c) => c.json({ signedIn: Boolean(c.get('auth')) }));
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
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
        resetMemoryRateLimitStore();
        vi.restoreAllMocks();

        const userRole = await getRoleByName('user');
        await db.insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    /**
     * An authenticated request from `address`.
     *
     * `x-forwarded-for` is what `getClientIp` falls back to where proxy-guard has
     * not tagged the request, which is the arrangement of this whole file: it is
     * the simplest way to choose the address a request resolves to. Passing null
     * sends no forwarding header at all, which is the row where nothing resolves.
     */
    function request(path: string, session: Session, address: string | null, method = 'POST')
    {
        return app.request(path, {
            method,
            headers: {
                ...JSON_HEADERS,
                Authorization: session.authorization,
                ...(address ? { 'x-forwarded-for': address } : {}),
            },
            ...(method === 'GET' ? {} : { body: '{}' }),
        });
    }

    /** One authenticated call, from `address`, whose only purpose is to be seen. */
    async function seenFrom(session: Session, address: string | null): Promise<void>
    {
        const response = await request('/_auth/keys/list', session, address);

        expect(response.status).toBe(200);

        // `updateLastUsedById` is fire-and-forget, so the row can be written after
        // the response. Read-after-write needs it settled.
        await settle();
    }

    /** Let the fire-and-forget write land before the row is read. */
    async function settle(): Promise<void>
    {
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    async function signIn(address = ADDRESS_A): Promise<Session>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': address },
            body: JSON.stringify({
                email: 'owner@test.com',
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
            }),
        });

        expect(response.status).toBe(200);

        return {
            authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`,
            keyId: keyPair.keyId,
        };
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    /**
     * Put the last sighting `agoMs` in the past.
     *
     * The rows are about two moments a chosen distance apart, and waiting for
     * real minutes is not a test. Both `lastUsedAt` (the throttle) and
     * `lastSeenAt` (the window) move together, because a real prior sighting
     * wrote both in one statement.
     */
    async function sightedAt(keyId: string, agoMs: number, address: string | null): Promise<void>
    {
        const moment = new Date(Date.now() - agoMs);

        await getTestDb()
            .update(userPublicKeys)
            .set({ lastUsedAt: moment, lastSeenAt: moment, lastSeenIp: address })
            .where(eq(userPublicKeys.keyId, keyId));
    }

    // ========================================================================
    // Rows
    // ========================================================================

    it('no previous observation, a request from A: concurrent_use_at stays null and last_seen_ip becomes A', async () =>
    {
        const session = await signIn();
        await sightedAt(session.keyId, 5 * MINUTE_MS, null);

        await seenFrom(session, ADDRESS_A);

        const key = await keyRow(session.keyId);
        expect(key.lastSeenIp).toBe(ADDRESS_A);
        expect(key.concurrentUseAt).toBeNull();
    });

    it('last seen from A a minute ago, another request from A: nothing moves, and the throttle writes nothing', async () =>
    {
        const session = await signIn();
        await sightedAt(session.keyId, 10_000, ADDRESS_A);
        const before = await keyRow(session.keyId);

        await seenFrom(session, ADDRESS_A);

        const after = await keyRow(session.keyId);
        expect(after.lastUsedAt!.getTime()).toBe(before.lastUsedAt!.getTime());
        expect(after.concurrentUseAt).toBeNull();
    });

    it('last seen from A two minutes ago, a request from B: concurrent_use_at moves to now, in the same UPDATE', async () =>
    {
        const session = await signIn();
        await sightedAt(session.keyId, 2 * MINUTE_MS, ADDRESS_A);

        await seenFrom(session, ADDRESS_B);

        const key = await keyRow(session.keyId);
        expect(key.lastSeenIp).toBe(ADDRESS_B);
        expect(key.concurrentUseAt).not.toBeNull();
        expect(Math.abs(key.concurrentUseAt!.getTime() - Date.now())).toBeLessThan(10_000);
    });

    it('last seen from A ten minutes ago, a request from B: nothing moves — that is outside the window', async () =>
    {
        const session = await signIn();
        await sightedAt(session.keyId, 2 * CONCURRENT_USE_WINDOW_MS, ADDRESS_A);

        await seenFrom(session, ADDRESS_B);

        const key = await keyRow(session.keyId);
        expect(key.lastSeenIp).toBe(ADDRESS_B);
        expect(key.concurrentUseAt).toBeNull();
    });

    it('last seen from A, a request whose address does not resolve: nothing moves and last_seen_ip becomes NULL, never the word unknown', async () =>
    {
        const session = await signIn();
        await sightedAt(session.keyId, 2 * MINUTE_MS, ADDRESS_A);

        await seenFrom(session, null);

        const key = await keyRow(session.keyId);
        expect(key.lastSeenIp).toBeNull();
        expect(key.concurrentUseAt).toBeNull();
    });

    it('a deployment without proxy-guard: every web request carries one address, so the signal never fires', async () =>
    {
        // Without proxy-guard the backend sees the Next.js server's address for
        // every browser, whichever browser it was. Two sightings, two continents,
        // one address — and nothing to notice.
        const session = await signIn();
        const nextJsServer = '10.0.0.5';

        await sightedAt(session.keyId, 2 * MINUTE_MS, nextJsServer);
        await seenFrom(session, nextJsServer);
        await sightedAt(session.keyId, 2 * MINUTE_MS, nextJsServer);
        await seenFrom(session, nextJsServer);

        expect((await keyRow(session.keyId)).concurrentUseAt).toBeNull();
    });

    it('two requests at once from A and B: whichever wins, the value is the same moment either way', async () =>
    {
        const session = await signIn();
        await sightedAt(session.keyId, 2 * MINUTE_MS, ADDRESS_A);

        await Promise.all([
            request('/_auth/keys/list', session, ADDRESS_A),
            request('/_auth/keys/list', session, ADDRESS_B),
        ]);
        await settle();

        const key = await keyRow(session.keyId);
        expect(key.concurrentUseAt).not.toBeNull();
        expect(Math.abs(key.concurrentUseAt!.getTime() - Date.now())).toBeLessThan(10_000);
    });

    it('an optionalAuth route: the same rule, because it is the same function', async () =>
    {
        const session = await signIn();
        await sightedAt(session.keyId, 2 * MINUTE_MS, ADDRESS_A);

        expect((await request('/_test/optional', session, ADDRESS_B, 'GET')).status).toBe(200);
        await settle();

        const key = await keyRow(session.keyId);
        expect(key.lastSeenIp).toBe(ADDRESS_B);
        expect(key.concurrentUseAt).not.toBeNull();
    });

    it('listKeys: concurrentUseAtMillis is there and the addresses behind it are not', async () =>
    {
        // Registered from a third address, so the one `listKeys` legitimately
        // shows — where the key first appeared — is neither of the two the signal
        // was raised by, and the assertion below cannot pass by accident.
        const session = await signIn(REGISTERED_FROM);
        await sightedAt(session.keyId, 2 * MINUTE_MS, ADDRESS_A);
        await seenFrom(session, ADDRESS_B);

        const response = await request('/_auth/keys/list', session, ADDRESS_B);
        const { keys } = await response.json();
        const entry = keys.find((key: { keyId: string }) => key.keyId === session.keyId);

        expect(entry.concurrentUseAtMillis).toBe((await keyRow(session.keyId)).concurrentUseAt!.getTime());
        expect(entry).not.toHaveProperty('lastSeenIp');
        expect(entry.registeredIp).toBe(REGISTERED_FROM);
        expect(JSON.stringify(entry)).not.toContain(ADDRESS_A);
        expect(JSON.stringify(entry)).not.toContain(ADDRESS_B);
    });

    it('the write failing: the request is answered 200 all the same, and the failure is logged', async () =>
    {
        const { keysRepository } = await import('@spfn/auth/server');
        const { authLogger } = await import('@spfn/auth/server');
        const session = await signIn();

        const write = vi.spyOn(keysRepository, 'updateLastUsedById')
            .mockRejectedValue(new Error('the audit write failed'));
        const logged = vi.spyOn(authLogger.middleware, 'error').mockImplementation(() => undefined);

        expect((await request('/_auth/keys/list', session, ADDRESS_B)).status).toBe(200);
        await settle();

        expect(write).toHaveBeenCalled();
        expect(logged).toHaveBeenCalledWith('Failed to update lastUsedAt', expect.any(Error));
    });
});
