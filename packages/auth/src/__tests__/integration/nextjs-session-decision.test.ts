/**
 * @spfn/auth - the Next.js proxy decides the session once per response (bundle 11, w-hk36p)
 *
 * Every row enters through the proxy as an app mounts it — `createRpcProxy` with
 * `authInterceptors` and this package's route map (`helpers/rpc-proxy.ts`) — with
 * the real backend app behind it on a real database. A browser here is a cookie
 * jar: each call sends the jar and its CSRF token, and every `Set-Cookie` the
 * proxy answers with is applied to it.
 *
 * | Row | Checks |
 * | --- | --- |
 * | T1 | every session-establishing route × incoming cookie (none, valid, unreadable, expired): one session cookie, the new session, no clear after it |
 * | T2 | each error code the server can answer: the key-refused family clears the session, every other code keeps it |
 * | T3 | each unsealing failure kind: the cookie is cleared on that response |
 * | T4 | sealing fails in the response phase: the typed 5xx, and no active key left from that sign-in |
 * | T5 | social sign-in completion naming another user: `getSession().userId` is the signed-in user's |
 * | T6 | after sign-out no cookie of this package remains |
 * | T7 | `SPFN_AUTH_COOKIE_SECURE=false` under production: no `Secure` on any cookie of any writer |
 * | T8 | `remember: true` → kept lifetime; `remember: '30d'` → 400; absent → default lifetime |
 * | T9 | a guard over a 503 / a refused connection: no redirect, cookies kept; over a refused key: signed out |
 * | T10 | every establishing path (and social → 202 → `mfa/verify`) over a previous session: the same account's key is no longer active, another account's is left |
 * | T11 | `TokenExpiredError`: one re-signed retry, session kept; refused again: passed through, session kept |
 *
 * No secret printed by these tests is a real one.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

const seams = vi.hoisted(() => ({
    /** The jar `next/headers` answers with, for `getSession`, `saveSession` and the guards. */
    jar: new Map<string, string>(),
    /** What `next/headers`' `cookies().set` and `.delete` were asked to write. */
    written: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
    /** Where a guard sent the browser. */
    redirected: [] as string[],
}));

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        get: (name: string) => (seams.jar.has(name) ? { name, value: seams.jar.get(name)! } : undefined),
        getAll: () => [...seams.jar].map(([name, value]) => ({ name, value })),
        set: (name: string, value: string, options: Record<string, unknown>) => void seams.written.push({ name, value, options }),
        delete: (name: string) => void seams.written.push({ name, value: '', options: { maxAge: 0 } }),
    }),
    // The host a server component's api. call resolves the app's own URL from
    headers: async () => new Headers({ host: 'app.test' }),
}));

// A guard's redirect, recorded; it throws as Next's does.
vi.mock('next/navigation', () => ({
    redirect: (path: string) =>
    {
        seams.redirected.push(path);

        throw new Error('redirected');
    },
}));

// `react` is the host app's; the guards' JSX needs a runtime, never called by these rows.
vi.mock('react/jsx-runtime', () => ({ jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }));
vi.mock('react/jsx-dev-runtime', () => ({ jsxDEV: () => null, Fragment: Symbol('Fragment') }));

// The package's client, built as `createAuthApi()` builds it, over whatever `fetch`
// is in place when it is called — the proxy `mountProxy` routes to.
vi.mock('@spfn/auth', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/auth')>();

    return { ...actual, authApi: actual.createAuthApi({ fetch: (input, init) => globalThis.fetch(input, init) }) };
});

// T4 makes one seal fail; every other caller gets the real sealer.
vi.mock('@/server/lib/session', async (importActual) =>
{
    const actual = await importActual<typeof import('@/server/lib/session')>();

    return { ...actual, sealSession: vi.fn(actual.sealSession) };
});

// T11 makes the proxy's request token arrive expired; every other caller gets the real signer.
vi.mock('@/server/lib/crypto', async (importActual) =>
{
    const actual = await importActual<typeof import('@/server/lib/crypto')>();

    return { ...actual, generateClientToken: vi.fn(actual.generateClientToken) };
});

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: (...args: unknown[]) => sendEmail(...args), sendSMS: vi.fn().mockResolvedValue({ success: true }) };
});

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mountProxy, type MountedProxy, type ProxiedBackend } from '../helpers/rpc-proxy';
import { userInvitations, userPublicKeys, users, verificationCodes } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashCredential } from '@/server/lib/link-credentials';
import { readSealedSession, sealSession, unsealSession, type SessionData } from '@/server/lib/session';
import { COOKIE_NAMES } from '@/server/lib/config';
import { authLogger } from '@/server/logger';
import { CSRF_HEADER, deriveCsrfToken } from '@/server/lib/csrf';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { verifyOAuthState } from '@/server/lib/oauth/state';
import { __resetSecondFactorPolicyForTests, configureSecondFactor } from '@/server/lib/second-factor-policy';
import { registerOAuthProvider } from '@/server/lib/oauth';
import { SESSION_ENDING_CODES } from '@/server/lib/admission-refusal';
import { authenticate } from '@/server/middleware/authenticate';
import { oneTimeTokenAuth } from '@/server/middleware/one-time-token-auth';
import { opsTokenAuth } from '@/server/middleware/ops-token-auth';
import { UnauthorizedError } from '@spfn/core/errors';
import { registerPublicKeyService } from '@/server/services/key.service';
import { routeMap as authRouteMap } from '@/generated/route-map';
import { packageCookieNames } from '@/nextjs/cookie-names';
import { clearSessionCookies } from '@/nextjs/cookie-writer';
import { getSession, saveSession, clearSession } from '@/nextjs/session-helpers';
import { createOAuthCallbackHandler } from '@/nextjs/oauth-handlers';
import { authInterceptors, sessionDecisionInterceptor } from '@/nextjs/interceptors';
import { authErrorRegistry } from '@/errors';
import { errorRegistry as coreErrorRegistry } from '@spfn/core/errors';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, createProxyGuard, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { settleLinkMail } = await import('@/server/lib/link-mail-delivery');
const { initOneTimeTokenManager } = await import('@/server/lib/one-time-token');

const dbAvailable = await isDatabaseAvailable();

const SECRET = 'test-secret-key-for-testing-only-min-32-chars';
const ROTATED_SECRET = 'a-secret-this-server-no-longer-uses-min-32-chars';
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'BrandNewPassword456!';
const OWNER = 'owner@test.com';
const OTHER = 'other@test.com';
const MFA_USER = 'mfa@test.com';
const NEWCOMER = 'newcomer@test.com';
const INVITEE = 'invitee@test.com';
const INVITER = 'inviter@test.com';
const INVITATION_TOKEN = '6f1d3c2a-8b4e-4f7a-9c1d-2e3f4a5b6c7d';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const TWELVE_HOURS = 12 * 3600;
const FOURTEEN_DAYS = 14 * 24 * 3600;

type KeyPair = ReturnType<typeof generateKeyPair>;

/** What a browser call answered with, its `Set-Cookie` lines, and the jar after them. */
interface Browsed
{
    status: number;
    body: any;
    setCookies: string[];
}

/** The backend app as `startServer` mounts it; every request is from the trusted proxy (`clientType: 'web'`). */
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

/** The route-map name of a path, as the isomorphic client calls it. */
function routeNameOf(path: string, method = 'POST'): string
{
    const entry = Object.entries(authRouteMap).find(([, route]) => route.path === path && route.method === method);

    if (!entry)
    {
        throw new Error(`no route ${method} ${path}`);
    }

    return entry[0];
}

/** Apply `Set-Cookie` lines to a jar the way a browser does; `Max-Age=0` removes the name. */
function applySetCookies(jar: Map<string, string>, setCookies: string[]): void
{
    for (const line of setCookies)
    {
        const [pair] = line.split(';');
        const name = pair.slice(0, pair.indexOf('='));
        const value = pair.slice(pair.indexOf('=') + 1);

        if (/Max-Age=0(;|$)/.test(line))
        {
            jar.delete(name);
        }
        else
        {
            jar.set(name, value);
        }
    }
}

/** The `Set-Cookie` lines for one name. */
function writesOf(setCookies: string[], name: string): string[]
{
    return setCookies.filter(line => line.startsWith(`${name}=`));
}

function maxAgeOf(line: string): number
{
    return Number(/Max-Age=(-?\d+)/.exec(line)?.[1]);
}

function valueOf(line: string): string
{
    return line.split(';')[0].split('=').slice(1).join('=');
}

/** The cookie lines a refusal or a decision cleared the session with. */
function sessionCleared(setCookies: string[]): boolean
{
    return writesOf(setCookies, COOKIE_NAMES.SESSION).some(line => maxAgeOf(line) === 0);
}

