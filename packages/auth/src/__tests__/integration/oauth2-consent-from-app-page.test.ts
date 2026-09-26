/**
 * @spfn/auth - the consent API called from an app page (fxylabs/spfn#108, c3)
 *
 * With no consent handler in the package, the app's own `'use client'` page
 * calls `GET` and `POST /_auth/oauth2/authorize` through the RPC proxy with the
 * browser's session cookie, and the browser client mirrors the readable CSRF
 * cookie into `x-spfn-csrf`. The handler used to carry its own form CSRF check;
 * without it, the proxy's check is the only thing between a cross-site POST and
 * a consent the user never gave.
 *
 * So these rows run the whole path: a real login on the backend, a session
 * cookie sealed around the key that login registered, the shipped
 * `authInterceptors` chain as `createRpcProxy` runs it, and — when the chain
 * lets the request through — the real authorize routes on the real database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { RequestInterceptorContext } from '@spfn/core/nextjs/server';
import { executeRequestInterceptors, filterMatchingInterceptors } from '@spfn/core/nextjs/server';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    createTestUser,
    JSON_HEADERS,
    mountAuthApp,
    pkcePair,
    registerLoopbackClient,
    resetMemoryRateLimitStore,
    TEST_PASSWORD,
    TEST_REDIRECT_URI,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import { authInterceptors } from '../../nextjs/interceptors';
import { generateKeyPair } from '../../server/lib/crypto';
import { sealSession } from '../../server/lib/session';
import { COOKIE_NAMES, configureAuth, type CsrfMode } from '../../server/lib/config';
import { CSRF_HEADER, deriveCsrfToken } from '../../server/lib/csrf';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Names unique to this file: one fork runs every suite. */
const EMAIL = 'consent-app-page@test.com';
const NAME = 'consent-app-page-cli';
const AUTHORIZE = '/_auth/oauth2/authorize';
const STATE = 'state-from-the-cli';

/** What the proxy answered, and whether the backend was reached at all. */
interface ProxyAnswer
{
    status: number;
    body: Record<string, unknown>;
    reachedBackend: boolean;
}

/**
 * Sign in on the backend and hand back the jar a browser would hold for it.
 *
 * The session cookie is sealed around the very key the login registered, so the
 * bearer the proxy mints from it is one the backend accepts.
 */
async function signedInJar(app: Hono, userId: number): Promise<Map<string, string>>
{
    const keyPair = generateKeyPair('ES256');
    const response = await app.request('/_auth/login', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-forwarded-for': '203.0.113.30' },
        body: JSON.stringify({
            email: EMAIL,
            password: TEST_PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'app consent page',
        }),
    });

    expect(response.status).toBe(200);

    const sealed = await sealSession({
        userId: String(userId),
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
    }, 7 * 24 * 3600);

    return new Map([
        [COOKIE_NAMES.SESSION, sealed],
        [COOKIE_NAMES.SESSION_KEY_ID, keyPair.keyId],
        [COOKIE_NAMES.CSRF, await deriveCsrfToken(keyPair.keyId)],
    ]);
}

/** The authorize parameters a CLI puts in the link, as the page reads them. */
function authorizeFields(clientId: string): Record<string, string>
{
    return {
        client_id: clientId,
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge: pkcePair('app-page').challenge,
        code_challenge_method: 'S256',
        resource: TEST_RESOURCE,
        state: STATE,
    };
}

