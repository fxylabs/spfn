/**
 * @spfn/auth - Next.js OAuth callback route handler
 *
 * The handler resolves `?returnUrl=` against the request URL and redirects the
 * browser there once the sign-in is complete, which is the last seam where a
 * caller-supplied destination can turn a genuine login into an open redirect
 * (GitHub fxylabs/spfn#89). What is pinned here is that a destination leaving
 * the app is replaced by the handler's default — and that only the destination
 * is replaced: the login still stands and still sets its cookies.
 *
 * The handler completes the sign-in through the app's own RPC proxy — the real
 * `createRpcProxy` with `authInterceptors`, the real finalize route behind it —
 * and redirects carrying the cookies the proxy's session decision wrote.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { registerRoutes } from '@spfn/core/route';

// The finalize route answers the principal its door admitted, and the key's binding; no database here.
vi.mock('../../server/middleware/oauth-finalize-auth', async () => (await import('../helpers/finalize-door')).finalizeDoorStandIn('user-1'));

vi.mock('../../server/services/session-binding.service', async (importActual) => ({
    ...(await importActual<typeof import('../../server/services/session-binding.service')>()),
    keySessionBindingService: vi.fn(async () => ({})),
}));

import { NextRequest } from 'next/server';

import { createOAuthCallbackHandler } from '../../nextjs/oauth-handlers';
import { sealPendingSession } from '../../nextjs/session-helpers';
import { unsealSession, type SessionData } from '../../server/lib/session';
import { generateKeyPair } from '../../server/lib/crypto';
import { buildStartCookieName } from '../../server/lib/oauth/start-cookies';
import { keySessionBindingService } from '../../server/services/session-binding.service';
import { mainAuthRouter } from '../../server/routes';
import { mountProxy } from '../helpers/rpc-proxy';

/** The browser's pending cookie for the start being completed, under its per-start name (#126). */
const pendingCookie = { name: '', value: '' };

/** A callback request carrying the pending cookie, with the app's proxy mounted in front of the real routes. */
function callbackRequest(url: URL, headers: Record<string, string> = {}): NextRequest
{
    const backend = new Hono();
    registerRoutes(backend, mainAuthRouter);
    mountProxy(backend);

    return new NextRequest(url, { headers: { ...headers, cookie: `${pendingCookie.name}=${pendingCookie.value}` } });
}

const APP = 'https://app.example';
const DEFAULT_REDIRECT = '/after-login';

describe('createOAuthCallbackHandler - returnUrl', () =>
{
    let keyId: string;

    beforeEach(async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');

        const keyPair = generateKeyPair('ES256');
        keyId = keyPair.keyId;
        pendingCookie.name = buildStartCookieName('pending', keyPair.keyId);
        pendingCookie.value = await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        });
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    /**
     * A callback as the backend issues it: userId and keyId in the query, plus
     * whatever `returnUrl` the flow carried. The attacker's reach is the query
     * string — a link the victim opens — so that is what the test varies.
     */
    async function callbackWith(returnUrl: string): Promise<Response>
    {
        const url = new URL('/api/auth/callback', APP);
        url.searchParams.set('userId', 'user-1');
        url.searchParams.set('keyId', keyId);
        url.searchParams.set('returnUrl', returnUrl);

        const handler = createOAuthCallbackHandler({ defaultRedirectUrl: DEFAULT_REDIRECT });

        return await handler(callbackRequest(url));
    }

    it.each([
        ['https://evil.com', 'absolute URL'],
        ['//evil.com', 'protocol-relative host'],
        ['/\\evil.com', 'backslash a browser may normalize to a slash'],
        ['\\\\evil.com', 'backslash pair'],
        ['/..//evil.com', 'traversal ahead of a host'],
        ['/./../evil', 'traversal spelled with a dot segment'],
        ['javascript:alert(1)', 'a javascript URL'],
        ['/javascript:x', 'protocol prefix in the first segment'],
        ['/a\r\nLocation: https://evil.com', 'raw CR/LF'],
        [' //evil.com', 'leading space ahead of a host'],
        ['/\t/evil.com', 'tab a URL parser strips, leaving //evil.com'],
        ['http:/evil.com', 'single-slash absolute URL'],
        ['/evil.com:443', 'host:port read as an authority'],
    ])('redirects to the default instead of %j (%s)', async (returnUrl) =>
    {
        const res = await callbackWith(returnUrl);

        expect(res.headers.get('location')).toBe(`${APP}${DEFAULT_REDIRECT}`);
    });

    it('keeps a destination inside the app, query and all', async () =>
    {
        const res = await callbackWith('/dashboard?x=1');

        expect(res.headers.get('location')).toBe(`${APP}/dashboard?x=1`);
    });

    it('accepts a percent-encoded value, which stays one path segment on this origin', async () =>
    {
        const res = await callbackWith('/%2F%2Fevil.com');

        expect(new URL(res.headers.get('location')!).origin).toBe(APP);
    });

    /**
     * The fix replaces the destination, not the login: a user who was handed a
     * poisoned link still ends up signed in, on the app's own page.
     */
    it('still sets the session, keyId and CSRF cookies when the destination was replaced', async () =>
    {
        const res = await callbackWith('https://evil.com');
        const names = res.headers.getSetCookie().map(cookie => cookie.split('=')[0]);

        expect(names).toEqual(expect.arrayContaining([
            expect.stringMatching(/^spfn_session/),
            expect.stringMatching(/^spfn_session_key_id/),
            expect.stringMatching(/^spfn_csrf/),
        ]));
    });
});

