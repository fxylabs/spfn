/**
 * @spfn/auth - a repeated OAuth finalize must not sign the person out (fxylabs/spfn#126, claim 1)
 *
 * Began as the reproduction; the case table of the fix (F and C rows) follows
 * it. The sequence is a reload of the callback page after a successful sign-in:
 *
 * 1. The first `POST /_auth/oauth/finalize` sealed the session and cleared
 *    `OAUTH_PENDING`, so the browser now holds a valid session and no pending
 *    cookie.
 * 2. The reload posts the same `userId`/`keyId` again. The backend route is a
 *    stateless echo, so it answers 200 a second time.
 * 3. `oauthFinalizeInterceptor` finds no pending cookie and rewrites that 200 into
 *    a 401 ("OAuth session expired").
 * 4. `generalAuthInterceptor` runs after it (registration order), sees a 401 on a
 *    request whose session it validated, and expires the session cookies.
 *
 * Fixed by answering a finalize that repeats the current session's key with the
 * backend's 200 unchanged, and by marking every 401 the finalize rule writes
 * itself (`proxyWroteError`) so the general rule leaves the session alone.
 *
 * The chain is driven exactly the way `session-renew-proxy-chain.test.ts` does it:
 * `filterMatchingInterceptors` against the shipped `authInterceptors`, then the two
 * chain executors `createRpcProxy` calls.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';
import { registerRoutes } from '@spfn/core/route';

import { authInterceptors } from '../../nextjs/interceptors';
import { runOAuthCallback, type CallbackOptions } from '../../nextjs/components/oauth-callback-flow';
import { sealPendingSession } from '../../nextjs/session-helpers';
import { sealSession, unsealSession } from '../../server/lib/session';
import { generateKeyPair } from '../../server/lib/crypto';
import { COOKIE_NAMES } from '../../server/lib/config';
import { CSRF_HEADER, deriveCsrfToken } from '../../server/lib/csrf';
import { mainAuthRouter } from '../../server/routes';

vi.mock('../../server/services/session-binding.service', async (importActual) => ({
    ...(await importActual<typeof import('../../server/services/session-binding.service')>()),
    keySessionBindingService: vi.fn(async () => ({})),
}));

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const FINALIZE = '/_auth/oauth/finalize';
const SEVEN_DAYS = 7 * 24 * 3600;

/** The jar right after the first, successful finalize: a session, no pending cookie. */
async function signedInJar(): Promise<{ jar: Map<string, string>; keyId: string }>
{
    const keyPair = generateKeyPair('ES256');
    const sealed = await sealSession({
        userId: '7',
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
    }, SEVEN_DAYS);

    const jar = new Map([
        [COOKIE_NAMES.SESSION, sealed],
        [COOKIE_NAMES.SESSION_KEY_ID, keyPair.keyId],
        [COOKIE_NAMES.CSRF, await deriveCsrfToken(keyPair.keyId)],
    ]);

    return { jar, keyId: keyPair.keyId };
}

/** Add the pending cookie an OAuth start leaves behind, for a fresh key pair; returns its keyId. */
async function withPendingCookie(jar: Map<string, string>): Promise<string>
{
    const keyPair = generateKeyPair('ES256');

    jar.set(COOKIE_NAMES.OAUTH_PENDING, await sealPendingSession({
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
    }));

    return keyPair.keyId;
}

/**
 * The request `runOAuthCallback` sends: `Content-Type` and the cookie jar, plus
 * whatever extra headers the caller passes (the CSRF header `postFinalize`
 * mirrors from the readable cookie, in the C rows).
 */
