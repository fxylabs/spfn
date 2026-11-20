/**
 * @spfn/auth - a sign-in made by a server action records the browser's address (#363)
 *
 * A server action signs in through the package's client: a request from the
 * Next.js server to its own proxy, which forwards it to the backend. The backend
 * sits behind proxy-guard in strict mode, with the same proxy key as the app, as
 * a deployment that turned the guard on runs it. The browser's address is named
 * only by the request the action runs for (`x-forwarded-for` through
 * `next/headers`); the device row and the sign-in guard must both see it.
 *
 * | Row | Checks |
 * | --- | --- |
 * | C8 | `registeredIp` of the new key and `attempt.ip` told to `admit` and `settled` are the browser's address |
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

const BROWSER = '203.0.113.7';

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        get: () => undefined,
        getAll: () => [],
        set: () => undefined,
        delete: () => undefined,
    }),
    // The browser request the server action runs for
    headers: async () => new Headers({ host: 'app.test', 'x-forwarded-for': BROWSER }),
}));

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: vi.fn().mockResolvedValue({ success: true }), sendSMS: vi.fn().mockResolvedValue({ success: true }) };
});

import { createAuthApi } from '@spfn/auth';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountProxy } from '../helpers/rpc-proxy';
import { userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { authenticate } from '@/server/middleware/authenticate';
import type { SignInAttempt, SignInOutcome } from '@/server/lib/sign-in-guard';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, createProxyGuard, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { configureSignIn, resetSignInGuardForTests } = await import('@/server/lib/sign-in-guard');

const dbAvailable = await isDatabaseAvailable();

const PROXY_SECRET = 'c8-proxy-guard-secret-at-least-32-characters';
const OWNER = 'owner@test.com';
const PASSWORD = 'Password123!';

/** The backend as `startServer` mounts it with `.proxyGuard({ mode: 'strict' })`. */
function guardedBackendApp(): Hono
{
    const app = new Hono();

    app.use('*', createProxyGuard({ mode: 'strict', secret: PROXY_SECRET }));
    registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
    app.onError(ErrorHandler());

    return app;
}

describe.skipIf(!dbAvailable)('a server action\'s sign-in records the browser\'s address (#363)', () =>
{
    const admitted: SignInAttempt[] = [];
    const settled: SignInOutcome[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'http://app.test';
    });

    afterAll(async () =>
    {
        resetSignInGuardForTests();
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        const userRole = await getRoleByName('user');
        await getTestDb().insert(users).values({
            email: OWNER, passwordHash: await hashPassword(PASSWORD), roleId: userRole!.id, emailVerifiedAt: new Date(),
        });

        resetSignInGuardForTests();
        configureSignIn({
            admit: (attempt) => void admitted.push(attempt),
            settled: (outcome) => void settled.push(outcome),
        });
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('C8: the new key\'s registeredIp and the guard\'s attempt.ip are the browser\'s address, not the Next.js server\'s', async () =>
    {
        // The app's proxy key, on both sides: the proxy signs with it, the action asserts with it
        vi.stubEnv('SPFN_PROXY_SECRET', PROXY_SECRET);
        mountProxy(guardedBackendApp(), {}, { proxySecret: PROXY_SECRET });

        // The server action
        await createAuthApi().login.call({ body: { email: OWNER, password: PASSWORD } });

        const [owner] = await getTestDb().select().from(users).where(eq(users.email, OWNER));
        const keys = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, owner.id));

        expect(keys.map(key => key.registeredIp)).toEqual([BROWSER]);
        expect(new Set(admitted.map(attempt => attempt.ip))).toEqual(new Set([BROWSER]));
        expect(settled.map(outcome => [outcome.result, outcome.ip])).toEqual([['succeeded', BROWSER]]);
    });
});
