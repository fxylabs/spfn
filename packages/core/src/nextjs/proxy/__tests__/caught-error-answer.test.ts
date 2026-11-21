/**
 * The proxy's own failure answers carry a fixed sentence, never a caught
 * error's text (#382)
 *
 * The 502 (the backend call or a response interceptor threw) and the 500 (a
 * request interceptor threw) are answers to the browser; the error is logged
 * by the proxy and stays out of the body. A development proxy (`debug`) adds
 * the stack, as core's error handler does under `includeStack`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { createRpcProxy } from '../rpc';

const SECRET = 'connect ECONNREFUSED 10.9.8.7:8790 secret-host.internal';
const routeMap = { createOrder: { method: 'POST' as const, path: '/orders' } };

function postRequest(): NextRequest
{
    return new NextRequest('http://localhost:3000/api/rpc/createOrder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: { item: 'x' } }),
    });
}

async function answerOf(proxy: ReturnType<typeof createRpcProxy>): Promise<{ status: number; text: string }>
{
    const response = await proxy.POST(postRequest(), { params: Promise.resolve({ routeName: 'createOrder' }) });

    return { status: response.status, text: await response.text() };
}

describe('rpc proxy - a caught error in its own answer (#382)', () =>
{
    afterEach(() =>
    {
        vi.unstubAllGlobals();
    });

    it('a thrown backend fetch answers 502 with a fixed sentence', async () =>
    {
        vi.stubGlobal('fetch', vi.fn(async () =>
        {
            throw new TypeError(SECRET);
        }));
        const proxy = createRpcProxy({ routeMap, apiUrl: 'http://backend.test', autoDiscoverInterceptors: false, debug: false });

        const answer = await answerOf(proxy);

        expect(answer.status).toBe(502);
        expect(JSON.parse(answer.text)).toEqual({ error: 'Bad Gateway', message: 'Failed to connect to backend' });
    });

    it('a throwing request interceptor answers 500 with a fixed sentence', async () =>
    {
        vi.stubGlobal('fetch', vi.fn());
        const proxy = createRpcProxy({
            routeMap,
            apiUrl: 'http://backend.test',
            autoDiscoverInterceptors: false,
            debug: false,
            interceptors: [{
                pathPattern: '*',
                request: async () =>
                {
                    throw new Error(SECRET);
                },
            }],
        });

        const answer = await answerOf(proxy);

        expect(answer.status).toBe(500);
        expect(JSON.parse(answer.text)).toEqual({ error: 'Internal Server Error', message: 'Internal server error' });
    });
});