function requestContext(body: unknown, jar: Map<string, string>, extra: Record<string, string> = {}, path = FINALIZE): RequestInterceptorContext
{
    const headers = { 'content-type': 'application/json', ...extra };

    return {
        path,
        method: 'POST',
        headers: { ...headers } as Record<string, string>,
        body,
        query: {},
        cookies: jar,
        request: { headers: new Headers(headers) },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

function responseContext(requestCtx: RequestInterceptorContext, status: number, body: unknown): ResponseInterceptorContext
{
    return {
        path: requestCtx.path,
        method: requestCtx.method,
        request: { headers: {}, body: requestCtx.body },
        response: { ok: status < 400, status, statusText: '', headers: new Headers(), body },
        cookies: requestCtx.cookies,
        setCookies: [] as SetCookie[],
        metadata: requestCtx.metadata,
    } as unknown as ResponseInterceptorContext;
}

/** What answers in place of the backend: the real routes, or a fixed status and body. */
type Backend = Hono | { status: number; body: unknown };

async function callBackend(backend: Backend, path: string, body: unknown): Promise<{ status: number; body: unknown }>
{
    if (!(backend instanceof Hono))
    {
        return backend;
    }

    const response = await backend.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.json() };
}

interface ChainInput
{
    body: Record<string, unknown>;
    jar: Map<string, string>;
    headers?: Record<string, string>;
    path?: string;
}

/** The body through every matching rule, the backend (real or fixed) in between. */
async function throughTheChain(backend: Backend, input: ChainInput)
{
    const path = input.path ?? FINALIZE;
    const matching = filterMatchingInterceptors(authInterceptors, path, 'POST');
    const requestCtx = requestContext(input.body, input.jar, input.headers, path);

    await executeRequestInterceptors(
        requestCtx,
        matching.map(rule => rule.request).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    if (requestCtx.abort)
    {
        return { requestCtx, responseCtx: undefined, backendStatus: undefined };
    }

    const answer = await callBackend(backend, path, requestCtx.body);
    const responseCtx = responseContext(requestCtx, answer.status, answer.body);

    await executeResponseInterceptors(
        responseCtx,
        matching.map(rule => rule.response).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    return { requestCtx, responseCtx, backendStatus: answer.status };
}

/** The finalize body through every matching rule, the real backend route in between. */
async function finalizeThroughTheChain(app: Hono, body: Record<string, string>, jar: Map<string, string>)
{
    return await throughTheChain(app, { body, jar });
}

/** Names among SESSION, SESSION_KEY_ID and CSRF that the response writes or expires. */
function sessionCookiesTouched(setCookies: SetCookie[]): string[]
{
    const names = [COOKIE_NAMES.SESSION, COOKIE_NAMES.SESSION_KEY_ID, COOKIE_NAMES.CSRF];

    return setCookies.filter(cookie => names.includes(cookie.name)).map(cookie => cookie.name);
}

/** The value of the last cookie of that name the response writes. */
function written(setCookies: SetCookie[], name: string): string | undefined
{
    return setCookies.filter(cookie => cookie.name === name).at(-1)?.value;
}

function expired(setCookies: SetCookie[]): string[]
{
    return setCookies.filter(cookie => cookie.options?.maxAge === 0).map(cookie => cookie.name);
}

describe('repeated POST /_auth/oauth/finalize (#126 claim 1)', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        app = new Hono();
        registerRoutes(app, mainAuthRouter);
    });

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('the chain that runs for the finalize path ends finalize, then general-auth', () =>
    {
        const names = filterMatchingInterceptors(authInterceptors, FINALIZE, 'POST')
            .map(rule => authInterceptors.indexOf(rule));

        // mfaVerifyInterceptor (3, acts on a 202 only), oauthFinalizeInterceptor (6),
        // generalAuthInterceptor (7). Response phases run in this order, so
        // general-auth sees the status finalize left behind.
        expect(names).toEqual([3, 6, 7]);
    });

    it('the backend answers a replayed finalize with 200 again — it keeps no state to refuse it', async () =>
    {
        const { jar, keyId } = await signedInJar();

        const { backendStatus } = await finalizeThroughTheChain(app, { userId: '7', keyId, returnUrl: '/' }, jar);

        expect(backendStatus).toBe(200);
    });

    it('a replayed finalize leaves the valid session cookies in place (default CSRF mode)', async () =>
    {
        const { jar, keyId } = await signedInJar();

        const { responseCtx } = await finalizeThroughTheChain(app, { userId: '7', keyId, returnUrl: '/' }, jar);

        // Today the page receives the interceptor's 401 "OAuth session expired",
        // and general-auth expires the session on the way out. Whatever the page
        // is told, the session the first finalize installed must survive.
        expect(expired(responseCtx!.setCookies)).not.toContain(COOKIE_NAMES.SESSION);
        expect(expired(responseCtx!.setCookies)).not.toContain(COOKIE_NAMES.SESSION_KEY_ID);
    });

    it('under SPFN_AUTH_CSRF=enforce the replay never reaches the backend — refused 403, session kept', async () =>
    {
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
        const { jar, keyId } = await signedInJar();

        const { requestCtx, responseCtx } = await finalizeThroughTheChain(app, { userId: '7', keyId, returnUrl: '/' }, jar);

        expect(responseCtx).toBeUndefined();
        expect(requestCtx.abort?.status).toBe(403);
        expect(expired(requestCtx.abort?.setCookies ?? [])).toEqual([]);
    });
});

/**
 * The finalize case table (#126, part A). Each `it` is named for its row.
 *
 * "Inbound session" is the one `generalAuthInterceptor` unsealed on the way in;
 * a row whose session must survive asserts the response neither writes nor
 * expires any of SESSION, SESSION_KEY_ID or CSRF.
 */
