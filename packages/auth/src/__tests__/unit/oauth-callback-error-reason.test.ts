/**
 * @spfn/auth - the OAuth error redirect names a reason (fxylabs/spfn#126, claim 4)
 *
 * Began as the reproduction; the reason table of the fix (R rows) follows it.
 * Every failure of `GET /_auth/oauth/:provider/callback` (and of the Google
 * literal route) redirects to `buildOAuthErrorUrl(message, reason)`:
 * `SPFN_AUTH_OAUTH_ERROR_URL`, `/auth/error?error={error}` by default, now with
 * `reason=<code>` beside the free text — a closed `OAuthErrorReason` an app page
 * can switch on, classified by the error's type and never by its message.
 *
 * R5 and R6 need a sign-in that reached the account checks, which takes a
 * database; there `oauthCallbackService` is replaced, per test, by one that
 * throws the error the real service throws at that point. The CSRF gate before
 * it stays real.
 */

import { describe, it, expect, expectTypeOf, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';
import { registerRoutes } from '@spfn/core/route';

const seams = vi.hoisted(() => ({
    jar: new Map<string, string>(),
    callbackFailure: null as null | (() => Error),
}));

vi.mock('@spfn/core/db', async (importActual) => ({
    ...(await importActual<typeof import('@spfn/core/db')>()),
    Transactional: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

vi.mock('../../server/services/oauth.service', async (importActual) =>
{
    const actual = await importActual<typeof import('../../server/services/oauth.service')>();

    return {
        ...actual,
        oauthCallbackService: async (params: Parameters<typeof actual.oauthCallbackService>[0]) =>
        {
            if (seams.callbackFailure)
            {
                throw seams.callbackFailure();
            }

            return await actual.oauthCallbackService(params);
        },
    };
});

// The finalize route's 200 reads the key row's binding; R9 needs no database.
vi.mock('../../server/services/session-binding.service', async (importActual) => ({
    ...(await importActual<typeof import('../../server/services/session-binding.service')>()),
    keySessionBindingService: vi.fn(async () => ({})),
}));

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        getAll: () => [...seams.jar].map(([name, value]) => ({ name, value })),
    }),
}));

import { NextRequest } from 'next/server';

import { getOAuthProvider, registerOAuthProvider, type OAuthProvider } from '../../server/lib/oauth';
import { createOAuthState } from '../../server/lib/oauth/state';
import { buildStartCookieName } from '../../server/lib/oauth/start-cookies';
import { generateKeyPair } from '../../server/lib/crypto';
import { COOKIE_NAMES } from '../../server/lib/config';
import { buildOAuthErrorUrl } from '../../server/services/oauth.service';
import { mainAuthRouter } from '../../server/routes';
import { authInterceptors } from '../../nextjs/interceptors';
import { createOAuthCallbackHandler } from '../../nextjs/oauth-handlers';
import { sealPendingSession } from '../../nextjs/session-helpers';
import {
    runOAuthCallback,
    type CallbackOptions,
    type CallbackOutcome,
} from '../../nextjs/components/oauth-callback-flow';
import { OAUTH_ERROR_REASONS, type OAuthErrorReason } from '../../lib/oauth-error-reason';
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    OAuthAccountNotFoundError,
    UnverifiedEmailLinkError,
} from '@spfn/auth/errors';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const NONCE = 'nonce-of-this-browser';
const KEY_ID = 'key-1';
const LIBRARY_LEAK = /claim|JWE|JWT|timestamp/;

/** A fresh client address per request, so the routes' per-IP limits never trip across the fork. */
let requests = 0;

function clientIp(): string
{
    requests += 1;

    return `2001:db8:1::${requests.toString(16)}`;
}

const exchange = { failure: null as null | Error };

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
            if (exchange.failure)
            {
                throw exchange.failure;
            }

            return { accessToken: 'a', expiresIn: 3600 };
        },
        getUserInfo: async () => ({ providerUserId: 'idp-1', email: null, emailVerified: false }),
    };
}