/**
 * The binding half of the same handler (design #97 v2, case table 6c).
 *
 * The handler seals nothing itself: the proxy's finalize rule seals, and since
 * bundle 8 part 2 no binding field is sealed at all — whether the key is bound,
 * and the browser family it is checked against, are the key row's. So neither
 * the finalize answer nor a callback query puts one in the cookie.
 */
describe('createOAuthCallbackHandler - the session binding fields', () =>
{
    const EXPIRES_AT = 1893456000000;
    const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    let keyId: string;

    beforeEach(async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');

        const keyPair = generateKeyPair('ES256');
        keyId = keyPair.keyId;
        pendingCookie.name = buildStartCookieName('pending', keyPair.keyId);
        pendingCookie.value = await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        });
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    /** A callback carrying whatever binding query, the session the redirect installs. */
    async function callbackSealing(query: Record<string, string>, userAgent = CHROME): Promise<SessionData>
    {
        const url = new URL('/api/auth/callback', APP);
        url.searchParams.set('userId', 'user-1');
        url.searchParams.set('keyId', keyId);

        for (const [name, value] of Object.entries(query))
        {
            url.searchParams.set(name, value);
        }

        const handler = createOAuthCallbackHandler({ defaultRedirectUrl: DEFAULT_REDIRECT });
        const response = await handler(callbackRequest(url, { 'user-agent': userAgent }));
        const sealed = response.headers.getSetCookie()
            .find(cookie => /^spfn_session(_\d+)?=/.test(cookie))!
            .split('=')[1].split(';')[0];

        return await unsealSession(decodeURIComponent(sealed));
    }

    it('a bound key, and a query claiming a binding: the sealed session carries none of the binding fields — the key row holds them', async () =>
    {
        vi.mocked(keySessionBindingService).mockResolvedValueOnce({ sessionBinding: 'passkey', keyExpiresAtMillis: EXPIRES_AT });

        const session = await callbackSealing({ sessionBinding: 'passkey', keyExpiresAtMillis: String(EXPIRES_AT) });

        expect(session).not.toHaveProperty('binding');
        expect(session).not.toHaveProperty('keyExpiresAt');
        expect(session).not.toHaveProperty('uaFamily');
    });
});

/**
 * The error page the handler sends the browser to (#489). Anyone can put
 * `?error=` on the handler's URL, so the page is told the reason's fixed
 * sentence, never that text; the app's refusal code travels only beside
 * `sign_in_refused` and only in the shape `signIn.admit` must answer.
 */
describe('createOAuthCallbackHandler - the error page (#489)', () =>
{
    async function errorPageFor(query: string): Promise<URLSearchParams>
    {
        const response = await createOAuthCallbackHandler()(new NextRequest(new URL(`/api/auth/callback?${query}`, APP)));
        const location = new URL(response.headers.get('location')!);

        expect(location.pathname).toBe('/auth/error');

        return location.searchParams;
    }

    it('O2: ?error=Call+us&reason=cancelled — error is the cancelled sentence, not the URL\'s text', async () =>
    {
        const params = await errorPageFor('error=Call+us&reason=cancelled');

        expect([params.get('reason'), params.get('error')]).toEqual(['cancelled', 'The sign-in was cancelled at the provider.']);
    });

    it('O4 (handler): the app\'s refusal code beside sign_in_refused travels as code; a forged one, or one beside another reason, does not', async () =>
    {
        const refused = await errorPageFor('error=Sign-in+refused&reason=sign_in_refused&code=LOCKED');
        const forged = await errorPageFor('error=x&reason=sign_in_refused&code=Call+us+at+555');
        const elsewhere = await errorPageFor('error=x&reason=cancelled&code=LOCKED');

        expect([refused.get('reason'), refused.get('code')]).toEqual(['sign_in_refused', 'LOCKED']);
        expect([forged.get('reason'), forged.has('code')]).toEqual(['sign_in_refused', false]);
        expect(elsewhere.has('code')).toBe(false);
    });
});
