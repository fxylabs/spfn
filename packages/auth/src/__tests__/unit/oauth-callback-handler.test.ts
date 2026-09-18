/**
 * @spfn/auth - Next.js OAuth callback route handler
 *
 * The handler resolves `?returnUrl=` against the request URL and redirects the
 * browser there once the session is sealed, which is the last seam where a
 * caller-supplied destination can turn a genuine login into an open redirect
 * (GitHub fxylabs/spfn#89). What is pinned here is that a destination leaving
 * the app is replaced by the handler's default — and that only the destination
 * is replaced: the login still stands and still sets its cookies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The handler reads the pending-session cookie through next/headers; the sealed
// value is produced by the real sealer below, so unsealing runs for real.
const pendingCookie = { value: '' };

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        get: (name: string) => (name.startsWith('spfn_oauth_pending') ? { name, value: pendingCookie.value } : undefined),
    }),
}));

import { NextRequest } from 'next/server';

import { createOAuthCallbackHandler } from '../../nextjs/oauth-handlers';
import { sealPendingSession } from '../../nextjs/session-helpers';
import { unsealSession, type SessionData } from '../../server/lib/session';
import { generateKeyPair } from '../../server/lib/crypto';

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
        pendingCookie.value = await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        });
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
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

        return await handler(new NextRequest(url));
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
 * This is the fifth sealing site and the only one that reads the two fields off
 * a query string: the handler runs before any route call, so the redirect the
 * backend issued is the one thing that can tell it the key it is sealing is a
 * short-lived bound one. Nothing is authorized by the query — the key row expires
 * when it says it does — but a cookie that did not carry the fields would take
 * the unbound branch at every proxy check for the whole life of that key.
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
        pendingCookie.value = await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        });
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    /** A callback carrying whatever binding query the backend put on the redirect. */
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
        const response = await handler(new NextRequest(url, { headers: { 'user-agent': userAgent } }));
        const sealed = response.headers.getSetCookie()
            .find(cookie => /^spfn_session(_\d+)?=/.test(cookie))!
            .split('=')[1].split(';')[0];

        return await unsealSession(decodeURIComponent(sealed));
    }

    it('a bound account: the sealed session carries binding, keyExpiresAt and the inbound family', async () =>
    {
        const session = await callbackSealing({
            sessionBinding: 'passkey',
            keyExpiresAtMillis: String(EXPIRES_AT),
        });

        expect(session.binding).toBe('passkey');
        expect(session.keyExpiresAt).toBe(EXPIRES_AT);
        expect(session.uaFamily).toBe('chrome');
    });

    it('an unbound account: the sealed session is the four-field one it has always been', async () =>
    {
        const session = await callbackSealing({});

        expect(session.binding).toBeUndefined();
        expect(session.keyExpiresAt).toBeUndefined();
        expect(session.uaFamily).toBeUndefined();
    });

    // `''` is deliberately not in this list: `Number('')` is 0, which is finite,
    // so an empty parameter seals `keyExpiresAt: 0`. Nothing decides by that value
    // any more — the proxy asks the backend about expiry — so it is a wart rather
    // than a defect, and pinning today's answer to it would be pinning the wart.
    it.each([
        ['not-a-number', 'a keyExpiresAtMillis that is not a number'],
        ['Infinity', 'an infinite keyExpiresAtMillis'],
        ['NaN', 'NaN spelled out'],
    ])('refuses to seal %j (%s) and falls back to unbound', async (expiresAt) =>
    {
        // The `Number.isFinite` guard. A query is a caller-supplied string, and a
        // cookie sealed with `keyExpiresAt: NaN` compares false against every
        // expiry — a bound session that silently never prompts for renewal.
        const session = await callbackSealing({ sessionBinding: 'passkey', keyExpiresAtMillis: expiresAt });

        expect(session.binding).toBeUndefined();
        expect(session.keyExpiresAt).toBeUndefined();
    });

    it('sessionBinding that is anything but passkey seals unbound, whatever the expiry says', async () =>
    {
        const session = await callbackSealing({ sessionBinding: 'none', keyExpiresAtMillis: String(EXPIRES_AT) });

        expect(session.binding).toBeUndefined();
        expect(session.keyExpiresAt).toBeUndefined();
    });
});
