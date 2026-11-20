/**
 * The browser's address across a server-side call (#363)
 *
 * A server component or server action calls the backend through the app's own RPC
 * proxy: a new request from the Next.js server. The call asserts the browser's
 * address to the proxy, keyed with the proxy key; the proxy believes an assertion
 * it verifies and nothing else, and signs the address it forwards.
 *
 * Every row runs the real path: server-side `createApi` → `createRpcProxy` →
 * a backend behind proxy-guard in strict mode, answering what `getClientIp` read.
 * The assertion is signed by core's built `@spfn/core/nextjs/server-call`, which
 * the client loads: rebuild core before a run.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { NextRequest } from 'next/server';

import { createApi } from '../../client/core';
import { createRpcProxy } from '../rpc';
import type { InterceptorRule } from '../interceptors/types';
import { createProxyGuard } from '../../../middleware/proxy-guard';
import { getClientIp } from '../../../middleware/client-ip';
import { parseProxyKey } from '../../../security/proxy-signature';
import { FORWARDED_CLIENT_HEADER, signForwardedClient } from '../../../security/forwarded-client';

const SECRET = 'k1:proxy-secret-for-the-client-address-rows';
const APP = 'http://app.test';
const BACKEND = 'http://backend.test';
const BROWSER = '203.0.113.7';
const NEXT_SERVER = '198.51.100.9';

/** The browser request a server-side call is made for, as `next/headers` answers it. */
const inbound = vi.hoisted(() => ({ forwardedFor: '' }));

vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers({ host: 'app.test', 'x-forwarded-for': inbound.forwardedFor }),
}));

function backend(): Hono
{
    const app = new Hono();

    app.use('*', createProxyGuard({ mode: 'strict', secret: SECRET }));
    app.get('/whoami', c => c.json({ ip: getClientIp(c) }));
    app.get('/whoami/again', c => c.json({ ip: getClientIp(c), again: true }));

    return app;
}

/**
 * The app's proxy in front of `backend()`, and the network between them: a request
 * to the backend origin reaches the backend, anything else the proxy.
 */
function network(interceptors: InterceptorRule[] = [])
{
    const { GET, POST } = createRpcProxy({
        routeMap: {
            whoami: { method: 'GET', path: '/whoami' },
            whoamiToo: { method: 'GET', path: '/whoami' },
        },
        apiUrl: BACKEND,
        proxySecret: SECRET,
        autoDiscoverInterceptors: false,
        interceptors,
    });
    const app = backend();
    const sent: Headers[] = [];

    async function routed(input: string | URL | Request, init?: RequestInit): Promise<Response>
    {
        const request = new Request(input, init);
        const url = new URL(request.url);

        if (url.origin === BACKEND)
        {
            return await app.request(`${url.pathname}${url.search}`, { method: request.method, headers: request.headers });
        }

        sent.push(request.headers);
        const handler = request.method === 'GET' ? GET : POST;

        return await handler(new NextRequest(request), { params: Promise.resolve({ routeName: url.pathname.split('/').pop() }) });
    }

    vi.stubGlobal('fetch', vi.fn(routed));

    return {
        /** What the app's proxy received, in order. */
        sent,
        /** A server component's client. */
        api: createApi<any>({ fetch: routed as typeof fetch }) as any,
        /** The browser calling the proxy itself. */
        async browser(routeName: string, headers: Record<string, string>): Promise<{ ip?: string }>
        {
            const url = `${APP}/api/rpc/${routeName}?input=${encodeURIComponent('{}')}`;

            return await (await routed(url, { headers })).json();
        },
    };
}

function assertion(path: string, clientIp: string, options: { secret?: string; timestamp?: number } = {}): string
{
    return signForwardedClient(
        parseProxyKey(options.secret ?? SECRET),
        { method: 'GET', path },
        clientIp,
        { timestamp: String(options.timestamp ?? Date.now()), nonce: 'n0nce' },
    )!;
}

describe('the browser\'s address across a server-side call', () =>
{
    afterEach(() =>
    {
        inbound.forwardedFor = '';
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    function configure(env: { secret?: string; hops?: string } = {})
    {
        vi.stubEnv('SPFN_APP_URL', '');
        vi.stubEnv('SPFN_PROXY_SECRET', env.secret ?? SECRET);
        vi.stubEnv('TRUSTED_PROXY_HOPS', env.hops ?? '1');
    }

    it('C1: a server-side call made for a browser request reaches the backend with the browser\'s address', async () =>
    {
        configure();
        inbound.forwardedFor = BROWSER;

        expect(await network().api.whoami.call({})).toEqual({ ip: BROWSER });
    });

    it('C2: an assertion a browser forged is ignored; the address its X-Forwarded-For names stands', async () =>
    {
        configure();
        const forged = assertion('/api/rpc/whoami', '192.0.2.66', { secret: 'k1:a-key-the-browser-made-up' });

        expect(await network().browser('whoami', { 'x-forwarded-for': NEXT_SERVER, [FORWARDED_CLIENT_HEADER]: forged }))
            .toEqual({ ip: NEXT_SERVER });
    });

    it('C3: an assertion replayed on another route, or after its window, is ignored', async () =>
    {
        configure();
        const { browser } = network();
        const made = assertion('/api/rpc/whoami', '192.0.2.66');

        // The control: on the call it was made for, it is believed
        expect(await browser('whoami', { 'x-forwarded-for': NEXT_SERVER, [FORWARDED_CLIENT_HEADER]: made }))
            .toEqual({ ip: '192.0.2.66' });
        expect(await browser('whoamiToo', { 'x-forwarded-for': NEXT_SERVER, [FORWARDED_CLIENT_HEADER]: made }))
            .toEqual({ ip: NEXT_SERVER });

        const stale = assertion('/api/rpc/whoami', '192.0.2.66', { timestamp: Date.now() - 31_000 });

        expect(await browser('whoami', { 'x-forwarded-for': NEXT_SERVER, [FORWARDED_CLIENT_HEADER]: stale }))
            .toEqual({ ip: NEXT_SERVER });
    });

    it('C5: without a proxy key a server-side call asserts nothing', async () =>
    {
        configure({ secret: '' });
        inbound.forwardedFor = BROWSER;
        const { api, sent } = network();

        await api.whoami.call({});

        expect(sent).toHaveLength(1);
        expect(sent[0].get(FORWARDED_CLIENT_HEADER)).toBeNull();
    });

    it('C6: behind two trusted hops, a server-side call asserts the entry the proxy reads off the browser\'s own request', async () =>
    {
        configure({ hops: '2' });
        inbound.forwardedFor = `192.0.2.66, ${BROWSER}, 10.0.0.2`;
        const { api, browser } = network();

        expect(await browser('whoami', { 'x-forwarded-for': inbound.forwardedFor })).toEqual({ ip: BROWSER });
        expect(await api.whoami.call({})).toEqual({ ip: BROWSER });
    });

    it('C7: a response interceptor\'s callBackend is signed over the address it forwards', async () =>
    {
        configure();
        const again: InterceptorRule = {
            pathPattern: '/whoami',
            response: async (ctx, next) =>
            {
                ctx.response.body = (await ctx.callBackend!({ path: '/whoami/again' })).body;
                await next();
            },
        };

        expect(await network([again]).browser('whoami', { 'x-forwarded-for': BROWSER }))
            .toEqual({ ip: BROWSER, again: true });
    });
});
