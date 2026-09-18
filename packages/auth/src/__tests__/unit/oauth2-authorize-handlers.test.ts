/**
 * @spfn/auth - OAuth 2.1 consent screen, web side (design #93 v2, case table 8b)
 *
 * 8b's rows describe the whole consent flow. The API half ships with PR A and is
 * pinned in `integration/oauth2-authorize-api.test.ts`; this file owns the web
 * half — the session redirect and its `isSafeReturnPath` check, the response
 * headers, what the page says, the form's own CSRF token, and which of the API's
 * two refusal kinds becomes a screen and which becomes a 302.
 *
 * The API is a mock here, and deliberately so: every row below is a statement
 * about what the handler does with an answer, and the answers themselves are
 * already pinned against a real database next door. What is *not* mocked is the
 * session (sealed for real and read through `next/headers`) or the CSRF token
 * (derived by the real `deriveCsrfToken` and compared by the real
 * `matchesCsrfToken`) — those two are the security properties this file exists
 * for, and a mock of either would pin nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** The API client, replaced wholesale: the handler's only use of it is these two calls. */
const api = vi.hoisted(() => ({
    describe: vi.fn(),
    decide: vi.fn(),
}));

vi.mock('@spfn/auth', () => ({
    authApi: {
        getOAuth2Authorize: { call: (input: unknown) => api.describe(input) },
        createOAuth2AuthorizationCode: { call: (input: unknown) => api.decide(input) },
    },
}));

/** The browser's cookie jar, as `next/headers` hands it to server code. */
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    }),
}));

import { NextRequest } from 'next/server';
import { ApiError } from '@spfn/core/nextjs';

import { createOAuth2AuthorizeHandlers, escapeHtml } from '../../nextjs/oauth2-authorize-handlers';
import { sessionCookieNames } from '../../nextjs/cookie-names';
import { sealSession } from '../../server/lib/session';
import { deriveCsrfToken } from '../../server/lib/csrf';
import { generateKeyPair } from '../../server/lib/crypto';

const APP = 'https://app.example';
const LOGIN = '/login';
const REDIRECT_URI = 'http://127.0.0.1:7777/callback';
const RESOURCE = 'https://api.example/mcp';

/** A request as a CLI composes it, before a row changes one thing about it. */
const AUTHORIZE_QUERY: Record<string, string> = {
    client_id: 'spfn_client_abc',
    redirect_uri: REDIRECT_URI,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'mcp:read',
    state: 'opaque-state',
};

/** What `GET /_auth/oauth2/authorize` answers for the request above. */
const CONSENT = {
    clientName: 'Acme CLI',
    redirectHost: '127.0.0.1',
    scopes: [{ name: 'mcp:read', description: 'Read your projects and tasks' }],
    resource: RESOURCE,
};

const { GET, POST } = createOAuth2AuthorizeHandlers({ loginPath: LOGIN });

let csrfToken: string;

