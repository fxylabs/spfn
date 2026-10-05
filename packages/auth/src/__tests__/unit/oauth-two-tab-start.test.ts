/**
 * @spfn/auth - two tabs starting a social sign-in (fxylabs/spfn#126, claim 2)
 *
 * Began as the reproduction; the case table of the fix (B rows) follows it.
 * `oauthUrlInterceptor` used to write two fixed-name cookies on every start —
 * `OAUTH_PENDING` (the sealed private key) and `OAUTH_CSRF` (the nonce sealed
 * into that start's state) — so a second start in another tab overwrote both,
 * and the callback route deleted every `spfn_oauth_csrf*` cookie before checking.
 *
 * Each start now writes its own pair, `<base>.<issuedAt>.<id>`, and every reader
 * picks the one its keyId names.
 *
 * Each tab is a real start through the interceptor (request and response phase);
 * the browser jar applies every Set-Cookie, an expiry removing the name. Each
 * callback goes through the real `GET /_auth/oauth/:provider/callback` route, with
 * `Transactional()` reduced to a pass-through because no database is involved
 * before the CSRF gate. A mock provider whose code exchange throws marks the
 * point a callback got past the nonce check: such a callback lands on the error
 * page with `reason=provider_error`, and nothing before the gate produces that
 * reason. Finalizes run through every matching proxy rule with the real
 * finalize route behind them.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';
import { registerRoutes } from '@spfn/core/route';

const browser = vi.hoisted(() => ({ jar: new Map<string, string>() }));

vi.mock('@spfn/core/db', async (importActual) => ({
    ...(await importActual<typeof import('@spfn/core/db')>()),
    Transactional: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

vi.mock('../../server/services/session-binding.service', async (importActual) => ({
    ...(await importActual<typeof import('../../server/services/session-binding.service')>()),
    keySessionBindingService: vi.fn(async () => ({})),
}));

// `createOAuthCallbackHandler` reads the jar through next/headers (B13).
vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        getAll: () => [...browser.jar].map(([name, value]) => ({ name, value })),
    }),
}));

import { NextRequest } from 'next/server';

import { authInterceptors, oauthUrlInterceptor } from '../../nextjs/interceptors';
import { createOAuthCallbackHandler } from '../../nextjs/oauth-handlers';
import { runOAuthCallback, type CallbackOptions } from '../../nextjs/components/oauth-callback-flow';
import { sealPendingSession, unsealPendingMfaSession } from '../../nextjs/session-helpers';
import { getOAuthProvider, registerOAuthProvider, type OAuthProvider } from '../../server/lib/oauth';
import { createOAuthState, verifyOAuthState } from '../../server/lib/oauth/state';
import {
    buildStartCookieName,
    listStartCookies,
    namesEvictedByStart,
    parseStartCookieName,
    startCookieId,
} from '../../server/lib/oauth/start-cookies';
import { generateKeyPair } from '../../server/lib/crypto';
import { sealSession, unsealSession } from '../../server/lib/session';
import { COOKIE_NAMES } from '../../server/lib/config';
import { matchOAuthCallbackCsrf } from '../../server/services/oauth.service';
import { mainAuthRouter } from '../../server/routes';
import { OAuthStateExpiredError, OAuthStateInvalidError } from '@spfn/auth/errors';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const GATE_PASSED = 'provider_error';
const CHALLENGE = 'challenge-secret-that-is-long-enough-to-pass';
const FINALIZE = '/_auth/oauth/finalize';

/** A fresh client address per request, so the routes' per-IP limits never trip across the fork. */
let requests = 0;

function clientIp(): string
{
    requests += 1;

    return `2001:db8::${requests.toString(16)}`;
}

/**
 * Auth's suite runs every file in one fork and the registry has no removal, so
 * whatever `superself` provider was registered before this file is put back.
 */
const previousProvider = getOAuthProvider('superself');

afterAll(() =>
{
    if (previousProvider)
    {
        registerOAuthProvider(previousProvider);
    }
});