/** Every `establish` caller's path list, read from the rules themselves. */
function establishingPaths(): string[]
{
    const dir = join(__dirname, '../../nextjs/interceptors');
    const callers = readdirSync(dir)
        .filter(file => file !== 'session-decision.ts')
        .filter(file => /\bestablish\(ctx,/.test(readFileSync(join(dir, file), 'utf8')));

    return callers.flatMap((file) =>
    {
        const source = readFileSync(join(dir, file), 'utf8');
        const declared = /export const ESTABLISHING_PATHS = \[([^\]]*)\]/.exec(source);

        expect(declared, `${file} calls establish() and must export ESTABLISHING_PATHS`).not.toBeNull();

        return [...declared![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    });
}

/** What each caller of `takeRemember` exports as `REMEMBER_PATHS` — the paths it takes `remember` on. */
async function rememberDeclarations(): Promise<Array<{ file: string; declared: unknown }>>
{
    const dir = join(__dirname, '../../nextjs/interceptors');
    const callers = readdirSync(dir)
        .filter(file => file !== 'remember.ts')
        .filter(file => /\btakeRemember\(ctx\)/.test(readFileSync(join(dir, file), 'utf8')));

    return await Promise.all(callers.map(async file => ({ file, declared: (await import(join(dir, file))).REMEMBER_PATHS })));
}

const REMEMBER_DECLARATIONS = await rememberDeclarations();

/** Every path a sign-in takes `remember` on. */
function rememberPaths(): string[]
{
    return REMEMBER_DECLARATIONS.flatMap(({ declared }) => (Array.isArray(declared) ? declared as string[] : []));
}

describe.skipIf(!dbAvailable)('the Next.js proxy decides the session once per response (bundle 11)', () =>
{
    let app: Hono;
    let proxy: MountedProxy;
    let expiredSessionCookie: string;
    let totpCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = SECRET;
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'http://app.test';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString('base64')}`;

        registerOAuthProvider({
            id: 'superself',
            isEnabled: () => true,
            pkce: 'S256',
            getAuthUrl: (state: string) => `https://mock.example.com/auth?state=${encodeURIComponent(state)}`,
            exchangeCodeForTokens: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
            getUserInfo: async () => ({ providerUserId: 'p-1', email: OWNER, emailVerified: true }),
        });

        app = backendApp();
        initOneTimeTokenManager();

        // A session this server sealed, past its lifetime by the time any row reads it
        expiredSessionCookie = await sealSession(sessionData(generateKeyPair('ES256'), '1'), 1);
        await new Promise(resolve => setTimeout(resolve, 1100));
    });

    afterAll(async () =>
    {
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();
        sendEmail.mockClear();
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
        seams.jar = new Map();
        seams.written = [];

        const userRole = await getRoleByName('user');
        const passwordHash = await hashPassword(PASSWORD);
        await db.insert(users).values([OWNER, OTHER, MFA_USER].map(email => ({
            email, passwordHash, roleId: userRole!.id, emailVerifiedAt: new Date(),
        })));

        proxy = mountProxy(app);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.mocked(sealSession).mockClear();
        vi.mocked(generateClientToken).mockClear();
    });

    // ========================================================================
    // The browser, the backend, and the accounts
    // ========================================================================

    /** A call through the proxy, as the browser behind `jar` makes it. */
    async function browse(
        jar: Map<string, string>,
        path: string,
        input: Record<string, unknown> = {},
        options: { method?: 'GET' | 'POST'; via?: MountedProxy } = {},
    ): Promise<Browsed>
    {
        const method = options.method ?? 'POST';
        const csrf = jar.get(COOKIE_NAMES.CSRF);
        const response = await (options.via ?? proxy).call(routeNameOf(path, method), input, {
            method,
            cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') || undefined,
            headers: { 'user-agent': CHROME, ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
        });
        const setCookies = response.headers.getSetCookie();

        applySetCookies(jar, setCookies);
        await settleLinkMail();

        return { status: response.status, body: await response.json().catch(() => null), setCookies };
    }

    /** A request straight at the backend — the steps a row needs that are not the browser's. */
    async function direct(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        const response = await app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'user-agent': CHROME, ...(authorization ? { Authorization: authorization } : {}) },
            body: JSON.stringify(body),
        });
        await settleLinkMail();

        return response;
    }

    function bearer(key: { keyId: string; privateKey: string }): string
    {
        return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    function keyFields(key: KeyPair)
    {
        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    function sessionData(key: KeyPair, userId: string, extra: Partial<SessionData> = {}): SessionData
    {
        return { userId, privateKey: key.privateKey, keyId: key.keyId, algorithm: 'ES256', ...extra };
    }

    async function userId(email: string): Promise<string>
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, email)).limit(1);

        return String(row.id);
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    /** A password sign-in straight at the backend: a device of `email`, signing its own requests. */
    async function signedInDevice(email: string): Promise<{ key: KeyPair; authorization: string }>
    {
        const key = generateKeyPair('ES256');
        const response = await direct('/_auth/login', { email, password: PASSWORD, ...keyFields(key) });

        expect(response.status).toBe(200);

        return { key, authorization: bearer(key) };
    }

    /** A browser holding a valid session for `email`'s live key, with its CSRF cookie. */
    async function validJar(email: string, extra: Partial<SessionData> = {}): Promise<{ jar: Map<string, string>; key: KeyPair }>
    {
        const { key } = await signedInDevice(email);
        const jar = new Map([
            [COOKIE_NAMES.SESSION, await sealSession(sessionData(key, await userId(email), extra))],
            [COOKIE_NAMES.SESSION_KEY_ID, key.keyId],
            [COOKIE_NAMES.CSRF, await deriveCsrfToken(key.keyId)],
        ]);

        return { jar, key };
    }

    /** A session cookie sealed before `SPFN_AUTH_SESSION_SECRET` was rotated. */
    async function unreadableSessionCookie(): Promise<string>
    {
        process.env.SPFN_AUTH_SESSION_SECRET = ROTATED_SECRET;
        const sealed = await sealSession(sessionData(generateKeyPair('ES256'), '1'));
        process.env.SPFN_AUTH_SESSION_SECRET = SECRET;

        return sealed;
    }

    /** The four browsers a sign-in can arrive at. */
    async function incomingJar(state: 'none' | 'valid' | 'unreadable' | 'expired'): Promise<Map<string, string>>
    {
        switch (state)
        {
            case 'none':
                return new Map();
            case 'valid':
                return (await validJar(OTHER)).jar;
            case 'unreadable':
                return new Map([[COOKIE_NAMES.SESSION, await unreadableSessionCookie()]]);
            case 'expired':
                return new Map([[COOKIE_NAMES.SESSION, expiredSessionCookie]]);
        }
    }

    function emailedToken(template: string): string
    {
        const sent = sendEmail.mock.calls.filter(([arg]) => arg?.template === template);

        return new URL(sent[sent.length - 1][0].data.confirmUrl).searchParams.get('token')!;
    }

    async function registrationToken(email: string): Promise<string>
    {
        await direct('/_auth/codes', { target: email, targetType: 'email', purpose: 'registration' });

        const [codeRow] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);
        const verified = await direct('/_auth/codes/verify', { target: email, targetType: 'email', code: codeRow.code, purpose: 'registration' });

        return (await verified.json()).verificationToken;
    }

    async function passkeyFor(email: string): Promise<FixtureAuthenticator>
    {
        const device = await signedInDevice(email);
        const authenticator = await FixtureAuthenticator.create();
        const options = await direct('/_auth/passkeys/register/options', {}, device.authorization);
        const verify = await direct('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
        }, device.authorization);

        expect(verify.status).toBe(200);

        return authenticator;
    }

    async function passkeyAssertion(authenticator: FixtureAuthenticator): Promise<unknown>
    {
        const challenge = (await (await direct('/_auth/passkeys/login/options', {})).json()).challenge;

        return authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: ++totpCounter });
    }

    function totpCode(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    // ========================================================================
    // A successful sign-in on each establishing path, through the proxy
    // ========================================================================

    /** Body fields a row adds to the request that starts a sign-in, and to the one that completes it. */
    type Extra = Record<string, unknown>;

    /**
     * Each establishing path, driven to its 200 from the browser behind `jar`.
     * `start` joins the body of the request that starts the sign-in, `finish` the
     * body of the one that completes it — the same request for a one-step sign-in.
     */
    const DRIVERS: Record<string, (jar: Map<string, string>, start?: Extra, finish?: Extra) => Promise<Browsed>> = {
        '/_auth/login': (jar, start = {}, finish = {}) => browse(jar, '/_auth/login', { body: { email: OWNER, password: PASSWORD, ...start, ...finish } }),

        '/_auth/register': async (jar, start = {}, finish = {}) => browse(jar, '/_auth/register', {
            body: { email: NEWCOMER, verificationToken: await registrationToken(NEWCOMER), password: PASSWORD, ...start, ...finish },
        }),

        '/_auth/invitations/accept': async (jar, start = {}, finish = {}) =>
        {
            // An invitation confers its role on its inviter's authority, read again at acceptance
            const [inviter] = await getTestDb().insert(users).values({
                email: INVITER, passwordHash: await hashPassword(PASSWORD), roleId: (await getRoleByName('admin'))!.id, emailVerifiedAt: new Date(),
            }).returning({ id: users.id });
            const userRole = await getRoleByName('user');
            await getTestDb().insert(userInvitations).values({
                email: INVITEE,
                tokenHash: hashCredential(INVITATION_TOKEN),
                roleId: userRole!.id,
                invitedBy: Number(inviter.id),
                status: 'pending',
                expiresAt: new Date(Date.now() + 86_400_000),
            });

            return await browse(jar, '/_auth/invitations/accept', { body: { token: INVITATION_TOKEN, password: PASSWORD, ...start, ...finish } });
        },

        '/_auth/signup/password': async (jar, start = {}, finish = {}) =>
        {
            expect((await direct('/_auth/signup/email', { email: NEWCOMER })).status).toBe(200);
            const { setupSecret } = await (await direct('/_auth/signup/email/confirm', { token: emailedToken('signup-link') })).json();

            return await browse(jar, '/_auth/signup/password', { body: { setupSecret, password: PASSWORD, ...start, ...finish } });
        },

        '/_auth/password/reset/complete': async (jar, start = {}, finish = {}) =>
        {
            expect((await direct('/_auth/password/reset', { email: OWNER })).status).toBe(200);
            const { setupSecret } = await (await direct('/_auth/password/reset/confirm', { token: emailedToken('password-reset') })).json();

            return await browse(jar, '/_auth/password/reset/complete', { body: { setupSecret, password: NEW_PASSWORD, ...start, ...finish } });
        },

        '/_auth/passkeys/login/verify': async (jar, start = {}, finish = {}) =>
        {
            const authenticator = await passkeyFor(OWNER);

            return await browse(jar, '/_auth/passkeys/login/verify', { body: { response: await passkeyAssertion(authenticator), ...start, ...finish } });
        },

        '/_auth/mfa/verify': async (jar, start = {}, finish = {}) =>
        {
            const secret = await enrolledTotp(MFA_USER);
            const stepUp = await browse(jar, '/_auth/login', { body: { email: MFA_USER, password: PASSWORD, ...start } });
            expect(stepUp.status).toBe(202);

            return await browse(jar, '/_auth/mfa/verify', { body: { challenge: stepUp.body.challenge.secret, code: totpCode(secret, 1), ...finish } });
        },

        '/_auth/device/link/poll': async (jar, start = {}, finish = {}) =>
        {
            const owner = await signedInDevice(OWNER);
            const { linkId, userCode } = await (await direct('/_auth/device/link/issue', {}, owner.authorization)).json();
            const redeemed = await browse(jar, '/_auth/device/link/redeem/web', { body: { userCode, deviceName: 'Office PC', ...start } });
            expect((await direct('/_auth/device/link/confirm', { linkId, choice: redeemed.body.matchNumber }, owner.authorization)).status).toBe(200);

            return await browse(jar, '/_auth/device/link/poll', { body: { deviceCode: redeemed.body.deviceCode, ...finish } });
        },

        '/_auth/device/poll': async (jar, start = {}, finish = {}) =>
        {
            const owner = await signedInDevice(OWNER);
            const started = await browse(jar, '/_auth/device/start/web', { body: { deviceName: 'Office PC', ...start } });
            expect((await direct('/_auth/device/approve', { userCode: started.body.userCode }, owner.authorization)).status).toBe(200);

            return await browse(jar, '/_auth/device/poll', { body: { deviceCode: started.body.deviceCode, ...finish } });
        },

        '/_auth/oauth/finalize': async (jar, start = {}, finish = {}) =>
        {
            const started = await browse(jar, '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/', ...start } });
            const state = await verifyOAuthState(new URL(started.body.authUrl).searchParams.get('state')!);

            // The backend callback registers the start's key to the account the
            // provider vouched for; the browser then completes it.
            await registerPublicKeyService({
                userId: Number(await userId(OWNER)),
                keyId: state.keyId,
                publicKey: state.publicKey,
                fingerprint: state.fingerprint,
                algorithm: state.algorithm,
                channel: 'oauth',
            });

            return await browse(jar, '/_auth/oauth/finalize', { body: { keyId: state.keyId, returnUrl: '/', ...finish } });
        },

        // Authenticated by the session being replaced, so only a valid one can reach them
        '/_auth/keys/rotate': async jar => browse(jar, '/_auth/keys/rotate', { body: {} }),

        '/_auth/session/renew/verify': async (jar) =>
        {
            const options = await browse(jar, '/_auth/session/renew/options', { body: {} });
            expect(options.status).toBe(200);

            return await browse(jar, '/_auth/session/renew/verify', {
                body: { response: renewing!.authenticator.assert({ challenge: options.body.challenge, origin: ORIGIN, rpId: RP_ID, counter: ++totpCounter }) },
            });
        },
    };

    /** Enrol a TOTP second factor for `email` from another device; its secret. */
    async function enrolledTotp(email: string): Promise<string>
    {
        const device = await signedInDevice(email);
        const secret = (await (await direct('/_auth/mfa/totp/enroll', {}, device.authorization)).json()).secret as string;
        expect((await direct('/_auth/mfa/totp/confirm', { code: totpCode(secret) }, device.authorization)).status).toBe(200);

        return secret;
    }

    /**
     * A social sign-in into an account with a second factor, completed: the
     * backend's callback answers with a challenge, `oauth/finalize` with 202, and
     * `mfa/verify` with the session (the reviewer's PROBE-N4b sequence).
     */
    async function socialStepUp(jar: Map<string, string>, start: Extra = {}, finish: Extra = {}): Promise<Browsed>
    {
        const secret = await enrolledTotp(OWNER);
        const started = await browse(jar, '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/', ...start } });
        const state = new URL(started.body.authUrl).searchParams.get('state')!;
        const callback = await app.request(`/_auth/oauth/superself/callback?code=x&state=${encodeURIComponent(state)}`, {
            headers: { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') },
        });
        const challenge = new URL(callback.headers.get('location')!).searchParams.get('mfaChallenge');
        expect(challenge, callback.headers.get('location')!).toBeTruthy();

        const accepted = await browse(jar, '/_auth/oauth/finalize', {
            body: { keyId: (await verifyOAuthState(state)).keyId, mfaChallenge: challenge, returnUrl: '/' },
        });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);

        return await browse(jar, '/_auth/mfa/verify', { body: { challenge, code: totpCode(secret, 1), ...finish } });
    }

    /** The account a bound renewal row renews, set by `boundJar`. */
    let renewing: { authenticator: FixtureAuthenticator } | undefined;

    /** A browser holding a bound session — binding on, its key bound — for the renewal path. */
    async function boundJar(): Promise<Map<string, string>>
    {
        const authenticator = await passkeyFor(OWNER);
        const device = await signedInDevice(OWNER);
        const bound = await enableBinding((path, body) => direct(path, body, device.authorization), authenticator, { origin: ORIGIN, rpId: RP_ID });
        expect(bound.status).toBe(200);
        renewing = { authenticator };

        const { keyExpiresAtMillis } = await bound.json();

        return new Map([
            [COOKIE_NAMES.SESSION, await sealSession(sessionData(device.key, await userId(OWNER), {
                binding: 'passkey',
                keyExpiresAt: keyExpiresAtMillis,
                uaFamily: 'chrome',
            }))],
            [COOKIE_NAMES.CSRF, await deriveCsrfToken(device.key.keyId)],
        ]);
    }

    /** The paths whose establishing request is signed by the session it replaces. */
    const SELF_AUTHENTICATED = new Set(['/_auth/keys/rotate', '/_auth/session/renew/verify']);

    // ========================================================================
    // T1 — every establishing route × every incoming cookie
    // ========================================================================

    const T1_ROWS = establishingPaths().flatMap(path => (SELF_AUTHENTICATED.has(path)
        ? [[path, 'valid'] as const]
        : (['none', 'valid', 'unreadable', 'expired'] as const).map(state => [path, state] as const)));

    it('T1: the establishing paths are read off the rules, and each has a driver', () =>
    {
        const paths = establishingPaths();

        expect(paths.length).toBeGreaterThanOrEqual(12);

        for (const path of paths)
        {
            expect(DRIVERS[path], `no T1 driver for ${path}`).toBeDefined();
        }
    });

    it.each(T1_ROWS)('T1 %s with a %s session cookie: one session cookie, the new session, no clear after it', async (path, state) =>
    {
        const jar = path === '/_auth/session/renew/verify'
            ? await boundJar()
            : (path === '/_auth/keys/rotate' ? (await validJar(OWNER)).jar : await incomingJar(state));
        const before = jar.get(COOKIE_NAMES.SESSION);

        const answer = await DRIVERS[path](jar);
        const writes = writesOf(answer.setCookies, COOKIE_NAMES.SESSION);

        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect(writes).toHaveLength(1);
        expect(maxAgeOf(writes[0])).toBeGreaterThan(0);

        const session = await unsealSession(valueOf(writes[0]));

        expect(valueOf(writes[0])).not.toBe(before);
        expect((await keyRow(session.keyId)).isActive).toBe(true);
        expect(String((await keyRow(session.keyId)).userId)).toBe(session.userId);
        expect(jar.get(COOKIE_NAMES.SESSION)).toBe(valueOf(writes[0]));
    });

    // ========================================================================
    // T2 — which backend refusals end the session
    // ========================================================================

    /** The key-refused family: this key or this account can no longer act. */
    const CLEARS = ['KeyRevokedError', 'AccountNotFoundError', 'AccountDisabledError', 'AccountPendingDeletionError', 'KeyExpiredError'];

    /** Every other code the server can answer: none of them says anything about the session. */
    const KEEPS = [
        'UnauthorizedError',
        'InvalidCredentialsError', 'InvalidTokenError', 'InvalidSocialTokenError', 'TokenExpiredError',
        'DeletionAlreadyRequestedError', 'DeletionNotRequestedError', 'ImmediateDeletionNotAllowedError',
        'AccountAlreadyExistsError', 'RegistrationRejectedError', 'ReservedUsernameError', 'UsernameAlreadyTakenError',
        'InvalidVerificationCodeError', 'InvalidVerificationTokenError', 'InvalidKeyFingerprintError',
        'KeyAlgorithmMismatchError', 'NonceKeyBindingError', 'NativeSignInUnsupportedError', 'UnverifiedEmailLinkError',
        'OAuthStateExpiredError', 'OAuthStateInvalidError', 'OAuthCookieMissingError', 'OAuthProviderError',
        'OAuthAccountNotFoundError', 'InvalidSignupLinkError', 'InvalidSignupSetupSessionError', 'PasswordResetLinkError',
        'PasswordResetSessionError', 'KeyNotFoundError', 'KeyIdAlreadyRegisteredError', 'RevokeAllLinkError',
        'InvitationNotFoundError', 'InvitationNoLongerValidError', 'InvitationChangedError', 'DeviceAuthNotFoundError',
        'DeviceAuthExpiredError', 'DeviceAuthAlreadyHandledError', 'DeviceAuthDeniedError', 'DeviceLinkNotFoundError',
        'DeviceLinkExpiredError', 'DeviceLinkNotRedeemedError', 'DeviceLinkAlreadyHandledError', 'DeviceLinkWrongMatchError',
        'DeviceLinkDeniedError', 'VerificationTokenPurposeMismatchError', 'VerificationTokenTargetMismatchError',
        'InsufficientPermissionsError', 'InsufficientRoleError', 'RoleEmailDomainNotAllowedError', 'PasskeyChallengeError',
        'PasskeyVerificationError', 'PasskeyNotFoundError', 'PasskeyAlreadyRegisteredError',
        'RecentAuthenticationRequiredError', 'LastRecoveryCredentialError', 'OAuthProviderAlreadyLinkedError',
        'OAuthSignInContendedError', 'OAuthLinkNotFoundError', 'OAuthProviderLinkOnlyError',
        'OAuthLinkCredentialUnsupportedError', 'DeferredCredentialUnsupportedError', 'OAuthEmailInUseError',
        'SignupDisabledError', 'ChannelDisabledError', 'PasskeyConfigError', 'SessionBindingUnavailableError',
        'SessionRenewalRequiredError', 'SessionRenewalRefusedError', 'SessionContextChangedError',
        'SessionResealFailedError', 'SessionSealFailedError', 'SessionDecisionMissingError', 'OAuth2UnknownClientError', 'OAuth2RedirectUriMismatchError',
        'OAuth2AuthorizeRedirectError', 'OAuth2GrantNotFoundError', 'MfaAlreadyEnrolledError', 'MfaNotEnrolledError',
        'MfaVerificationFailedError', 'StepUpRequiredError', 'SecondFactorEnrolmentRequiredError',
        'SecondFactorMethodDisabledError', 'SecondFactorRequiredError', 'MfaConfigError', 'SessionPendingMismatchError',
        'SessionPendingExpiredError', 'UserSettingNotDeclaredError', 'AccountBusyError', 'SecondFactorLockedError',
        'ConfigOwnedMappingError', 'ConfigOwnedRoleError', 'RoleInUseError', 'AuthorityContendedError', 'RbacSyncBusyError',
        'PasskeyUserVerificationRequiredError', 'PasskeyProofRequiredError',
        'HttpError', 'BadRequestError', 'ValidationError', 'ForbiddenError', 'NotFoundError', 'ConflictError', 'GoneError',
        'TooManyRequestsError', 'UnsupportedMediaTypeError', 'UnprocessableEntityError', 'InternalServerError',
        'ServiceUnavailableError', 'DatabaseError', 'ConnectionError', 'QueryError', 'EntityNotFoundError',
        'ConstraintViolationError', 'TransactionError', 'DeadlockError', 'DuplicateEntryError',
    ];

    /** Every class name the server's error registries can answer with. */
    function registryCodes(): Map<string, new (data?: any) => Error>
    {
        const registered = (registry: unknown) => (registry as { errors: Map<string, new (data?: any) => Error> }).errors;

        return new Map([...registered(coreErrorRegistry), ...registered(authErrorRegistry)]);
    }

    /** A backend whose one route answers with an instance of `ErrorClass`, through the real error handler. */
    function refusingBackend(ErrorClass: new (data?: any) => Error): Hono
    {
        const failing = new Hono();

        failing.post('/_t2/refuse', () =>
        {
            throw new ErrorClass({});
        });
        failing.onError(ErrorHandler());

        return failing;
    }

    it('T2: every code the registries hold is in exactly one column, and the clearing column is the server\'s key-refused family', () =>
    {
        const codes = [...registryCodes().keys()];

        expect(new Set([...CLEARS, ...KEEPS]).size).toBe(CLEARS.length + KEEPS.length);
        expect([...codes].sort()).toEqual([...CLEARS, ...KEEPS].sort());
        expect([...SESSION_ENDING_CODES].sort()).toEqual([...CLEARS].sort());
    });

    it.each([...CLEARS.map(code => [code, true] as const), ...KEEPS.map(code => [code, false] as const)])(
        'T2 %s answered to a valid session: cleared %s',
        async (code, clears) =>
        {
            const ErrorClass = registryCodes().get(code)!;
            const { jar } = await validJar(OWNER);
            const via = mountProxy(refusingBackend(ErrorClass) as ProxiedBackend, { t2Refuse: { method: 'POST', path: '/_t2/refuse' } });
            const csrf = jar.get(COOKIE_NAMES.CSRF)!;

            const response = await via.call('t2Refuse', { body: {} }, {
                cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
                headers: { 'user-agent': CHROME, [CSRF_HEADER]: csrf },
            });
            const body = await response.json();

            expect(body.error?.code ?? body.__type).toBe(code);
            expect(sessionCleared(response.headers.getSetCookie())).toBe(clears);
        },
    );

    // ------------------------------------------------------------------------
    // B1 — a 401 that is not the key-refused family leaves the session
    // ------------------------------------------------------------------------

    /** App routes behind other doors, as an app mounts them beside the auth router. */
    function otherDoorsBackend(): Hono
    {
        const doors = new Hono();

        doors.post('/_b1/ott', oneTimeTokenAuth.handler, c => c.json({ ok: true }));
        doors.post('/_b1/ops', opsTokenAuth.handler, c => c.json({ ok: true }));
        doors.post('/_b1/pin', authenticate.handler, () =>
        {
            throw new UnauthorizedError({ message: 'Wrong PIN' });
        });
        doors.onError(ErrorHandler());

        return doors;
    }

    const OTHER_DOORS = {
        b1Ott: { method: 'POST', path: '/_b1/ott' },
        b1Ops: { method: 'POST', path: '/_b1/ops' },
        b1Pin: { method: 'POST', path: '/_b1/pin' },
    } as const;

    it.each([
        ['a stale one-time token', 'b1Ott', { query: { token: 'stale-one-time-token' }, body: {} }, 'Invalid or expired one-time token'],
        ['an ops-token route', 'b1Ops', { body: {} }, 'Invalid ops token'],
        ['an app handler throwing UnauthorizedError', 'b1Pin', { body: {} }, 'Wrong PIN'],
    ] as const)('B1 %s with a valid session: the 401 passes through and the session is kept', async (_label, route, input, message) =>
    {
        const { jar } = await validJar(OWNER);
        const before = new Map(jar);
        const via = mountProxy(otherDoorsBackend() as ProxiedBackend, OTHER_DOORS);

        const refused = await via.call(route, input, {
            cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
            headers: { 'user-agent': CHROME, [CSRF_HEADER]: jar.get(COOKIE_NAMES.CSRF)! },
        });
        const body = await refused.json();

        expect(refused.status).toBe(401);
        expect(body.error.code).toBe('UnauthorizedError');
        expect(body.error.message).toBe(message);
        expect(sessionCleared(refused.headers.getSetCookie())).toBe(false);

        applySetCookies(jar, refused.headers.getSetCookie());

        for (const name of [COOKIE_NAMES.SESSION, COOKIE_NAMES.SESSION_KEY_ID, COOKIE_NAMES.CSRF])
        {
            expect(jar.get(name), name).toBe(before.get(name));
        }
    });

    it('B1 a missing Authorization cannot reach an authenticated route with a valid cookie: the proxy signs every such call', async () =>
    {
        const { jar, key } = await validJar(OWNER);
        const via = mountProxy(otherDoorsBackend() as ProxiedBackend, OTHER_DOORS);

        await via.call('b1Pin', { body: {} }, {
            cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
            headers: { 'user-agent': CHROME, [CSRF_HEADER]: jar.get(COOKIE_NAMES.CSRF)! },
        });

        expect(via.backendCalls.at(-1)?.headers.get('authorization')).toMatch(/^Bearer /);
        expect(via.backendCalls.at(-1)?.headers.get('x-key-id')).toBe(key.keyId);
    });

    it('B1 a revoked key answers KeyRevokedError, and the session is cleared', async () =>
    {
        const { jar, key } = await validJar(OWNER);
        await getTestDb().update(userPublicKeys).set({ isActive: false, revokedAt: new Date() }).where(eq(userPublicKeys.keyId, key.keyId));

        const answer = await browse(jar, '/_auth/session', {}, { method: 'GET' });

        expect(answer.status).toBe(401);
        expect(answer.body.error.code).toBe('KeyRevokedError');
        expect(answer.body.error.message).toBe('Invalid or revoked key');
        expect(sessionCleared(answer.setCookies)).toBe(true);
        expect([COOKIE_NAMES.SESSION, COOKIE_NAMES.SESSION_KEY_ID, COOKIE_NAMES.CSRF].filter(name => jar.has(name))).toEqual([]);
    });

    it('T2 a backend that refuses the connection: 502, and the session is kept', async () =>
    {
        const { jar } = await validJar(OWNER);
        const down = mountProxy('down');

        const answer = await browse(jar, '/_auth/session', {}, { method: 'GET', via: down });

        expect(answer.status).toBe(502);
        expect(answer.setCookies).toEqual([]);
    });

    // ========================================================================
    // T3 — every unsealing failure clears the cookie
    // ========================================================================

    /** A JWE with this server's key and another audience: decrypts, fails the claims. */
    async function otherAudienceCookie(): Promise<string>
    {
        const jose = await import('jose');
        const key = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET)));

        return await new jose.EncryptJWT({ data: sessionData(generateKeyPair('ES256'), '1') })
            .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
            .setIssuedAt()
            .setExpirationTime('1h')
            .setIssuer('spfn-auth')
            .setAudience('someone-else')
            .encrypt(key);
    }

    it.each([
        ['expired', () => Promise.resolve(expiredSessionCookie)],
        ['undecryptable', unreadableSessionCookie],
        ['claims', otherAudienceCookie],
        ['malformed', () => Promise.resolve('this-is-not-a-jwe')],
    ] as const)('T3 a %s session cookie is cleared on the response that presented it', async (failure, cookie) =>
    {
        const sealed = await cookie();

        expect(await readSealedSession(sealed)).toEqual({ failure });

        const jar = new Map([[COOKIE_NAMES.SESSION, sealed]]);
        const answer = await browse(jar, '/_auth/session', {}, { method: 'GET' });

        expect(answer.status).toBe(401);
        expect(sessionCleared(answer.setCookies)).toBe(true);
        expect(writesOf(answer.setCookies, COOKIE_NAMES.SESSION_KEY_ID).map(maxAgeOf)).toEqual([0]);
        expect(jar.has(COOKIE_NAMES.SESSION)).toBe(false);
    });

    // ========================================================================
    // T4 — a session that could not be written is not a success
    // ========================================================================

    /** The browser an establishing path is driven from: the session a self-authenticated path replaces, else none. */
    async function establishingJar(path: string): Promise<Map<string, string>>
    {
        if (path === '/_auth/session/renew/verify')
        {
            return await boundJar();
        }

        return path === '/_auth/keys/rotate' ? (await validJar(OWNER)).jar : new Map();
    }

    /**
     * The proxy holds the private key of every establishing path's new session —
     * it minted it, or a pending cookie it sealed holds it — so on every one the
     * seal-failure path revokes that key; none is left to a log line alone.
     */
    it.each(establishingPaths())('T4 %s: the seal fails after the backend\'s 200 — SessionSealFailedError, no session cookie, the new key not active', async (path) =>
    {
        const jar = await establishingJar(path);
        vi.mocked(sealSession).mockClear();
        vi.mocked(sealSession).mockRejectedValueOnce(new Error('seal failed'));

        const answer = await DRIVERS[path](jar);
        const unwritten = vi.mocked(sealSession).mock.calls[0][0] as SessionData;

        expect(answer.status).toBe(500);
        expect(answer.body.error.code).toBe('SessionSealFailedError');
        expect(writesOf(answer.setCookies, COOKIE_NAMES.SESSION).filter(line => maxAgeOf(line) > 0)).toEqual([]);
        expect((await keyRow(unwritten.keyId)).isActive).toBe(false);
    });

    // ========================================================================
    // N1 — a proposal with nobody to decide it is an error
    // ========================================================================

    it('N1: an interceptor list without the session decision — the sign-in answers SessionDecisionMissingError, not 200, and its key is revoked', async () =>
    {
        const undecided = mountProxy(app, {}, { interceptors: authInterceptors.filter(rule => rule !== sessionDecisionInterceptor) });
        const jar = new Map<string, string>();

        const answer = await browse(jar, '/_auth/login', { body: { email: OWNER, password: PASSWORD } }, { via: undecided });
        const keys = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, Number(await userId(OWNER))));

        expect(answer.status).toBe(500);
        expect(answer.body.error.code).toBe('SessionDecisionMissingError');
        expect(answer.body.error.message).toContain('authInterceptors');
        expect(answer.setCookies).toEqual([]);
        expect(keys).toHaveLength(1);
        expect(keys.filter(key => key.isActive)).toEqual([]);
    });

    // ========================================================================
    // N3 — oauth/finalize answers the key that signed it, and only that
    // ========================================================================

    /** A social start whose key the callback registered to OWNER: the key id a finalize would name. */
    async function registeredStartKey(): Promise<string>
    {
        const started = await browse(new Map(), '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/' } });
        const state = await verifyOAuthState(new URL(started.body.authUrl).searchParams.get('state')!);
        await registerPublicKeyService({
            userId: Number(await userId(OWNER)),
            keyId: state.keyId,
            publicKey: state.publicKey,
            fingerprint: state.fingerprint,
            algorithm: state.algorithm,
            channel: 'oauth',
        });

        return state.keyId;
    }

    it('N3: a finalize without the key\'s signature, or signed by another key under its id — refused, nothing about the owner', async () =>
    {
        const keyId = await registeredStartKey();
        const forger = generateKeyPair('ES256');
        const forged = `Bearer ${generateClientToken({ keyId }, forger.privateKey, 'ES256', { expiresIn: '5m' })}`;

        for (const authorization of [undefined, forged])
        {
            const answer = await direct('/_auth/oauth/finalize', { keyId, returnUrl: '/' }, authorization);
            const body = await answer.json();

            expect(answer.status).toBe(401);
            expect(body.userId).toBeUndefined();
            expect(body.keyId).toBeUndefined();
            expect(body.success).toBeUndefined();
        }
    });

    it('N3: a finalize signed by the caller\'s own key naming another key id answers the caller, never the named key\'s owner', async () =>
    {
        const keyId = await registeredStartKey();
        const caller = await signedInDevice(OTHER);

        const answer = await direct('/_auth/oauth/finalize', { keyId, returnUrl: '/' }, caller.authorization);
        const body = await answer.json();

        expect(answer.status).toBe(200);
        expect(body.userId).toBe(await userId(OTHER));
        expect(body.keyId).toBe(caller.key.keyId);
    });

    it('N3: an account the second-factor policy holds to enrolment completes a social sign-in — its enrolment-only session', async () =>
    {
        configureSecondFactor({ required: true, methods: ['totp'] });

        const answer = await DRIVERS['/_auth/oauth/finalize'](new Map()).finally(() => __resetSecondFactorPolicyForTests());

        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect(answer.body.secondFactorEnrolmentRequired).toBe(true);
        expect(writesOf(answer.setCookies, COOKIE_NAMES.SESSION).map(maxAgeOf)[0]).toBeGreaterThan(0);
    });

    // ========================================================================
    // T5 — getSession().userId is the backend's
    // ========================================================================

    it('T5: a finalize posting another user\'s id seals the signed-in user\'s id, and getSession() answers it', async () =>
    {
        const jar = new Map<string, string>();
        const started = await browse(jar, '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/' } });
        const state = await verifyOAuthState(new URL(started.body.authUrl).searchParams.get('state')!);
        await registerPublicKeyService({
            userId: Number(await userId(OWNER)),
            keyId: state.keyId,
            publicKey: state.publicKey,
            fingerprint: state.fingerprint,
            algorithm: state.algorithm,
            channel: 'oauth',
        });

        const finalized = await browse(jar, '/_auth/oauth/finalize', { body: { userId: await userId(OTHER), keyId: state.keyId, returnUrl: '/' } });
        seams.jar = jar;

        expect(finalized.status).toBe(200);
        expect(await getSession()).toEqual({ userId: await userId(OWNER) });
    });

    // ========================================================================
    // T6 — sign-out leaves nothing of this package behind
    // ========================================================================

    it('T6: after sign-out no cookie of this package remains', async () =>
    {
        const { jar } = await validJar(OWNER);
        const issued = await browse(jar, '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/' } });
        await browse(jar, '/_auth/device/start/web', { body: { deviceName: 'Office PC' } });
        const stepUpPending = 'a-pending-cookie-left-by-a-flow';

        jar.set(COOKIE_NAMES.MFA_PENDING, stepUpPending);
        jar.set(COOKIE_NAMES.SIGNUP_SETUP, 'setup');
        jar.set(COOKIE_NAMES.PASSWORD_RESET_SETUP, 'setup');
        expect(issued.status).toBe(200);
        expect(jar.has(COOKIE_NAMES.DEVICE_PENDING)).toBe(true);

        const names = packageCookieNames(jar);
        const signedOut = await browse(jar, '/_auth/logout', { body: {} });

        expect(signedOut.status).toBe(204);
        expect(names.filter(name => jar.has(name))).toEqual([]);
        expect([...jar.keys()]).toEqual([]);
    });

    // ========================================================================
    // T7 — SPFN_AUTH_COOKIE_SECURE=false is honoured by every writer
    // ========================================================================

    it('T7: under NODE_ENV=production with SPFN_AUTH_COOKIE_SECURE=false, no cookie of any writer carries Secure', async () =>
    {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('SPFN_AUTH_COOKIE_SECURE', 'false');
        const lines: string[] = [];
        const record = (browsed: Browsed) => void lines.push(...browsed.setCookies);

        const jar = new Map<string, string>();
        record(await browse(jar, '/_auth/login', { body: { email: OWNER, password: PASSWORD } }));
        record(await browse(jar, '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/' } }));
        record(await browse(jar, '/_auth/device/start/web', { body: { deviceName: 'Office PC' } }));
        expect((await direct('/_auth/signup/email', { email: NEWCOMER })).status).toBe(200);
        record(await browse(jar, '/_auth/signup/email/confirm', { body: { token: emailedToken('signup-link') } }));
        expect((await direct('/_auth/password/reset', { email: OTHER })).status).toBe(200);
        record(await browse(jar, '/_auth/password/reset/confirm', { body: { token: emailedToken('password-reset') } }));
        record(await DRIVERS['/_auth/mfa/verify'](new Map()));

        // The CSRF refusal's repair, the near-expiry refresh path and sign-out
        const refused = new Map(jar);
        refused.set(COOKIE_NAMES.CSRF, 'stale');
        const csrfRefusal = await proxy.call('logout', { body: {} }, {
            cookie: [...refused].map(([name, value]) => `${name}=${value}`).join('; '),
            headers: { 'user-agent': CHROME, [CSRF_HEADER]: 'stale' },
        });
        expect(csrfRefusal.status).toBe(403);
        lines.push(...csrfRefusal.headers.getSetCookie());
        record(await browse(jar, '/_auth/logout', { body: {} }));

        // The writers outside the proxy
        const key = generateKeyPair('ES256');
        await saveSession(sessionData(key, '1'));
        await clearSession();
        lines.push(...clearSessionCookies(new NextResponse()).headers.getSetCookie());

        const written = new Set(lines.map(line => line.split('=')[0]));

        for (const name of [COOKIE_NAMES.SESSION, COOKIE_NAMES.SESSION_KEY_ID, COOKIE_NAMES.CSRF, COOKIE_NAMES.MFA_PENDING,
            COOKIE_NAMES.DEVICE_PENDING, COOKIE_NAMES.SIGNUP_SETUP, COOKIE_NAMES.PASSWORD_RESET_SETUP])
        {
            expect(written.has(name), name).toBe(true);
        }

        expect(lines.filter(line => /;\s*Secure/i.test(line))).toEqual([]);
        expect(seams.written.length).toBeGreaterThan(0);
        expect(seams.written.filter(cookie => cookie.options.secure !== false)).toEqual([]);
    });

    it('T7: the OAuth callback handler relays the proxy\'s cookies, Secure decided by the same setting', async () =>
    {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('SPFN_AUTH_COOKIE_SECURE', 'false');
        const jar = new Map<string, string>();
        const started = await browse(jar, '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/' } });
        const state = await verifyOAuthState(new URL(started.body.authUrl).searchParams.get('state')!);
        await registerPublicKeyService({
            userId: Number(await userId(OWNER)),
            keyId: state.keyId,
            publicKey: state.publicKey,
            fingerprint: state.fingerprint,
            algorithm: state.algorithm,
            channel: 'oauth',
        });

        const { NextRequest } = await import('next/server');
        const callback = new URL(`/api/auth/callback?userId=${await userId(OTHER)}&keyId=${state.keyId}&returnUrl=%2F`, 'http://app.test');
        const response = await createOAuthCallbackHandler()(new NextRequest(callback, {
            headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), 'user-agent': CHROME },
        }));
        const lines = response.headers.getSetCookie();

        expect(writesOf(lines, COOKIE_NAMES.SESSION)).toHaveLength(1);
        expect(lines.filter(line => /;\s*Secure/i.test(line))).toEqual([]);
        expect((await unsealSession(valueOf(writesOf(lines, COOKIE_NAMES.SESSION)[0]))).userId).toBe(await userId(OWNER));
    });

    /** An API-mode OAuth start straight at the backend, which sets its CSRF cookie itself: its `Set-Cookie` lines. */
    async function apiModeStartCookies(): Promise<string[]>
    {
        const key = generateKeyPair('ES256');
        const response = await direct('/_auth/oauth/start', { provider: 'superself', returnUrl: '/', ...keyFields(key) });

        expect(response.status).toBe(200);

        return response.headers.getSetCookie();
    }

    it.each([
        ['production', 'false', false],
        ['development', 'true', true],
    ])('T7: the backend\'s own cookie writer (API-mode OAuth start) under NODE_ENV=%s, SPFN_AUTH_COOKIE_SECURE=%s: Secure %s', async (nodeEnv, secure, carriesSecure) =>
    {
        vi.stubEnv('NODE_ENV', nodeEnv);
        vi.stubEnv('SPFN_AUTH_COOKIE_SECURE', secure);

        const lines = await apiModeStartCookies();

        expect(lines).toHaveLength(1);
        expect(/;\s*Secure/i.test(lines[0])).toBe(carriesSecure);
        expect(lines[0]).toMatch(/;\s*HttpOnly/i);
        expect(lines[0]).toMatch(/;\s*SameSite=Lax/i);
    });

    // ========================================================================
    // N2 — the OAuth callback completes in-process, never over the network
    // ========================================================================

    it('N2: with SPFN_APP_URL pointing at a host the server cannot reach, the callback completes — as the browser, no HTTP hop', async () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'http://unreachable.invalid');
        const jar = new Map<string, string>();
        const started = await browse(jar, '/_auth/oauth/:provider/url', { params: { provider: 'superself' }, body: { returnUrl: '/' } });
        const state = await verifyOAuthState(new URL(started.body.authUrl).searchParams.get('state')!);
        await registerPublicKeyService({
            userId: Number(await userId(OWNER)),
            keyId: state.keyId,
            publicKey: state.publicKey,
            fingerprint: state.fingerprint,
            algorithm: state.algorithm,
            channel: 'oauth',
        });
        const edge = mountProxy(app, {}, { appUnreachable: true });
        const calls = edge.backendCalls.length;

        const { NextRequest } = await import('next/server');
        const response = await createOAuthCallbackHandler()(new NextRequest(new URL(`/api/auth/callback?keyId=${state.keyId}&returnUrl=%2Fhome`, 'http://app.test'), {
            headers: {
                cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
                'user-agent': CHROME,
                'x-forwarded-for': '203.0.113.7',
            },
        }));
        const finalize = edge.backendCalls.slice(calls).find(call => call.path === '/_auth/oauth/finalize');

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe('http://app.test/home');
        expect((await unsealSession(valueOf(writesOf(response.headers.getSetCookie(), COOKIE_NAMES.SESSION)[0]))).userId).toBe(await userId(OWNER));
        expect(finalize?.headers.get('x-spfn-proxy-client-ip')).toBe('203.0.113.7');
        expect(finalize?.headers.get('user-agent')).toBe(CHROME);
    });

    // ========================================================================
    // T8 — remember chooses between the operator's two lifetimes
    // ========================================================================

    it('T8: remember true → the kept lifetime; remember \'30d\' → 400 and no key; absent → the default lifetime', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        vi.stubEnv('SPFN_AUTH_SESSION_TTL_REMEMBER', '14d');

        const kept = await browse(new Map(), '/_auth/login', { body: { email: OWNER, password: PASSWORD, remember: true } });
        const refused = await browse(new Map(), '/_auth/login', { body: { email: OTHER, password: PASSWORD, remember: '30d' } });
        const plain = await browse(new Map(), '/_auth/login', { body: { email: MFA_USER, password: PASSWORD } });

        expect(kept.status).toBe(200);
        expect(writesOf(kept.setCookies, COOKIE_NAMES.SESSION).map(maxAgeOf)).toEqual([FOURTEEN_DAYS]);
        expect((await unsealSession(valueOf(writesOf(kept.setCookies, COOKIE_NAMES.SESSION)[0]))).remember).toBe(true);

        expect(refused.status).toBe(400);
        expect(refused.body.error.code).toBe('ValidationError');
        expect(refused.setCookies).toEqual([]);
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, Number(await userId(OTHER))))).toEqual([]);

        expect(plain.status).toBe(200);
        expect(writesOf(plain.setCookies, COOKIE_NAMES.SESSION).map(maxAgeOf)).toEqual([TWELVE_HOURS]);
    });

    /**
     * Where a sign-in started on each `remember` path completes, and with which
     * driver: the start's own path for a one-step sign-in, else the later request.
     */
    const COMPLETED_AT: Record<string, string> = {
        '/_auth/oauth/:provider/url': '/_auth/oauth/finalize',
        '/_auth/device/start/web': '/_auth/device/poll',
        '/_auth/device/link/redeem/web': '/_auth/device/link/poll',
    };

    /** A sign-in started with `remember: true`, completed: the session it was given. */
    async function keptBy(driver: typeof socialStepUp, start: Extra, finish: Extra = {}): Promise<{ maxAge: number[]; remember: unknown }>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_TTL', '12h');
        vi.stubEnv('SPFN_AUTH_SESSION_TTL_REMEMBER', '14d');

        const answer = await driver(new Map(), start, finish);
        const writes = writesOf(answer.setCookies, COOKIE_NAMES.SESSION);

        expect(answer.status, JSON.stringify(answer.body)).toBe(200);

        return { maxAge: writes.map(maxAgeOf), remember: (await unsealSession(valueOf(writes[0]))).remember };
    }

    it('T8: the remember paths are read off the rules, and each completes somewhere a driver reaches', () =>
    {
        const paths = rememberPaths();

        for (const { file, declared } of REMEMBER_DECLARATIONS)
        {
            expect(declared, `${file} calls takeRemember() and must export REMEMBER_PATHS`).toBeInstanceOf(Array);
        }

        expect(paths.length).toBeGreaterThanOrEqual(9);

        for (const path of paths)
        {
            expect(DRIVERS[COMPLETED_AT[path] ?? path], `no T8 driver for ${path}`).toBeDefined();
        }
    });

    it.each(rememberPaths().map(path => [path, COMPLETED_AT[path] ?? path]))(
        'T8 remember: true at %s → the kept lifetime when %s completes',
        async (_start, completion) =>
        {
            expect(await keptBy(DRIVERS[completion], { remember: true })).toEqual({ maxAge: [FOURTEEN_DAYS], remember: true });
        },
    );

    it('T8 remember: true on a sign-in answered 202 → the kept lifetime when mfa/verify completes it', async () =>
    {
        expect(await keptBy(DRIVERS['/_auth/mfa/verify'], { remember: true })).toEqual({ maxAge: [FOURTEEN_DAYS], remember: true });
    });

    it('T8 remember: true on a social start answered 202 by finalize → the kept lifetime when mfa/verify completes it', async () =>
    {
        expect(await keptBy(socialStepUp, { remember: true })).toEqual({ maxAge: [FOURTEEN_DAYS], remember: true });
    });

    it.each([
        ['/_auth/mfa/verify'],
        ['/_auth/oauth/finalize'],
        ['/_auth/device/poll'],
        ['/_auth/device/link/poll'],
    ])('T8 remember: true added only on the request that completes %s → the default lifetime', async (path) =>
    {
        expect(await keptBy(DRIVERS[path], {}, { remember: true })).toEqual({ maxAge: [TWELVE_HOURS], remember: undefined });
    });

    // ========================================================================
    // T9 — an outage is not a sign-out
    // ========================================================================

    /** RequireAuth rendered as a page would, over the given backend; what it did. */
    async function guarded(backend: ProxiedBackend, jar: Map<string, string>): Promise<{ redirected: string[]; thrown: unknown; backendCalls: MountedProxy['backendCalls'] }>
    {
        seams.redirected = [];
        seams.written = [];
        seams.jar = jar;

        const mounted = mountProxy(backend);
        const { RequireAuth } = await import('@/nextjs/guards/require-auth');
        const thrown = await RequireAuth({ children: null, redirectTo: '/login' }).then(() => null, (error: unknown) => error);

        return { redirected: seams.redirected, thrown, backendCalls: mounted.backendCalls };
    }

    /** A backend that answers every request 503. */
    function unavailableBackend(): ProxiedBackend
    {
        const unavailable = new Hono();
        unavailable.all('*', c => c.json({ __type: 'ServiceUnavailableError', message: 'down', error: { code: 'ServiceUnavailableError' } }, 503));

        return unavailable;
    }

    it.each([
        ['answers 503', unavailableBackend],
        ['refuses the connection', (): ProxiedBackend => 'down'],
    ])('T9 the backend %s: the guard throws for the error boundary, no redirect, the cookies kept', async (_label, backend) =>
    {
        const { jar } = await validJar(OWNER);

        const outcome = await guarded(backend(), jar);

        expect(outcome.redirected).toEqual([]);
        expect(outcome.thrown).toBeInstanceOf(Error);
        expect((outcome.thrown as Error).message).not.toBe('redirected');
        expect(outcome.backendCalls.length).toBeGreaterThan(0);
        // The cookies a guard can change are the ones it writes through `next/headers`
        expect(seams.written).toEqual([]);
    });

    it('T9 the backend refuses the key (revoked): signed out — the guard redirects to sign-in', async () =>
    {
        const { jar, key } = await validJar(OWNER);
        await getTestDb().update(userPublicKeys).set({ isActive: false, revokedAt: new Date() }).where(eq(userPublicKeys.keyId, key.keyId));

        const outcome = await guarded(app, jar);

        expect(outcome.redirected).toEqual(['/login']);
        expect(outcome.backendCalls.at(-1)?.headers.get('x-key-id')).toBe(key.keyId);
    });

    it('T9 an account held to enrolment: the guard\'s session lookup answers its session with the flag, nothing thrown', async () =>
    {
        const { jar } = await validJar(OWNER);
        seams.jar = jar;
        configureSecondFactor({ required: true, methods: ['totp'] });

        const { getAuthSessionData } = await import('@/nextjs/guards/auth-utils');
        const session = await getAuthSessionData().finally(() => __resetSecondFactorPolicyForTests());

        expect(session).toMatchObject({ userId: Number(await userId(OWNER)), secondFactorEnrolmentRequired: true });
    });

    // ========================================================================
    // N5 — the proxy's own backend calls are signed for proxy-guard
    // ========================================================================

    const PROXY_SECRET = 'n5-proxy-guard-secret-at-least-32-characters';

    /** The backend behind a strict proxy-guard: an unsigned or mis-signed call is refused 403. */
    function guardedBackendApp(): Hono
    {
        const guardedApp = new Hono();

        guardedApp.use('*', createProxyGuard({ mode: 'strict', secret: PROXY_SECRET }));
        guardedApp.route('/', app);

        return guardedApp;
    }

    it('N5 proxy-guard strict: the re-signed retry and the revocation of an unwritten key carry a valid proxy signature', async () =>
    {
        const via = mountProxy(guardedBackendApp(), {}, { proxySecret: PROXY_SECRET });
        const { jar } = await validJar(OWNER);
        await expireNextTokens(1);

        const retried = await browse(jar, '/_auth/session', {}, { method: 'GET', via });

        expect(retried.status).toBe(200);
        expect(via.backendCalls.map(call => call.path)).toEqual(['/_auth/session', '/_auth/session']);

        vi.mocked(sealSession).mockClear();
        vi.mocked(sealSession).mockRejectedValueOnce(new Error('seal failed'));
        const failed = await browse(new Map(), '/_auth/login', { body: { email: OTHER, password: PASSWORD } }, { via });
        const unwritten = vi.mocked(sealSession).mock.calls[0][0] as SessionData;

        expect(failed.body.error.code).toBe('SessionSealFailedError');
        expect(via.backendCalls.at(-1)?.path).toBe('/_auth/logout');
        expect((await keyRow(unwritten.keyId)).isActive).toBe(false);
        expect(via.backendCalls.every(call => call.headers.get('x-spfn-proxy-signature'))).toBe(true);
    });

    // ========================================================================
    // T10 — a sign-in replaces the browser's previous key
    // ========================================================================

    /** The account each establishing path signs in. */
    const SIGNS_IN: Record<string, string> = {
        '/_auth/login': OWNER,
        '/_auth/register': NEWCOMER,
        '/_auth/invitations/accept': INVITEE,
        '/_auth/signup/password': NEWCOMER,
        '/_auth/password/reset/complete': OWNER,
        '/_auth/passkeys/login/verify': OWNER,
        '/_auth/mfa/verify': MFA_USER,
        '/_auth/device/link/poll': OWNER,
        '/_auth/device/poll': OWNER,
        '/_auth/oauth/finalize': OWNER,
        '/_auth/keys/rotate': OWNER,
        '/_auth/session/renew/verify': OWNER,
    };

    /** The paths that create the account they sign in: no session of it can exist before. */
    const CREATES_ACCOUNT = new Set(['/_auth/register', '/_auth/invitations/accept', '/_auth/signup/password']);

    const SOCIAL_STEP_UP = 'social → oauth/finalize 202 → /_auth/mfa/verify';

    /**
     * Same-account rows: every establishing path whose account exists before it,
     * by its own driver — except `mfa/verify`, which a password sign-in from a
     * browser holding that account's session never reaches (the replacement
     * proof makes it the same device, answered 200), so its row is the social
     * step-up, which carries no proof.
     */
    const T10_SAME_ACCOUNT = establishingPaths()
        .filter(path => !CREATES_ACCOUNT.has(path))
        .map(path => (path === '/_auth/mfa/verify' ? [SOCIAL_STEP_UP, OWNER] : [path, SIGNS_IN[path]]));

    /** Another account's rows: every path not signed by the session it replaces, and the social step-up. */
    const T10_OTHER_ACCOUNT = [...establishingPaths().filter(path => !SELF_AUTHENTICATED.has(path)), SOCIAL_STEP_UP];

    function t10Driver(path: string): typeof socialStepUp
    {
        return path === SOCIAL_STEP_UP ? socialStepUp : DRIVERS[path];
    }

    it('T10: every establishing path has a same-account row or creates its account, and names the account it signs in', () =>
    {
        for (const path of establishingPaths())
        {
            expect(SIGNS_IN[path], `T10 does not know which account ${path} signs in`).toBeDefined();
        }

        expect(T10_SAME_ACCOUNT.length + CREATES_ACCOUNT.size).toBe(establishingPaths().length);
    });

    it.each(T10_SAME_ACCOUNT)('T10 %s from a browser with a valid session of the same account (%s): the previous key is no longer active, nothing logged', async (path, account) =>
    {
        const jar = path === '/_auth/session/renew/verify' ? await boundJar() : (await validJar(account)).jar;
        const previous = await unsealSession(jar.get(COOKIE_NAMES.SESSION)!);
        const logged = vi.spyOn(authLogger.interceptor.general, 'error');

        const answer = await t10Driver(path)(jar);
        const session = await unsealSession(jar.get(COOKIE_NAMES.SESSION)!);
        // Read before the restore, which empties them
        const errors = logged.mock.calls.map(([message]) => message);
        logged.mockRestore();

        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect(session.userId).toBe(previous.userId);
        expect(session.keyId).not.toBe(previous.keyId);
        expect((await keyRow(previous.keyId)).isActive).toBe(false);
        // A key the backend already replaced answers the sign-out KeyRevokedError: already gone, not an error
        expect(errors).toEqual([]);
    });

    it.each(T10_OTHER_ACCOUNT)('T10 %s from a browser holding another account\'s session: that key stays active', async (path) =>
    {
        const { jar, key } = await validJar(OTHER);

        const answer = await t10Driver(path)(jar);

        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect((await unsealSession(jar.get(COOKIE_NAMES.SESSION)!)).userId).not.toBe(await userId(OTHER));
        expect((await keyRow(key.keyId)).isActive).toBe(true);
    });

    /** The backend, but its sign-out answers 503. */
    function signOutUnavailableBackend(): Hono
    {
        const backend = new Hono();
        backend.post('/_auth/logout', c => c.json({ __type: 'ServiceUnavailableError', message: 'down', error: { code: 'ServiceUnavailableError' } }, 503));
        backend.route('/', app);

        return backend;
    }

    it('T10 a revocation of the previous key that fails is logged with its key id, and the sign-in stands', async () =>
    {
        const via = mountProxy(signOutUnavailableBackend());
        const { jar, key } = await validJar(OWNER);
        const logged = vi.spyOn(authLogger.interceptor.general, 'error');

        const started = await browse(jar, '/_auth/device/start/web', { body: { deviceName: 'Office PC' } }, { via });
        const owner = await signedInDevice(OWNER);
        expect((await direct('/_auth/device/approve', { userCode: started.body.userCode }, owner.authorization)).status).toBe(200);

        const answer = await browse(jar, '/_auth/device/poll', { body: { deviceCode: started.body.deviceCode } }, { via });

        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect(writesOf(answer.setCookies, COOKIE_NAMES.SESSION).map(maxAgeOf)[0]).toBeGreaterThan(0);
        expect(logged).toHaveBeenCalledWith('Could not revoke the previous key of a sign-in', { keyId: key.keyId, status: 503 });
        expect((await keyRow(key.keyId)).isActive).toBe(true);
        logged.mockRestore();
    });

    // ========================================================================
    // T11 — a refused request token is retried once, signed afresh
    // ========================================================================

    /** The next `count` request tokens the proxy signs are already expired. */
    async function expireNextTokens(count: number): Promise<void>
    {
        const actual = await vi.importActual<typeof import('@/server/lib/crypto')>('@/server/lib/crypto');

        for (let index = 0; index < count; index += 1)
        {
            vi.mocked(generateClientToken).mockImplementationOnce((payload, privateKey, algorithm) =>
                actual.generateClientToken(payload, privateKey, algorithm, { expiresIn: -60 }));
        }
    }

    it('T11: TokenExpiredError once — one re-signed retry answers, and the session is kept', async () =>
    {
        const { jar } = await validJar(OWNER);
        const before = new Map(jar);
        const calls = proxy.backendCalls.length;
        await expireNextTokens(1);

        const answer = await browse(jar, '/_auth/session', {}, { method: 'GET' });

        expect(answer.status).toBe(200);
        expect(proxy.backendCalls.slice(calls).map(call => call.path)).toEqual(['/_auth/session', '/_auth/session']);
        expect(sessionCleared(answer.setCookies)).toBe(false);
        expect(jar.get(COOKIE_NAMES.SESSION)).toBe(before.get(COOKIE_NAMES.SESSION));
    });

    it('T11: TokenExpiredError twice — passed through after the one retry, and the session is kept', async () =>
    {
        const { jar } = await validJar(OWNER);
        const before = new Map(jar);
        const calls = proxy.backendCalls.length;
        await expireNextTokens(2);

        const answer = await browse(jar, '/_auth/session', {}, { method: 'GET' });

        expect(answer.status).toBe(401);
        expect(answer.body.error.code).toBe('TokenExpiredError');
        expect(proxy.backendCalls.slice(calls)).toHaveLength(2);
        expect(sessionCleared(answer.setCookies)).toBe(false);
        expect(jar.get(COOKIE_NAMES.SESSION)).toBe(before.get(COOKIE_NAMES.SESSION));
    });
});
