/**
 * @spfn/auth - :provider OAuth Route Tests
 *
 * google 하드코딩이 아닌 generic `:provider` 라우트가
 * 등록된 임의 provider로 url 흐름을 타는지 검증한다 (DB 불필요).
 *
 * 또한 static segment(/providers) > param(:provider) 우선순위가 유지되어
 * google 리터럴/목록 라우트가 generic 라우트에 흡수되지 않는지 확인한다.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { RequestInterceptorContext } from '@spfn/core/nextjs/server';
import { registerRoutes } from '@spfn/core/route';
import { mainAuthRouter } from '@/server/routes';
import { registerOAuthProvider, type OAuthProvider } from '@/server/lib/oauth';
import { oauthUrlInterceptor } from '@/nextjs/interceptors/oauth';

function mockProvider(id: OAuthProvider['id'], enabled = true): OAuthProvider
{
    return {
        id,
        isEnabled: () => enabled,
        getAuthUrl: (state: string) => `https://mock.example.com/${id}/auth?state=${state}`,
        exchangeCodeForTokens: async () => ({ accessToken: 'mock-access', expiresIn: 3600 }),
        getUserInfo: async () => ({ providerUserId: 'mock-id', email: null, emailVerified: false }),
    };
}

describe(':provider OAuth routes', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

        // 외부 패키지가 등록하듯 더미 provider 등록
        registerOAuthProvider(mockProvider('superself', true));
        registerOAuthProvider(mockProvider('naver', false));

        app = new Hono();

        // 프레임워크 onError(statusCode → 응답) 동등 핸들러: ValidationError를 400으로 매핑
        app.onError((err, c) =>
        {
            if ('statusCode' in err && typeof err.statusCode === 'number')
            {
                return c.json({ error: err.message }, err.statusCode as never);
            }

            return c.json({ error: 'Internal Server Error' }, 500);
        });

        registerRoutes(app, mainAuthRouter);
    });

    it('POST /_auth/oauth/:provider/url 가 등록된 provider의 authUrl을 반환한다', async () =>
    {
        const res = await app.request('/_auth/oauth/superself/url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnUrl: '/dashboard', state: 'injected-state' }),
        });

        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.authUrl).toBe('https://mock.example.com/superself/auth?state=injected-state');
    });

    it('POST /_auth/oauth/:provider/url 가 비활성 provider면 400을 반환한다', async () =>
    {
        const res = await app.request('/_auth/oauth/naver/url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnUrl: '/', state: 'injected-state' }),
        });

        expect(res.status).toBe(400);
    });

    /**
     * The start flow as an app actually runs it: the Next.js interceptor seals the
     * caller's returnUrl into the state, the backend route turns that state into an
     * authUrl. A destination that leaves the app has to die at the interceptor —
     * the route only ever sees sealed state and cannot judge it (fxylabs/spfn#89).
     */
    async function startThroughInterceptor(returnUrl: string): Promise<Response>
    {
        const ctx = {
            path: '/_auth/oauth/superself/url',
            body: { returnUrl },
            metadata: {},
        } as unknown as RequestInterceptorContext;

        await oauthUrlInterceptor.request?.(ctx, vi.fn(async () => undefined));

        if (ctx.abort)
        {
            return new Response(JSON.stringify(ctx.abort.body), {
                status: ctx.abort.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return await app.request('/_auth/oauth/superself/url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ctx.body),
        });
    }

    it('start flow: a returnUrl inside the app reaches the provider authUrl', async () =>
    {
        const res = await startThroughInterceptor('/dashboard');

        expect(res.status).toBe(200);
        expect((await res.json()).authUrl).toMatch(/^https:\/\/mock\.example\.com\/superself\/auth\?state=/);
    });

    it.each([
        ['https://evil.com', 'absolute URL'],
        ['//evil.com', 'protocol-relative host'],
        ['/\t/evil.com', 'tab a URL parser strips, leaving //evil.com'],
        ['/..//evil.com', 'traversal ahead of a host'],
    ])('start flow: %j (%s) is refused with 400 and never reaches the provider', async (returnUrl) =>
    {
        const res = await startThroughInterceptor(returnUrl);

        expect(res.status).toBe(400);
        expect((await res.json()).message).toContain('returnUrl');
    });

    it('POST /_auth/oauth/finalize refuses a returnUrl that leaves the app', async () =>
    {
        const res = await app.request('/_auth/oauth/finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '1', keyId: 'key-1', returnUrl: 'https://evil.com' }),
        });

        expect(res.status).toBe(400);
    });

    /**
     * A callback page that forwards `?returnUrl=` verbatim sends the empty string
     * when the query parameter is present but empty. That login worked before the
     * rule existed and still has to: empty means "no destination", answered with
     * the app root, not refused.
     */
    it('POST /_auth/oauth/finalize answers an empty returnUrl with the app root', async () =>
    {
        const res = await app.request('/_auth/oauth/finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '1', keyId: 'key-1', returnUrl: '' }),
        });

        expect(res.status).toBe(200);
        expect((await res.json()).returnUrl).toBe('/');
    });

    it('POST /_auth/oauth/finalize echoes a returnUrl inside the app', async () =>
    {
        const res = await app.request('/_auth/oauth/finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '1', keyId: 'key-1', returnUrl: '/dashboard' }),
        });

        expect(res.status).toBe(200);
        expect((await res.json()).returnUrl).toBe('/dashboard');
    });

    it('GET /_auth/oauth/providers 는 :provider start에 흡수되지 않는다 (static > param)', async () =>
    {
        const res = await app.request('/_auth/oauth/providers');

        // generic GET /_auth/oauth/:provider 가 이겼다면 state 누락으로 검증 실패(400)했을 것.
        // static 우선순위가 보장되면 목록 핸들러가 200으로 응답한다.
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(Array.isArray(data.providers)).toBe(true);
    });
});