/** `buildRequestContext`'s shape; `csrf` is the header the browser sent, if any. */
function requestContext(
    method: 'GET' | 'POST',
    fields: Record<string, unknown>,
    jar: Map<string, string>,
    csrf?: string,
): RequestInterceptorContext
{
    return {
        path: AUTHORIZE,
        method,
        headers: { 'content-type': 'application/json' } as Record<string, string>,
        body: method === 'POST' ? fields : undefined,
        query: method === 'GET' ? fields : {},
        cookies: jar,
        request: { headers: new Headers(csrf === undefined ? {} : { [CSRF_HEADER]: csrf }) },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

/**
 * One call from the app page: the matching interceptors, exactly as
 * `createRpcProxy` selects and runs them, then the backend unless they aborted.
 */
async function throughTheProxy(app: Hono, ctx: RequestInterceptorContext): Promise<ProxyAnswer>
{
    const matching = filterMatchingInterceptors(authInterceptors, ctx.path, ctx.method);

    await executeRequestInterceptors(
        ctx,
        matching.map(rule => rule.request).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    if (ctx.abort)
    {
        return { status: ctx.abort.status, body: ctx.abort.body as Record<string, unknown>, reachedBackend: false };
    }

    const query = ctx.method === 'GET' ? `?${new URLSearchParams(ctx.query as Record<string, string>)}` : '';
    const response = await app.request(`${ctx.path}${query}`, {
        method: ctx.method,
        headers: ctx.headers,
        body: ctx.method === 'POST' ? JSON.stringify(ctx.body) : undefined,
    });

    return { status: response.status, body: await response.json() as Record<string, unknown>, reachedBackend: true };
}

describe.skipIf(!dbAvailable)('OAuth2 consent API called from an app page (#108 c3)', () =>
{
    let app: Hono;
    let jar: Map<string, string>;
    let fields: Record<string, string>;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        configureAuth({ csrf: undefined });
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        configureTestAuthorizationServer({ defaultScopes: ['mcp:read'] });

        const userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);

        jar = await signedInJar(app, userId);
        fields = authorizeFields(await registerLoopbackClient(app, NAME));
    });

    /** A consent POST carrying `csrf` as its header, or none when undefined. */
    async function approve(csrf?: string): Promise<ProxyAnswer>
    {
        return await throughTheProxy(app, requestContext('POST', { ...fields, approve: true }, jar, csrf));
    }

    describe('mode enforce — what `spfn init` scaffolds', () =>
    {
        beforeEach(() =>
        {
            configureAuth({ csrf: { mode: 'enforce' } });
        });

        it('GET with the session cookie describes the request', async () =>
        {
            const answer = await throughTheProxy(app, requestContext('GET', fields, jar, jar.get(COOKIE_NAMES.CSRF)));

            expect(answer.status).toBe(200);
            expect(answer.body.clientName).toBe(NAME);
            expect(answer.body.redirectHost).toBe('127.0.0.1:7777');
        });

        it('POST with a CSRF header equal to the CSRF cookie issues a code for the vetted URI', async () =>
        {
            const answer = await approve(jar.get(COOKIE_NAMES.CSRF));

            expect(answer.status).toBe(200);
            expect(answer.body.code).toEqual(expect.any(String));
            expect(answer.body.redirectUri).toBe(TEST_REDIRECT_URI);
            expect(answer.body.state).toBe(STATE);
        });

        it('POST without the header is refused 403 before the backend', async () =>
        {
            const answer = await approve();

            expect(answer.status).toBe(403);
            expect(answer.reachedBackend).toBe(false);
        });

        it('POST with a mismatched header is refused 403 before the backend', async () =>
        {
            const answer = await approve('0'.repeat(64));

            expect(answer.status).toBe(403);
            expect(answer.reachedBackend).toBe(false);
        });
    });

    // The package default. These rows record what an app gets when it never set
    // a mode: the proxy logs the failed check and forwards the request anyway.
    describe.each<[string, CsrfMode | undefined]>([
        ['unset (package default, behaves as warn)', undefined],
        ['warn', 'warn'],
    ])('mode %s', (_label, mode) =>
    {
        beforeEach(() =>
        {
            configureAuth({ csrf: mode ? { mode } : undefined });
        });

        it('POST without the header is NOT refused — the consent is recorded', async () =>
        {
            const answer = await approve();

            expect(answer.reachedBackend).toBe(true);
            expect(answer.status).toBe(200);
            expect(answer.body.code).toEqual(expect.any(String));
        });

        it('POST with a mismatched header is NOT refused — the consent is recorded', async () =>
        {
            const answer = await approve('0'.repeat(64));

            expect(answer.reachedBackend).toBe(true);
            expect(answer.status).toBe(200);
        });
    });
});
