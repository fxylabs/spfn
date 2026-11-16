/**
 * The Next.js proxy as an app mounts it, in front of a backend app in-process.
 *
 * `createRpcProxy` with this package's `authInterceptors` and route map — the
 * request phase, the backend fetch, the response phase and the `Set-Cookie`
 * headers are the production code. `fetch` is replaced for the duration so that
 * a request to the backend base URL is answered by the given Hono app, a request
 * to the app's own `/api/rpc/<route>` (as `createOAuthCallbackHandler` makes) by
 * the proxy, and a backend that is down by a connection refusal. `call` hands
 * its request to the proxy's handler directly.
 */

import { vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Hono } from 'hono';
import { createRpcProxy } from '@spfn/core/nextjs/server';
import type { InterceptorRule, RouteMapEntry } from '@spfn/core/nextjs/server';

import { authInterceptors } from '../../nextjs/interceptors';
import { routeMap as authRouteMap } from '../../generated/route-map';

export const APP_ORIGIN = 'http://app.test';

const BACKEND_ORIGIN = 'http://backend.test';

/** A backend app, or `'down'` for one that refuses the connection. */
export type ProxiedBackend = Pick<Hono, 'request'> | 'down';

export interface MountedProxy
{
    /** Call a route through the proxy the way the isomorphic client does. */
    call(routeName: string, input: Record<string, unknown>, init: { cookie?: string; headers?: Record<string, string>; method?: 'GET' | 'POST' }): Promise<Response>;
    /** Every request the proxy sent to the backend, in order. */
    backendCalls: Array<{ path: string; headers: Headers }>;
}

/**
 * Mount the proxy over `backend`, with `fetch` routed as described above. Undo
 * with `vi.unstubAllGlobals()` and `vi.unstubAllEnvs()`.
 *
 * @param extraRoutes - route-map entries for routes the package does not ship
 * @param options.interceptors - the list an app assembles itself; `authInterceptors` when absent
 * @param options.proxySecret - the proxy-guard key the proxy signs every backend call with
 * @param options.appUnreachable - a request to the app's own origin over the network (rather
 *   than `call`) is refused, as an edge the server cannot call back through refuses it
 */
export function mountProxy(
    backend: ProxiedBackend,
    extraRoutes: Record<string, RouteMapEntry> = {},
    options: { interceptors?: InterceptorRule[]; appUnreachable?: boolean; proxySecret?: string } = {},
): MountedProxy
{
    // Where core's `SPFN_API_URL` says the backend is, so a proxy built with the
    // defaults — the OAuth callback handler's own — reaches the same app as this one
    vi.stubEnv('SPFN_API_URL', BACKEND_ORIGIN);

    const routeMap = { ...authRouteMap, ...extraRoutes };
    const { GET, POST } = createRpcProxy({
        routeMap,
        apiUrl: BACKEND_ORIGIN,
        autoDiscoverInterceptors: false,
        interceptors: options.interceptors ?? authInterceptors,
        proxySecret: options.proxySecret,
    });
    const backendCalls: MountedProxy['backendCalls'] = [];

    async function routed(input: string | URL | Request, init?: RequestInit): Promise<Response>
    {
        const request = new Request(input, init);
        const url = new URL(request.url);

        if (url.origin === BACKEND_ORIGIN)
        {
            backendCalls.push({ path: url.pathname, headers: request.headers });

            if (backend === 'down')
            {
                throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
            }

            return await backend.request(`${url.pathname}${url.search}`, {
                method: request.method,
                headers: request.headers,
                body: request.method === 'GET' ? undefined : await request.text(),
            });
        }

        if (options.appUnreachable)
        {
            throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
        }

        return await toProxy(request);
    }

    async function toProxy(request: Request): Promise<Response>
    {
        const routeName = new URL(request.url).pathname.split('/').pop()!;
        const handler = request.method === 'GET' ? GET : POST;

        return await handler(new NextRequest(request), { params: Promise.resolve({ routeName }) });
    }

    vi.stubGlobal('fetch', vi.fn(routed));

    return {
        backendCalls,
        async call(routeName, input, init)
        {
            const method = init.method ?? 'POST';
            const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };

            if (init.cookie)
            {
                headers.cookie = init.cookie;
            }

            const url = method === 'GET'
                ? `${APP_ORIGIN}/api/rpc/${routeName}?input=${encodeURIComponent(JSON.stringify(input))}`
                : `${APP_ORIGIN}/api/rpc/${routeName}`;

            return await toProxy(new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(input) }));
        },
    };
}
