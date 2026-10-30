/**
 * OAuth link/unlink: attempts the #154 case table does not name directly.
 *
 * These began as the Opus reviewer's probes on PR #290 and stay as permanent rows
 * beside integration/oauth-link.test.ts (rows L, S, C, U):
 *
 * - P1: two concurrent unlinks of the account's only two social identities
 * - P2: a concurrent passkey revoke and social unlink of the account's only two credentials
 * - P3: C10's third cell — the account is deleted while the link is in flight
 * - P4: the link start driven through the shipped `authInterceptors` chain end to end
 *       (proxy request phase → backend → proxy response phase → callback)
 * - P5: a Battle.net link state brought to the Google-specific callback route
 * - P6: a sign-in CSRF cookie (keyed by the sign-in keyId) cannot stand in for a link's
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { passkeys, userSocialAccounts, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';
import {
    registerOAuthProvider,
    githubProvider,
    googleProvider,
    type NormalizedIdentity,
    type OAuthProvider,
} from '@/server/lib/oauth';
import { battlenetProvider } from '@/server/lib/oauth/battlenet-provider';
import { buildStartCookieName, listStartCookies } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { sealSession } from '@/server/lib/session';
import { COOKIE_NAMES } from '@/server/lib/config';
import { CSRF_HEADER, deriveCsrfToken } from '@/server/lib/csrf';
import { authInterceptors } from '@/nextjs/interceptors';
import { generalAuthInterceptor } from '@/nextjs/interceptors/general-auth';
import { oauthLinkInterceptor } from '@/nextjs/interceptors/oauth';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const APP_URL = 'http://localhost:3000';
const RETURN_URL = '/settings/connections';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const SECRET = 'test-secret-key-for-testing-only-min-32-chars';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const FLASH: NormalizedIdentity = {
    providerUserId: '100001', email: null, emailVerified: false, name: 'Flash#1234', handle: 'Flash#1234',
};
const OCTOCAT: NormalizedIdentity = {
    providerUserId: 'gh-1', email: null, emailVerified: false, name: 'octocat',
};

const identities = new Map<string, NormalizedIdentity>([
    ['code-flash', FLASH],
    ['code-octocat', OCTOCAT],
]);

let exchanges = 0;

function standIn(id: OAuthProvider['id']): OAuthProvider
{
    return {
        id,
        isEnabled: () => true,
        getAuthUrl: (state: string) => `https://provider.example/${id}/authorize?state=${state}`,
        exchangeCodeForTokens: async (code: string) =>
        {
            exchanges += 1;

            return { accessToken: `access-${code}-${exchanges}`, expiresIn: 86400, identity: identities.get(code) };
        },
        getUserInfo: async () =>
        {
            throw new Error('identity comes from the token response');
        },
    };
}

interface Session
{
    authorization: string;
    keyId: string;
    key: KeyPair;
}

interface StartedLink
{
    state: string;
    cookie: string;
}

describe.skipIf(!dbAvailable)('OAuth link/unlink beyond the case table (#154)', () =>
{
    let app: Hono;
    let ownerId: number;
    let ipCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = SECRET;
        process.env.SPFN_AUTH_PASSKEY_RP_ID = 'localhost';
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = APP_URL;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        registerOAuthProvider(battlenetProvider);
        registerOAuthProvider(githubProvider);
        registerOAuthProvider(googleProvider);
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        registerOAuthProvider(standIn('battlenet'));
        registerOAuthProvider(standIn('github'));
        registerOAuthProvider(standIn('google'));
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        exchanges = 0;

        ownerId = await createUser('owner@test.com');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    async function createUser(email: string): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });

        return Number(row!.id);
    }

    function nextIp(): string
    {
        ipCounter += 1;

        return `198.51.100.${ipCounter % 250 + 1}`;
    }

    function post(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        return Promise.resolve(app.request(path, {
            method: 'POST',
            headers: {
                ...JSON_HEADERS,
                'x-forwarded-for': nextIp(),
                ...(authorization ? { Authorization: authorization } : {}),
            },
            body: JSON.stringify(body),
        }));
    }

    function sessionFor(key: KeyPair): Session
    {
        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: key.keyId, key };
    }

    async function signIn(email: string): Promise<Session>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(response.status).toBe(200);

        return sessionFor(key);
    }

    async function startLink(session: Session, provider = 'battlenet'): Promise<StartedLink>
    {
        const nonce = generateOAuthNonce();
        const startId = generateOAuthNonce();
        const response = await post(`/_auth/oauth/${provider}/link`, {
            returnUrl: RETURN_URL,
            nonce,
            startId,
        }, session.authorization);

        expect(response.status).toBe(200);

        const { authUrl } = await response.json() as { authUrl: string };

        return {
            state: new URL(authUrl).searchParams.get('state')!,
            cookie: `${buildStartCookieName('csrf', startId)}=${nonce}`,
        };
    }

    async function callback(path: string, state: string, query: Record<string, string>, cookie: string | null): Promise<URL>
    {
        const params = new URLSearchParams({ ...query, state });
        const response = await app.request(`${path}?${params}`, {
            headers: cookie ? { Cookie: cookie } : {},
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    function finishLink(started: StartedLink, code: string, provider = 'battlenet'): Promise<URL>
    {
        return callback(`/_auth/oauth/${provider}/callback`, started.state, { code }, started.cookie);
    }

    /** A Battle.net sign-in that makes a new, Battle.net-only account; the key it registered. */
    async function battlenetOnlyAccount(): Promise<{ userId: number; session: Session }>
    {
        const key = generateKeyPair('ES256');
        const nonce = generateOAuthNonce();
        const state = await createOAuthState({
            provider: 'battlenet',
            returnUrl: '/',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            nonce,
        });
        const location = await callback('/_auth/oauth/battlenet/callback', state, { code: 'code-flash' },
            `${buildStartCookieName('csrf', key.keyId)}=${nonce}`);

        expect(location.searchParams.get('isNewUser')).toBe('true');

        return { userId: Number(location.searchParams.get('userId')), session: sessionFor(key) };
    }

    async function socialRowsOf(userId: number)
    {
        return await getTestDb().select().from(userSocialAccounts).where(eq(userSocialAccounts.userId, userId));
    }

    // ------------------------------------------------------------------------

    it('P1: two concurrent unlinks of an account\'s only two social identities — one wins, one is refused', async () =>
    {
        const { userId, session } = await battlenetOnlyAccount();
        const linked = await finishLink(await startLink(session, 'github'), 'code-octocat', 'github');
        expect(linked.searchParams.get('oauthLink')).toBe('linked');
        expect(await socialRowsOf(userId)).toHaveLength(2);

        const [a, b] = await Promise.all([
            post('/_auth/oauth/battlenet/unlink', {}, session.authorization),
            post('/_auth/oauth/github/unlink', {}, session.authorization),
        ]);

        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect(await socialRowsOf(userId)).toHaveLength(1);
    });

    it('P2: a concurrent passkey revoke and social unlink of the only two credentials — one wins, one is refused', async () =>
    {
        const { userId, session } = await battlenetOnlyAccount();
        const [passkey] = await getTestDb().insert(passkeys).values({
            userId,
            credentialId: `cred-${generateOAuthNonce()}`,
            publicKey: 'pk',
            deviceType: 'singleDevice',
        }).returning({ id: passkeys.id });

        const [revoke, unlink] = await Promise.all([
            post('/_auth/passkeys/revoke', { passkeyId: String(passkey!.id) }, session.authorization),
            post('/_auth/oauth/battlenet/unlink', {}, session.authorization),
        ]);

        expect([revoke.status, unlink.status].sort()).toEqual([200, 409]);

        const liveKeys = (await getTestDb().select().from(passkeys).where(eq(passkeys.userId, userId)))
            .filter(row => !row.revokedAt);
        const left = liveKeys.length + (await socialRowsOf(userId)).length;
        expect(left).toBe(1);
    });

    it('P3: an account deleted while its link is in flight returns account_unavailable and writes nothing', async () =>
    {
        const session = await signIn('owner@test.com');
        const started = await startLink(session);
        await getTestDb().delete(users).where(eq(users.id, ownerId));

        const location = await finishLink(started, 'code-flash');

        expect(location.searchParams.get('oauthLink')).toBe('account_unavailable');
        expect(await getTestDb().select().from(userSocialAccounts)).toHaveLength(0);
    });

    it('P4: the link start through the shipped interceptor chain signs the request, sets one CSRF cookie, and its callback links', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);

        expect(authInterceptors.indexOf(oauthLinkInterceptor))
            .toBeLessThan(authInterceptors.indexOf(generalAuthInterceptor));

        const session = await signIn('owner@test.com');
        const sealed = await sealSession({
            userId: String(ownerId),
            privateKey: session.key.privateKey,
            keyId: session.key.keyId,
            algorithm: session.key.algorithm,
            uaFamily: 'chrome',
        });
        const jar = new Map([
            [COOKIE_NAMES.SESSION, sealed],
            [COOKIE_NAMES.SESSION_KEY_ID, session.key.keyId],
            [COOKIE_NAMES.CSRF, await deriveCsrfToken(session.key.keyId)],
        ]);
        const path = '/_auth/oauth/battlenet/link';
        const matching = filterMatchingInterceptors(authInterceptors, path, 'POST');

        // the client tries to choose its own CSRF pair; the proxy must overwrite it
        const requestCtx = {
            path,
            method: 'POST',
            headers: { 'content-type': 'application/json' } as Record<string, string>,
            body: { returnUrl: RETURN_URL, nonce: 'a'.repeat(32), startId: 'b'.repeat(32) },
            query: {},
            cookies: jar,
            request: { headers: new Headers({ 'user-agent': CHROME, [CSRF_HEADER]: jar.get(COOKIE_NAMES.CSRF)! }) },
            metadata: {} as Record<string, unknown>,
        } as unknown as RequestInterceptorContext;

        await executeRequestInterceptors(
            requestCtx,
            matching.map(rule => rule.request).filter((phase): phase is NonNullable<typeof phase> => !!phase),
        );

        expect(requestCtx.abort).toBeUndefined();

        const body = requestCtx.body as { returnUrl: string; nonce: string; startId: string };
        expect(body.nonce).not.toBe('a'.repeat(32));
        expect(body.startId).not.toBe('b'.repeat(32));

        const authorization = requestCtx.headers['Authorization'];
        expect(authorization).toMatch(/^Bearer /);

        const backend = await post(path, body, authorization);
        expect(backend.status).toBe(200);
        const backendBody = await backend.json() as { authUrl: string };

        const responseCtx = {
            path,
            method: 'POST',
            request: { headers: { 'user-agent': CHROME }, body: requestCtx.body },
            response: { ok: true, status: 200, statusText: '', headers: new Headers(), body: backendBody },
            cookies: jar,
            setCookies: [] as SetCookie[],
            metadata: requestCtx.metadata,
        } as unknown as ResponseInterceptorContext;

        await executeResponseInterceptors(
            responseCtx,
            matching.map(rule => rule.response).filter((phase): phase is NonNullable<typeof phase> => !!phase),
        );

        const written = (responseCtx.setCookies as SetCookie[]).filter(cookie => cookie.value);
        const csrfStarts = listStartCookies('csrf', written.map(cookie => [cookie.name, cookie.value] as const));
        const pendingStarts = listStartCookies('pending', written.map(cookie => [cookie.name, cookie.value] as const));

        expect(csrfStarts).toHaveLength(1);
        expect(pendingStarts).toHaveLength(0);
        expect(csrfStarts[0]!.name).toBe(buildStartCookieName('csrf', body.startId, csrfStarts[0]!.issuedAt * 1000));
        expect(csrfStarts[0]!.value).toBe(body.nonce);

        const state = new URL(backendBody.authUrl).searchParams.get('state')!;
        const location = await callback('/_auth/oauth/battlenet/callback', state, { code: 'code-flash' },
            `${csrfStarts[0]!.name}=${csrfStarts[0]!.value}`);

        expect(location.searchParams.get('oauthLink')).toBe('linked');
        expect(await socialRowsOf(ownerId)).toHaveLength(1);
    });

    it('P5: a Battle.net link state at the Google-specific callback is refused invalid_state before any exchange', async () =>
    {
        const session = await signIn('owner@test.com');
        const started = await startLink(session);

        const location = await callback('/_auth/oauth/google/callback', started.state, { code: 'code-flash' }, started.cookie);

        expect(location.pathname).toBe('/auth/error');
        expect(location.searchParams.get('reason')).toBe('invalid_state');
        expect(exchanges).toBe(0);
        expect(await getTestDb().select().from(userSocialAccounts)).toHaveLength(0);
    });

    it('P6: the browser\'s sign-in CSRF cookie cannot answer a link state', async () =>
    {
        const session = await signIn('owner@test.com');
        const started = await startLink(session);

        // A sign-in start in the same browser: its own cookie, keyed by its keyId.
        const signInKey = generateKeyPair('ES256');
        const signInNonce = generateOAuthNonce();
        const signInCookie = `${buildStartCookieName('csrf', signInKey.keyId)}=${signInNonce}`;

        const location = await callback('/_auth/oauth/battlenet/callback', started.state, { code: 'code-flash' }, signInCookie);

        expect(location.pathname).toBe('/auth/error');
        expect(location.searchParams.get('reason')).toBe('no_cookie');
        expect(exchanges).toBe(0);
        expect(await getTestDb().select().from(userSocialAccounts).where(and(
            eq(userSocialAccounts.userId, ownerId),
            eq(userSocialAccounts.provider, 'battlenet'),
        ))).toHaveLength(0);
    });
});