describe('POST /_auth/oauth/finalize case table (#126)', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        app = new Hono();
        registerRoutes(app, mainAuthRouter);
    });

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('F1: pending cookie for the body key, no session — the session is sealed', async () =>
    {
        const jar = new Map<string, string>();
        const keyId = await withPendingCookie(jar);

        const { responseCtx } = await throughTheChain(app, { body: { userId: '7', keyId }, jar });

        expect(responseCtx!.response.status).toBe(200);
        expect(written(responseCtx!.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(keyId);
        expect((await unsealSession(written(responseCtx!.setCookies, COOKIE_NAMES.SESSION)!)).keyId).toBe(keyId);
        expect(expired(responseCtx!.setCookies)).toContain(COOKIE_NAMES.OAUTH_PENDING);
    });

    it('F2: no pending cookie, session for the body key — 200, body unchanged, no session cookie touched', async () =>
    {
        const { jar, keyId } = await signedInJar();

        const { responseCtx } = await throughTheChain(app, { body: { userId: '7', keyId, returnUrl: '/home' }, jar });

        expect(responseCtx!.response.status).toBe(200);
        expect(responseCtx!.response.body).toMatchObject({ userId: '7', keyId, returnUrl: '/home' });
        expect(sessionCookiesTouched(responseCtx!.setCookies)).toEqual([]);
        expect(responseCtx!.setCookies.map(cookie => cookie.name)).not.toContain(COOKIE_NAMES.OAUTH_PENDING);
    });

    it('F3: no pending cookie, session for another key — 401, the session is left alone', async () =>
    {
        const { jar } = await signedInJar();

        const { responseCtx } = await throughTheChain(app, { body: { userId: '7', keyId: 'some-other-key' }, jar });

        expect(responseCtx!.response.status).toBe(401);
        expect(responseCtx!.response.body).toMatchObject({ success: false, message: 'OAuth session expired. Please try again.' });
        expect(sessionCookiesTouched(responseCtx!.setCookies)).toEqual([]);
    });

    it('F4: no pending cookie, no session — 401, as before', async () =>
    {
        const { responseCtx } = await throughTheChain(app, { body: { userId: '7', keyId: 'any-key' }, jar: new Map() });

        expect(responseCtx!.response.status).toBe(401);
        expect(responseCtx!.response.body).toMatchObject({ success: false, message: 'OAuth session expired. Please try again.' });
        expect(sessionCookiesTouched(responseCtx!.setCookies)).toEqual([]);
    });

    it('F5: pending cookie for another key, valid session — 401 "session mismatch", the session is left alone', async () =>
    {
        const { jar } = await signedInJar();
        await withPendingCookie(jar);

        const { responseCtx } = await throughTheChain(app, { body: { userId: '7', keyId: 'not-the-pending-key' }, jar });

        expect(responseCtx!.response.status).toBe(401);
        expect(responseCtx!.response.body).toMatchObject({ message: 'OAuth session mismatch. Please try again.' });
        expect(sessionCookiesTouched(responseCtx!.setCookies)).toEqual([]);
    });

    it('F6: pending cookie for the body key, valid session for another — the new session replaces the old', async () =>
    {
        const { jar, keyId: oldKeyId } = await signedInJar();
        const keyId = await withPendingCookie(jar);

        const { responseCtx } = await throughTheChain(app, { body: { userId: '8', keyId }, jar });

        expect(keyId).not.toBe(oldKeyId);
        expect(responseCtx!.response.status).toBe(200);
        expect(written(responseCtx!.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(keyId);
        expect((await unsealSession(written(responseCtx!.setCookies, COOKIE_NAMES.SESSION)!)).keyId).toBe(keyId);
        expect(expired(responseCtx!.setCookies)).not.toContain(COOKIE_NAMES.SESSION);
    });

    it('F7: the backend itself answers 401 with a valid session — the session cookies are expired', async () =>
    {
        const refused = { status: 401, body: { __type: 'UnauthorizedError', message: 'Key revoked' } };

        for (const path of [FINALIZE, '/users/me/profile'])
        {
            const { jar, keyId } = await signedInJar();

            const { responseCtx } = await throughTheChain(refused, { body: { userId: '7', keyId }, jar, path });

            expect(responseCtx!.response.status).toBe(401);
            expect(expired(responseCtx!.setCookies)).toEqual(expect.arrayContaining([
                COOKIE_NAMES.SESSION,
                COOKIE_NAMES.SESSION_KEY_ID,
                COOKIE_NAMES.CSRF,
            ]));
        }
    });

    it('F8: no pending cookie, session for the body key, body lacks userId or keyId — 401, the session is left alone', async () =>
    {
        const { jar, keyId } = await signedInJar();

        for (const body of [{ keyId }, { userId: '7' }])
        {
            // The real route refuses such a body with a 400 before this rule
            // runs; a fixed 200 is what reaches the rule if it ever did not.
            const { responseCtx } = await throughTheChain({ status: 200, body }, { body, jar });

            expect(responseCtx!.response.status).toBe(401);
            expect(sessionCookiesTouched(responseCtx!.setCookies)).toEqual([]);
        }
    });
});

/** A `fetch` that hands what `postFinalize` sends to the proxy chain, the real routes behind it. */
function proxiedFetch(app: Hono, jar: Map<string, string>)
{
    const results: Array<Awaited<ReturnType<typeof throughTheChain>>> = [];

    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const result = await throughTheChain(app, { body: JSON.parse(String(init?.body)).body, jar, headers });
        const answer = result.requestCtx.abort ?? result.responseCtx!.response;

        results.push(result);

        return new Response(JSON.stringify(answer.body), { status: answer.status });
    });

    return { fetch: fetch as unknown as CallbackOptions['fetch'], results };
}

