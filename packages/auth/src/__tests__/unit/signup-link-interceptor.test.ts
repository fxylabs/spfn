/**
 * @spfn/auth - Verified-Email Signup Interceptor Tests
 *
 * The interceptor is what keeps the password-setup secret out of page script:
 * it moves the secret from the confirm response into an HttpOnly cookie, and
 * puts it back into the body when the password is submitted.
 *
 * Covers cells D1–D3 of the feature's case table (what the setup cookie is NOT
 * accepted for) by asserting the rule matches only the two signup paths.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import { signupLinkInterceptor } from '../../nextjs/interceptors/signup-link';
import { COOKIE_NAMES } from '../../server/lib/config';
import { decidedResponse } from '../helpers/session-decision';

const CONFIRM_PATH = '/_auth/signup/email/confirm';
const PASSWORD_PATH = '/_auth/signup/password';

function requestContext(path: string, cookie?: string)
{
    return {
        path,
        body: {} as Record<string, unknown>,
        cookies: {
            get: (name: string) => (name === COOKIE_NAMES.SIGNUP_SETUP ? cookie : undefined),
        },
        metadata: {},
    } as unknown as RequestInterceptorContext;
}

function responseContext(path: string, ok: boolean, body: Record<string, unknown>)
{
    return {
        path,
        response: { ok, body },
        setCookies: [] as { name: string; value: string; options: Record<string, unknown> }[],
        cookies: { get: () => undefined },
        metadata: {},
    } as unknown as ResponseInterceptorContext;
}

function matches(path: string): boolean
{
    return (signupLinkInterceptor.pathPattern as RegExp).test(path);
}

describe('signup link interceptor - which requests it touches', () =>
{
    it('matches the two verified-email signup paths', () =>
    {
        expect(matches(CONFIRM_PATH)).toBe(true);
        expect(matches(PASSWORD_PATH)).toBe(true);
    });

    it.each([
        '/_auth/login',
        '/_auth/register',
        '/_auth/codes',
        '/_auth/codes/verify',
        '/_auth/session',
        '/_auth/password',
        '/_auth/signup/email',
    ])('leaves %s alone, so the setup cookie authorizes nothing there', (path) =>
    {
        expect(matches(path)).toBe(false);
    });
});

describe('signup link interceptor - confirm response', () =>
{
    it('moves the setup secret into a cookie and out of the body', async () =>
    {
        const ctx = responseContext(CONFIRM_PATH, true, { email: 'a@example.com', setupSecret: 'secret-value' });
        const next = vi.fn(async () => undefined);

        await decidedResponse(ctx, [signupLinkInterceptor.response], next);

        expect(ctx.response.body.setupSecret).toBeUndefined();
        expect(ctx.setCookies).toHaveLength(1);
        expect(ctx.setCookies[0].value).toBe('secret-value');
        expect(next).toHaveBeenCalledOnce();
    });

    it('sets the cookie HttpOnly, same-site and path-wide', async () =>
    {
        const ctx = responseContext(CONFIRM_PATH, true, { setupSecret: 'secret-value' });

        await decidedResponse(ctx, [signupLinkInterceptor.response], vi.fn(async () => undefined));

        expect(ctx.setCookies[0].options).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
        });
    });

    it('sets no cookie when the confirm was refused', async () =>
    {
        const ctx = responseContext(CONFIRM_PATH, false, { message: 'nope' });

        await decidedResponse(ctx, [signupLinkInterceptor.response], vi.fn(async () => undefined));

        expect(ctx.setCookies).toHaveLength(0);
    });
});

describe('signup link interceptor - password request', () =>
{
    it('puts the cookie back into the body', async () =>
    {
        const ctx = requestContext(PASSWORD_PATH, 'secret-value');

        await signupLinkInterceptor.request?.(ctx, vi.fn(async () => undefined));

        expect(ctx.body.setupSecret).toBe('secret-value');
    });

    it('injects nothing when there is no cookie, so the route refuses on its own', async () =>
    {
        const ctx = requestContext(PASSWORD_PATH, undefined);

        await signupLinkInterceptor.request?.(ctx, vi.fn(async () => undefined));

        expect(ctx.body.setupSecret).toBeUndefined();
    });

    it('does not inject the secret on the confirm request', async () =>
    {
        const ctx = requestContext(CONFIRM_PATH, 'secret-value');

        await signupLinkInterceptor.request?.(ctx, vi.fn(async () => undefined));

        expect(ctx.body.setupSecret).toBeUndefined();
    });
});

describe('signup link interceptor - password response', () =>
{
    it('clears the cookie once the signup succeeded', async () =>
    {
        const ctx = responseContext(PASSWORD_PATH, true, { userId: '1' });

        await decidedResponse(ctx, [signupLinkInterceptor.response], vi.fn(async () => undefined));

        expect(ctx.setCookies).toHaveLength(1);
        expect(ctx.setCookies[0].value).toBe('');
        expect(ctx.setCookies[0].options?.maxAge).toBe(0);
    });

    it('keeps the cookie when the password was refused, so a retry can present it', async () =>
    {
        const ctx = responseContext(PASSWORD_PATH, false, { message: 'password too short' });

        await decidedResponse(ctx, [signupLinkInterceptor.response], vi.fn(async () => undefined));

        expect(ctx.setCookies).toHaveLength(0);
    });
});