async function stateIssued(overrides: { provider?: string; nonce?: string } = {}): Promise<string>
{
    return await createOAuthState({
        provider: overrides.provider ?? 'superself',
        returnUrl: '/',
        publicKey: 'pk',
        keyId: KEY_ID,
        fingerprint: 'fp',
        algorithm: 'ES256',
        nonce: overrides.nonce ?? NONCE,
    });
}

/** The error redirect's query, as the app's error page would read it. */
async function errorRedirect(
    app: Hono,
    query: string,
    cookie = `${COOKIE_NAMES.OAUTH_CSRF}=${NONCE}`,
): Promise<URLSearchParams>
{
    const response = await app.request(`/_auth/oauth/superself/callback?${query}`, {
        headers: { 'Cookie': cookie, 'x-forwarded-for': clientIp() },
    });

    expect(response.status).toBe(302);

    return new URL(response.headers.get('location')!, 'https://app.example').searchParams;
}

/** The redirect of a callback whose CSRF gate passes, the per-start cookie in the jar. */
async function pastTheGate(app: Hono): Promise<URLSearchParams>
{
    return await errorRedirect(
        app,
        `code=c&state=${await stateIssued()}`,
        `${buildStartCookieName('csrf', KEY_ID)}=${NONCE}`,
    );
}

describe('OAuth callback error redirect (#126 claim 4)', () =>
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
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('a cancel at the provider carries a reason code', async () =>
    {
        const state = await stateIssued();

        const params = await errorRedirect(app, `error=access_denied&state=${state}`);

        expect(params.get('reason')).toBe('cancelled');
    });

    it('a callback after the state expired carries a reason code distinct from a cancel', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const state = await stateIssued();
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);

        const params = await errorRedirect(app, `code=c&state=${state}`);

        expect(params.get('error')).not.toMatch(/claim/);
        expect(params.get('reason')).toBe('expired');
    });
});

/** The reason table for the backend redirect (#126). Each `it` is named for its row. */
describe('OAuth callback reason codes — backend redirect (#126)', () =>
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
        vi.useRealTimers();
        vi.unstubAllEnvs();
        exchange.failure = null;
        seams.callbackFailure = null;
    });

    it('R1: the provider returned error=access_denied — cancelled, the text unchanged', async () =>
    {
        const bare = await errorRedirect(app, 'error=access_denied');
        const described = await errorRedirect(app, 'error=access_denied&error_description=The%20user%20said%20no');

        expect([bare.get('reason'), bare.get('error')]).toEqual(['cancelled', 'access_denied']);
        expect([described.get('reason'), described.get('error')]).toEqual(['cancelled', 'The user said no']);
    });

    it('R2: the state expired — expired, a fixed sentence and never jose\'s message', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const state = await stateIssued();
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);

        const params = await errorRedirect(app, `code=c&state=${state}`, `${buildStartCookieName('csrf', KEY_ID)}=${NONCE}`);

        expect(params.get('reason')).toBe('expired');
        expect(params.get('error')).toBe('This sign-in took longer than ten minutes. Start it again.');
        expect(params.get('error')).not.toMatch(LIBRARY_LEAK);
    });

    it('R3: a tampered state, a missing or mismatched nonce, a provider mismatch — invalid_state, one fixed sentence', async () =>
    {
        const perStart = buildStartCookieName('csrf', KEY_ID);
        const cases = [
            await errorRedirect(app, 'code=c&state=tampered-garbage'),
            await errorRedirect(app, `code=c&state=${await stateIssued()}`, 'unrelated=1'),
            await errorRedirect(app, `code=c&state=${await stateIssued()}`, `${perStart}=another-nonce`),
            await errorRedirect(app, `code=c&state=${await stateIssued({ provider: 'kakao' })}`, `${perStart}=${NONCE}`),
        ];

        for (const params of cases)
        {
            expect(params.get('reason')).toBe('invalid_state');
            expect(params.get('error')).toBe('This sign-in could not be confirmed as started in this browser. Start it again.');
            expect(params.get('error')).not.toMatch(LIBRARY_LEAK);
        }
    });

    it('R4: any other provider error=, or a failed token exchange — provider_error; provider text unchanged, library text replaced', async () =>
    {
        const providerSaid = await errorRedirect(app, 'error=server_error&error_description=IdP%20is%20down');
        exchange.failure = new Error('ECONNRESET at undici fetch "exp" claim');
        const libraryThrew = await pastTheGate(app);

        expect([providerSaid.get('reason'), providerSaid.get('error')]).toEqual(['provider_error', 'IdP is down']);
        expect(libraryThrew.get('reason')).toBe('provider_error');
        expect(libraryThrew.get('error')).toBe('The sign-in provider could not complete the sign-in. Try again.');
    });

    it('R5: account disabled, pending deletion, or gone — account_unavailable, the text unchanged', async () =>
    {
        for (const failure of [
            () => new AccountDisabledError({ status: 'suspended' }),
            () => new AccountPendingDeletionError({}),
            () => new OAuthAccountNotFoundError(),
        ])
        {
            seams.callbackFailure = failure;

            const params = await pastTheGate(app);

            expect(params.get('reason')).toBe('account_unavailable');
            expect(params.get('error')).toBe(failure().message);
        }
    });

    it('R6: missing code or state, an unverified-email link refusal, a missing role, anything else — failed, the text unchanged', async () =>
    {
        const missing = await errorRedirect(app, `state=${await stateIssued()}`);

        expect([missing.get('reason'), missing.get('error')]).toEqual(['failed', 'Missing authorization code or state']);

        for (const failure of [
            () => new UnverifiedEmailLinkError(),
            () => new Error('Default user role not found. Run initializeAuth() first.'),
            () => new Error('something nobody planned for'),
        ])
        {
            seams.callbackFailure = failure;

            const params = await pastTheGate(app);

            expect([params.get('reason'), params.get('error')]).toEqual(['failed', failure().message]);
        }
    });
});

