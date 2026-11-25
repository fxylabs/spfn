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
 *
 * fxylabs/spfn#129 adds `no_cookie`: a callback that finds none of the cookies
 * the start set. Its case table — A (backend callback), B (Next.js callback
 * handler), D (the reason-code surface) — follows the #126 rows; the finalize
 * rows (C) sit with the finalize chain in `oauth-two-tab-start.test.ts`.
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
    linkFailure: null as null | (() => Error),
}));

vi.mock('../../server/services/oauth-link.service', async (importActual) =>
{
    const actual = await importActual<typeof import('../../server/services/oauth-link.service')>();

    return {
        ...actual,
        oauthLinkCallbackService: async (params: Parameters<typeof actual.oauthLinkCallbackService>[0]) =>
        {
            if (seams.linkFailure)
            {
                throw seams.linkFailure();
            }

            return await actual.oauthLinkCallbackService(params);
        },
    };
});

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

// The finalize route's 200 answers the principal its door admitted, and the key's binding; R9 needs no database.
vi.mock('../../server/middleware/oauth-finalize-auth', async () => (await import('../helpers/finalize-door')).finalizeDoorStandIn('7'));

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
import { createOAuthLinkState, createOAuthState } from '../../server/lib/oauth/state';
import { buildStartCookieName } from '../../server/lib/oauth/start-cookies';
import { generateKeyPair } from '../../server/lib/crypto';
import { COOKIE_NAMES } from '../../server/lib/config';
import { buildOAuthErrorUrl, matchOAuthCallbackCsrf, oauthErrorReason, oauthFailureUrl } from '../../server/services/oauth.service';
import { mainAuthRouter } from '../../server/routes';
import { authLogger } from '../../server/logger';
import { authInterceptors } from '../../nextjs/interceptors';
import { createOAuthCallbackHandler } from '../../nextjs/oauth-handlers';
import { sealPendingSession } from '../../nextjs/session-helpers';
import {
    oauthCallbackErrorArguments,
    readCallbackInput,
    runOAuthCallback,
    type CallbackOptions,
    type CallbackOutcome,
} from '../../nextjs/components/oauth-callback-flow';
import {
    OAUTH_ERROR_MESSAGES,
    OAUTH_ERROR_REASONS,
    isOAuthErrorReason,
    withOAuthErrorReason,
    type OAuthErrorReason,
} from '../../lib/oauth-error-reason';
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    authErrorRegistry,
    OAUTH_COOKIE_MISSING_MESSAGE,
    OAuthAccountNotFoundError,
    OAuthCookieMissingError,
    OAuthEmailInUseError,
    OAuthSignInContendedError,
    OAuthStateExpiredError,
    OAuthStateInvalidError,
    SignInRefusedError,
    SignupDisabledError,
    UnverifiedEmailLinkError,
} from '@spfn/auth/errors';
import { ServiceUnavailableError, ValidationError } from '@spfn/core/errors';
import { mountProxy } from '../helpers/rpc-proxy';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const NONCE = 'nonce-of-this-browser';
const KEY_ID = 'key-1';
const LIBRARY_LEAK = /claim|JWE|JWT|timestamp/;
/** The fixed sentences the error page is given for `cancelled`, `provider_error` and `failed` (#489). */
const CANCELLED = 'The sign-in was cancelled at the provider.';
const PROVIDER_ERROR = 'The sign-in provider could not complete the sign-in. Try again.';
const FAILED = 'OAuth sign-in could not be completed.';

/** A fresh client address per request, so the routes' per-IP limits never trip across the fork. */
let requests = 0;

function clientIp(): string
{
    requests += 1;

    return `2001:db8:1::${requests.toString(16)}`;
}