function provider(): OAuthProvider
{
    return {
        id: 'superself',
        isEnabled: () => true,
        getAuthUrl: (state: string) => `https://idp.example/auth?state=${state}`,
        exchangeCodeForTokens: async () =>
        {
            throw new Error('the code exchange ran, so the CSRF gate passed');
        },
        getUserInfo: async () => ({ providerUserId: 'idp-1', email: null, emailVerified: false }),
    };
}

interface Tab
{
    state: string;
    keyId: string;
    /** What the start's response wrote, expiries included. */
    setCookies: SetCookie[];
}

/** The jar after a response: a write sets the name, an expiry removes it. */
function applyToJar(jar: Map<string, string>, setCookies: SetCookie[]): void
{
    for (const cookie of setCookies)
    {
        if (cookie.options?.maxAge === 0)
        {
            jar.delete(cookie.name);
        }
        else
        {
            jar.set(cookie.name, cookie.value);
        }
    }
}

/** The same, for raw `Set-Cookie` headers; returns the names they expired. */
function applyHeadersToJar(jar: Map<string, string>, headers: string[]): string[]
{
    const expired: string[] = [];

    for (const header of headers)
    {
        const [pair] = header.split(';');
        const name = pair.slice(0, pair.indexOf('='));

        if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(header))
        {
            jar.delete(name);
            expired.push(name);
        }
        else
        {
            jar.set(name, pair.slice(pair.indexOf('=') + 1));
        }
    }

    return expired;
}

function expired(setCookies: SetCookie[]): string[]
{
    return setCookies.filter(cookie => cookie.options?.maxAge === 0).map(cookie => cookie.name);
}

function cookieHeader(jar: Map<string, string>): string
{
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** The two names a start's cookies sit under, read back from what it wrote. */
function startNames(tab: Tab): { pending: string; csrf: string }
{
    const written = tab.setCookies.filter(cookie => cookie.options?.maxAge !== 0).map(cookie => cookie.name);

    return {
        pending: written.find(name => parseStartCookieName('pending', name))!,
        csrf: written.find(name => parseStartCookieName('csrf', name))!,
    };
}

/** One start through the interceptor; its cookies land in the jar. */
async function startIn(jar: Map<string, string>): Promise<Tab>
{
    const requestCtx = {
        path: '/_auth/oauth/superself/url',
        method: 'POST',
        body: { returnUrl: '/' },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;

    await oauthUrlInterceptor.request!(requestCtx, async () => undefined);

    const responseCtx = {
        path: requestCtx.path,
        method: 'POST',
        response: { ok: true, status: 200, statusText: '', headers: new Headers(), body: {} },
        cookies: jar,
        setCookies: [] as SetCookie[],
        metadata: requestCtx.metadata,
    } as unknown as ResponseInterceptorContext;

    await oauthUrlInterceptor.response!(responseCtx, async () => undefined);
    applyToJar(jar, responseCtx.setCookies);

    const state = requestCtx.body.state as string;

    return { state, keyId: (await verifyOAuthState(state)).keyId, setCookies: responseCtx.setCookies };
}

interface CallbackResult
{
    reason: string | null;
    error: string | null;
    expired: string[];
}

/** The provider's redirect back to the callback route, carrying the jar. */
async function callback(app: Hono, state: string, jar: Map<string, string>): Promise<CallbackResult>
{
    const response = await app.request(`/_auth/oauth/superself/callback?code=c&state=${state}`, {
        headers: { 'Cookie': cookieHeader(jar), 'x-forwarded-for': clientIp() },
    });
    const location = new URL(response.headers.get('location')!, 'https://app.example');

    return {
        reason: location.searchParams.get('reason'),
        error: location.searchParams.get('error'),
        expired: applyHeadersToJar(jar, response.headers.getSetCookie()),
    };
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
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp() },
        body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.json() };
}

