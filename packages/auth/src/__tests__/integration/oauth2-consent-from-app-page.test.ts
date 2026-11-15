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
 * The proxy therefore checks this POST in every mode — `off` and `warn`
 * included — and whatever the exempt list says, because the route declares
 * `.csrf('required')` and the check reads that from the route map this package
 * ships, whatever the app's own generated copy says. The disconnect button,
 * `DELETE /_auth/oauth2/grants/:id`, declares the same. These rows run the whole path:
 * a real login on the backend, a session cookie sealed around the key that
 * login registered, the shipped `authInterceptors` chain as `createRpcProxy`
 * runs it, and — when the chain lets the request through — the real authorize
 * routes on the real database and the response interceptors after them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { SetCookie } from '@spfn/core/nextjs';
import { csrfHeaderValue } from '@spfn/core/nextjs';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';

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
import { routeMap } from '../../generated/route-map';
import { oauth2Grants } from '../../server/entities';
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

/** What the proxy answered, whether the backend was reached, and the cookies it set. */
interface ProxyAnswer
{
    status: number;
    body: Record<string, unknown>;
    reachedBackend: boolean;
    setCookies: SetCookie[];
}

/** The CSRF cookie value a proxy answer set, if it set one. */
function issuedCsrf(answer: ProxyAnswer): string | undefined
{
    return answer.setCookies.find(cookie => cookie.name === COOKIE_NAMES.CSRF)?.value;
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

/**
 * `buildRequestContext`'s shape, with the route-map entry `createRpcProxy`
 * resolved the route name to; `csrf` is the header the browser sent, if any.
 */
function requestContext(
    method: 'GET' | 'POST',
    fields: Record<string, unknown>,
    jar: Map<string, string>,
    csrf?: string,
): RequestInterceptorContext
{
    return {
        path: AUTHORIZE,
        route: method === 'GET' ? routeMap.getOAuth2Authorize : routeMap.createOAuth2AuthorizationCode,
        method,
        headers: { 'content-type': 'application/json' } as Record<string, string>,
        body: method === 'POST' ? fields : undefined,
        query: method === 'GET' ? fields : {},
        cookies: jar,
        request: { headers: new Headers(csrf === undefined ? {} : { [CSRF_HEADER]: csrf }) },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

/** The disconnect button's call, `revokeOAuth2Grant` resolved as the proxy resolves it. */
function disconnectContext(grantId: number, jar: Map<string, string>): RequestInterceptorContext
{
    return {
        path: `/_auth/oauth2/grants/${grantId}`,
        route: routeMap.revokeOAuth2Grant,
        method: 'DELETE',
        headers: {} as Record<string, string>,
        body: undefined,
        query: {},
        cookies: jar,
        request: { headers: new Headers() },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

/**
 * One call from the app page: the matching interceptors, exactly as
 * `createRpcProxy` selects and runs them, then the backend and the response
 * interceptors unless the request phase aborted.
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
        return {
            status: ctx.abort.status,
            body: ctx.abort.body as Record<string, unknown>,
            reachedBackend: false,
            setCookies: ctx.abort.setCookies ?? [],
        };
    }

    const responseCtx = await callBackend(app, ctx);

    await executeResponseInterceptors(
        responseCtx,
        matching.map(rule => rule.response).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    return {
        status: responseCtx.response.status,
        body: responseCtx.response.body as Record<string, unknown>,
        reachedBackend: true,
        setCookies: responseCtx.setCookies,
    };
}

/** Forward the request to the backend; `buildResponseContext`'s shape for what came back. */
async function callBackend(app: Hono, ctx: RequestInterceptorContext): Promise<ResponseInterceptorContext>
{
    const query = ctx.method === 'GET' ? `?${new URLSearchParams(ctx.query as Record<string, string>)}` : '';
    const response = await app.request(`${ctx.path}${query}`, {
        method: ctx.method,
        headers: ctx.headers,
        body: ctx.method === 'POST' ? JSON.stringify(ctx.body) : undefined,
    });

    return {
        path: ctx.path,
        method: ctx.method,
        request: { headers: ctx.headers, body: ctx.body },
        response: {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            // As the proxy's parseResponseBody reads it: a route the backend
            // does not have answers Hono's plain-text 404.
            body: response.headers.get('content-type')?.includes('application/json')
                ? await response.json()
                : await response.text(),
        },
        cookies: ctx.cookies,
        setCookies: [],
        metadata: ctx.metadata,
    };
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

    // Every mode short of enforce. The consent POST is checked regardless: it
    // issues a code on the strength of the session alone.
    describe.each<[string, CsrfMode | undefined]>([
        ['unset (package default, behaves as warn)', undefined],
        ['warn', 'warn'],
        ['off', 'off'],
    ])('mode %s — the consent POST is still checked', (_label, mode) =>
    {
        beforeEach(() =>
        {
            configureAuth({ csrf: mode ? { mode } : undefined });
        });

        it('GET without the header describes the request (safe method, unchecked)', async () =>
        {
            const answer = await throughTheProxy(app, requestContext('GET', fields, jar));

            expect(answer.status).toBe(200);
            expect(answer.body.clientName).toBe(NAME);
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

        it('POST with a CSRF header equal to the CSRF cookie issues a code', async () =>
        {
            const answer = await approve(jar.get(COOKIE_NAMES.CSRF));

            expect(answer.status).toBe(200);
            expect(answer.body.code).toEqual(expect.any(String));
            expect(answer.body.redirectUri).toBe(TEST_REDIRECT_URI);
        });

        it('an exempt-list entry naming the consent path does not reopen it', async () =>
        {
            configureAuth({ csrf: { ...(mode ? { mode } : {}), exemptPaths: [AUTHORIZE] } });

            const answer = await approve();

            expect(answer.status).toBe(403);
            expect(answer.reachedBackend).toBe(false);
        });

        it('a server-side authApi call, which mirrors the forwarded jar itself, passes', async () =>
        {
            // What @spfn/core's client sends when it runs on the server: the
            // header built from the jar it forwards, not from document.cookie.
            const answer = await approve(csrfHeaderValue(jar.entries()));

            expect(answer.status).toBe(200);
            expect(answer.body.code).toEqual(expect.any(String));
        });
    });

    // An app running `off` must still be able to approve. The readable cookie is
    // issued in every mode, and a refusal repairs a jar that lacks it.
    describe('mode off — a jar without the CSRF cookie', () =>
    {
        beforeEach(() =>
        {
            configureAuth({ csrf: { mode: 'off' } });
            jar.delete(COOKIE_NAMES.CSRF);
        });

        it('a page load (the consent GET) issues the cookie', async () =>
        {
            const answer = await throughTheProxy(app, requestContext('GET', fields, jar));

            expect(answer.status).toBe(200);
            expect(issuedCsrf(answer)).toBe(await expectedCsrf());
        });

        it('the first POST is refused 403 with a repair cookie; the retry mirroring it gets a code', async () =>
        {
            const first = await approve();

            expect(first.status).toBe(403);
            expect(first.reachedBackend).toBe(false);
            expect(issuedCsrf(first)).toBe(await expectedCsrf());

            jar.set(COOKIE_NAMES.CSRF, issuedCsrf(first)!);

            const retry = await approve(csrfHeaderValue(jar.entries()));

            expect(retry.status).toBe(200);
            expect(retry.body.code).toEqual(expect.any(String));
        });
    });

    // T7 (au6-B5): the disconnect button is a cookie-session mutation as much as
    // the consent is. Under the default settings — `warn` — a cross-site page
    // could otherwise cut the user's CLI off through their session cookie.
    describe('default settings — the disconnect button', () =>
    {
        beforeEach(() =>
        {
            configureAuth({ csrf: undefined });
        });

        it('DELETE /_auth/oauth2/grants/:id without the CSRF header is refused 403, the grant left live', async () =>
        {
            expect((await approve(jar.get(COOKIE_NAMES.CSRF))).status).toBe(200);

            const [grant] = await getTestDb().select().from(oauth2Grants);
            const answer = await throughTheProxy(app, disconnectContext(Number(grant!.id), jar));

            expect(answer.status).toBe(403);
            expect(answer.reachedBackend).toBe(false);

            const [after] = await getTestDb().select().from(oauth2Grants);

            expect(after!.revokedAt).toBeNull();
        });
    });

    // F2 (a10f1): the declaration of the package's own routes is read from the
    // map the package ships, not from the app's generated copy. An app that
    // upgraded without regenerating holds entries with no `csrf` — and the proxy
    // hands those over as `ctx.route`. Neither that entry nor a spelling of the
    // path the backend still routes may switch the check off.
    describe('a stale app route map — entries generated before `.csrf()` was declared', () =>
    {
        const MODES: [string, { mode: CsrfMode } | undefined][] = [
            ['unset', undefined],
            ['warn', { mode: 'warn' }],
            ['off', { mode: 'off' }],
        ];

        /** The consent POST, resolved through a stale entry spelled `path`. */
        function staleConsent(path: string): RequestInterceptorContext
        {
            return {
                ...requestContext('POST', { ...fields, approve: true }, jar),
                path,
                route: { method: 'POST', path },
            } as RequestInterceptorContext;
        }

        /** The disconnect, resolved through a stale entry spelled `path`. */
        function staleDisconnect(path: string): RequestInterceptorContext
        {
            return {
                ...disconnectContext(0, jar),
                path,
                route: { method: 'DELETE', path: '/_auth/oauth2/grants/:id' },
            } as RequestInterceptorContext;
        }

        /** A live grant to disconnect, made with a valid header. */
        async function liveGrantId(): Promise<number>
        {
            expect((await approve(jar.get(COOKIE_NAMES.CSRF))).status).toBe(200);

            const [grant] = await getTestDb().select().from(oauth2Grants);

            return Number(grant!.id);
        }

        /** Refused by the proxy, or never routed by the backend — never passed. */
        function expectNotPassed(answer: ProxyAnswer): void
        {
            if (answer.reachedBackend)
            {
                expect(answer.status).toBe(404);

                return;
            }

            expect(answer.status).toBe(403);
        }

        describe.each(MODES)('mode %s', (_label, csrf) =>
        {
            beforeEach(() =>
            {
                configureAuth({ csrf });
            });

            it('consent approve without the CSRF header → 403, nothing recorded', async () =>
            {
                const answer = await throughTheProxy(app, staleConsent(AUTHORIZE));

                expect(answer.status).toBe(403);
                expect(answer.reachedBackend).toBe(false);
                expect(await getTestDb().select().from(oauth2Grants)).toHaveLength(0);
            });

            it('disconnect without the CSRF header → 403, the grant left live', async () =>
            {
                const grantId = await liveGrantId();
                const answer = await throughTheProxy(app, staleDisconnect(`/_auth/oauth2/grants/${grantId}`));

                expect(answer.status).toBe(403);
                expect(answer.reachedBackend).toBe(false);

                const [after] = await getTestDb().select().from(oauth2Grants);

                expect(after!.revokedAt).toBeNull();
            });
        });

        describe('variant spellings, default settings', () =>
        {
            beforeEach(() =>
            {
                configureAuth({ csrf: undefined });
            });

            it.each([
                ['an encoded character', '/_auth/oauth2/%61uthorize'],
                ['a dot segment', '/_auth/oauth2/x/../authorize'],
                ['an encoded dot segment', '/_auth/oauth2/x/%2e%2e/authorize'],
                ['a trailing slash', '/_auth/oauth2/authorize/'],
            ])('consent approve spelled with %s → refused or not routed, nothing recorded', async (_label, path) =>
            {
                expectNotPassed(await throughTheProxy(app, staleConsent(path)));
                expect(await getTestDb().select().from(oauth2Grants)).toHaveLength(0);
            });

            it.each([
                ['an encoded character', (id: number) => `/_auth/oauth2/grant%73/${id}`],
                ['an encoded id', (id: number) => `/_auth/oauth2/grants/${[...String(id)].map(digit => `%3${digit}`).join('')}`],
                ['a dot segment', (id: number) => `/_auth/oauth2/x/../grants/${id}`],
                ['a trailing slash', (id: number) => `/_auth/oauth2/grants/${id}/`],
            ])('disconnect spelled with %s → refused or not routed, the grant left live', async (_label, spell) =>
            {
                const grantId = await liveGrantId();

                expectNotPassed(await throughTheProxy(app, staleDisconnect(spell(grantId))));

                const [after] = await getTestDb().select().from(oauth2Grants);

                expect(after!.revokedAt).toBeNull();
            });
        });
    });

    /** The token the proxy derives for this jar's session key. */
    async function expectedCsrf(): Promise<string>
    {
        return await deriveCsrfToken(jar.get(COOKIE_NAMES.SESSION_KEY_ID)!);
    }
});