describe('OAuth callback reason codes — createOAuthCallbackHandler (#126)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        seams.jar = new Map();
    });

    async function handled(query: string): Promise<URLSearchParams>
    {
        const response = await createOAuthCallbackHandler()(new NextRequest(new URL(`/api/auth/callback?${query}`, 'https://app.example')));
        const location = new URL(response.headers.get('location')!);

        expect(location.pathname).toBe('/auth/error');

        return location.searchParams;
    }

    function sealedFor(keyId: string): Promise<string>
    {
        const keyPair = generateKeyPair('ES256');

        return sealPendingSession({ privateKey: keyPair.privateKey, keyId, algorithm: keyPair.algorithm });
    }

    it('R7: ?error=access_denied, missing params, missing pending, key mismatch, unseal failure — cancelled, failed, expired, invalid_state, invalid_state', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        const reasons: (string | null)[] = [];

        reasons.push((await handled('error=access_denied')).get('reason'));
        reasons.push((await handled('userId=7')).get('reason'));
        reasons.push((await handled(`userId=7&keyId=${keyId}`)).get('reason'));
        seams.jar = new Map([[buildStartCookieName('pending', keyId), await sealedFor('some-other-key')]]);
        reasons.push((await handled(`userId=7&keyId=${keyId}`)).get('reason'));
        seams.jar = new Map([[buildStartCookieName('pending', keyId), 'not-a-sealed-value']]);
        reasons.push((await handled(`userId=7&keyId=${keyId}`)).get('reason'));

        expect(reasons).toEqual(['cancelled', 'failed', 'expired', 'invalid_state', 'invalid_state']);
    });
});

describe('SPFN_AUTH_OAUTH_ERROR_URL and {reason} (#126)', () =>
{
    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('R8: {reason} in the template is substituted; without it reason is appended as a query parameter, before any fragment', () =>
    {
        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error?error={error}&code={reason}');
        const substituted = buildOAuthErrorUrl('Too slow', 'expired');

        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error?error={error}');
        const appended = buildOAuthErrorUrl('Too slow', 'expired');

        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', 'https://app.example/oops?src=oauth&error={error}#top');
        const withFragment = buildOAuthErrorUrl('Too slow', 'cancelled');
        const parsed = new URL(withFragment);

        expect(substituted).toBe('/auth/error?error=Too%20slow&code=expired');
        expect(new URL(appended, 'https://app.example').searchParams.get('reason')).toBe('expired');
        expect(new URL(appended, 'https://app.example').searchParams.get('error')).toBe('Too slow');
        expect(appended.startsWith('/auth/error?')).toBe(true);
        expect(parsed.searchParams.get('src')).toBe('oauth');
        expect(parsed.searchParams.get('reason')).toBe('cancelled');
        expect(parsed.hash).toBe('#top');
        expect(withFragment.endsWith('&reason=cancelled#top')).toBe(true);
    });
});