describe('createOAuth2AuthorizeHandlers (8b, web rows)', () =>
{
    beforeEach(async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        api.describe.mockReset();
        api.decide.mockReset();
        jar.clear();
        await signIn();
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    /** Put a real sealed session and its real CSRF token in the jar. */
    async function signIn(): Promise<void>
    {
        const keyPair = generateKeyPair('ES256');
        const names = sessionCookieNames();

        csrfToken = await deriveCsrfToken(keyPair.keyId);
        jar.set(names.session, await sealSession({
            userId: 'user-1',
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        }, 600));
        jar.set(names.keyId, keyPair.keyId);
        jar.set(names.csrf, csrfToken);
    }

    function signOut(): void
    {
        jar.delete(sessionCookieNames().session);
    }

    function authorizeUrl(query: Record<string, string> = AUTHORIZE_QUERY): URL
    {
        const url = new URL('/oauth/authorize', APP);

        for (const [name, value] of Object.entries(query))
        {
            url.searchParams.set(name, value);
        }

        return url;
    }

    async function get(query?: Record<string, string>): Promise<Response>
    {
        return await GET(new NextRequest(authorizeUrl(query)));
    }

    async function post(form: Record<string, string>, contentType?: string): Promise<Response>
    {
        const request = new NextRequest(authorizeUrl(), {
            method: 'POST',
            headers: { 'content-type': contentType ?? 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString(),
        });

        return await POST(request);
    }

    /** The consent form as the rendered page submits it. */
    function formFor(query: Record<string, string> = AUTHORIZE_QUERY, decision = 'approve'): Record<string, string>
    {
        return { ...query, csrf: csrfToken, decision };
    }

    /**
     * A refusal on the wire: an `ApiError` carrying the SPFN error envelope.
     *
     * The same values the API's own test reads out of `details`, in the shape the
     * typed client hands the handler when the class is not deserialized.
     */
    function refusal(details: Record<string, unknown>, status = 400): ApiError
    {
        return new ApiError('refused', status, `${APP}/api/rpc/getOAuth2Authorize`, {
            error: { code: 'ValidationError', message: 'refused', details },
        }, 'http');
    }

    function redirectable(error: string, redirectUri = REDIRECT_URI, state?: string): ApiError
    {
        return refusal({ error, redirectUri, state });
    }

    // ── Row 1 ────────────────────────────────────────────────────────────────

    it('no session, valid request → 302 loginPath?returnUrl', async () =>
    {
        signOut();

        const response = await get();
        const location = new URL(response.headers.get('location')!);

        expect(response.status).toBe(302);
        expect(location.origin + location.pathname).toBe(`${APP}${LOGIN}`);
        expect(location.searchParams.get('returnUrl')).toBe(`/oauth/authorize${authorizeUrl().search}`);
        expect(api.describe).not.toHaveBeenCalled();
    });

    // ── Row 2 ────────────────────────────────────────────────────────────────

    it('no session, authorize URL refused by isSafeReturnPath → 400 screen, not sent to the login', async () =>
    {
        signOut();

        // `..` anywhere in the value is refused, and the query is where a caller
        // reaches: this is a link somebody was sent, not a path the app built.
        const response = await get({ ...AUTHORIZE_QUERY, state: '../../elsewhere' });

        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
        expect(api.describe).not.toHaveBeenCalled();
    });

    // ── Row 3 ────────────────────────────────────────────────────────────────

    it('signed in, unregistered client_id → 400 screen, no redirect', async () =>
    {
        api.describe.mockRejectedValue(refusal({ error: 'unknown_client' }));

        const response = await get();

        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    // ── Row 4 ────────────────────────────────────────────────────────────────

    it('signed in, redirect_uri whose host does not match the registration → 400 screen, no redirect', async () =>
    {
        api.describe.mockRejectedValue(refusal({ error: 'redirect_uri_mismatch' }));

        const response = await get({ ...AUTHORIZE_QUERY, redirect_uri: 'http://127.0.0.2:7777/callback' });

        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
    });

    // ── Row 5 ────────────────────────────────────────────────────────────────

    it('signed in, 127.0.0.1 registered and localhost requested → 400 screen, no redirect', async () =>
    {
        api.describe.mockRejectedValue(refusal({ error: 'redirect_uri_mismatch' }));

        const response = await get({ ...AUTHORIZE_QUERY, redirect_uri: 'http://localhost:7777/callback' });

        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
    });

    // ── Row 6 ────────────────────────────────────────────────────────────────

    it('signed in, loopback with the same port and a different path → 400 screen, no redirect', async () =>
    {
        api.describe.mockRejectedValue(refusal({ error: 'redirect_uri_mismatch' }));

        const response = await get({ ...AUTHORIZE_QUERY, redirect_uri: 'http://127.0.0.1:7777/elsewhere' });

        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
    });

    // ── Row 7 ────────────────────────────────────────────────────────────────

    it('signed in, [::1] registered and [0:0:0:0:0:0:0:1] requested → normalized match, consent screen', async () =>
    {
        api.describe.mockResolvedValue({ ...CONSENT, redirectHost: '[::1]' });

        const query = { ...AUTHORIZE_QUERY, redirect_uri: 'http://[0:0:0:0:0:0:0:1]:7777/callback' };
        const response = await get(query);

        expect(response.status).toBe(200);
        expect(api.describe).toHaveBeenCalledWith({ query });
        await expect(response.text()).resolves.toContain('[::1]');
    });

    // ── Row 8 ────────────────────────────────────────────────────────────────

    it('signed in, loopback differing only in port → consent screen', async () =>
    {
        api.describe.mockResolvedValue(CONSENT);

        const response = await get({ ...AUTHORIZE_QUERY, redirect_uri: 'http://127.0.0.1:41235/callback' });

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain('Acme CLI');
    });

    // ── Row 9 ────────────────────────────────────────────────────────────────

    it('signed in, no code_challenge_method or plain → 302 error=invalid_request', async () =>
    {
        api.describe.mockRejectedValue(redirectable('invalid_request', REDIRECT_URI, 'opaque-state'));

        const { code_challenge_method: _omitted, ...query } = AUTHORIZE_QUERY;
        const response = await get(query);
        const location = new URL(response.headers.get('location')!);

        expect(response.status).toBe(302);
        expect(location.origin + location.pathname).toBe(REDIRECT_URI);
        expect(location.searchParams.get('error')).toBe('invalid_request');
        expect(location.searchParams.get('state')).toBe('opaque-state');
    });

    // ── Row 10 ───────────────────────────────────────────────────────────────

    it('signed in, no resource → 302 error=invalid_target', async () =>
    {
        api.describe.mockRejectedValue(redirectable('invalid_target'));

        const { resource: _omitted, ...query } = AUTHORIZE_QUERY;
        const response = await get(query);

        expect(response.status).toBe(302);
        expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    });

    // ── Row 11 ───────────────────────────────────────────────────────────────

    it('signed in, no scope → consent screen showing the default scope set', async () =>
    {
        api.describe.mockResolvedValue({
            ...CONSENT,
            scopes: [{ name: 'mcp:read', description: 'Read your projects and tasks' }],
        });

        const { scope: _omitted, ...query } = AUTHORIZE_QUERY;
        const response = await get(query);

        expect(api.describe).toHaveBeenCalledWith({ query });
        await expect(response.text()).resolves.toContain('Read your projects and tasks');
    });

    // ── Row 12 ───────────────────────────────────────────────────────────────

    it('signed in, a scope the configuration does not list → 302 error=invalid_scope', async () =>
    {
        api.describe.mockRejectedValue(redirectable('invalid_scope'));

        const response = await get({ ...AUTHORIZE_QUERY, scope: 'mcp:read mcp:nonesuch' });

        expect(response.status).toBe(302);
        expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
    });

    // ── Row 13 ───────────────────────────────────────────────────────────────

    it('signed in (GET) → frame-ancestors and no-store headers, body with client_name, redirect host, '
        + 'scope descriptions, resource and a hidden CSRF field', async () =>
    {
        api.describe.mockResolvedValue(CONSENT);

        const response = await get();
        const body = await response.text();

        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        expect(response.headers.get('cache-control')).toBe('no-store');

        expect(body).toContain('Acme CLI');
        expect(body).toContain('127.0.0.1');
        expect(body).toContain('Read your projects and tasks');
        expect(body).toContain(escapeHtml(RESOURCE));
        expect(body).toContain(`<input type="hidden" name="csrf" value="${csrfToken}">`);

        for (const [name, value] of Object.entries(AUTHORIZE_QUERY))
        {
            expect(body).toContain(`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`);
        }

        expect(body).toContain('name="decision" value="approve"');
        expect(body).toContain('name="decision" value="deny"');
    });

    // ── Row 14 ───────────────────────────────────────────────────────────────

    it.each([
        ['missing', {}],
        ['not the session\'s token', { csrf: 'f'.repeat(64) }],
    ])('signed in (POST), form CSRF %s → 403, refused by the route handler', async (_name, override) =>
    {
        const form = { ...formFor(), ...override };

        if (!('csrf' in override))
        {
            delete (form as Record<string, string>).csrf;
        }

        const response = await post(form);

        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(api.decide).not.toHaveBeenCalled();
    });

    // ── Row 15 ───────────────────────────────────────────────────────────────

    it('signed in (POST), approved → 302 with code and state, state verbatim', async () =>
    {
        api.decide.mockResolvedValue({ code: 'the-code', redirectUri: REDIRECT_URI, state: 'opaque-state' });

        const response = await post(formFor());
        const location = new URL(response.headers.get('location')!);

        expect(response.status).toBe(302);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(location.origin + location.pathname).toBe(REDIRECT_URI);
        expect(location.searchParams.get('code')).toBe('the-code');
        expect(location.searchParams.get('state')).toBe('opaque-state');
        expect(api.decide).toHaveBeenCalledWith({ body: { ...AUTHORIZE_QUERY, approve: true } });
    });

    // ── Row 16 ───────────────────────────────────────────────────────────────

    it('signed in (POST), approved with no state → 302 carrying the code only', async () =>
    {
        api.decide.mockResolvedValue({ code: 'the-code', redirectUri: REDIRECT_URI });

        const { state: _omitted, ...query } = AUTHORIZE_QUERY;
        const location = new URL((await post(formFor(query))).headers.get('location')!);

        expect(location.searchParams.get('code')).toBe('the-code');
        expect(location.searchParams.has('state')).toBe(false);
    });

    // ── Row 17 ───────────────────────────────────────────────────────────────

    it('signed in (POST), denied → 302 error=access_denied with the state', async () =>
    {
        api.decide.mockRejectedValue(redirectable('access_denied', REDIRECT_URI, 'opaque-state'));

        const response = await post(formFor(AUTHORIZE_QUERY, 'deny'));
        const location = new URL(response.headers.get('location')!);

        expect(response.status).toBe(302);
        expect(location.searchParams.get('error')).toBe('access_denied');
        expect(location.searchParams.get('state')).toBe('opaque-state');
        expect(api.decide).toHaveBeenCalledWith({ body: { ...AUTHORIZE_QUERY, approve: false } });
    });

    // ── Row 18 ───────────────────────────────────────────────────────────────

    it('an existing grant whose scopes are being widened → consent screen again, showing both', async () =>
    {
        api.describe.mockResolvedValue({
            ...CONSENT,
            scopes: [
                { name: 'mcp:read', description: 'Read your projects and tasks' },
                { name: 'mcp:write', description: 'Create and edit your tasks' },
            ],
        });

        const body = await (await get({ ...AUTHORIZE_QUERY, scope: 'mcp:read mcp:write' })).text();

        expect(body).toContain('Read your projects and tasks');
        expect(body).toContain('Create and edit your tasks');
    });

    // ── Beyond the table ─────────────────────────────────────────────────────

    it('POST with no session at all → 403 and the API is never called', async () =>
    {
        signOut();

        const response = await post(formFor());

        expect(response.status).toBe(403);
        expect(api.decide).not.toHaveBeenCalled();
    });

    it('escapes a client_name of <script>alert(1)</script>', async () =>
    {
        api.describe.mockResolvedValue({ ...CONSENT, clientName: '<script>alert(1)</script>' });

        const body = await (await get()).text();

        expect(body).not.toContain('<script>');
        expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('sends a redirectable refusal to the API\'s redirectUri, never to the query\'s', async () =>
    {
        const vetted = 'http://127.0.0.1:7777/callback';
        api.describe.mockRejectedValue(redirectable('invalid_scope', vetted));

        const response = await get({ ...AUTHORIZE_QUERY, redirect_uri: 'https://evil.example/steal' });
        const location = new URL(response.headers.get('location')!);

        expect(location.origin).toBe('http://127.0.0.1:7777');
        expect(response.headers.get('location')).not.toContain('evil.example');
    });

    it('carries a state holding &, = and unicode through the code redirect verbatim', async () =>
    {
        const state = 'a&b=c 안녕/+%';
        api.decide.mockResolvedValue({ code: 'the-code', redirectUri: REDIRECT_URI, state });

        const response = await post(formFor({ ...AUTHORIZE_QUERY, state }));

        expect(new URL(response.headers.get('location')!).searchParams.get('state')).toBe(state);
    });

    it('carries the same state through a refusal redirect verbatim', async () =>
    {
        const state = 'a&b=c 안녕/+%';
        api.describe.mockRejectedValue(redirectable('invalid_target', REDIRECT_URI, state));

        const response = await get({ ...AUTHORIZE_QUERY, state });

        expect(new URL(response.headers.get('location')!).searchParams.get('state')).toBe(state);
    });

    it('refuses a POST that is not a form with 415, without reading it', async () =>
    {
        const response = await post(formFor(), 'application/json');

        expect(response.status).toBe(415);
        expect(api.decide).not.toHaveBeenCalled();
    });

    it('does not forward form fields the authorize request has no room for', async () =>
    {
        api.decide.mockResolvedValue({ code: 'the-code', redirectUri: REDIRECT_URI, state: 'opaque-state' });

        await post({ ...formFor(), userId: '99', approve: 'true' });

        expect(api.decide).toHaveBeenCalledWith({ body: { ...AUTHORIZE_QUERY, approve: true } });
    });

    it('sends a stale session (the API answers 401) to the login once, with the returnUrl', async () =>
    {
        api.describe.mockRejectedValue(refusal({}, 401));

        const response = await get();
        const location = new URL(response.headers.get('location')!);

        expect(response.status).toBe(302);
        expect(location.pathname).toBe(LOGIN);
        expect(location.searchParams.get('returnUrl')).toBe(`/oauth/authorize${authorizeUrl().search}`);
    });

    it('answers an unrecognized failure with a screen that echoes nothing of it', async () =>
    {
        api.describe.mockRejectedValue(new ApiError('socket hang up', 0, `${APP}/api/rpc/x`, undefined, 'network'));

        const response = await get();

        expect(response.status).toBe(500);
        expect(response.headers.get('location')).toBeNull();
        await expect(response.text()).resolves.not.toContain('socket hang up');
    });

    it('reads a refusal that arrived as the deserialized error class, not as an ApiError', async () =>
    {
        const { OAuth2AuthorizeRedirectError } = await import('../../errors');
        api.describe.mockRejectedValue(new OAuth2AuthorizeRedirectError({
            error: 'invalid_request',
            redirectUri: REDIRECT_URI,
            state: 'opaque-state',
        }));

        const response = await get();

        expect(response.status).toBe(302);
        expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    });

    it('lets a custom render own the body while the handler keeps the headers', async () =>
    {
        api.describe.mockResolvedValue(CONSENT);

        const handlers = createOAuth2AuthorizeHandlers({
            loginPath: LOGIN,
            render: view => `<p>${escapeHtml(view.clientName)} wants ${view.scopes.length} thing(s)</p>`,
        });

        const response = await handlers.GET(new NextRequest(authorizeUrl()));

        expect(await response.text()).toBe('<p>Acme CLI wants 1 thing(s)</p>');
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
});
