/**
 * @spfn/auth - The sign-out-everywhere page, web side (follow-up to #94)
 *
 * The two endpoints behind the mailed link are pinned against a real database in
 * `integration/revoke-all-link.test.ts`; this file owns the page in front of
 * them — the response headers, what the screens say and do not say, where the
 * token is allowed to appear, and the CSRF pair the page mints for itself
 * because there is no session here to derive one from.
 *
 * The API is a mock, deliberately: every row below is a statement about what the
 * handler does with an answer, and the answers are already pinned next door.
 * What is *not* mocked is the CSRF comparison — it runs through the real
 * `matchesCsrfToken`, and the value the form echoes is the one a real `GET`
 * actually set in the cookie jar.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** The API client, replaced wholesale: the handler's only use of it is these two calls. */
const api = vi.hoisted(() => ({
    confirm: vi.fn(),
    consume: vi.fn(),
}));

vi.mock('@spfn/auth', () => ({
    authApi: {
        confirmRevokeAllLink: { call: (input: unknown) => api.confirm(input) },
        consumeRevokeAllLink: { call: (input: unknown) => api.consume(input) },
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

import { createRevokeAllPageHandlers } from '../../nextjs/revoke-all-page-handlers';
import { escapeHtml } from '../../nextjs/oauth2-authorize-handlers';

const APP = 'https://app.example';
const PAGE = '/account/revoke-all';
const TOKEN = 'revoke-all-token-value';

/** The cookie the page mints for itself — pinned here because the form depends on the name. */
const CSRF_COOKIE = 'spfn_revoke_all_csrf';

/** What `POST /_auth/keys/revoke-all/confirm` answers for a live link. */
const DESCRIBED = { expiresAt: '2026-09-18T12:34:56.000Z', activeKeyCount: 4 };

const { GET, POST } = createRevokeAllPageHandlers();

describe('createRevokeAllPageHandlers (#94 follow-up, web rows)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        api.confirm.mockReset();
        api.consume.mockReset();
        jar.clear();
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    /** The page URL; `null` leaves the query string off altogether. */
    function pageUrl(token: string | null = TOKEN): URL
    {
        const url = new URL(PAGE, APP);

        if (token !== null)
        {
            url.searchParams.set('token', token);
        }

        return url;
    }

    async function get(token: string | null = TOKEN): Promise<Response>
    {
        return await GET(new NextRequest(pageUrl(token)));
    }

    async function post(form: Record<string, string>, contentType?: string): Promise<Response>
    {
        const request = new NextRequest(pageUrl(), {
            method: 'POST',
            headers: { 'content-type': contentType ?? 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString(),
        });

        return await POST(request);
    }

    /** The CSRF value a drawn page set, read back out of its `Set-Cookie`. */
    function csrfFrom(response: Response): string
    {
        return /spfn_revoke_all_csrf=([0-9a-f]{64})/.exec(response.headers.get('set-cookie') ?? '')![1];
    }

    /**
     * Walk the flow the browser walks: draw the page, keep the cookie it set,
     * and submit the form it rendered. The CSRF value is never fabricated here.
     */
    async function confirmedForm(token = TOKEN): Promise<Record<string, string>>
    {
        api.confirm.mockResolvedValue(DESCRIBED);

        const csrf = csrfFrom(await get(token));

        jar.set(CSRF_COOKIE, csrf);
        api.confirm.mockReset();

        return { token, csrf };
    }

    /** A refusal on the wire: an `ApiError` carrying the SPFN error envelope. */
    function refusal(status: number): ApiError
    {
        return new ApiError('refused', status, `${APP}/api/rpc/confirmRevokeAllLink`, {
            error: { code: 'RevokeAllLinkError', message: 'This link is no longer valid' },
        }, 'http');
    }

    // ── Row 1 ────────────────────────────────────────────────────────────────

    it('GET with no token → 400 screen and the API is never called', async () =>
    {
        const response = await get(null);

        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(api.confirm).not.toHaveBeenCalled();
    });

    it('GET with an empty token → the same 400 screen', async () =>
    {
        const response = await get('');

        expect(response.status).toBe(400);
        expect(api.confirm).not.toHaveBeenCalled();
    });

    // ── Row 2 ────────────────────────────────────────────────────────────────

    it('GET with a live token → 200 with the three headers, the expiry, the device count, '
        + 'hidden token and csrf fields, and the csrf cookie set', async () =>
    {
        api.confirm.mockResolvedValue(DESCRIBED);

        const response = await get();
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(api.confirm).toHaveBeenCalledWith({ body: { token: TOKEN } });
        expect(api.consume).not.toHaveBeenCalled();

        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        expect(response.headers.get('cache-control')).toBe('no-store');

        expect(body).toContain(DESCRIBED.expiresAt);
        expect(body).toContain('<strong>4</strong>');
        expect(body).toContain(`<input type="hidden" name="token" value="${TOKEN}">`);
        expect(body).toMatch(/<input type="hidden" name="csrf" value="[0-9a-f]{64}">/);
        expect(body).toContain('<form method="post">');
        expect(body).toContain('<button type="submit">');

        const setCookie = response.headers.get('set-cookie')!;

        expect(setCookie).toContain(`${CSRF_COOKIE}=`);
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('SameSite=strict');
        expect(setCookie).toContain(`Path=${PAGE}`);
        expect(setCookie).toContain('Max-Age=900');
    });

    // ── Row 3 ────────────────────────────────────────────────────────────────

    it('GET whose token the API answers 404 for → the invalid screen, with no reason and no '
        + 'cookie carrying the token', async () =>
    {
        api.confirm.mockRejectedValue(refusal(404));

        const response = await get();
        const body = await response.text();

        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(body).toContain('Link no longer valid');
        expect(body).not.toContain(TOKEN);
        expect(body).not.toContain('expired');
        expect(body).not.toContain('spent');
        expect(response.headers.get('set-cookie') ?? '').not.toContain(TOKEN);
        expect(response.headers.get('set-cookie')).toBeNull();
    });

    // ── Row 4 ────────────────────────────────────────────────────────────────

    it('GET the API fails some other way → 500 screen echoing nothing of the failure', async () =>
    {
        api.confirm.mockRejectedValue(new ApiError('socket hang up', 0, `${APP}/api/rpc/x`, undefined, 'network'));

        const response = await get();
        const body = await response.text();

        expect(response.status).toBe(500);
        expect(body).not.toContain('socket hang up');
        expect(body).not.toContain(TOKEN);
        expect(api.consume).not.toHaveBeenCalled();
    });

    // ── Row 5 ────────────────────────────────────────────────────────────────

    it('POST carrying the csrf value the GET set → consume called with the token, 200 reporting '
        + 'the count, and the cookie cleared', async () =>
    {
        const form = await confirmedForm();
        api.consume.mockResolvedValue({ revokedCount: 4 });

        const response = await post(form);
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(api.consume).toHaveBeenCalledWith({ body: { token: TOKEN } });
        expect(body).toContain('4 device(s) signed out');
        expect(body).not.toContain(TOKEN);
        expect(response.headers.get('cache-control')).toBe('no-store');

        const setCookie = response.headers.get('set-cookie')!;

        expect(setCookie).toContain(`${CSRF_COOKIE}=;`);
        expect(setCookie).toContain('Expires=Thu, 01 Jan 1970');
    });

    // ── Row 6 ────────────────────────────────────────────────────────────────

    it('POST with no csrf field → 403 and the API is never called', async () =>
    {
        const { csrf: _omitted, ...form } = await confirmedForm();

        const response = await post(form);

        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(api.consume).not.toHaveBeenCalled();
    });

    // ── Row 7 ────────────────────────────────────────────────────────────────

    it('POST whose csrf field is not the cookie\'s value → 403 and the API is never called', async () =>
    {
        const form = await confirmedForm();

        const response = await post({ ...form, csrf: 'f'.repeat(64) });

        expect(response.status).toBe(403);
        expect(api.consume).not.toHaveBeenCalled();
    });

    // ── Row 8 ────────────────────────────────────────────────────────────────

    it('POST that is not a form → 415, without reading the body', async () =>
    {
        const form = await confirmedForm();

        const response = await post(form, 'application/json');

        expect(response.status).toBe(415);
        expect(api.consume).not.toHaveBeenCalled();
    });

    // ── Row 9 ────────────────────────────────────────────────────────────────

    it('POST with a valid csrf whose token the API answers 404 for → the same invalid screen', async () =>
    {
        const form = await confirmedForm();
        api.consume.mockRejectedValue(refusal(404));

        const response = await post(form);
        const body = await response.text();

        expect(response.status).toBe(404);
        expect(body).toContain('Link no longer valid');
        expect(body).not.toContain(TOKEN);
    });

    // ── Row 10 ───────────────────────────────────────────────────────────────

    it('a token carrying <script> and quotes → escaped in every hidden field, and in the body '
        + 'text not at all', async () =>
    {
        const hostile = '"><script>alert(1)</script>';
        api.confirm.mockResolvedValue(DESCRIBED);

        const drawn = await get(hostile);
        const body = await drawn.text();

        expect(api.confirm).toHaveBeenCalledWith({ body: { token: hostile } });
        expect(body).not.toContain('<script>');
        expect(body).toContain(`<input type="hidden" name="token" value="${escapeHtml(hostile)}">`);

        jar.set(CSRF_COOKIE, csrfFrom(drawn));
        api.consume.mockResolvedValue({ revokedCount: 1 });

        const done = await (await post({ token: hostile, csrf: csrfFrom(drawn) })).text();

        expect(api.consume).toHaveBeenCalledWith({ body: { token: hostile } });
        expect(done).not.toContain('<script>');
        expect(done).not.toContain(hostile);
    });

    // ── Row 11 ───────────────────────────────────────────────────────────────

    it('a custom render owns the body at every stage while the handler keeps the headers and '
        + 'the cookie', async () =>
    {
        api.confirm.mockResolvedValue(DESCRIBED);

        const handlers = createRevokeAllPageHandlers({
            render: view => `<p>${view.stage}:${view.activeKeyCount ?? ''}:${view.fields.token ?? ''}</p>`,
        });

        const response = await handlers.GET(new NextRequest(pageUrl(TOKEN)));

        expect(await response.text()).toBe(`<p>confirm:4:${TOKEN}</p>`);
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('set-cookie')).toContain(CSRF_COOKIE);
    });

    // ── Beyond the table ─────────────────────────────────────────────────────

    it('never puts the token in a Location header, at any stage', async () =>
    {
        const form = await confirmedForm();
        api.consume.mockResolvedValue({ revokedCount: 2 });

        for (const response of [await get(), await post(form)])
        {
            expect(response.headers.get('location')).toBeNull();
        }
    });

    it('ignores form fields the consume call has no room for', async () =>
    {
        const form = await confirmedForm();
        api.consume.mockResolvedValue({ revokedCount: 2 });

        await post({ ...form, userId: '99', includeCurrent: 'true' });

        expect(api.consume).toHaveBeenCalledWith({ body: { token: TOKEN } });
    });

    it('POST with a valid csrf but no token field → 400, and the API is never called', async () =>
    {
        const { token: _omitted, ...form } = await confirmedForm();

        const response = await post(form);

        expect(response.status).toBe(400);
        expect(api.consume).not.toHaveBeenCalled();
    });
});
