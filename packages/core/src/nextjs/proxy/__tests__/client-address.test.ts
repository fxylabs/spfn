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
import { parseProxyKey, PROXY_CLIENT_IP_HEADER } from '../../../security/proxy-signature';
import { FORWARDED_CLIENT_HEADER, signForwardedClient } from '../../../security/forwarded-client';

const SECRET = 'k1:proxy-secret-for-the-client-address-rows';
const APP = 'http://app.test';
const BACKEND = 'http://backend.test';
const BROWSER = '203.0.113.7';
const NEXT_SERVER = '198.51.100.9';
/** An address a browser that reaches the app directly writes into `X-Forwarded-For` itself. */
const CHOSEN = '203.0.113.9';

/**
 * The browser request a server-side call is made for, as `next/headers` answers it:
 * one headers object for the whole of that request, as Next's request store holds it.
 */
const inbound = vi.hoisted(() => ({ request: new Headers() }));

vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => inbound.request,
}));

/** A new browser request reaching the app, from the address `forwardedFor` names. */
function browserRequest(forwardedFor: string): void
{
    inbound.request = new Headers({ host: 'app.test', 'x-forwarded-for': forwardedFor });
}

/** Lets the clock move on, so a fresh signature would differ from the last one. */
async function tick(): Promise<void>
{
    await new Promise(resolve => setTimeout(resolve, 5));
}

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
 * to the backend origin reaches the backend over a connection from the Next.js
 * server, anything else the proxy.
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
    const received: Headers[] = [];

    async function routed(input: string | URL | Request, init?: RequestInit): Promise<Response>
    {
        const request = new Request(input, init);
        const url = new URL(request.url);

        if (url.origin === BACKEND)
        {
            received.push(request.headers);
            const connection = { incoming: { socket: { remoteAddress: NEXT_SERVER } } };

            return await app.request(`${url.pathname}${url.search}`, { method: request.method, headers: request.headers }, connection);
        }

        sent.push(request.headers);
        const handler = request.method === 'GET' ? GET : POST;

        return await handler(new NextRequest(request), { params: Promise.resolve({ routeName: url.pathname.split('/').pop() }) });
    }

    vi.stubGlobal('fetch', vi.fn(routed));

    return {
        /** What the app's proxy received, in order. */
        sent,
        /** What the backend received from the proxy, in order. */
        received,
        /** A server component's client. */
        api: createApi<any>({ fetch: routed as typeof fetch }) as any,
        /** The browser calling the proxy itself. */
        async browser(routeName: string, headers: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<{ ip?: string }>
        {
            const url = method === 'GET'
                ? `${APP}/api/rpc/${routeName}?input=${encodeURIComponent('{}')}`
                : `${APP}/api/rpc/${routeName}`;
            const body = method === 'POST' ? '{}' : undefined;

            return await (await routed(url, { method, body, headers: { 'content-type': 'application/json', ...headers } })).json();
        },
    };
}

function assertion(path: string, clientIp: string, options: { secret?: string; timestamp?: number } = {}): string
{
    return signForwardedClient(parseProxyKey(options.secret ?? SECRET), { method: 'GET', path }, clientIp, options.timestamp)!;
}