const exchange = { failure: null as null | Error, calls: 0 };

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
        pkce: 'S256',
        getAuthUrl: (state: string) => `https://idp.example/auth?state=${state}`,
        exchangeCodeForTokens: async () =>
        {
            exchange.calls += 1;

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

/** The link callback's redirect for a link state whose CSRF gate passes, `query` beside the state */
async function linkPastTheGate(app: Hono, query = 'code=c'): Promise<URLSearchParams>
{
    const state = await createOAuthLinkState({
        provider: 'superself',
        userId: '7',
        returnUrl: '/settings',
        nonce: NONCE,
        startId: KEY_ID,
        codeVerifier: 'verifier',
        startedByKeyId: null,
        keyEpoch: null,
    });

    return await errorRedirect(app, `${query}&state=${state}`, `${buildStartCookieName('csrf', KEY_ID)}=${NONCE}`);
}

/** The core console transport's lines at each level while `work` runs, colours stripped */
async function levelLinesDuring(work: () => Promise<unknown>): Promise<{ error: string[]; warn: string[] }>
{
    const lines: string[] = [];
    const keep = (line: unknown) =>
    {
        lines.push(String(line).replace(/\x1b\[[0-9;]*m/g, ''));
    };
    const spies = [vi.spyOn(console, 'error').mockImplementation(keep), vi.spyOn(console, 'warn').mockImplementation(keep), vi.spyOn(console, 'log').mockImplementation(keep)];

    await work().finally(() => spies.forEach(spy => spy.mockRestore()));

    return { error: lines.filter(line => line.includes('(ERROR)')), warn: lines.filter(line => line.includes('(WARN)')) };
}

/** A pending session sealed for `keyId`, its private key a fresh one. */
/**
 * A callback request as the browser makes it — the jar on its `cookie` header —
 * with the app's proxy mounted, which `createOAuthCallbackHandler` completes the
 * sign-in through.
 */
function callbackRequest(url: URL): NextRequest
{
    const backend = new Hono();
    registerRoutes(backend, mainAuthRouter);
    mountProxy(backend);

    const cookie = [...seams.jar].map(([name, value]) => `${name}=${value}`).join('; ');

    return new NextRequest(url, { headers: cookie ? { cookie } : {} });
}

function sealedFor(keyId: string): Promise<string>
{
    const keyPair = generateKeyPair('ES256');

    return sealPendingSession({ privateKey: keyPair.privateKey, keyId, algorithm: keyPair.algorithm });
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
        seams.linkFailure = null;
    });

    it('R1 (O1, #489): the provider returned error=access_denied — cancelled, its fixed sentence and never the query\'s text', async () =>
    {
        const bare = await errorRedirect(app, 'error=access_denied');
        const described = await errorRedirect(app, 'error=access_denied&error_description=Call+us');

        expect([bare.get('reason'), bare.get('error')]).toEqual(['cancelled', CANCELLED]);
        expect([described.get('reason'), described.get('error')]).toEqual(['cancelled', CANCELLED]);
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

    it('R3: a tampered state, a mismatched nonce, a provider mismatch — invalid_state, one fixed sentence', async () =>
    {
        // A missing nonce cookie is `no_cookie` since #129 (row A5).
        const perStart = buildStartCookieName('csrf', KEY_ID);
        const cases = [
            await errorRedirect(app, 'code=c&state=tampered-garbage'),
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

    it('R4 (O1, #489): any other provider error=, or a failed token exchange — provider_error, its fixed sentence; neither provider nor library text', async () =>
    {
        const providerSaid = await errorRedirect(app, 'error=server_error&error_description=Call+us+at+555');
        exchange.failure = new Error('ECONNRESET at undici fetch "exp" claim');
        const libraryThrew = await pastTheGate(app);

        expect([providerSaid.get('reason'), providerSaid.get('error')]).toEqual(['provider_error', PROVIDER_ERROR]);
        expect(libraryThrew.get('reason')).toBe('provider_error');
        expect(libraryThrew.get('error')).toBe(PROVIDER_ERROR);
    });

    it('R5: account disabled or gone — account_unavailable, its fixed sentence; pending deletion — pending_deletion, its own (#489)', async () =>
    {
        for (const failure of [
            () => new AccountDisabledError({ status: 'suspended' }),
            () => new OAuthAccountNotFoundError(),
        ])
        {
            seams.callbackFailure = failure;

            const params = await pastTheGate(app);

            expect(params.get('reason')).toBe('account_unavailable');
            expect(params.get('error')).toBe('This account cannot sign in.');
        }

        seams.callbackFailure = () => new AccountPendingDeletionError({});
        const pending = await pastTheGate(app);

        expect([pending.get('reason'), pending.get('error')]).toEqual(['pending_deletion', OAUTH_ERROR_MESSAGES.pending_deletion]);
    });

    it('R6: missing code or state, a missing role, anything else — failed, its fixed sentence; an unverified-email link refusal — email_unverified (#382, #489)', async () =>
    {
        const missing = await errorRedirect(app, `state=${await stateIssued()}`);

        expect([missing.get('reason'), missing.get('error')]).toEqual(['failed', FAILED]);

        seams.callbackFailure = () => new UnverifiedEmailLinkError();
        const typed = await pastTheGate(app);

        expect([typed.get('reason'), typed.get('error')]).toEqual(['email_unverified', OAUTH_ERROR_MESSAGES.email_unverified]);

        for (const failure of [
            () => new Error('Default user role not found. Run initializeAuth() first.'),
            () => new Error('something nobody planned for'),
        ])
        {
            seams.callbackFailure = failure;

            const params = await pastTheGate(app);

            expect([params.get('reason'), params.get('error')]).toEqual(['failed', FAILED]);
        }
    });

    it('R6b: the fixed text\'s fault is in the server log at error level; a typed error meant for the client is not logged as a fault (#382)', async () =>
    {
        const lines: string[] = [];
        const stderr = vi.spyOn(console, 'error').mockImplementation((line: unknown) =>
        {
            lines.push(String(line).replace(/\x1b\[[0-9;]*m/g, ''));
        });

        try
        {
            seams.callbackFailure = () => new UnverifiedEmailLinkError();
            await pastTheGate(app);
            seams.callbackFailure = () => new Error('Default user role not found. Run initializeAuth() first.');
            const params = await pastTheGate(app);

            await vi.waitFor(() => expect(lines.join('\n')).toContain('Default user role not found'));
            const errorLines = lines.filter(line => line.includes('(ERROR)'));

            expect(params.get('error')).toBe(FAILED);
            expect(errorLines.filter(line => line.includes('Default user role not found'))).toHaveLength(1);
            expect(errorLines.join('\n')).not.toContain(new UnverifiedEmailLinkError().message);
        }
        finally
        {
            stderr.mockRestore();
        }
    });

    it('R6d: a typed 5xx is a fault — logged at error level as core\'s error handler logs it; the redirect carries the failed sentence (#382, #489)', async () =>
    {
        seams.callbackFailure = () => new ServiceUnavailableError({ message: 'Sign-in is down for maintenance' });
        let params = new URLSearchParams();

        const lines = await levelLinesDuring(async () =>
        {
            params = await pastTheGate(app);
        });

        expect(params.get('error')).toBe(FAILED);
        expect(lines.error.filter(line => line.includes('OAuth callback failed'))).toHaveLength(1);
        expect(lines.error.join('\n')).toContain('ServiceUnavailableError');
    });

    it('R6e: a link callback that fails on a fault is logged at error level, not only turned into the outcome failed (#382)', async () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'https://app.example');
        seams.linkFailure = () => new Error('Default user role not found. Run initializeAuth() first.');
        let params = new URLSearchParams();

        const lines = await levelLinesDuring(async () =>
        {
            params = await linkPastTheGate(app);
        });

        expect([params.get('oauthLink'), params.get('provider')]).toEqual(['failed', 'superself']);
        expect(lines.error.filter(line => line.includes('OAuth link failed'))).toHaveLength(1);
        expect(lines.error.join('\n')).toContain('Default user role not found');
    });

    it('O5 (#489): a provider error leaves one warn line naming a registered code, unrecognised otherwise, and nothing else of the query', async () =>
    {
        // Every logger shares core's Logger class, so this sees every logger argument, at every level
        const spies = (['debug', 'info', 'warn', 'error', 'fatal'] as const)
            .map(level => vi.spyOn(Object.getPrototypeOf(authLogger.service), level));
        let calls: unknown[][][] = [];

        const lines = await levelLinesDuring(async () =>
        {
            await errorRedirect(app, 'error=invalid_scope&error_description=Call+us');
            await errorRedirect(app, 'error=Call+us');
            await errorRedirect(app, 'error=access_denied&error_description=Call+us');
            calls = spies.map(spy => [...spy.mock.calls]);
        }).finally(() => spies.forEach(spy => spy.mockRestore()));

        expect(calls[2]!.filter(([message]) => message === 'OAuth provider returned an error')).toEqual([
            ['OAuth provider returned an error', { provider: 'superself', reason: 'provider_error', providerError: 'invalid_scope' }],
            ['OAuth provider returned an error', { provider: 'superself', reason: 'provider_error', providerError: 'unrecognised' }],
        ]);
        expect(JSON.stringify(calls)).not.toContain('Call us');
        expect([...lines.error, ...lines.warn].join('\n')).not.toContain('Call us');
    });

    it('O9 (#489): a provider error on a link callback leaves the warn line the sign-in path leaves, and nothing else of the query', async () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'https://app.example');
        const spies = (['debug', 'info', 'warn', 'error', 'fatal'] as const)
            .map(level => vi.spyOn(Object.getPrototypeOf(authLogger.service), level));
        let params = new URLSearchParams();
        let calls: unknown[][][] = [];

        await levelLinesDuring(async () =>
        {
            params = await linkPastTheGate(app, 'error=invalid_scope&error_description=Call+us');
            calls = spies.map(spy => [...spy.mock.calls]);
        }).finally(() => spies.forEach(spy => spy.mockRestore()));

        expect([params.get('oauthLink'), params.get('provider')]).toEqual(['provider_error', 'superself']);
        expect(calls[2]!.filter(([message]) => message === 'OAuth provider returned an error')).toEqual([
            ['OAuth provider returned an error', { provider: 'superself', reason: 'provider_error', providerError: 'invalid_scope' }],
        ]);
        expect(JSON.stringify(calls)).not.toContain('Call us');
    });

    it('O10 (#489): a sign-in start for a registered provider that is not configured leaves a warn line naming it', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', '');
        registerOAuthProvider({ ...provider(), isEnabled: () => false });
        const spies = (['debug', 'info', 'warn', 'error', 'fatal'] as const)
            .map(level => vi.spyOn(Object.getPrototypeOf(authLogger.service), level));
        const start = (path: string) => app.request(path, { headers: { 'x-forwarded-for': clientIp() } });
        let redirects: (string | null)[] = [];
        let calls: unknown[][][] = [];

        await levelLinesDuring(async () =>
        {
            const answers = [await start('/_auth/oauth/superself?state=s'), await start('/_auth/oauth/google?state=s')];

            redirects = answers.map(answer => new URL(answer.headers.get('location')!, 'https://app.example').searchParams.get('reason'));
            calls = spies.map(spy => [...spy.mock.calls]);
        }).finally(() =>
        {
            spies.forEach(spy => spy.mockRestore());
            registerOAuthProvider(provider());
        });

        expect(redirects).toEqual(['failed', 'failed']);
        expect(calls[2]!.filter(([message]) => message === 'OAuth provider is not configured')).toEqual([
            ['OAuth provider is not configured', { provider: 'superself' }],
            ['OAuth provider is not configured', { provider: 'google' }],
        ]);
    });

    it('R6c: a provider error shaped like a typed one (numeric statusCode, toJSON) redirects with the fixed text, not its own (#382)', async () =>
    {
        seams.callbackFailure = () => Object.assign(new Error('invalid_grant: refresh token of tenant internal-42 revoked'), {
            statusCode: 400,
            toJSON: () => ({ __type: 'ProviderError', message: 'invalid_grant: refresh token of tenant internal-42 revoked' }),
        });

        const params = await pastTheGate(app);

        expect([params.get('reason'), params.get('error')]).toEqual(['failed', FAILED]);
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
        vi.unstubAllGlobals();
        seams.jar = new Map();
    });

    async function handled(query: string): Promise<URLSearchParams>
    {
        const response = await createOAuthCallbackHandler()(callbackRequest(new URL(`/api/auth/callback?${query}`, 'https://app.example')));
        const location = new URL(response.headers.get('location')!);

        expect(location.pathname).toBe('/auth/error');

        return location.searchParams;
    }

    it('R7: ?error=access_denied, missing params, missing pending, key mismatch, unseal failure — cancelled, failed, no_cookie, invalid_state, invalid_state', async () =>
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

        expect(reasons).toEqual(['cancelled', 'failed', 'no_cookie', 'invalid_state', 'invalid_state']);
    });
});

