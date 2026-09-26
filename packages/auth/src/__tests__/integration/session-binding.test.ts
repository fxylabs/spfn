/**
 * @spfn/auth - session binding, end to end (design #97 v2, case tables 6a, 6b, 6g)
 *
 * Real HTTP against the mounted auth router, one `it` per row of the three
 * tables, with the row's own text in the title.
 *
 * Two things the bare router does not give us, supplied here the way a real
 * deployment gives them:
 *
 * `clientType` is what `proxy-guard` sets, and session binding may only be turned
 * on where the backend can recognise the trusted Next.js proxy. The middleware
 * below sets it from a test header, so "proxy-guard configured" and "proxy-guard
 * not configured" are both reachable rows rather than an environment.
 *
 * The session cookie is the Next.js proxy's, not the router's — the rows about
 * what the cookie carries live in `unit/session-binding-proxy.test.ts`. What is
 * asserted here is the response body the interceptor re-seals from, and the key
 * rows behind it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

/**
 * `saveSession` writes through next/headers; the row about it is the only thing
 * in this file that touches the cookie jar, so the jar is a Map.
 */
const savedCookies = new Map<string, string>();

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        get: (name: string) => (savedCookies.has(name) ? { name, value: savedCookies.get(name) } : undefined),
        set: (name: string, value: string) => savedCookies.set(name, value),
        delete: (name: string) => savedCookies.delete(name),
    }),
}));

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import { BOUND_KEY_TTL_HOURS, KEY_TTL_DAYS } from '@/server/lib/key-policy';
import { COOKIE_NAMES } from '@/server/lib/config';
import { routeMap } from '@/generated/route-map';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { authApi } = await import('@spfn/auth');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Header the test middleware reads instead of running proxy-guard for real. */
const CLIENT_TYPE_HEADER = 'x-test-client-type';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Session
{
    authorization: string;
    keyId: string;
    privateKey: string;
}