describe('the browser\'s address across a server-side call', () =>
{
    afterEach(() =>
    {
        browserRequest('');
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
        browserRequest(BROWSER);

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
        browserRequest(BROWSER);
        const { api, sent } = network();

        await api.whoami.call({});

        expect(sent).toHaveLength(1);
        expect(sent[0].get(FORWARDED_CLIENT_HEADER)).toBeNull();
    });

    it('C6: behind two trusted hops, a server-side call asserts the entry the proxy reads off the browser\'s own request', async () =>
    {
        configure({ hops: '2' });
        const forwardedFor = `192.0.2.66, ${BROWSER}, 10.0.0.2`;
        browserRequest(forwardedFor);
        const { api, browser } = network();

        expect(await browser('whoami', { 'x-forwarded-for': forwardedFor })).toEqual({ ip: BROWSER });
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

    it('C9: two identical calls in one inbound request send the same assertion, byte for byte, so Next can dedupe them', async () =>
    {
        configure();
        browserRequest(BROWSER);
        const { api, sent } = network();

        await api.whoami.call({});
        await tick();
        await api.whoami.call({});

        expect(sent[0].get(FORWARDED_CLIENT_HEADER)).toMatch(new RegExp(`^${BROWSER};\\d+;[0-9a-f]{64}$`));
        expect(sent[1].get(FORWARDED_CLIENT_HEADER)).toBe(sent[0].get(FORWARDED_CLIENT_HEADER));
    });

    it('C10: two inbound requests get their own assertions, never one another\'s', async () =>
    {
        configure();
        const { api, sent } = network();

        browserRequest(BROWSER);
        await api.whoami.call({});
        await tick();
        browserRequest(BROWSER);
        await api.whoami.call({});
        browserRequest('192.0.2.66');

        expect(await api.whoami.call({})).toEqual({ ip: '192.0.2.66' });
        expect(sent[1].get(FORWARDED_CLIENT_HEADER)).not.toBe(sent[0].get(FORWARDED_CLIENT_HEADER));
    });

    it('C11: a call cached across requests asserts no address; one that is not cached does', async () =>
    {
        configure();
        browserRequest(BROWSER);
        const { api, sent } = network();

        expect(await api.whoami.fetchOptions({ next: { revalidate: 60 } }).call({})).not.toEqual({ ip: BROWSER });
        await api.whoami.fetchOptions({ next: { tags: ['who'] } }).call({});
        await api.whoami.fetchOptions({ next: { revalidate: false } }).call({});
        await api.whoami.fetchOptions({ cache: 'force-cache' }).call({});
        expect(sent.map(headers => headers.get(FORWARDED_CLIENT_HEADER))).toEqual([null, null, null, null]);

        // The controls: not cached, so the call is this browser's
        expect(await api.whoami.fetchOptions({ next: { revalidate: 0 } }).call({})).toEqual({ ip: BROWSER });
        expect(await api.whoami.fetchOptions({ cache: 'no-store', next: { tags: ['who'] } }).call({})).toEqual({ ip: BROWSER });
    });

    it('C12: an assertion made after half its window is signed again, so a long request\'s late call still verifies', async () =>
    {
        configure();
        browserRequest(BROWSER);
        const { api, sent } = network();
        const start = Date.now();
        const clock = vi.spyOn(Date, 'now');

        clock.mockReturnValue(start);
        await api.whoami.call({});
        clock.mockReturnValue(start + 31_000);
        const late = await api.whoami.call({});
        clock.mockRestore();

        expect(late).toEqual({ ip: BROWSER });
        expect(sent[1].get(FORWARDED_CLIENT_HEADER)).not.toBe(sent[0].get(FORWARDED_CLIENT_HEADER));
    });

    it('C13: the method is signed: a GET assertion replayed as a POST on the same path is ignored', async () =>
    {
        configure();
        const { browser } = network();
        const made = assertion('/api/rpc/whoami', '192.0.2.66');

        // The control: as the GET it was made for, it is believed
        expect(await browser('whoami', { 'x-forwarded-for': NEXT_SERVER, [FORWARDED_CLIENT_HEADER]: made }))
            .toEqual({ ip: '192.0.2.66' });
        expect(await browser('whoami', { 'x-forwarded-for': NEXT_SERVER, [FORWARDED_CLIENT_HEADER]: made }, 'POST'))
            .toEqual({ ip: NEXT_SERVER });
    });

    it('C14: with nothing in front (TRUSTED_PROXY_HOPS=0), the proxy forwards no address out of a browser-written X-Forwarded-For', async () =>
    {
        configure({ hops: '0' });
        const { browser, received } = network();

        await browser('whoami', { 'x-forwarded-for': CHOSEN });

        expect(received).toHaveLength(1);
        expect(received[0].get(PROXY_CLIENT_IP_HEADER)).toBeNull();
    });

    it('C15: with TRUSTED_PROXY_HOPS=0, a server-side call asserts no address', async () =>
    {
        configure({ hops: '0' });
        browserRequest(CHOSEN);
        const { api, sent } = network();

        await api.whoami.call({});

        expect(sent).toHaveLength(1);
        expect(sent[0].get(FORWARDED_CLIENT_HEADER)).toBeNull();
    });

    it('C16: a signed request with no address is served, and getClientIp answers the backend\'s own rule: the Next.js server, never the browser\'s X-Forwarded-For', async () =>
    {
        configure({ hops: '0' });
        const { browser } = network();

        for (const serverHops of ['0', '1'])
        {
            vi.stubEnv('SERVER_TRUSTED_PROXY_HOPS', serverHops);

            expect(await browser('whoami', { 'x-forwarded-for': CHOSEN })).toEqual({ ip: NEXT_SERVER });
        }
    });

    it('C17: a TRUSTED_PROXY_HOPS that is not a whole number of 0 or more is refused, not read as 1', async () =>
    {
        for (const hops of ['-1', '1.5', 'one'])
        {
            configure({ hops });
            browserRequest(BROWSER);
            const { api, browser, received } = network();

            expect(await browser('whoami', { 'x-forwarded-for': CHOSEN })).not.toHaveProperty('ip');
            await expect(api.whoami.call({})).rejects.toThrow('Environment validation failed');
            expect(received).toHaveLength(0);
        }
    });
});