describe('SPFN_AUTH_OAUTH_ERROR_URL and {reason} (#126)', () =>
{
    /** The expired sentence as `{error}` takes it. */
    const EXPIRED = encodeURIComponent('This sign-in took longer than ten minutes. Start it again.');

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('R8: {reason} in the template is substituted; without it reason is appended as a query parameter, before any fragment', () =>
    {
        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error?error={error}&why={reason}');
        const substituted = buildOAuthErrorUrl('expired');

        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error?error={error}');
        const appended = buildOAuthErrorUrl('expired');

        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', 'https://app.example/oops?src=oauth&error={error}#top');
        const withFragment = buildOAuthErrorUrl('cancelled');
        const parsed = new URL(withFragment);

        expect(substituted).toBe(`/auth/error?error=${EXPIRED}&why=expired`);
        expect(new URL(appended, 'https://app.example').searchParams.get('reason')).toBe('expired');
        expect(new URL(appended, 'https://app.example').searchParams.get('error')).toBe('This sign-in took longer than ten minutes. Start it again.');
        expect(appended.startsWith('/auth/error?')).toBe(true);
        expect(parsed.searchParams.get('src')).toBe('oauth');
        expect(parsed.searchParams.get('reason')).toBe('cancelled');
        expect(parsed.hash).toBe('#top');
        expect(withFragment.endsWith('&reason=cancelled#top')).toBe(true);
    });

    it.each([
        ['absolute', 'https://app.example/e?error={error}', `https://app.example/e?error=${EXPIRED}&reason=expired`],
        ['protocol-relative', '//other.example/e?error={error}', `//other.example/e?error=${EXPIRED}&reason=expired`],
        ['path-only', '/auth/oops', '/auth/oops?reason=expired'],
        ['existing query', '/auth/oops?src=oauth&error={error}', `/auth/oops?src=oauth&error=${EXPIRED}&reason=expired`],
        ['fragment', '/auth/oops?error={error}#top', `/auth/oops?error=${EXPIRED}&reason=expired#top`],
        ['fragment holding a ?', '/auth/oops#top?x', '/auth/oops?reason=expired#top?x'],
        ['%20 in the template', '/auth/sign%20in?note=a%20b&error={error}', `/auth/sign%20in?note=a%20b&error=${EXPIRED}&reason=expired`],
    ])('R8 (exact form, %s): the template with {error} substituted plus exactly the appended parameter, byte for byte', (_form, template, expected) =>
    {
        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', template);

        expect(buildOAuthErrorUrl('expired')).toBe(expected);
    });

    it('O6 (#489): the app\'s refusal code takes {refusalCode}, else is appended after reason as refusalCode; without one {refusalCode} is emptied and nothing appended', () =>
    {
        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error?r={reason}&c={refusalCode}#top');
        const placed = buildOAuthErrorUrl('sign_in_refused', 'LOCKED');
        const emptied = buildOAuthErrorUrl('failed');

        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error#top');
        const appended = buildOAuthErrorUrl('sign_in_refused', 'LOCKED');
        const none = buildOAuthErrorUrl('failed');

        expect([placed, emptied]).toEqual(['/auth/error?r=sign_in_refused&c=LOCKED#top', '/auth/error?r=failed&c=#top']);
        expect([appended, none]).toEqual(['/auth/error?reason=sign_in_refused&refusalCode=LOCKED#top', '/auth/error?reason=failed#top']);
    });

    it('O7 (#489): the template main documented, /auth/error?error={error}&code={reason}, on sign_in_refused — one code, the reason, and one refusalCode', () =>
    {
        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error?error={error}&code={reason}');
        const params = new URL(buildOAuthErrorUrl('sign_in_refused', 'LOCKED'), 'https://app.example').searchParams;

        expect([params.getAll('code'), params.getAll('refusalCode')]).toEqual([['sign_in_refused'], ['LOCKED']]);
    });

    it('O8 (#489): a refusal whose code is outside the shape — the reason and its sentence, no refusal code, nothing of the code or the message', async () =>
    {
        vi.stubEnv('SPFN_AUTH_OAUTH_ERROR_URL', '/auth/error?error={error}');
        let url = '';

        await levelLinesDuring(async () =>
        {
            url = oauthFailureUrl(new SignInRefusedError({ message: 'Call us at 555', details: { code: 'x&reason=cancelled' } }), 'OAuth callback failed');
        });

        expect(url).toBe('/auth/error?error=Sign-in%20refused.&reason=sign_in_refused');
    });

    it('O12: a pre-#489 call shape — an any-typed reason — throws a TypeError whose message does not contain that text', () =>
    {
        let caught: unknown;

        try
        {
            buildOAuthErrorUrl('Google OAuth is not configured' as never);
        }
        catch (error)
        {
            caught = error;
        }

        expect(caught).toBeInstanceOf(TypeError);
        expect(String((caught as Error).message)).not.toContain('Google OAuth is not configured');
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

        // Refused before the backend is asked
        if (requestCtx.abort)
        {
            return new Response(JSON.stringify(requestCtx.abort.body), { status: requestCtx.abort.status });
        }

        const answer = await app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp(), ...requestCtx.headers },
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

        expect(await outcomeFor(`?userId=7&keyId=${keyId}`)).toMatchObject({ kind: 'error', reason: 'no_cookie' });
        expect(await outcomeFor(`?userId=7&keyId=${keyId}`, mismatchJar)).toMatchObject({ kind: 'error', reason: 'invalid_state' });
        expect(await outcomeFor('?error=gone&reason=account_unavailable')).toMatchObject({ kind: 'error', reason: 'account_unavailable' });
        expect(await outcomeFor('?error=whatever&reason=not-a-code')).toMatchObject({ kind: 'error', reason: 'provider_error' });
        expect(await runOAuthCallback(`?userId=7&keyId=${keyId}`, { apiBasePath: '/api/rpc', fetch: brokenFetch }))
            .toMatchObject({ kind: 'error', reason: 'failed' });
        expect(await outcomeFor('?userId=7')).toMatchObject({ kind: 'error', reason: 'failed' });
    });

    it('R9d: a finalize whose fetch throws — failed with a fixed sentence, never the caught error\'s text (#382)', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        const throwingFetch = (async () =>
        {
            throw new TypeError('connect ECONNREFUSED 10.9.8.7:8790 secret-host.internal');
        }) as unknown as CallbackOptions['fetch'];

        for (const search of [`?userId=7&keyId=${keyId}`, `?mfaChallenge=c-1&keyId=${keyId}`])
        {
            const outcome = await runOAuthCallback(search, { apiBasePath: '/api/rpc', fetch: throwingFetch });

            expect(outcome).toEqual({ kind: 'error', message: FAILED, reason: 'failed' });
        }
    });

    it('O3 (#489): ?error=Call+us on the callback page — the message is the provider_error sentence, never the URL\'s text', () =>
    {
        expect(readCallbackInput('?error=Call+us')).toEqual({ kind: 'error', message: PROVIDER_ERROR, reason: 'provider_error' });
    });

    it('O4 (page): the app\'s refusal code beside sign_in_refused reaches onError; a forged one, or one beside another reason, does not', () =>
    {
        expect(readCallbackInput('?error=x&reason=sign_in_refused&refusalCode=LOCKED'))
            .toEqual({ kind: 'error', message: 'Sign-in refused.', reason: 'sign_in_refused', refusalCode: 'LOCKED' });
        expect(readCallbackInput('?error=x&reason=sign_in_refused&refusalCode=%3Cb%3ECall+us%3C%2Fb%3E')).not.toHaveProperty('refusalCode');
        expect(readCallbackInput('?error=x&reason=cancelled&refusalCode=LOCKED')).not.toHaveProperty('refusalCode');
        expect(readCallbackInput('?error=x&reason=sign_in_refused&code=LOCKED')).not.toHaveProperty('refusalCode');
    });

    it('O11 (#489): onError and errorComponent are handed the reason\'s sentence, the reason and the refusal code', async () =>
    {
        const refused = await outcomeFor('?error=x&reason=sign_in_refused&refusalCode=LOCKED');
        const cancelled = await outcomeFor('?error=Call+us&reason=cancelled');

        expect(refused.kind === 'error' && oauthCallbackErrorArguments(refused)).toEqual(['Sign-in refused.', 'sign_in_refused', 'LOCKED']);
        expect(cancelled.kind === 'error' && oauthCallbackErrorArguments(cancelled)).toEqual([CANCELLED, 'cancelled', undefined]);
    });

    /** The finalize a callback page posts, through the proxy rules, answered by the real route. */
    async function finalizeAnswer(keyId: string, jar: Map<string, string>): Promise<{ status: number; body: Record<string, unknown> }>
    {
        const response = await proxiedFetch(app, jar)('/api/rpc', {
            method: 'POST',
            body: JSON.stringify({ body: { userId: '7', keyId, returnUrl: '/' } }),
        });

        return { status: response.status, body: await response.json() };
    }

    it('R9b: a malformed per-start pending cookie — 401 with a fixed sentence and invalid_state, no library text', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const parts = (await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        })).split('.');
        parts[2] = 'AAAA';
        const jar = new Map([[buildStartCookieName('pending', keyPair.keyId), parts.join('.')]]);

        const answer = await finalizeAnswer(keyPair.keyId, jar);
        const outcome = await outcomeFor(`?userId=7&keyId=${keyPair.keyId}`, new Map(jar));

        expect(answer.status).toBe(401);
        expect(answer.body).toEqual({ success: false, message: 'OAuth session could not be verified. Please try again.', reason: 'invalid_state' });
        expect(JSON.stringify(answer.body)).not.toMatch(/Vector|JWE|JWT|claim/);
        expect(outcome).toEqual({ kind: 'error', message: 'This sign-in could not be confirmed as started in this browser. Start it again.', reason: 'invalid_state' });
    });

    it('R9c: a per-start pending cookie past its ten minutes — 401 expired', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const keyPair = generateKeyPair('ES256');
        const jar = new Map([[buildStartCookieName('pending', keyPair.keyId), await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        })]]);
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);

        const answer = await finalizeAnswer(keyPair.keyId, jar);
        vi.useRealTimers();

        expect(answer.status).toBe(401);
        expect(answer.body).toEqual({ success: false, message: 'OAuth session expired. Please try again.', reason: 'expired' });
    });

    it('D3: a 401 finalize body with reason no_cookie reaches the error outcome — onError\'s arguments — unchanged', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        const refusal = { success: false, message: OAUTH_COOKIE_MISSING_MESSAGE, reason: 'no_cookie' };
        const stubbed = (async () => new Response(JSON.stringify(refusal), { status: 401 })) as unknown as CallbackOptions['fetch'];
        const expected = { kind: 'error', message: OAUTH_COOKIE_MISSING_MESSAGE, reason: 'no_cookie' };

        expect(await runOAuthCallback(`?userId=7&keyId=${keyId}`, { apiBasePath: '/api/rpc', fetch: stubbed })).toEqual(expected);
        expect(await outcomeFor(`?userId=7&keyId=${keyId}`)).toEqual(expected);
    });

    it('R9 (types): the codes are a closed union, and the error outcome carries one', () =>
    {
        expectTypeOf<OAuthErrorReason>()
            .toEqualTypeOf<'cancelled' | 'expired' | 'invalid_state' | 'no_cookie' | 'provider_error' | 'account_unavailable' | 'pending_deletion' | 'email_unverified' | 'link_only' | 'email_in_use' | 'signup_disabled' | 'provider_already_linked' | 'sign_in_contended' | 'sign_in_refused' | 'failed'>();
        expectTypeOf<'unknown_reason'>().not.toMatchTypeOf<OAuthErrorReason>();
        expectTypeOf<Extract<CallbackOutcome, { kind: 'error' }>['reason']>().toEqualTypeOf<OAuthErrorReason>();
        expect(OAUTH_ERROR_REASONS).toHaveLength(15);
    });

    it('C1 (#156): email_in_use is a reason code, and the email-match refusal maps to it', () =>
    {
        expect(OAUTH_ERROR_REASONS).toHaveLength(15);
        expect(OAUTH_ERROR_REASONS).toContain('email_in_use');
        expect(OAUTH_ERROR_REASONS.at(-1)).toBe('failed');
        expect(oauthErrorReason(new OAuthEmailInUseError())).toBe('email_in_use');
    });

    it('#308: signup_disabled is a reason code, and the sign-up refusal maps to it', () =>
    {
        expect(OAUTH_ERROR_REASONS).toContain('signup_disabled');
        expect(OAUTH_ERROR_REASONS.at(-1)).toBe('failed');
        expect(oauthErrorReason(new SignupDisabledError())).toBe('signup_disabled');
    });

    it('PR #314 F2: sign_in_contended is a reason code, and the second contention maps to it', () =>
    {
        expect(OAUTH_ERROR_REASONS).toContain('sign_in_contended');
        expect(OAUTH_ERROR_REASONS.at(-1)).toBe('failed');
        expect(oauthErrorReason(new OAuthSignInContendedError())).toBe('sign_in_contended');
    });
});