/** The callback page's finalize, through every matching proxy rule, the real routes behind them. */
function proxiedFetch(app: Hono, jar: Map<string, string>): CallbackOptions['fetch']
{
    return (async (_url: string | URL | Request, init?: RequestInit) =>
    {
        const path = '/_auth/oauth/finalize';
        const matching = filterMatchingInterceptors(authInterceptors, path, 'POST');
        const body = JSON.parse(String(init?.body)).body;
        const requestCtx = {
            path,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            query: {},
            cookies: jar,
            request: { headers: new Headers() },
            metadata: {},
        } as unknown as RequestInterceptorContext;

        await executeRequestInterceptors(requestCtx, matching.map(rule => rule.request).filter(phase => !!phase));

        const answer = await app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp() },
            body: JSON.stringify(body),
        });
        const responseCtx = {
            path,
            method: 'POST',
            request: { headers: {}, body },
            response: { ok: answer.ok, status: answer.status, statusText: '', headers: new Headers(), body: await answer.json() },
            cookies: jar,
            setCookies: [] as SetCookie[],
            metadata: requestCtx.metadata,
        } as unknown as ResponseInterceptorContext;

        await executeResponseInterceptors(responseCtx, matching.map(rule => rule.response).filter(phase => !!phase));

        return new Response(JSON.stringify(responseCtx.response.body), { status: responseCtx.response.status });
    }) as unknown as CallbackOptions['fetch'];
}

describe('OAuthCallback page flow reason codes (#126)', () =>
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
        vi.stubGlobal('document', { cookie: '' });
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    async function outcomeFor(search: string, jar = new Map<string, string>()): Promise<CallbackOutcome>
    {
        return await runOAuthCallback(search, { apiBasePath: '/api/rpc', fetch: proxiedFetch(app, jar) });
    }

    it('R9: the error outcome carries the code for the finalize failures it can tell apart, failed otherwise', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        const other = generateKeyPair('ES256');
        const mismatchJar = new Map([[COOKIE_NAMES.OAUTH_PENDING, await sealPendingSession({
            privateKey: other.privateKey,
            keyId: other.keyId,
            algorithm: other.algorithm,
        })]]);
        const brokenFetch = (async () => new Response('{}', { status: 500 })) as unknown as CallbackOptions['fetch'];

        expect(await outcomeFor(`?userId=7&keyId=${keyId}`)).toMatchObject({ kind: 'error', reason: 'expired' });
        expect(await outcomeFor(`?userId=7&keyId=${keyId}`, mismatchJar)).toMatchObject({ kind: 'error', reason: 'invalid_state' });
        expect(await outcomeFor('?error=gone&reason=account_unavailable')).toMatchObject({ kind: 'error', reason: 'account_unavailable' });
        expect(await outcomeFor('?error=whatever&reason=not-a-code')).toMatchObject({ kind: 'error', reason: 'provider_error' });
        expect(await runOAuthCallback(`?userId=7&keyId=${keyId}`, { apiBasePath: '/api/rpc', fetch: brokenFetch }))
            .toMatchObject({ kind: 'error', reason: 'failed' });
        expect(await outcomeFor('?userId=7')).toMatchObject({ kind: 'error', reason: 'failed' });
    });

    it('R9 (types): the codes are a closed union, and the error outcome carries one', () =>
    {
        expectTypeOf<OAuthErrorReason>()
            .toEqualTypeOf<'cancelled' | 'expired' | 'invalid_state' | 'provider_error' | 'account_unavailable' | 'failed'>();
        expectTypeOf<'unknown_reason'>().not.toMatchTypeOf<OAuthErrorReason>();
        expectTypeOf<Extract<CallbackOutcome, { kind: 'error' }>['reason']>().toEqualTypeOf<OAuthErrorReason>();
        expect(OAUTH_ERROR_REASONS).toHaveLength(6);
    });
});