describe.skipIf(!dbAvailable)('session binding (case tables 6a, 6b, 6g)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;

        app = new Hono();
        app.use('*', async (c, next) =>
        {
            const declared = c.req.header(CLIENT_TYPE_HEADER);

            if (declared)
            {
                c.set('clientType', declared);
            }

            await next();
        });
        // A route behind optionalAuth, which the auth router does not carry: row
        // 6b.3 is about what that middleware does with an expired bound key, and
        // it has to be asked on a route that uses it. Mounted on the bare Hono
        // app so the router's own shape is untouched.
        app.get('/_test/optional', optionalAuth.handler, async (c) => c.json({ signedIn: Boolean(c.get('auth')) }));

        registerRoutes(app, mainAuthRouter, [
            { name: authenticate.name, handler: authenticate.handler },
        ]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
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

    function send(method: string, path: string, body: unknown, session?: Session, proxied = true)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'user-agent': CHROME };

        if (session)
        {
            headers.Authorization = session.authorization;
        }

        if (proxied)
        {
            headers[CLIENT_TYPE_HEADER] = 'web';
        }

        return app.request(path, {
            method,
            headers,
            ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        });
    }

    const post = (path: string, body: unknown, session?: Session, proxied = true) =>
        send('POST', path, body, session, proxied);

    const get = (path: string, session?: Session, proxied = true) =>
        send('GET', path, undefined, session, proxied);

    /** Sign in exactly as a browser does, through a request the proxy signed. */
    async function signIn(proxied = true): Promise<Session>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: 'owner@test.com',
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        }, undefined, proxied);

        expect(response.status).toBe(200);

        return {
            authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`,
            keyId: keyPair.keyId,
            privateKey: keyPair.privateKey,
        };
    }

    /** Enroll a passkey on the caller's session and answer the authenticator. */
    async function enrollPasskey(session: Session): Promise<FixtureAuthenticator>
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session);
        const { challenge } = await options.json();
        const verify = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
        }, session);

        expect(verify.status).toBe(200);

        return authenticator;
    }

    /** Sign in, enroll a passkey, and turn binding on. */
    async function boundSession(): Promise<{ session: Session; authenticator: FixtureAuthenticator }>
    {
        const session = await signIn();
        const authenticator = await enrollPasskey(session);
        const enabled = await post('/_auth/session/binding', { mode: 'passkey' }, session);

        expect(enabled.status).toBe(200);

        return { session, authenticator };
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function userRow()
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, 'owner@test.com')).limit(1);

        return row;
    }

    /** Move a key's expiry, which is how every "expired" row is reached. */
    async function expireKey(keyId: string, agoMs: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ expiresAt: new Date(Date.now() - agoMs) })
            .where(eq(userPublicKeys.keyId, keyId));
    }

    /** Age the device key so `assertRecentAuthentication`'s window has passed. */
    async function ageSession(session: Session, minutes: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(userPublicKeys.keyId, session.keyId));
    }

    // ========================================================================
    // 6a. Turning binding on and off
    // ========================================================================

    describe('6a. the binding setting', () =>
    {
        it('proxy-guard not configured, { mode: passkey }: 400 SessionBindingUnavailableError, the setting does not move', async () =>
        {
            const session = await signIn(false);
            await enrollPasskey(session);

            const response = await post('/_auth/session/binding', { mode: 'passkey' }, session, false);

            expect(response.status).toBe(400);
            expect((await response.json()).__type).toBe('SessionBindingUnavailableError');
            expect((await userRow()).sessionBinding).toBe('none');
        });

        it('no passkey, { mode: passkey }: 400, the setting does not move', async () =>
        {
            const session = await signIn();

            const response = await post('/_auth/session/binding', { mode: 'passkey' }, session);

            expect(response.status).toBe(400);
            expect((await userRow()).sessionBinding).toBe('none');
        });

        it('a passkey, no recent authentication: RecentAuthenticationRequiredError', async () =>
        {
            const session = await signIn();
            await enrollPasskey(session);
            await ageSession(session, 60);

            const response = await post('/_auth/session/binding', { mode: 'passkey' }, session);

            expect(response.status).toBe(403);
            expect((await response.json()).__type).toBe('RecentAuthenticationRequiredError');
            expect((await userRow()).sessionBinding).toBe('none');
        });

        it('a passkey and recent authentication: 200 { keyExpiresAtMillis }, users updated, the current key binding=passkey and expiring in about 24h', async () =>
        {
            const session = await signIn();
            await enrollPasskey(session);

            const response = await post('/_auth/session/binding', { mode: 'passkey' }, session);
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.mode).toBe('passkey');
            expect((await userRow()).sessionBinding).toBe('passkey');

            const key = await keyRow(session.keyId);
            expect(key.binding).toBe('passkey');
            expect(key.expiresAt!.getTime()).toBe(body.keyExpiresAtMillis);
            expect(Math.abs(key.expiresAt!.getTime() - (Date.now() + BOUND_KEY_TTL_HOURS * HOUR_MS))).toBeLessThan(60_000);
        });

        it('already on, { mode: passkey } again: 200, and the expiry is not recomputed', async () =>
        {
            const { session } = await boundSession();
            const before = (await keyRow(session.keyId)).expiresAt!.getTime();

            const response = await post('/_auth/session/binding', { mode: 'passkey' }, session);

            expect(response.status).toBe(200);
            expect((await response.json()).keyExpiresAtMillis).toBe(before);
            expect((await keyRow(session.keyId)).expiresAt!.getTime()).toBe(before);
        });

        it('just turned on, GET binding: { mode: passkey, keyExpiresAtMillis }', async () =>
        {
            const { session } = await boundSession();

            const response = await get('/_auth/session/binding', session);
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.mode).toBe('passkey');
            expect(body.keyExpiresAtMillis).toBe((await keyRow(session.keyId)).expiresAt!.getTime());
        });

        it('on, a cookie copied within ten minutes of signing in, { mode: none } with no credential: refused', async () =>
        {
            // The copied cookie's key is minutes old, which is the whole of what
            // `assertRecentAuthentication` asks for. It must not be enough here.
            const { session } = await boundSession();

            const response = await post('/_auth/session/binding', { mode: 'none' }, session);

            expect(response.status).toBe(403);
            expect((await response.json()).__type).toBe('RecentAuthenticationRequiredError');
            expect((await userRow()).sessionBinding).toBe('passkey');
            expect((await keyRow(session.keyId)).binding).toBe('passkey');
        });

        it('on, { mode: none, currentPassword }: 200, every bound key back to none and 90 days', async () =>
        {
            const { session } = await boundSession();

            const response = await post('/_auth/session/binding', { mode: 'none', currentPassword: PASSWORD }, session);

            expect(response.status).toBe(200);
            expect((await response.json()).mode).toBe('none');
            expect((await userRow()).sessionBinding).toBe('none');

            const key = await keyRow(session.keyId);
            expect(key.binding).toBe('none');
            expect(Math.abs(key.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);
        });

        it('two devices, binding turned off on one: the other device\'s key is unbound and 90-day, and it keeps working past its old bound expiry', async () =>
        {
            // The disable rewrites every active key, not just the caller's. The
            // second device's cookie still says `binding: 'passkey'` with the old
            // expiry, and that is now a stale hint the proxy decides nothing by —
            // the row it is really running on is an ordinary 90-day one.
            const { session: first } = await boundSession();
            const second = await signIn();

            expect((await keyRow(second.keyId)).binding).toBe('passkey');

            expect((await post('/_auth/session/binding', { mode: 'none', currentPassword: PASSWORD }, first)).status).toBe(200);

            const key = await keyRow(second.keyId);
            expect(key.binding).toBe('none');
            expect(Math.abs(key.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);

            // Past the moment the old cookie believes the key ran out.
            expect((await post('/_auth/keys/list', {}, second)).status).toBe(200);
        });

        it('on, { mode: none, response } with an assertion: 200, the same result', async () =>
        {
            const { session, authenticator } = await boundSession();
            const options = await post('/_auth/session/binding/disable/options', {}, session);
            const { challenge } = await options.json();

            const response = await post('/_auth/session/binding', {
                mode: 'none',
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 2 }),
            }, session);

            expect(response.status).toBe(200);
            expect((await userRow()).sessionBinding).toBe('none');

            const key = await keyRow(session.keyId);
            expect(key.binding).toBe('none');
            expect(Math.abs(key.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);
        });

        it('on, asked from a key that is not itself bound: { mode: passkey } with no keyExpiresAtMillis', async () =>
        {
            const { session } = await boundSession();
            // A key registered on a channel the proxy never touched — a native
            // client's. The account is bound; this session is not.
            const native = await signIn(false);

            const response = await get('/_auth/session/binding', native);
            const body = await response.json();

            expect(body.mode).toBe('passkey');
            expect(body.keyExpiresAtMillis).toBeUndefined();
            expect((await keyRow(session.keyId)).binding).toBe('passkey');
        });
    });

    // ========================================================================
    // 6b. A bound key meeting a request
    // ========================================================================

    describe('6b. the bound key against the middlewares', () =>
    {
        it('bound, before expiry, authenticate: 200', async () =>
        {
            const { session } = await boundSession();

            expect((await post('/_auth/keys/list', {}, session)).status).toBe(200);
        });

        it('bound, after expiry, authenticate: 401 KeyExpiredError', async () =>
        {
            const { session } = await boundSession();
            await expireKey(session.keyId, 1_000);

            const response = await post('/_auth/keys/list', {}, session);

            expect(response.status).toBe(401);
            expect((await response.json()).__type).toBe('KeyExpiredError');
        });

        it('bound, after expiry, an optionalAuth route: passes anonymously', async () =>
        {
            const { session } = await boundSession();
            await expireKey(session.keyId, 1_000);

            const response = await get('/_test/optional', session);

            expect(response.status).toBe(200);
            expect((await response.json()).signedIn).toBe(false);
        });

        it('bound, expired, past the grace too: 401, and the key is still active and visible on listKeys as expired', async () =>
        {
            const { session } = await boundSession();
            await expireKey(session.keyId, 400 * HOUR_MS);

            expect((await post('/_auth/keys/list', {}, session)).status).toBe(401);

            const key = await keyRow(session.keyId);
            expect(key.isActive).toBe(true);
            expect(key.expiresAt!.getTime()).toBeLessThan(Date.now());
        });

        it('bound, renewal completed: the old key is revoked with "Replaced by bound-session renewal"', async () =>
        {
            const { session, authenticator } = await boundSession();
            await expireKey(session.keyId, 1_000);

            // Signed by the expired key itself — which is what the proxy sends on
            // these two paths, and the only thing that names the key being renewed.
            const expiring = {
                ...session,
                authorization: `Bearer ${generateClientToken({ keyId: session.keyId }, session.privateKey, 'ES256', { expiresIn: '5m' })}`,
            };
            const options = await post('/_auth/session/renew/options', {}, expiring);
            const { challenge } = await options.json();
            const fresh = generateKeyPair('ES256');
            const verify = await post('/_auth/session/renew/verify', {
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 2 }),
                publicKey: fresh.publicKey,
                keyId: fresh.keyId,
                fingerprint: fresh.fingerprint,
                algorithm: fresh.algorithm,
            }, expiring);

            expect(verify.status).toBe(200);

            const old = await keyRow(session.keyId);
            expect(old.isActive).toBe(false);
            expect(old.revokedReason).toBe('Replaced by bound-session renewal');

            const replacement = {
                authorization: `Bearer ${generateClientToken({ keyId: fresh.keyId }, fresh.privateKey, 'ES256', { expiresIn: '5m' })}`,
                keyId: fresh.keyId,
                privateKey: fresh.privateKey,
            };
            expect((await post('/_auth/keys/list', {}, replacement)).status).toBe(200);
        });

        it('an expired bound key re-registered under the same keyId by a login: not extended to 90 days, the expiry stands', async () =>
        {
            const { session } = await boundSession();
            await expireKey(session.keyId, 1_000);
            const expiry = (await keyRow(session.keyId)).expiresAt!.getTime();

            const login = await app.request('/_auth/login', {
                method: 'POST',
                headers: { ...JSON_HEADERS, [CLIENT_TYPE_HEADER]: 'web' },
                body: JSON.stringify({
                    email: 'owner@test.com',
                    password: PASSWORD,
                    ...reRegistration(session.keyId),
                }),
            });

            expect(login.status).toBe(200);
            expect((await keyRow(session.keyId)).expiresAt!.getTime()).toBe(expiry);
        });

        it('unbound: everything answers exactly as it does today, sign-in body and listKeys row alike', async () =>
        {
            const keyPair = generateKeyPair('ES256');
            const login = await post('/_auth/login', {
                email: 'owner@test.com',
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
            });
            const body = await login.json();
            const session = {
                authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`,
                keyId: keyPair.keyId,
                privateKey: keyPair.privateKey,
            };

            // Absence, field by field: this is the shape a 0.11.x client parses,
            // and a sign-in that started naming the default would change it.
            expect(login.status).toBe(200);
            expect(body.sessionBinding).toBeUndefined();
            expect(body.keyExpiresAtMillis).toBeUndefined();

            const key = await keyRow(session.keyId);
            expect(key.binding).toBe('none');
            expect(Math.abs(key.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);

            const listed = await post('/_auth/keys/list', {}, session);
            const entry = (await listed.json()).keys.find((row: { keyId: string }) => row.keyId === session.keyId);

            expect(listed.status).toBe(200);
            // Absent rather than `'none'` — the same rule the sign-in body follows,
            // so a row for an account that did not opt in has the fields it had.
            expect(entry.binding).toBeUndefined();
            expect(entry.concurrentUseAtMillis).toBeUndefined();
            expect(entry).not.toHaveProperty('lastSeenIp');
        });

        it('a bound account signing in with a non-web clientType: binding=none and 90 days, even when the body declares platform web', async () =>
        {
            await boundSession();
            const keyPair = generateKeyPair('ES256');

            const response = await app.request('/_auth/login', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    email: 'owner@test.com',
                    password: PASSWORD,
                    platform: 'web',
                    publicKey: keyPair.publicKey,
                    keyId: keyPair.keyId,
                    fingerprint: keyPair.fingerprint,
                    algorithm: keyPair.algorithm,
                }),
            });

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.sessionBinding).toBeUndefined();

            const key = await keyRow(keyPair.keyId);
            expect(key.platform).toBe('web');
            expect(key.binding).toBe('none');
            expect(Math.abs(key.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);
        });
    });

    // ========================================================================
    // 6g. Rotation and the unbound regression
    // ========================================================================

    describe('6g. rotation, the route map, and the unbound regression', () =>
    {
        it('rotateKey on a bound key: the new key is bound, keeps the old expiry, and inherits the provenance', async () =>
        {
            const { session } = await boundSession();
            const before = await keyRow(session.keyId);
            const fresh = generateKeyPair('ES256');

            const response = await post('/_auth/keys/rotate', {
                publicKey: fresh.publicKey,
                keyId: fresh.keyId,
                fingerprint: fresh.fingerprint,
                algorithm: fresh.algorithm,
            }, session);

            expect(response.status).toBe(200);

            const rotated = await keyRow(fresh.keyId);
            expect(rotated.binding).toBe('passkey');
            expect(rotated.expiresAt!.getTime()).toBe(before.expiresAt!.getTime());
            expect(rotated.registeredIp).toBe(before.registeredIp);
            expect(rotated.registeredUserAgent).toBe(before.registeredUserAgent);
            expect(rotated.registeredUaFamily).toBe('chrome');
        });

        it('rotateKey on an unbound key: the provenance carries over and the ninety days start again', async () =>
        {
            // The key being replaced is aged first, which is the whole of the row.
            // Rotating a key registered seconds ago cannot tell "inherit the old
            // expiry" from "compute a fresh ninety days" — both land on the same
            // day — so the replaced key is moved to 30 days out and the assertion
            // then means one of the two.
            const session = await signIn();
            const aged = new Date(Date.now() + 30 * DAY_MS);
            await getTestDb().update(userPublicKeys)
                .set({ expiresAt: aged })
                .where(eq(userPublicKeys.keyId, session.keyId));
            const before = await keyRow(session.keyId);
            const fresh = generateKeyPair('ES256');

            expect((await post('/_auth/keys/rotate', {
                publicKey: fresh.publicKey,
                keyId: fresh.keyId,
                fingerprint: fresh.fingerprint,
                algorithm: fresh.algorithm,
            }, session)).status).toBe(200);

            const rotated = await keyRow(fresh.keyId);
            expect(rotated.binding).toBe('none');
            expect(rotated.registeredUaFamily).toBe(before.registeredUaFamily);
            expect(rotated.expiresAt!.getTime()).not.toBe(before.expiresAt!.getTime());
            expect(Math.abs(rotated.expiresAt!.getTime() - (Date.now() + KEY_TTL_DAYS * DAY_MS))).toBeLessThan(60_000);
        });

        it('an app calling saveSession() by hand: the fields are optional there, so it seals an unbound session', async () =>
        {
            const { saveSession } = await import('@/nextjs/session-helpers');
            const { unsealSession } = await import('@/server/lib/session');
            const keyPair = generateKeyPair('ES256');

            savedCookies.clear();
            await saveSession({
                userId: '1',
                privateKey: keyPair.privateKey,
                keyId: keyPair.keyId,
                algorithm: 'ES256',
            });

            const session = await unsealSession(savedCookies.get(COOKIE_NAMES.SESSION)!);
            expect(session.binding).toBeUndefined();
            expect(session.keyExpiresAt).toBeUndefined();
            expect(session.uaFamily).toBeUndefined();
        });

        it('the route map: authApi exposes the five new routes at the paths the design names', () =>
        {
            expect(routeMap).toMatchObject({
                setSessionBinding: { method: 'POST', path: '/_auth/session/binding' },
                getSessionBinding: { method: 'GET', path: '/_auth/session/binding' },
                sessionBindingDisableOptions: { method: 'POST', path: '/_auth/session/binding/disable/options' },
                sessionRenewOptions: { method: 'POST', path: '/_auth/session/renew/options' },
                sessionRenewVerify: { method: 'POST', path: '/_auth/session/renew/verify' },
            });

            for (const name of Object.keys(routeMap).filter(key => key.includes('Session')))
            {
                expect(typeof (authApi as Record<string, { call?: unknown }>)[name]?.call).toBe('function');
            }
        });

        it('the contract: the four optional fields, the KeyBinding enum, and the bundle at 0.13.1 or later', async () =>
        {
            const { buildMobileContractBundle, CONTRACT_SUPPORTED_RANGE, CONTRACT_VERSION } =
                await import('@/server/client-proof/contract-bundle');
            const bundle = buildMobileContractBundle() as {
                types: { name: string; fields: { name: string; type: string; optional: boolean }[] }[];
                enums: { name: string; values: string[] }[];
            };
            const fieldsOf = (name: string) => bundle.types.find(type => type.name === name)!.fields;

            expect(CONTRACT_VERSION.localeCompare('0.13.1', undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
            expect(CONTRACT_SUPPORTED_RANGE).toBe('>=0.13.0 <0.14.0');
            expect(bundle.enums).toContainEqual({ name: 'KeyBinding', values: ['none', 'passkey'] });

            // Optional throughout: a consumer generated against 0.11.x reads
            // nothing whose shape changed.
            expect(fieldsOf('KeySummary')).toEqual(expect.arrayContaining([
                { name: 'binding', type: 'KeyBinding', optional: true },
                { name: 'concurrentUseAtMillis', type: 'integer', optional: true },
            ]));
            expect(fieldsOf('LoginResponse')).toEqual(expect.arrayContaining([
                { name: 'sessionBinding', type: 'KeyBinding', optional: true },
                { name: 'keyExpiresAtMillis', type: 'integer', optional: true },
            ]));
            // An approved device-auth poll *is* the login the approval produced,
            // so it carries the same two fields — and they are optional there for
            // the additional reason that the pending branch carries neither.
            expect(fieldsOf('PollDeviceAuthResponse')).toEqual(expect.arrayContaining([
                { name: 'sessionBinding', type: 'KeyBinding', optional: true },
                { name: 'keyExpiresAtMillis', type: 'integer', optional: true },
            ]));
            expect(fieldsOf('KeySummary').every(field => field.name !== 'lastSeenIp')).toBe(true);
            // Every field this change added is optional on every type that took
            // one, which is what makes 0.11.x consumers read nothing new.
            for (const type of ['KeySummary', 'LoginResponse', 'PollDeviceAuthResponse'])
            {
                const added = fieldsOf(type).filter(field =>
                    ['binding', 'concurrentUseAtMillis', 'sessionBinding', 'keyExpiresAtMillis'].includes(field.name));

                expect(added.every(field => field.optional)).toBe(true);
            }
        });

        it('an unbound account: authenticate makes one key-repository read and one last-used write, as it did before', async () =>
        {
            // Repository calls, not queries: `resolveAuthenticatedUser`'s own reads
            // are outside this count, and always were. What the row pins is that
            // the binding work added neither a lookup nor a write to the hot path.
            // The instance `authenticate` holds, which it imports through the
            // package entry rather than from the source tree.
            const { keysRepository } = await import('@spfn/auth/server');
            const find = vi.spyOn(keysRepository, 'findActiveByKeyId');
            const write = vi.spyOn(keysRepository, 'updateLastUsedById');

            const session = await signIn();
            find.mockClear();
            write.mockClear();

            expect((await post('/_auth/keys/list', {}, session)).status).toBe(200);

            expect(find).toHaveBeenCalledTimes(1);
            expect(write).toHaveBeenCalledTimes(1);
        });
    });

    /** The device-key fields of a login that re-presents a key already registered. */
    function reRegistration(keyId: string): Record<string, string>
    {
        const keyPair = generateKeyPair('ES256');

        return {
            publicKey: keyPair.publicKey,
            keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        };
    }
});