/**
 * A jar that throws on any access: a refusal raised with it proves no cookie
 * was read before the refusal was decided.
 */
const untouchable = new Proxy({}, {
    get: () =>
    {
        throw new Error('a cookie was read');
    },
    ownKeys: () =>
    {
        throw new Error('a cookie was read');
    },
    has: () =>
    {
        throw new Error('a cookie was read');
    },
}) as Record<string, string>;

/** What `matchOAuthCallbackCsrf` threw for the route's provider, or `null` when it matched. */
async function refusalFor(state: string, cookies: Record<string, string>): Promise<unknown>
{
    return await matchOAuthCallbackCsrf({ provider: 'superself', state, cookies }).then(() => null, (error: unknown) => error);
}

/** The callback route's answer: the error page's query and every Set-Cookie it wrote. */
async function callbackAnswer(app: Hono, state: string, cookie: string): Promise<{ params: URLSearchParams; setCookies: string[] }>
{
    const response = await app.request(`/_auth/oauth/superself/callback?code=c&state=${state}`, {
        headers: { 'Cookie': cookie, 'x-forwarded-for': clientIp() },
    });

    expect(response.status).toBe(302);

    return {
        params: new URL(response.headers.get('location')!, 'https://app.example').searchParams,
        setCookies: response.headers.getSetCookie(),
    };
}

