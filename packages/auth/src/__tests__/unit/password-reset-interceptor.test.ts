/**
 * @spfn/auth - Password Reset Interceptor Tests
 *
 * The interceptor is what keeps the password-setup secret out of page script:
 * it moves the secret from the confirm response into an HttpOnly cookie, and
 * puts it back into the body when the new password is submitted.
 *
 * The path assertions are what makes row C11 hold from the browser's side: the
 * reset cookie is offered to nothing but the reset paths, so a leftover signup
 * cookie and a leftover reset cookie can never be presented to each other's
 * flow.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import { passwordResetInterceptor } from '../../nextjs/interceptors/password-reset';
import { loginRegisterInterceptor } from '../../nextjs/interceptors/login-register';
import { COOKIE_NAMES } from '../../server/lib/config';

const CONFIRM_PATH = '/_auth/password/reset/confirm';
const COMPLETE_PATH = '/_auth/password/reset/complete';

function requestContext(path: string, cookie?: string)
{
    return {
        path,
        body: {} as Record<string, unknown>,
        cookies: {
            get: (name: string) => (name === COOKIE_NAMES.PASSWORD_RESET_SETUP ? cookie : undefined),
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
    return (passwordResetInterceptor.pathPattern as RegExp).test(path);
}

describe('password reset interceptor - which requests it touches', () =>
{
    it('matches the two browser-facing reset paths', () =>
    {
        expect(matches(CONFIRM_PATH)).toBe(true);
        expect(matches(COMPLETE_PATH)).toBe(true);
    });

    it.each([
        '/_auth/login',
        '/_auth/register',
        '/_auth/codes',
        '/_auth/session',
        '/_auth/password',
        '/_auth/password/reset',
        '/_auth/signup/password',
        '/_auth/signup/email/confirm',
    ])('leaves %s alone, so the reset cookie authorizes nothing there', (path) =>
    {
        expect(matches(path)).toBe(false);
    });

    it('names its own cookie, never the signup one', () =>
    {
        const ctx = responseContext(CONFIRM_PATH, true, { setupSecret: 'secret-value' });

        passwordResetInterceptor.response?.(ctx, vi.fn(async () => undefined));

        expect(COOKIE_NAMES.PASSWORD_RESET_SETUP).not.toBe(COOKIE_NAMES.SIGNUP_SETUP);
    });

    it('shares the complete path with loginRegisterInterceptor, which supplies the device key', () =>
    {
        expect((loginRegisterInterceptor.pathPattern as RegExp).test(COMPLETE_PATH)).toBe(true);
        expect((loginRegisterInterceptor.pathPattern as RegExp).test(CONFIRM_PATH)).toBe(false);
    });
});

describe('password reset interceptor - confirm response', () =>
{
    it('moves the setup secret into a cookie and out of the body', async () =>
    {
        const ctx = responseContext(CONFIRM_PATH, true, { email: 'a@example.com', setupSecret: 'secret-value' });
        const next = vi.fn(async () => undefined);

        await passwordResetInterceptor.response?.(ctx, next);

        expect(ctx.response.body.setupSecret).toBeUndefined();
        expect(ctx.setCookies).toHaveLength(1);
        expect(ctx.setCookies[0].name).toBe(COOKIE_NAMES.PASSWORD_RESET_SETUP);
        expect(ctx.setCookies[0].value).toBe('secret-value');
        expect(next).toHaveBeenCalledOnce();
    });

    it('sets the cookie HttpOnly, same-site and path-wide', async () =>
    {
        const ctx = responseContext(CONFIRM_PATH, true, { setupSecret: 'secret-value' });

        await passwordResetInterceptor.response?.(ctx, vi.fn(async () => undefined));

        expect(ctx.setCookies[0].options).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
        });
    });

    it('sets no cookie when the confirm was refused', async () =>
    {
        const ctx = responseContext(CONFIRM_PATH, false, { message: 'nope' });

        await passwordResetInterceptor.response?.(ctx, vi.fn(async () => undefined));

        expect(ctx.setCookies).toHaveLength(0);
    });
});

describe('password reset interceptor - complete request', () =>
{
    it('puts the cookie back into the body', async () =>
    {
        const ctx = requestContext(COMPLETE_PATH, 'secret-value');

        await passwordResetInterceptor.request?.(ctx, vi.fn(async () => undefined));

        expect(ctx.body.setupSecret).toBe('secret-value');
    });

    it('injects nothing when there is no cookie, so the route refuses on its own', async () =>
    {
        const ctx = requestContext(COMPLETE_PATH, undefined);

        await passwordResetInterceptor.request?.(ctx, vi.fn(async () => undefined));

        expect(ctx.body.setupSecret).toBeUndefined();
    });

    it('does not inject the secret on the confirm request', async () =>
    {
        const ctx = requestContext(CONFIRM_PATH, 'secret-value');

        await passwordResetInterceptor.request?.(ctx, vi.fn(async () => undefined));

        expect(ctx.body.setupSecret).toBeUndefined();
    });
});

describe('password reset interceptor - complete response', () =>
{
    it('clears the cookie once the reset succeeded', async () =>
    {
        const ctx = responseContext(COMPLETE_PATH, true, { userId: '1' });

        await passwordResetInterceptor.response?.(ctx, vi.fn(async () => undefined));

        expect(ctx.setCookies).toHaveLength(1);
        expect(ctx.setCookies[0].value).toBe('');
        expect(ctx.setCookies[0].options?.maxAge).toBe(0);
    });

    it('keeps the cookie when the password was refused, so a retry can present it', async () =>
    {
        const ctx = responseContext(COMPLETE_PATH, false, { message: 'password too short' });

        await passwordResetInterceptor.response?.(ctx, vi.fn(async () => undefined));

        expect(ctx.setCookies).toHaveLength(0);
    });
});
