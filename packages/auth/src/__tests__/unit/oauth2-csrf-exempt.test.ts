/**
 * The CLI's three cookie-less POSTs and the CSRF check (design #93 v2, §7)
 *
 * `register`, `token` and `revoke` arrive from a process on somebody's laptop:
 * no cookie, no `x-spfn-csrf` header, no browser. Two independent things have to
 * be true of them, and this file asserts both, because each on its own would be
 * a 403 nobody could explain from the CLI's side.
 *
 * 1. The proxy's check never reaches them anyway — it runs only after a session
 *    cookie has been unsealed, and a request with no cookie takes the
 *    unauthenticated path straight to the backend.
 * 2. They are on `getCsrfExemptPaths()`, so an application that DOES route them
 *    through the proxy while the same browser happens to hold a session still
 *    gets a working token endpoint.
 *
 * And the one that must not be exempt: `POST /_auth/oauth2/authorize` is the
 * consent form, a cookie-session mutation, and exactly what the check is for.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { RequestInterceptorContext } from '@spfn/core/nextjs/server';

import { generalAuthInterceptor } from '../../nextjs/interceptors/general-auth';
import { generateKeyPair } from '../../server/lib/crypto';
import { sealSession, type SessionData } from '../../server/lib/session';
import { COOKIE_NAMES, configureAuth, getCsrfExemptPaths } from '../../server/lib/config';

const CLI_PATHS = ['/_auth/oauth2/register', '/_auth/oauth2/token', '/_auth/oauth2/revoke'];
const CONSENT_PATH = '/_auth/oauth2/authorize';

process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

/** A sealed session cookie, as the proxy would find one on a signed-in browser. */
async function sessionCookie(): Promise<string>
{
    const keyPair = generateKeyPair('ES256');
    const data: SessionData = {
        userId: '1',
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
    };

    return await sealSession(data, 3600);
}

/** The context the proxy hands an interceptor, with or without a session. */
function requestContext(path: string, cookie?: string): RequestInterceptorContext
{
    const cookies = new Map<string, string>();

    if (cookie)
    {
        cookies.set(COOKIE_NAMES.SESSION, cookie);
    }

    return {
        path,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: {},
        query: {},
        cookies,
        // No `x-spfn-csrf`: that is the whole point of these requests.
        request: { headers: new Headers() } as unknown as NextRequest,
        metadata: {},
    };
}

/** Run the interceptor; report whether the request reached the backend. */
async function reachesBackend(ctx: RequestInterceptorContext): Promise<boolean>
{
    let continued = false;

    await generalAuthInterceptor.request!(ctx, async () =>
    {
        continued = true;
    });

    return continued && ctx.abort === undefined;
}

describe('OAuth2 CLI endpoints and the CSRF check', () =>
{
    beforeEach(() =>
    {
        configureAuth({ csrf: { mode: 'enforce' } });
    });

    it.each(CLI_PATHS)('%s is on the exempt list', (path) =>
    {
        expect(getCsrfExemptPaths()).toContain(path);
    });

    it('POST /_auth/oauth2/authorize is NOT exempt — it is a cookie-session mutation', () =>
    {
        expect(getCsrfExemptPaths()).not.toContain(CONSENT_PATH);
    });

    it.each(CLI_PATHS)('%s with no cookie and no header reaches the backend', async (path) =>
    {
        expect(await reachesBackend(requestContext(path))).toBe(true);
    });

    it.each(CLI_PATHS)('%s reaches the backend even when a session cookie is present', async (path) =>
    {
        expect(await reachesBackend(requestContext(path, await sessionCookie()))).toBe(true);
    });

    it('the consent POST with a session and no CSRF header is refused 403', async () =>
    {
        const ctx = requestContext(CONSENT_PATH, await sessionCookie());

        expect(await reachesBackend(ctx)).toBe(false);
        expect(ctx.abort?.status).toBe(403);
    });
});