/** The case table for the backend callback (#129). Each `it` is named for its row. */
describe('no_cookie case table A — backend callback, matchOAuthCallbackCsrf (#129)', () =>
{
    const perStart = buildStartCookieName('csrf', KEY_ID);
    const anotherStart = `${buildStartCookieName('csrf', 'key-of-another-start')}=nonce-of-another-start`;
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
        exchange.calls = 0;
    });

    afterEach(() =>
    {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        exchange.failure = null;
    });

    it('A1: a state that does not decrypt — invalid_state even beside a matching cookie; no cookie read, none expired', async () =>
    {
        const refusal = await refusalFor('not-a-state', untouchable);
        const answer = await callbackAnswer(app, 'not-a-state', `${perStart}=${NONCE}`);

        expect(refusal).toBeInstanceOf(OAuthStateInvalidError);
        expect(answer.params.get('reason')).toBe('invalid_state');
        expect(answer.setCookies).toEqual([]);
        expect(exchange.calls).toBe(0);
    });

    it('A2: a state past its ten minutes — expired, whatever the cookies', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const state = await stateIssued();
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);

        const refusal = await refusalFor(state, untouchable);
        const answer = await callbackAnswer(app, state, '');

        expect(refusal).toBeInstanceOf(OAuthStateExpiredError);
        expect(answer.params.get('reason')).toBe('expired');
    });

    it('A3: a valid state naming another provider, no cookie — invalid_state, never no_cookie, decided before any cookie is read', async () =>
    {
        const state = await stateIssued({ provider: 'kakao' });

        const refusal = await refusalFor(state, untouchable);
        const answer = await callbackAnswer(app, state, '');

        expect(refusal).toBeInstanceOf(OAuthStateInvalidError);
        expect(refusal).not.toBeInstanceOf(OAuthCookieMissingError);
        expect(answer.params.get('reason')).toBe('invalid_state');
    });

    it('A4: a valid state naming another provider, a cookie holding its nonce — invalid_state, never proceeds', async () =>
    {
        const state = await stateIssued({ provider: 'kakao' });

        const refusal = await refusalFor(state, { [perStart]: NONCE });
        const answer = await callbackAnswer(app, state, `${perStart}=${NONCE}`);

        expect(refusal).toBeInstanceOf(OAuthStateInvalidError);
        expect(answer.params.get('reason')).toBe('invalid_state');
        expect(answer.setCookies).toEqual([]);
        expect(exchange.calls).toBe(0);
    });

    it('A5: a valid state for this provider, no per-start and no legacy cookie — no_cookie with the fixed sentence; nothing expired, the provider never called', async () =>
    {
        const state = await stateIssued();

        const refusal = await refusalFor(state, { unrelated: '1', [buildStartCookieName('csrf', 'key-of-another-start')]: NONCE });
        const answer = await callbackAnswer(app, state, `unrelated=1; ${anotherStart}`);

        expect(refusal).toBeInstanceOf(OAuthCookieMissingError);
        expect((refusal as Error).message).toBe(OAUTH_COOKIE_MISSING_MESSAGE);
        expect(oauthErrorReason(refusal)).toBe('no_cookie');
        expect(answer.params.get('reason')).toBe('no_cookie');
        expect(answer.params.get('error')).toBe(OAUTH_COOKIE_MISSING_MESSAGE);
        expect(answer.setCookies).toEqual([]);
        expect(exchange.calls).toBe(0);
    });

    it('A6: a valid state for this provider, per-start cookies none of which holds the nonce — invalid_state, not no_cookie; nothing expired', async () =>
    {
        const state = await stateIssued();
        const older = buildStartCookieName('csrf', KEY_ID, Date.now() - 60_000);

        const refusal = await refusalFor(state, { [perStart]: 'another-nonce', [older]: 'yet-another-nonce' });
        const answer = await callbackAnswer(app, state, `${perStart}=another-nonce; ${older}=yet-another-nonce`);

        expect(refusal).toBeInstanceOf(OAuthStateInvalidError);
        expect(refusal).not.toBeInstanceOf(OAuthCookieMissingError);
        expect(answer.params.get('reason')).toBe('invalid_state');
        expect(answer.setCookies).toEqual([]);
        expect(exchange.calls).toBe(0);
    });

    it('A7: a valid state for this provider, a per-start cookie holding the nonce — proceeds; that cookie only is expired', async () =>
    {
        const state = await stateIssued();
        exchange.failure = new Error('the code exchange ran');

        const match = await matchOAuthCallbackCsrf({ provider: 'superself', state, cookies: { [perStart]: NONCE } });
        const answer = await callbackAnswer(app, state, `${perStart}=${NONCE}; ${anotherStart}`);

        expect(match).toEqual({ name: perStart, nonce: NONCE });
        expect(answer.params.get('reason')).toBe('provider_error');
        expect(exchange.calls).toBe(1);
        expect(answer.setCookies.map(header => header.split('=')[0])).toEqual([perStart]);
        expect(answer.setCookies[0]).toMatch(/Max-Age=0/i);
    });

    it('A8: a valid state for this provider, no per-start cookie, a legacy cookie holding the nonce — proceeds through the legacy fallback', async () =>
    {
        const state = await stateIssued();
        exchange.failure = new Error('the code exchange ran');

        const match = await matchOAuthCallbackCsrf({ provider: 'superself', state, cookies: { [COOKIE_NAMES.OAUTH_CSRF]: NONCE } });
        const answer = await callbackAnswer(app, state, `${COOKIE_NAMES.OAUTH_CSRF}=${NONCE}`);

        expect(match).toEqual({ name: COOKIE_NAMES.OAUTH_CSRF, nonce: NONCE });
        expect(answer.params.get('reason')).toBe('provider_error');
        expect(exchange.calls).toBe(1);
        expect(answer.setCookies.map(header => header.split('=')[0])).toEqual([COOKIE_NAMES.OAUTH_CSRF]);
    });

    it('A9: a valid state for this provider, no per-start cookie, a legacy cookie with another nonce — invalid_state, not no_cookie', async () =>
    {
        const state = await stateIssued();

        const refusal = await refusalFor(state, { [COOKIE_NAMES.OAUTH_CSRF]: 'legacy-nonce-of-another-start' });
        const answer = await callbackAnswer(app, state, `${COOKIE_NAMES.OAUTH_CSRF}=legacy-nonce-of-another-start`);

        expect(refusal).toBeInstanceOf(OAuthStateInvalidError);
        expect(refusal).not.toBeInstanceOf(OAuthCookieMissingError);
        expect(answer.params.get('reason')).toBe('invalid_state');
        expect(answer.setCookies).toEqual([]);
    });
});