function requestContext(path: string, body: unknown, jar: Map<string, string>): RequestInterceptorContext
{
    const headers = { 'content-type': 'application/json' };

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

/** The body through every matching proxy rule, the backend in between; the jar takes the answer. */
async function throughTheChain(backend: Backend, path: string, body: unknown, jar: Map<string, string>)
{
    const matching = filterMatchingInterceptors(authInterceptors, path, 'POST');
    const requestCtx = requestContext(path, body, jar);

    await executeRequestInterceptors(requestCtx, matching.map(rule => rule.request).filter(phase => !!phase));

    const answer = await callBackend(backend, path, requestCtx.body);
    const responseCtx = {
        path,
        method: 'POST',
        request: { headers: {}, body: requestCtx.body },
        response: { ok: answer.status < 400, status: answer.status, statusText: '', headers: new Headers(), body: answer.body },
        cookies: jar,
        setCookies: [] as SetCookie[],
        metadata: requestCtx.metadata,
    } as unknown as ResponseInterceptorContext;

    await executeResponseInterceptors(responseCtx, matching.map(rule => rule.response).filter(phase => !!phase));
    applyToJar(jar, responseCtx.setCookies);

    return responseCtx;
}

/** The finalize a callback page posts for a tab whose backend callback succeeded. */
async function finalize(app: Hono, keyId: string, jar: Map<string, string>): Promise<ResponseInterceptorContext>
{
    return await throughTheChain(app, FINALIZE, { userId: '7', keyId, returnUrl: '/' }, jar);
}

function written(setCookies: SetCookie[], name: string): string | undefined
{
    return setCookies.filter(cookie => cookie.name === name && cookie.options?.maxAge !== 0).at(-1)?.value;
}

/** Every per-start cookie name in the jar, both kinds. */
function startCookiesIn(jar: Map<string, string>): string[]
{
    return [...listStartCookies('pending', jar), ...listStartCookies('csrf', jar)].map(cookie => cookie.name);
}

/** A state minted in another browser: its nonce cookie was never set here. */
async function foreignState(): Promise<string>
{
    const keyPair = generateKeyPair('ES256');

    return await createOAuthState({
        provider: 'superself',
        returnUrl: '/',
        publicKey: keyPair.publicKey,
        keyId: keyPair.keyId,
        fingerprint: keyPair.fingerprint,
        algorithm: keyPair.algorithm,
        nonce: 'nonce-in-the-attacker-browser',
    });
}

describe('two tabs starting OAuth in one browser (#126 claim 2)', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        registerOAuthProvider(provider());
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
        vi.useRealTimers();
        browser.jar = new Map();
    });

    it('the second start no longer overwrites the first start\'s two cookies', async () =>
    {
        const jar = new Map<string, string>();
        const first = await startIn(jar);
        const second = await startIn(jar);

        // Reproduction inverted: both pairs coexist, each under its own name,
        // and the first start's CSRF cookie still holds the nonce its state seals.
        expect(startCookiesIn(jar)).toHaveLength(4);
        expect(jar.get(startNames(first).csrf)).toBe((await verifyOAuthState(first.state)).nonce);
        expect(jar.get(startNames(second).csrf)).toBe((await verifyOAuthState(second.state)).nonce);
    });

    it('first tab returns first: both callbacks pass the CSRF gate', async () =>
    {
        const jar = new Map<string, string>();
        const first = await startIn(jar);
        const second = await startIn(jar);

        const outcomes = [(await callback(app, first.state, jar)).reason, (await callback(app, second.state, jar)).reason];

        expect(outcomes).toEqual([GATE_PASSED, GATE_PASSED]);
    });

    it('second tab returns first: the first tab\'s callback still passes the CSRF gate', async () =>
    {
        const jar = new Map<string, string>();
        const first = await startIn(jar);
        const second = await startIn(jar);

        const outcomes = [(await callback(app, second.state, jar)).reason, (await callback(app, first.state, jar)).reason];

        expect(outcomes).toEqual([GATE_PASSED, GATE_PASSED]);
    });

    it('finalize for the first tab finds its own private key, not the second tab\'s', async () =>
    {
        const jar = new Map<string, string>();
        const first = await startIn(jar);
        await startIn(jar);

        const ctx = await finalize(app, first.keyId, jar);

        expect(ctx.response.status).toBe(200);
        expect(ctx.setCookies.map(cookie => cookie.name)).toContain(COOKIE_NAMES.SESSION);
    });
});

