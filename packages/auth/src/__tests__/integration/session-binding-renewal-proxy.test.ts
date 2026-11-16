/**
 * @spfn/auth - a bound session through the proxy: asked to renew, not signed out
 * (PR #326 review U3), and checked against its key row's browser family by the
 * backend (bundle 8 part 2, au8-A1)
 *
 * Every row enters through the proxy as an app mounts it — `createRpcProxy` with
 * `authInterceptors` (`helpers/rpc-proxy.ts`) — with the real backend app behind
 * it on a real database. The browser is a cookie jar; no cookie carries a copy of
 * the binding, the key row says bound. T5a/T5b enter one step earlier, through
 * the real server-side client (`createAuthApi`) inside a simulated Next.js
 * request scope (`next/headers` answers the browser's cookies and `user-agent`).
 *
 * | Row | Checks |
 * | --- | --- |
 * | R1 | a legacy key bound at its first use through the proxy (S1): expired inside its grace → 401 |
 * |    | `SessionRenewalRequiredError`, cookies kept; past its grace → `KeyExpiredError`, cookies cleared |
 * | R2 | another web session bound when the owner turned binding on (T3): expired inside its grace → the |
 * |    | renewal prompt, cookies kept; renewed with the passkey through the proxy → a new bound key, |
 * |    | the cookie holding no copy of the binding; that key past its grace → cleared |
 * | T5a | a server component's `api.` call for a bound session registered from Chrome, rendering a Chrome |
 * |     | request → 200, the backend seeing Chrome's `user-agent`. Without it: au8-A1 again — every |
 * |     | server-rendered page of a bound account signed out |
 * | T5b | the same call rendering a Firefox request → 401 `SessionContextChangedError`, the session cookies |
 * |     | cleared by the decision. Without it: the check silently off |
 * | T5c | R1's session, bound on the server under a cookie sealed unbound, presented from Firefox → |
 * |     | refused. Without it: the gap the check moved to the backend for |
 * | T5d | a bound key with no recorded family is admitted from anywhere; a passkey renewal from Chrome records |
 * |     | `chrome`, a renewal from a newer Chrome keeps it, and Firefox is refused. Without it: the family |
 * |     | silently re-recorded from whoever renews |
 * | T5e | sign-out of a bound session from Firefox → the key revoked, the cookies cleared. Without it: the |
 * |     | owner cannot end a session from a changed browser |
 * | F1 | the `clear_server_hop_ua_family` migration's statement, run on a bound key whose family a sign-in |
 * |    | through a server-side hop recorded as `other`: refused from Chrome before, admitted after. Without |
 * |    | it: such owners signed out at upgrade, and locked out whenever they enable binding later |
 * | F2 | the same statement leaves a key of family `chrome` as it was: Firefox still refused |
 * | E1 | a bound key expired inside its grace, presented from Firefox → 401 `SessionContextChangedError`, |
 * |    | cookies cleared, no renewal prompt. Without it: a copy from another browser treated as the |
 * |    | owner's session at every expiry |
 * | E2 | the same key from Chrome → the renewal prompt, cookies kept |
 * | E3 | an expired bound key's request with a wrong signature → `InvalidTokenError`, not the expired |
 * |    | answer. Without it: anyone holding a key id learns that the key is expired and renewable |
 *
 * Time moves by shifting a key's stored expiry, never by waiting.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

/** The browser request a server component renders for — what `next/headers` answers inside it. */
const rendering = vi.hoisted(() => ({ cookies: new Map<string, string>(), userAgent: undefined as string | undefined }));

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        get: (name: string) => (rendering.cookies.has(name) ? { name, value: rendering.cookies.get(name) } : undefined),
        getAll: () => [...rendering.cookies].map(([name, value]) => ({ name, value })),
        set: () => undefined,
        delete: () => undefined,
    }),
    headers: async () => new Headers({ host: 'app.test', ...(rendering.userAgent ? { 'user-agent': rendering.userAgent } : {}) }),
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
import { createAuthApi } from '@/index';
import { SessionContextChangedError } from '@/errors';

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
const CHROME_NEWER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0';
const HOUR_MS = 60 * 60 * 1000;
const INSIDE_GRACE_MS = 60_000;
const PAST_GRACE_MS = (BOUND_KEY_RENEW_GRACE_HOURS + 1) * HOUR_MS;