/** The case table for `createOAuthCallbackHandler`'s pending lookup (#129). */
describe('no_cookie case table B — createOAuthCallbackHandler, through the finalize rule (#129)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        seams.jar = new Map();
    });

    async function handled(keyId: string): Promise<{ location: URL; setCookies: string[] }>
    {
        const url = new URL(`/api/auth/callback?userId=7&keyId=${keyId}&returnUrl=%2Fhome`, 'https://app.example');
        const response = await createOAuthCallbackHandler()(callbackRequest(url));

        return { location: new URL(response.headers.get('location')!), setCookies: response.headers.getSetCookie() };
    }

    it('B1: no pending cookie for the keyId and no legacy one — redirect with reason=no_cookie and the fixed sentence; no cookie written or deleted', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        const other = generateKeyPair('ES256').keyId;
        seams.jar = new Map([[buildStartCookieName('pending', other), await sealedFor(other)]]);

        const answer = await handled(keyId);

        expect(answer.location.pathname).toBe('/auth/error');
        expect(answer.location.searchParams.get('reason')).toBe('no_cookie');
        expect(answer.location.searchParams.get('error')).toBe(OAUTH_COOKIE_MISSING_MESSAGE);
        expect(answer.setCookies).toEqual([]);
    });

    it('B2: a pending cookie that does not unseal — invalid_state, not no_cookie', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        seams.jar = new Map([[buildStartCookieName('pending', keyId), 'not-a-sealed-value']]);

        const answer = await handled(keyId);

        expect(answer.location.searchParams.get('reason')).toBe('invalid_state');
        expect(answer.setCookies).toEqual([]);
    });

    it('B3: a pending cookie that unseals to another keyId — invalid_state', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        seams.jar = new Map([[buildStartCookieName('pending', keyId), await sealedFor('some-other-key')]]);

        const answer = await handled(keyId);

        expect(answer.location.searchParams.get('reason')).toBe('invalid_state');
    });

    it('B4: a pending cookie that unseals to this keyId — the session the proxy decided is on the redirect to returnUrl', async () =>
    {
        const keyId = generateKeyPair('ES256').keyId;
        const pending = buildStartCookieName('pending', keyId);
        seams.jar = new Map([[pending, await sealedFor(keyId)]]);

        const answer = await handled(keyId);
        const names = answer.setCookies.map(header => header.split('=')[0]);

        expect(answer.location.pathname).toBe('/home');
        expect(names).toEqual(expect.arrayContaining([COOKIE_NAMES.SESSION, pending]));
    });
});