/** The browser's readable cookies — the CSRF cookie and nothing HttpOnly. */
function stubDocumentCookie(jar: Map<string, string>): void
{
    const csrf = jar.get(COOKIE_NAMES.CSRF);

    vi.stubGlobal('document', { cookie: csrf ? `${COOKIE_NAMES.CSRF}=${csrf}` : '' });
}

/** The callback page for a finished sign-in, run against the proxy chain. */
async function callbackThroughTheProxy(app: Hono, jar: Map<string, string>, keyId: string)
{
    stubDocumentCookie(jar);
    const { fetch, results } = proxiedFetch(app, jar);

    const outcome = await runOAuthCallback(`?userId=7&keyId=${keyId}&returnUrl=/home`, { apiBasePath: '/api/rpc', fetch });
    const sentHeaders = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);

    return { outcome, sentHeaders, result: results[0] };
}

/** The CSRF header on the callback's finalize, against the proxy (#126). */
describe('postFinalize carries the CSRF header (#126)', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        app = new Hono();
        registerRoutes(app, mainAuthRouter);
    });

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('C1: enforce, signed in, a new pending cookie — the finalize passes the gate and seals the new session', async () =>
    {
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
        const { jar } = await signedInJar();
        const keyId = await withPendingCookie(jar);

        const { outcome, sentHeaders, result } = await callbackThroughTheProxy(app, jar, keyId);

        expect(sentHeaders.get(CSRF_HEADER)).toBe(jar.get(COOKIE_NAMES.CSRF));
        expect(result.requestCtx.abort).toBeUndefined();
        expect(outcome).toEqual({ kind: 'navigate', to: '/home', userId: '7' });
        expect(written(result.responseCtx!.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(keyId);
    });

    it('C2: enforce, signed in, same key, no pending cookie (a replay) — passes the gate, answered 200', async () =>
    {
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
        const { jar, keyId } = await signedInJar();

        const { outcome, result } = await callbackThroughTheProxy(app, jar, keyId);

        expect(result.requestCtx.abort).toBeUndefined();
        expect(result.responseCtx!.response.status).toBe(200);
        expect(outcome).toEqual({ kind: 'navigate', to: '/home', userId: '7' });
        expect(sessionCookiesTouched(result.responseCtx!.setCookies)).toEqual([]);
    });

    it('C3: enforce, not signed in — no header is sent and the session is sealed, as before', async () =>
    {
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
        const jar = new Map<string, string>();
        const keyId = await withPendingCookie(jar);

        const { outcome, sentHeaders, result } = await callbackThroughTheProxy(app, jar, keyId);

        expect(sentHeaders.has(CSRF_HEADER)).toBe(false);
        expect(outcome).toEqual({ kind: 'navigate', to: '/home', userId: '7' });
        expect(written(result.responseCtx!.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(keyId);
    });

    it('C4: warn — signing in again and a replay both succeed, as before', async () =>
    {
        const { jar, keyId: currentKeyId } = await signedInJar();

        const replay = await callbackThroughTheProxy(app, jar, currentKeyId);
        const keyId = await withPendingCookie(jar);
        const again = await callbackThroughTheProxy(app, jar, keyId);

        expect(replay.outcome).toEqual({ kind: 'navigate', to: '/home', userId: '7' });
        expect(again.outcome).toEqual({ kind: 'navigate', to: '/home', userId: '7' });
        expect(written(again.result.responseCtx!.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(keyId);
    });
});