/** The `clear_server_hop_ua_family` migration's statement, as it will run on upgrade. */
const CLEAR_OTHER_FAMILY = readFileSync(resolve(__dirname, '../../../migrations/20261116140755_clear_server_hop_ua_family/migration.sql'), 'utf8')
    .split('\n')
    .filter(line => !line.startsWith('--'))
    .join('\n')
    .trim();

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
        rendering.cookies = new Map();
        rendering.userAgent = undefined;
    });

    afterEach(() =>
    {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    /** A browser call through the proxy, its `Set-Cookie` applied to the jar. */
    async function browse(jar: Map<string, string>, path: string, input: Record<string, unknown> = {}, userAgent = CHROME): Promise<Browsed>
    {
        const routeName = Object.entries(authRouteMap).find(([, entry]) => entry.path === path && entry.method === 'POST')![0];
        const csrf = jar.get(COOKIE_NAMES.CSRF);
        const response = await proxy.call(routeName, { body: input }, {
            cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') || undefined,
            headers: { 'user-agent': userAgent, ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
        });
        const setCookies = response.headers.getSetCookie();

        applySetCookies(jar, setCookies);

        return { status: response.status, body: await response.json().catch(() => null), setCookies };
    }

    /** A browser signed in through the proxy while the account is unbound. No cookie says anything of binding. */
    async function browserSignedIn(): Promise<{ jar: Map<string, string>; keyId: string }>
    {
        const jar = new Map<string, string>();

        expect((await browse(jar, '/_auth/login', { email: OWNER, password: PASSWORD })).status).toBe(200);
        expect(await unsealSession(jar.get(COOKIE_NAMES.SESSION)!)).not.toHaveProperty('binding');

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
        expect(await unsealSession(browser.jar.get(COOKIE_NAMES.SESSION)!)).not.toHaveProperty('binding');

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
        expect(session).not.toHaveProperty('binding');
        expect(renewedRow.binding).toBe('passkey');

        await expectCleared(browser.jar, session.keyId);
    });

    /** Renew an expired bound key with the passkey through the proxy, from `userAgent`; answers the new key id. */
    async function renewFrom(jar: Map<string, string>, authenticator: FixtureAuthenticator, counter: number, userAgent: string): Promise<string>
    {
        const options = await browse(jar, '/_auth/session/renew/options', {}, userAgent);
        expect(options.status).toBe(200);
        const response = authenticator.assert({ challenge: options.body.challenge, origin: ORIGIN, rpId: RP_ID, counter });
        expect((await browse(jar, '/_auth/session/renew/verify', { response }, userAgent)).status).toBe(200);

        return jar.get(COOKIE_NAMES.SESSION_KEY_ID)!;
    }

    /** A server component rendering `userAgent`'s request for `jar`: `api.getAuthSession.call()`, and the proxy's answer. */
    async function renderSession(jar: Map<string, string>, userAgent: string): Promise<{ result: unknown; setCookies: string[] }>
    {
        rendering.cookies = new Map(jar);
        rendering.userAgent = userAgent;
        vi.stubEnv('SPFN_APP_URL', '');

        const calls = vi.mocked(fetch).mock.results.length;
        const result = await createAuthApi().getAuthSession.call({}).catch((error: unknown) => error);
        // The client's own call — the first this render made; the proxy's call to the backend follows it
        const answered = await vi.mocked(fetch).mock.results[calls].value as Response;

        return { result, setCookies: answered.headers.getSetCookie() };
    }

    it('T5a: a server component\'s api call for a session bound in Chrome, rendering a Chrome request → 200, and the backend sees Chrome', async () =>
    {
        const browser = await browserSignedIn();
        await bindFromAnotherDevice();
        expect((await keyRow(browser.keyId)).registeredUaFamily).toBe('chrome');

        const { result } = await renderSession(browser.jar, CHROME);

        expect(result).toMatchObject({ userId: expect.any(Number), email: OWNER });
        expect(proxy.backendCalls.at(-1)!.headers.get('user-agent')).toBe(CHROME);
    });

    it('T5b: the same call rendering a Firefox request → 401 SessionContextChangedError, the session cookies cleared by the decision', async () =>
    {
        const browser = await browserSignedIn();
        await bindFromAnotherDevice();

        const { result, setCookies } = await renderSession(browser.jar, FIREFOX);

        expect(result).toBeInstanceOf(SessionContextChangedError);
        expect((result as SessionContextChangedError).statusCode).toBe(401);
        expect(sessionCleared(setCookies)).toBe(true);
    });

    it('T5c: R1\'s session, bound at its first use under a cookie sealed unbound, presented from Firefox → refused, cleared', async () =>
    {
        const browser = await browserSignedIn();
        await getTestDb().update(userPublicKeys).set({ viaWebProxy: false }).where(eq(userPublicKeys.keyId, browser.keyId));
        await bindFromAnotherDevice();
        expect((await browse(browser.jar, '/_auth/keys/list')).status).toBe(200);
        await vi.waitFor(async () => expect((await keyRow(browser.keyId)).binding).toBe('passkey'));

        const answered = await browse(browser.jar, '/_auth/keys/list', {}, FIREFOX);

        expect(answered.status).toBe(401);
        expect(answered.body.error.code).toBe('SessionContextChangedError');
        expect(sessionCleared(answered.setCookies)).toBe(true);
    });

    it('T5d: a bound key with no recorded family is admitted; a renewal from Chrome records chrome, a newer Chrome keeps it, Firefox is refused', async () =>
    {
        const browser = await browserSignedIn();
        const authenticator = await bindFromAnotherDevice();
        // As a key that predates the column, or the migration's clearing of a Node user-agent, leaves it
        await getTestDb().update(userPublicKeys).set({ registeredUaFamily: null }).where(eq(userPublicKeys.keyId, browser.keyId));
        expect((await browse(browser.jar, '/_auth/keys/list', {}, FIREFOX)).status).toBe(200);

        await expireKey(browser.keyId, INSIDE_GRACE_MS);
        const renewedKeyId = await renewFrom(browser.jar, authenticator, 1, CHROME);
        expect((await keyRow(renewedKeyId)).registeredUaFamily).toBe('chrome');

        await expireKey(renewedKeyId, INSIDE_GRACE_MS);
        const secondRenewal = await renewFrom(browser.jar, authenticator, 2, CHROME_NEWER);
        expect((await keyRow(secondRenewal)).registeredUaFamily).toBe('chrome');

        const refused = await browse(browser.jar, '/_auth/keys/list', {}, FIREFOX);
        expect(refused.status).toBe(401);
        expect(refused.body.error.code).toBe('SessionContextChangedError');
    });

    it('T5e: sign-out of a bound session from Firefox → the key revoked, the cookies cleared', async () =>
    {
        const browser = await browserSignedIn();
        await bindFromAnotherDevice();

        const answered = await browse(browser.jar, '/_auth/logout', {}, FIREFOX);

        expect(answered.status).toBe(204);
        expect((await keyRow(browser.keyId)).isActive).toBe(false);
        expect(sessionCleared(answered.setCookies)).toBe(true);
    });

    it('F1: a bound key whose family a server-side hop recorded as other → refused from Chrome before the migration, admitted after', async () =>
    {
        // Before this release a sign-in through the SPFN client on the server sent `user-agent: node`
        const jar = new Map<string, string>();
        expect((await browse(jar, '/_auth/login', { email: OWNER, password: PASSWORD }, 'node')).status).toBe(200);
        const keyId = jar.get(COOKIE_NAMES.SESSION_KEY_ID)!;
        await bindFromAnotherDevice();
        expect(await keyRow(keyId)).toMatchObject({ binding: 'passkey', registeredUaFamily: 'other' });

        const before = await browse(new Map(jar), '/_auth/keys/list', {}, CHROME);
        expect(before.body.error.code).toBe('SessionContextChangedError');

        await getTestDb().execute(sql.raw(CLEAR_OTHER_FAMILY));

        expect((await keyRow(keyId)).registeredUaFamily).toBeNull();
        expect((await browse(jar, '/_auth/keys/list', {}, CHROME)).status).toBe(200);
    });

    it('F2: the same statement leaves a key of family chrome as it was: Firefox is still refused', async () =>
    {
        const browser = await browserSignedIn();
        await bindFromAnotherDevice();

        await getTestDb().execute(sql.raw(CLEAR_OTHER_FAMILY));

        expect((await keyRow(browser.keyId)).registeredUaFamily).toBe('chrome');
        const refused = await browse(browser.jar, '/_auth/keys/list', {}, FIREFOX);
        expect(refused.status).toBe(401);
        expect(refused.body.error.code).toBe('SessionContextChangedError');
    });

    it('E1: a bound key expired inside its grace, presented from Firefox → 401 SessionContextChangedError, cookies cleared, no renewal prompt', async () =>
    {
        const browser = await browserSignedIn();
        await bindFromAnotherDevice();
        await expireKey(browser.keyId, INSIDE_GRACE_MS);

        const answered = await browse(browser.jar, '/_auth/keys/list', {}, FIREFOX);

        expect(answered.status).toBe(401);
        expect(answered.body.error.code).toBe('SessionContextChangedError');
        expect(sessionCleared(answered.setCookies)).toBe(true);
        expect((await keyRow(browser.keyId)).isActive).toBe(true);
    });

    it('E2: the same key from Chrome → the renewal prompt, cookies kept', async () =>
    {
        const browser = await browserSignedIn();
        await bindFromAnotherDevice();

        await expectRenewalPrompt(browser.jar, browser.keyId);
    });

    it('E3: an expired bound key\'s request with a wrong signature → InvalidTokenError, not the expired answer', async () =>
    {
        const browser = await browserSignedIn();
        await bindFromAnotherDevice();
        await expireKey(browser.keyId, INSIDE_GRACE_MS);
        const forged = generateClientToken({ keyId: browser.keyId }, generateKeyPair('ES256').privateKey, 'ES256', { expiresIn: '5m' });

        const answered = await direct('/_auth/keys/list', {}, `Bearer ${forged}`);

        expect(answered.status).toBe(401);
        expect((await answered.json()).error.code).toBe('InvalidTokenError');
    });
});