/** The reason-code surface of #129. */
describe('no_cookie case table D — the reason-code surface (#129)', () =>
{
    it('D1: OAUTH_ERROR_REASONS holds no_cookie and isOAuthErrorReason accepts it', () =>
    {
        expect(OAUTH_ERROR_REASONS).toContain('no_cookie');
        expect(isOAuthErrorReason('no_cookie')).toBe(true);
    });

    it.each([
        ['placeholder', '/auth/error?code={reason}', '/auth/error?code=no_cookie'],
        ['path-only', '/auth/oops', '/auth/oops?reason=no_cookie'],
        ['existing query', '/auth/oops?src=oauth', '/auth/oops?src=oauth&reason=no_cookie'],
        ['fragment', '/auth/oops?src=oauth#top', '/auth/oops?src=oauth&reason=no_cookie#top'],
    ])('D2 (%s): withOAuthErrorReason places no_cookie by the same rules as every code', (_form, url, expected) =>
    {
        expect(withOAuthErrorReason(url, 'no_cookie')).toBe(expected);
    });

    it('D4: @spfn/auth, @spfn/auth/server and @spfn/auth/nextjs/client carry the widened union; @spfn/auth/errors exports OAuthCookieMissingError', async () =>
    {
        // The client entry imports React components, which this suite cannot load,
        // so it is checked by type: its re-exports are the same module's.
        const entries = await Promise.all([import('../../index'), import('../../server')]);
        const error = new OAuthCookieMissingError();

        for (const entry of entries)
        {
            expect(entry.OAUTH_ERROR_REASONS).toContain('no_cookie');
            expect(entry.isOAuthErrorReason('no_cookie')).toBe(true);
        }

        expectTypeOf<'no_cookie'>().toMatchTypeOf<import('../../index').OAuthErrorReason>();
        expectTypeOf<'no_cookie'>().toMatchTypeOf<import('../../server').OAuthErrorReason>();
        expectTypeOf<import('../../nextjs/client').OAuthErrorReason>().toEqualTypeOf<OAuthErrorReason>();
        expectTypeOf<typeof import('../../nextjs/client').OAUTH_ERROR_REASONS>().toEqualTypeOf<typeof OAUTH_ERROR_REASONS>();
        expect(error).toBeInstanceOf(ValidationError);
        expect([error.name, error.message, error.statusCode]).toEqual(['OAuthCookieMissingError', OAUTH_COOKIE_MISSING_MESSAGE, 400]);
        expect(authErrorRegistry.has('OAuthCookieMissingError')).toBe(true);
    });
});
