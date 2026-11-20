/**
 * What an interceptor can see of the browser's headers
 *
 * buildProxyHeaders() forwards a fixed allowlist to the backend, and
 * buildRequestContext() hands that filtered set to interceptors as `ctx.headers`.
 * A security header the browser sent is therefore absent from `ctx.headers` —
 * which is why the CSRF check in @spfn/auth reads `ctx.request` instead. Pinned
 * here so the two halves of that arrangement cannot drift apart silently.
 */

import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';

import { buildProxyHeaders, buildRequestContext, buildSetCookieHeader } from '../helpers';

const CSRF_HEADER = 'x-spfn-csrf';

describe('proxy header forwarding', () =>
{
    const browserHeaders = new Headers({
        'content-type': 'application/json',
        'user-agent': 'test-agent',
        [CSRF_HEADER]: 'token-abc',
    });

    it('does not forward the CSRF header to the backend', () =>
    {
        const forwarded = buildProxyHeaders(browserHeaders, {}, undefined);

        // Proxy-terminated by design: the backend authenticates a bearer token and
        // has no use for it.
        expect(forwarded.get(CSRF_HEADER)).toBeNull();
        expect(forwarded.get('content-type')).toBe('application/json');
    });

    it('still lets an interceptor read it off the original request', () =>
    {
        const ctx = buildRequestContext(
            'orders',
            'POST',
            buildProxyHeaders(browserHeaders, {}, undefined),
            undefined,
            new URLSearchParams(),
            new Map(),
            { headers: browserHeaders } as unknown as NextRequest,
            { method: 'POST', path: '/orders' },
        );

        expect(ctx.headers[CSRF_HEADER]).toBeUndefined();
        expect(ctx.request.headers.get(CSRF_HEADER)).toBe('token-abc');
    });
});

describe('proxy Set-Cookie serialization', () =>
{
    it('emits no HttpOnly for a cookie the client has to read', () =>
    {
        // The CSRF cookie in @spfn/auth is HttpOnly:false on purpose — if this
        // serializer emitted the attribute anyway, the client could never mirror
        // the token and every mutation would be refused.
        const header = buildSetCookieHeader({
            name: 'spfn_csrf',
            value: 'token',
            options: { httpOnly: false, secure: true, sameSite: 'lax', maxAge: 3600, path: '/' },
        });

        expect(header).not.toContain('HttpOnly');
        expect(header).toBe('spfn_csrf=token; Secure; SameSite=lax; Max-Age=3600; Path=/');
    });
});
