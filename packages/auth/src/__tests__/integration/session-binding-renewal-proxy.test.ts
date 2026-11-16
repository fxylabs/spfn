/**
 * @spfn/auth - a session bound on the server is asked to renew, not signed out (PR #326 review U3)
 *
 * Every row enters through the proxy as an app mounts it — `createRpcProxy` with
 * `authInterceptors` (`helpers/rpc-proxy.ts`) — with the real backend app behind
 * it on a real database. The browser is a cookie jar whose session was sealed
 * before its key was bound, so the cookie says unbound; the key row says bound.
 *
 * | Row | Checks |
 * | --- | --- |
 * | R1 | a legacy key bound at its first use through the proxy (S1): expired inside its grace → 401 |
 * |    | `SessionRenewalRequiredError`, cookies kept; past its grace → `KeyExpiredError`, cookies cleared |
 * | R2 | another web session bound when the owner turned binding on (T3): expired inside its grace → the |
 * |    | renewal prompt, cookies kept; renewed with the passkey through the proxy → the cookie sealed |
 * |    | bound, as the backend answered; that key past its grace → cleared |
 *
 * Time moves by shifting a key's stored expiry, never by waiting.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

vi.mock('next/headers.js', () => ({
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined }),
    headers: async () => new Headers({ host: 'app.test' }),
}));

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mountProxy, type MountedProxy } from '../helpers/rpc-proxy';
import { userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { unsealSession } from '@/server/lib/session';
import { COOKIE_NAMES } from '@/server/lib/config';
import { CSRF_HEADER } from '@/server/lib/csrf';
import { BOUND_KEY_RENEW_GRACE_HOURS } from '@/server/lib/key-policy';
import { authenticate } from '@/server/middleware/authenticate';
import { routeMap as authRouteMap } from '@/generated/route-map';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const PASSWORD = 'Password123!';
const OWNER = 'owner@test.com';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HOUR_MS = 60 * 60 * 1000;
const INSIDE_GRACE_MS = 60_000;
const PAST_GRACE_MS = (BOUND_KEY_RENEW_GRACE_HOURS + 1) * HOUR_MS;

interface Browsed
{
    status: number;
    body: any;
    setCookies: string[];
}

/** The backend app as `startServer` mounts it; every request is the trusted proxy's (`clientType: 'web'`). */
function backendApp(): Hono
{
    const app = new Hono();

    app.use('*', async (c, next) =>
    {
        c.set('clientType' as never, 'web' as never);
        await next();
    });
    registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
    app.onError(ErrorHandler());

    return app;
}

/** Apply `Set-Cookie` lines to a jar the way a browser does; `Max-Age=0` removes the name. */
function applySetCookies(jar: Map<string, string>, setCookies: string[]): void
{
    for (const line of setCookies)
    {
        const [pair] = line.split(';');
        const name = pair.slice(0, pair.indexOf('='));

        if (/Max-Age=0(;|$)/.test(line))
        {
            jar.delete(name);
        }
        else
        {
            jar.set(name, pair.slice(pair.indexOf('=') + 1));
        }
    }
}

function sessionCleared(setCookies: string[]): boolean
{
    return setCookies.some(line => line.startsWith(`${COOKIE_NAMES.SESSION}=`) && /Max-Age=0(;|$)/.test(line));
}