/** The `OAuthCallback` page flow on a 202 callback for `keyId`, through the proxy chain. */
async function secondFactorIn(
    app: Hono,
    jar: Map<string, string>,
    keyId: string,
): Promise<{ ctx: ResponseInterceptorContext; outcome: Awaited<ReturnType<typeof runOAuthCallback>> }>
{
    const calls: ResponseInterceptorContext[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    {
        const ctx = await throughTheChain(app, FINALIZE, JSON.parse(String(init?.body)).body, jar);
        calls.push(ctx);

        return new Response(JSON.stringify(ctx.response.body), { status: ctx.response.status });
    });
    const outcome = await runOAuthCallback(
        `?mfaChallenge=${CHALLENGE}&keyId=${keyId}&returnUrl=%2F`,
        { apiBasePath: '/api/rpc', fetch: fetch as unknown as CallbackOptions['fetch'] },
    );

    return { ctx: calls[0], outcome };
}

/**
 * The case table of the fix (#126, part B). Each `it` is named for its row.
 */
describe('per-start OAuth cookies — case table (#126)', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        registerOAuthProvider(provider());
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
        vi.useRealTimers();
        browser.jar = new Map();
    });

    it('B1: one tab — start, callback, finalize: signed in, both cookies gone, no legacy cookie ever written', async () =>
    {
        const jar = new Map<string, string>();
        const tab = await startIn(jar);
        const names = startNames(tab);

        const back = await callback(app, tab.state, jar);
        const ctx = await finalize(app, tab.keyId, jar);

        expect(tab.setCookies.map(cookie => cookie.name)).not.toContain(COOKIE_NAMES.OAUTH_PENDING);
        expect(tab.setCookies.map(cookie => cookie.name)).not.toContain(COOKIE_NAMES.OAUTH_CSRF);
        expect(back.reason).toBe(GATE_PASSED);
        expect(ctx.response.status).toBe(200);
        expect((await unsealSession(jar.get(COOKIE_NAMES.SESSION)!)).keyId).toBe(tab.keyId);
        expect(jar.has(names.pending)).toBe(false);
        expect(jar.has(names.csrf)).toBe(false);
        expect(startCookiesIn(jar)).toEqual([]);
    });

    it('B2: two tabs, the first returns first — both callbacks pass, both finalizes succeed', async () =>
    {
        const jar = new Map<string, string>();
        const first = await startIn(jar);
        const second = await startIn(jar);

        const reasons = [(await callback(app, first.state, jar)).reason, (await callback(app, second.state, jar)).reason];
        const firstFinal = await finalize(app, first.keyId, jar);
        const secondFinal = await finalize(app, second.keyId, jar);

        expect(reasons).toEqual([GATE_PASSED, GATE_PASSED]);
        expect([firstFinal.response.status, secondFinal.response.status]).toEqual([200, 200]);
        expect(written(firstFinal.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(first.keyId);
        expect(written(secondFinal.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(second.keyId);
    });

    it('B3: two tabs, the second returns first — both callbacks pass, both finalizes succeed', async () =>
    {
        const jar = new Map<string, string>();
        const first = await startIn(jar);
        const second = await startIn(jar);

        const reasons = [(await callback(app, second.state, jar)).reason, (await callback(app, first.state, jar)).reason];
        const secondFinal = await finalize(app, second.keyId, jar);
        const firstFinal = await finalize(app, first.keyId, jar);

        expect(reasons).toEqual([GATE_PASSED, GATE_PASSED]);
        expect([secondFinal.response.status, firstFinal.response.status]).toEqual([200, 200]);
        expect(written(secondFinal.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(second.keyId);
        expect(written(firstFinal.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(first.keyId);
    });

    it('B4: a state with no cookie in this browser (login-CSRF) is refused invalid_state; the start in flight is untouched and finishes', async () =>
    {
        const jar = new Map<string, string>();
        const own = await startIn(jar);
        const before = new Map(jar);

        const forged = await callback(app, await foreignState(), jar);

        expect(forged.reason).toBe('invalid_state');
        expect(forged.expired).toEqual([]);
        expect(jar).toEqual(before);

        expect((await callback(app, own.state, jar)).reason).toBe(GATE_PASSED);
        expect((await finalize(app, own.keyId, jar)).response.status).toBe(200);
    });

    it('B5: the per-start CSRF cookie is found by id but holds another value — refused invalid_state, no cookie expired', async () =>
    {
        const jar = new Map<string, string>();
        const tab = await startIn(jar);
        await startIn(jar);
        jar.set(startNames(tab).csrf, 'a-value-this-state-never-sealed');
        const before = new Map(jar);

        const refused = await callback(app, tab.state, jar);

        expect(refused.reason).toBe('invalid_state');
        expect(refused.expired).toEqual([]);
        expect(jar).toEqual(before);
    });

    it('B6: a callback success with two starts in flight expires exactly one CSRF cookie — its own', async () =>
    {
        const jar = new Map<string, string>();
        const first = await startIn(jar);
        await startIn(jar);

        const back = await callback(app, first.state, jar);

        expect(back.reason).toBe(GATE_PASSED);
        expect(back.expired).toEqual([startNames(first).csrf]);
    });

    it('B7: a finalize success with two starts in flight expires exactly one pending cookie — its own', async () =>
    {
        // The newer start finalizes, so a reader that took the oldest pending
        // cookie (the first in the jar's order) instead of the keyed one fails.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));

        const jar = new Map<string, string>();
        await startIn(jar);
        vi.setSystemTime(new Date('2026-10-05T10:01:00Z'));
        const second = await startIn(jar);

        const ctx = await finalize(app, second.keyId, jar);
        const startCookiesExpired = expired(ctx.setCookies)
            .filter(name => parseStartCookieName('pending', name) || parseStartCookieName('csrf', name));

        expect(ctx.response.status).toBe(200);
        expect(startCookiesExpired).toEqual([startNames(second).pending]);
    });

    it('B8: a finalize whose keyId has no pending cookie while another start\'s exists, no session — 401 as F4, the other start untouched', async () =>
    {
        const jar = new Map<string, string>();
        const other = await startIn(jar);
        const before = new Map(jar);

        const ctx = await finalize(app, generateKeyPair('ES256').keyId, jar);

        expect(ctx.response.status).toBe(401);
        expect(ctx.response.body).toMatchObject({ success: false, message: 'OAuth session expired. Please try again.' });
        expect(expired(ctx.setCookies)).toEqual([]);
        expect(jar).toEqual(before);
        expect((await finalize(app, other.keyId, jar)).response.status).toBe(200);
    });

    it('B8b: the same, but the browser holds a session for that keyId — 200 as F2, nothing expired', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const jar = new Map([[COOKIE_NAMES.SESSION, await sealSession({
            userId: '7',
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        }, 7 * 24 * 3600)], [COOKIE_NAMES.SESSION_KEY_ID, keyPair.keyId]]);
        await startIn(jar);

        const ctx = await finalize(app, keyPair.keyId, jar);

        expect(ctx.response.status).toBe(200);
        expect(expired(ctx.setCookies)).toEqual([]);
    });

    it('B9: a sixth start within ten minutes expires the oldest start\'s two cookies; five remain; the evicted callback is refused', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const jar = new Map<string, string>();
        const tabs: Tab[] = [];

        for (let i = 0; i < 6; i++)
        {
            vi.setSystemTime(new Date('2026-10-05T10:00:00Z').getTime() + i * 60_000);
            tabs.push(await startIn(jar));
        }

        const oldest = startNames(tabs[0]);

        expect(expired(tabs[5].setCookies).sort()).toEqual([oldest.pending, oldest.csrf].sort());
        expect(listStartCookies('pending', jar).map(cookie => cookie.id))
            .toEqual(tabs.slice(1).map(tab => startCookieId(tab.keyId)));
        expect(listStartCookies('csrf', jar)).toHaveLength(5);
        expect((await callback(app, tabs[0].state, jar)).reason).toBe('invalid_state');
        expect((await callback(app, tabs[1].state, jar)).reason).toBe(GATE_PASSED);
    });

    it('B9b: a fifth start evicts nothing', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const jar = new Map<string, string>();
        const tabs: Tab[] = [];

        for (let i = 0; i < 5; i++)
        {
            vi.setSystemTime(new Date('2026-10-05T10:00:00Z').getTime() + i * 60_000);
            tabs.push(await startIn(jar));
        }

        expect(expired(tabs[4].setCookies)).toEqual([]);
        expect(startCookiesIn(jar)).toHaveLength(10);
    });

    it('B10: a start made before the upgrade (legacy names only) — callback passes, finalize seals, both legacy cookies expired after use', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const nonce = 'nonce-from-before-the-upgrade';
        const state = await createOAuthState({
            provider: 'superself',
            returnUrl: '/',
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            nonce,
        });
        const jar = new Map([
            [COOKIE_NAMES.OAUTH_CSRF, nonce],
            [COOKIE_NAMES.OAUTH_PENDING, await sealPendingSession({
                privateKey: keyPair.privateKey,
                keyId: keyPair.keyId,
                algorithm: keyPair.algorithm,
            })],
        ]);

        const back = await callback(app, state, jar);
        const ctx = await finalize(app, keyPair.keyId, jar);

        expect(back.reason).toBe(GATE_PASSED);
        expect(back.expired).toEqual([COOKIE_NAMES.OAUTH_CSRF]);
        expect(ctx.response.status).toBe(200);
        expect(written(ctx.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toBe(keyPair.keyId);
        expect(expired(ctx.setCookies)).toContain(COOKIE_NAMES.OAUTH_PENDING);
        expect(jar.has(COOKIE_NAMES.OAUTH_CSRF) || jar.has(COOKIE_NAMES.OAUTH_PENDING)).toBe(false);
    });

    it('B10b: a legacy pending cookie for another keyId, no per-start match — 401 "session mismatch", the legacy cookie handled as today', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const jar = new Map([[COOKIE_NAMES.OAUTH_PENDING, await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        })]]);

        const ctx = await finalize(app, generateKeyPair('ES256').keyId, jar);

        expect(ctx.response.status).toBe(401);
        expect(ctx.response.body).toMatchObject({ message: 'OAuth session mismatch. Please try again.' });
        expect(written(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();
        expect(expired(ctx.setCookies)).toEqual([COOKIE_NAMES.OAUTH_PENDING]);
    });

    it('B11: two tabs, tab 1 meets the 202 — the second-factor cookie is sealed from tab 1\'s key, not tab 2\'s', async () =>
    {
        // A minute apart, and each tab in turn: whichever start is older, the
        // cookie is picked by the 202's keyId, never by its place in the jar.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));

        const jar = new Map<string, string>();
        const first = await startIn(jar);
        vi.setSystemTime(new Date('2026-10-05T10:01:00Z'));
        const second = await startIn(jar);
        vi.stubGlobal('document', { cookie: '' });

        for (const [tab, other] of [[first, second], [second, first]])
        {
            const { ctx, outcome } = await secondFactorIn(app, jar, tab.keyId);
            const mfaPending = written(ctx.setCookies, COOKIE_NAMES.MFA_PENDING)!;

            expect(ctx.response.status).toBe(202);
            expect(ctx.response.body).toMatchObject({ keyId: tab.keyId });
            expect(outcome.kind).toBe('navigate');
            expect((await unsealPendingMfaSession(mfaPending)).keyId).toBe(tab.keyId);
            expect((await unsealPendingMfaSession(mfaPending)).keyId).not.toBe(other.keyId);
        }
    });

    it('B11b: a 202 whose keyId has no pending cookie at all bakes no second-factor cookie', async () =>
    {
        const jar = new Map<string, string>();
        await startIn(jar);

        const ctx = await throughTheChain(app, FINALIZE, {
            mfaChallenge: CHALLENGE,
            keyId: generateKeyPair('ES256').keyId,
            returnUrl: '/',
        }, jar);

        expect(ctx.response.status).toBe(202);
        expect(ctx.setCookies.map(cookie => cookie.name)).not.toContain(COOKIE_NAMES.MFA_PENDING);
    });

    it('B12: logout with two starts in flight plus legacy cookies expires all of them', async () =>
    {
        const jar = new Map([[COOKIE_NAMES.OAUTH_PENDING, 'legacy-pending'], [COOKIE_NAMES.OAUTH_CSRF, 'legacy-nonce']]);
        const first = await startIn(jar);
        const second = await startIn(jar);

        const ctx = await throughTheChain({ status: 200, body: { success: true } }, '/_auth/logout', {}, jar);

        expect(expired(ctx.setCookies)).toEqual(expect.arrayContaining([
            COOKIE_NAMES.OAUTH_PENDING,
            COOKIE_NAMES.OAUTH_CSRF,
            ...Object.values(startNames(first)),
            ...Object.values(startNames(second)),
        ]));
        expect(startCookiesIn(jar)).toEqual([]);
    });

    it('B13: createOAuthCallbackHandler, two tabs, both orders — both succeed', async () =>
    {
        const handler = createOAuthCallbackHandler();

        for (const order of [[0, 1], [1, 0]])
        {
            browser.jar = new Map();
            const tabs = [await startIn(browser.jar), await startIn(browser.jar)];

            for (const index of order)
            {
                const url = new URL(`/api/auth/callback?userId=7&keyId=${tabs[index].keyId}&returnUrl=%2Fhome`, 'https://app.example');
                const response = await handler(new NextRequest(url));
                const expiredNow = applyHeadersToJar(browser.jar, response.headers.getSetCookie());

                expect(new URL(response.headers.get('location')!).pathname).toBe('/home');
                expect((await unsealSession(browser.jar.get(COOKIE_NAMES.SESSION)!)).keyId).toBe(tabs[index].keyId);
                expect(expiredNow).toEqual([startNames(tabs[index]).pending]);
            }
        }
    });

    it('B14: API-mode oauthStart then callback — per-start CSRF cookie written and matched; a second start does not break the first', async () =>
    {
        const jar = new Map<string, string>();

        async function apiStart(): Promise<string>
        {
            const keyPair = generateKeyPair('ES256');
            const response = await app.request('/_auth/oauth/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader(jar), 'x-forwarded-for': clientIp() },
                body: JSON.stringify({
                    provider: 'superself',
                    returnUrl: '/',
                    publicKey: keyPair.publicKey,
                    keyId: keyPair.keyId,
                    fingerprint: keyPair.fingerprint,
                    algorithm: keyPair.algorithm,
                }),
            });
            const setCookies = response.headers.getSetCookie();

            applyHeadersToJar(jar, setCookies);
            expect(setCookies.map(header => header.split('=')[0]))
                .toEqual([buildStartCookieName('csrf', keyPair.keyId)]);

            return new URL((await response.json()).authUrl).searchParams.get('state')!;
        }

        const firstState = await apiStart();
        const secondState = await apiStart();

        expect(listStartCookies('csrf', jar)).toHaveLength(2);
        expect((await callback(app, firstState, jar)).reason).toBe(GATE_PASSED);
        expect((await callback(app, secondState, jar)).reason).toBe(GATE_PASSED);
    });

    it('B15: a callback after the state\'s ten minutes is refused with reason=expired', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const jar = new Map<string, string>();
        const tab = await startIn(jar);
        vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1000);

        const back = await callback(app, tab.state, jar);

        expect(back.reason).toBe('expired');
        expect(back.error).not.toMatch(/claim|JWE|JWT/);
        expect(back.expired).toEqual([]);
    });

    it('B16: proxy and backend disagree on the base\'s port suffix — the backend still finds the per-start CSRF cookie', async () =>
    {
        const jar = new Map<string, string>();
        vi.stubEnv('SPFN_PORT', '3790');
        const tab = await startIn(jar);
        vi.stubEnv('SPFN_PORT', '8790');

        const back = await callback(app, tab.state, jar);

        expect(startNames(tab).csrf.startsWith('spfn_oauth_csrf_3790.')).toBe(true);
        expect(back.reason).toBe(GATE_PASSED);
        expect(back.expired).toEqual([startNames(tab).csrf]);
    });

    it('B17: lookalike names are ignored by parse and list, and never matched or expired by the cap or logout', async () =>
    {
        const lookalikes = [
            'spfn_oauth_pending.x',
            'spfn_oauth_pending.kx1a2b',
            'spfn_oauth_pending.kx1a2b.0123456789abcdef.extra',
            'spfn_oauth_pending.kx1a2b.0123456789ABCDEF',
            'spfn_oauth_pending.kx1a2b.0123456789abcdeg',
            'spfn_oauth_pending.KX1A2B.0123456789abcdef',
            'spfn_oauth_pending..0123456789abcdef',
            'spfn_oauth_pending_extra.kx1a2b.0123456789abcdef',
            'spfn_oauth_pending_.kx1a2b.0123456789abcdef',
            'xspfn_oauth_pending.kx1a2b.0123456789abcdef',
            'spfn_oauth_csrf_extra.kx1a2b.0123456789abcdef',
            '',
            '.',
            'spfn_oauth_pending.' + 'z'.repeat(5000) + '.0123456789abcdef',
        ];
        const jar = new Map(lookalikes.map(name => [name, 'v']));

        for (const name of lookalikes)
        {
            expect(parseStartCookieName('pending', name)).toBeNull();
            expect(parseStartCookieName('csrf', name)).toBeNull();
        }

        expect(listStartCookies('pending', jar)).toEqual([]);
        expect(listStartCookies('csrf', jar)).toEqual([]);
        expect(namesEvictedByStart('pending', jar)).toEqual([]);

        for (let i = 0; i < 5; i++)
        {
            await startIn(jar);
        }

        const sixth = await startIn(jar);
        const logout = await throughTheChain({ status: 200, body: { success: true } }, '/_auth/logout', {}, jar);

        for (const name of [...expired(sixth.setCookies), ...expired(logout.setCookies)])
        {
            expect(lookalikes).not.toContain(name);
        }

        expect(lookalikes.every(name => jar.has(name))).toBe(true);
    });
});

/**
 * Verify-then-read: no cookie is read because of a state before it verified.
 *
 * The jar handed to the CSRF pick throws on any access, so a state that does not
 * verify must be refused with the state's own error, not the jar's.
 */
describe('B4/B5 order — the state is verified before any cookie is read (#126)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    const untouchable = new Proxy({}, {
        get: () =>
        {
            throw new Error('a cookie was read before the state verified');
        },
        ownKeys: () =>
        {
            throw new Error('a cookie was read before the state verified');
        },
        has: () =>
        {
            throw new Error('a cookie was read before the state verified');
        },
    }) as Record<string, string>;

    it('B4/B5 order: a tampered state is refused without touching the jar', async () =>
    {
        await expect(matchOAuthCallbackCsrf({ provider: 'superself', state: 'not-a-state', cookies: untouchable }))
            .rejects.toThrow(OAuthStateInvalidError);
    });

    it('B4/B5 order: an expired state is refused without touching the jar', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const state = await foreignState();
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);

        await expect(matchOAuthCallbackCsrf({ provider: 'superself', state, cookies: untouchable }))
            .rejects.toThrow(OAuthStateExpiredError);
    });
});
