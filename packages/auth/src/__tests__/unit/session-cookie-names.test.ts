/**
 * @spfn/auth - session cookie names and the clearSessionCookies helper
 *
 * An app that answers "the API refused your session" with a page that empties
 * the cookie jar used to copy the names and the `SPFN_PORT` suffix rule out of
 * the package (GitHub fxylabs/spfn#90). What is pinned here is that the export
 * reads the names at call time — so a port set after import still suffixes —
 * and that clearing expires exactly those names under the path the setters use.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

import { sessionCookieNames, clearSessionCookies } from '../../nextjs/cookie-names';

/**
 * The suite runs in the same fork as every other auth file, so a leaked
 * SPFN_PORT would rename the cookies unrelated tests assert on.
 */
let savedPort: string | undefined;

describe('sessionCookieNames', () =>
{
    beforeEach(() =>
    {
        savedPort = process.env.SPFN_PORT;
        delete process.env.SPFN_PORT;
    });

    afterEach(() =>
    {
        if (savedPort === undefined)
        {
            delete process.env.SPFN_PORT;
        }
        else
        {
            process.env.SPFN_PORT = savedPort;
        }
    });

    it('returns the base names when SPFN_PORT is unset', () =>
    {
        expect(sessionCookieNames()).toEqual({
            session: 'spfn_session',
            keyId: 'spfn_session_key_id',
            oauthPending: 'spfn_oauth_pending',
            oauthPendingPrefix: 'spfn_oauth_pending.',
            csrf: 'spfn_csrf',
        });
    });

    it('suffixes every name with a SPFN_PORT set after this module was imported', () =>
    {
        process.env.SPFN_PORT = '4001';

        expect(sessionCookieNames()).toEqual({
            session: 'spfn_session_4001',
            keyId: 'spfn_session_key_id_4001',
            oauthPending: 'spfn_oauth_pending_4001',
            oauthPendingPrefix: 'spfn_oauth_pending_4001.',
            csrf: 'spfn_csrf_4001',
        });
    });

    it('expires exactly the three session cookies and the two legacy OAuth names, each under Path=/', () =>
    {
        const setCookies = clearSessionCookies(new NextResponse()).headers.getSetCookie();

        expect(setCookies).toHaveLength(5);

        for (const setCookie of setCookies)
        {
            expect(setCookie).toContain('Path=/');
            expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
        }

        expect(setCookies.map((setCookie) => setCookie.split('=')[0])).toEqual([
            'spfn_session',
            'spfn_session_key_id',
            'spfn_csrf',
            'spfn_oauth_pending',
            'spfn_oauth_csrf',
        ]);
    });

    it('given the request, also expires every in-flight start\'s two cookies — and no lookalike (#126)', () =>
    {
        const jar = [
            'spfn_oauth_pending.kx1a2b.0123456789abcdef',
            'spfn_oauth_csrf.kx1a2b.0123456789abcdef',
            'spfn_oauth_pending.kx1a2c.fedcba9876543210',
            'spfn_oauth_pending_extra.kx1a2b.0123456789abcdef',
            'spfn_oauth_pending.x',
        ].map(name => ({ name, value: 'v' }));

        const cleared = clearSessionCookies(new NextResponse(), { cookies: { getAll: () => jar } })
            .headers.getSetCookie()
            .map((setCookie) => setCookie.split('=')[0]);

        expect(cleared).toEqual(expect.arrayContaining(jar.slice(0, 3).map(cookie => cookie.name)));
        expect(cleared).not.toContain('spfn_oauth_pending_extra.kx1a2b.0123456789abcdef');
        expect(cleared).not.toContain('spfn_oauth_pending.x');
        expect(cleared).toHaveLength(8);
    });

    it('clears the names sessionCookieNames reports under the same env', () =>
    {
        process.env.SPFN_PORT = '4001';

        const cleared = clearSessionCookies(new NextResponse())
            .headers.getSetCookie()
            .map((setCookie) => setCookie.split('=')[0]);

        const { session, keyId, oauthPending, csrf } = sessionCookieNames();

        expect(cleared.sort()).toEqual([session, keyId, oauthPending, csrf, 'spfn_oauth_csrf_4001'].sort());
    });

    it('returns the same response, and does not throw when the cookies are absent', () =>
    {
        const response = new NextResponse();

        expect(clearSessionCookies(response)).toBe(response);
    });
});