describe.skipIf(!dbAvailable)('a session bound on the server is asked to renew at its key\'s expiry (U3)', () =>
{
    let app: Hono;
    let proxy: MountedProxy;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        app = backendApp();
    });

    afterAll(async () =>
    {
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();

        await db.insert(users).values({
            email: OWNER,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        });

        proxy = mountProxy(app);
    });

    afterEach(() =>
    {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    /** A browser call through the proxy, its `Set-Cookie` applied to the jar. */
    async function browse(jar: Map<string, string>, path: string, input: Record<string, unknown> = {}): Promise<Browsed>
    {
        const routeName = Object.entries(authRouteMap).find(([, entry]) => entry.path === path && entry.method === 'POST')![0];
        const csrf = jar.get(COOKIE_NAMES.CSRF);
        const response = await proxy.call(routeName, { body: input }, {
            cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') || undefined,
            headers: { 'user-agent': CHROME, ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
        });
        const setCookies = response.headers.getSetCookie();

        applySetCookies(jar, setCookies);

        return { status: response.status, body: await response.json().catch(() => null), setCookies };
    }

    /** A browser signed in through the proxy while the account is unbound: its cookie says nothing of binding. */
    async function browserSignedIn(): Promise<{ jar: Map<string, string>; keyId: string }>
    {
        const jar = new Map<string, string>();

        expect((await browse(jar, '/_auth/login', { email: OWNER, password: PASSWORD })).status).toBe(200);
        expect((await unsealSession(jar.get(COOKIE_NAMES.SESSION)!)).binding).toBeUndefined();

        return { jar, keyId: jar.get(COOKIE_NAMES.SESSION_KEY_ID)! };
    }

    /** The owner's other device, straight at the backend: signs in, enrols a passkey, turns binding on. */
    async function bindFromAnotherDevice(): Promise<FixtureAuthenticator>
    {
        const key = generateKeyPair('ES256');
        const login = await direct('/_auth/login', {
            email: OWNER, password: PASSWORD, publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm,
        });
        expect(login.status).toBe(200);
        const authorization = () => `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
        const authenticator = await FixtureAuthenticator.create();
        const options = await (await direct('/_auth/passkeys/register/options', {}, authorization())).json();
        const attestation = authenticator.attest({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID });

        expect((await direct('/_auth/passkeys/register/verify', { response: attestation }, authorization())).status).toBe(200);
        expect((await enableBinding((path, body) => direct(path, body, authorization()), authenticator, { origin: ORIGIN, rpId: RP_ID })).status).toBe(200);

        return authenticator;
    }

    async function direct(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        return await app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'user-agent': CHROME, ...(authorization ? { Authorization: authorization } : {}) },
            body: JSON.stringify(body),
        });
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function expireKey(keyId: string, agoMs: number): Promise<void>
    {
        await getTestDb().update(userPublicKeys).set({ expiresAt: new Date(Date.now() - agoMs) }).where(eq(userPublicKeys.keyId, keyId));
    }

    /** The key, expired inside its grace: the renewal prompt, the cookies kept. */
    async function expectRenewalPrompt(jar: Map<string, string>, keyId: string): Promise<void>
    {
        await expireKey(keyId, INSIDE_GRACE_MS);
        const sealed = jar.get(COOKIE_NAMES.SESSION);

        const answered = await browse(jar, '/_auth/keys/list');

        expect(answered.status).toBe(401);
        expect(answered.body.error.code).toBe('SessionRenewalRequiredError');
        expect(sessionCleared(answered.setCookies)).toBe(false);
        expect(jar.get(COOKIE_NAMES.SESSION)).toBe(sealed);
    }

    /** The key, past its grace: the backend's refusal, the session cleared. */
    async function expectCleared(jar: Map<string, string>, keyId: string): Promise<void>
    {
        await expireKey(keyId, PAST_GRACE_MS);

        const answered = await browse(jar, '/_auth/keys/list');

        expect(answered.status).toBe(401);
        expect(answered.body.error.code).toBe('KeyExpiredError');
        expect(sessionCleared(answered.setCookies)).toBe(true);
        expect(jar.has(COOKIE_NAMES.SESSION)).toBe(false);
    }

    it('R1 (RV-S1P): a legacy key bound at its first use through the proxy — inside its grace the renewal prompt, cookies kept; past it cleared', async () =>
    {
        const browser = await browserSignedIn();
        // As the `via_web_proxy` migration finds a key registered before the column existed
        await getTestDb().update(userPublicKeys).set({ viaWebProxy: false }).where(eq(userPublicKeys.keyId, browser.keyId));
        await bindFromAnotherDevice();
        expect((await keyRow(browser.keyId)).binding).toBe('none');

        expect((await browse(browser.jar, '/_auth/keys/list')).status).toBe(200);
        await vi.waitFor(async () => expect((await keyRow(browser.keyId)).binding).toBe('passkey'));
        expect((await unsealSession(browser.jar.get(COOKIE_NAMES.SESSION)!)).binding).toBeUndefined();

        await expectRenewalPrompt(browser.jar, browser.keyId);
        await expectCleared(browser.jar, browser.keyId);
    });

    it('R2 (T3): another web session bound when the owner turned binding on — the renewal prompt, a renewal sealed bound, then cleared past grace', async () =>
    {
        const browser = await browserSignedIn();
        const authenticator = await bindFromAnotherDevice();
        expect((await keyRow(browser.keyId)).binding).toBe('passkey');

        await expectRenewalPrompt(browser.jar, browser.keyId);

        const options = await browse(browser.jar, '/_auth/session/renew/options');
        expect(options.status).toBe(200);
        const response = authenticator.assert({ challenge: options.body.challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 });
        const renewed = await browse(browser.jar, '/_auth/session/renew/verify', { response });
        expect(renewed.status).toBe(200);

        const session = await unsealSession(browser.jar.get(COOKIE_NAMES.SESSION)!);
        const renewedRow = await keyRow(session.keyId);
        expect(session.keyId).not.toBe(browser.keyId);
        expect(session.binding).toBe('passkey');
        expect(session.keyExpiresAt).toBe(renewedRow.expiresAt!.getTime());
        expect(renewedRow.binding).toBe('passkey');

        await expectCleared(browser.jar, session.keyId);
    });
});
