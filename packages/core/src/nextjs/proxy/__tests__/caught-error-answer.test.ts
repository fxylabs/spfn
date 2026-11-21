/**
 * The proxy's own failure answers carry a fixed sentence, never a caught
 * error's text (#382)
 *
 * The 502 (the backend call or a response interceptor threw) and the 500 (a
 * request interceptor threw) are answers to the browser; the error is logged
 * by the proxy and stays out of the body. A development proxy (`debug`) adds
 * the error's description — the log line's value — and never its message or
 * stack: the stack's first line is the message, and for a failed statement it
 * holds the bound values.
 *
 * | Row | Catches |
 * |-----|---------|
 * | D1 | a `debug` answer that adds a failed statement's raw stack (its SQL and bound values) instead of the description |
 * | D2 | a `debug` answer that adds a fetch error's raw stack or message (an internal host) instead of the description |
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { describeError } from '@spfn/core/logger';
import { createRpcProxy } from '../rpc';
import { expectNoValues, failedInsert } from '../../../logger/__tests__/helpers/leak-probe';

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

    it('D1: a database error thrown by an interceptor under debug answers its description, no stack, no value', async () =>
    {
        const thrown = failedInsert();
        vi.stubGlobal('fetch', vi.fn());
        const proxy = createRpcProxy({
            routeMap,
            apiUrl: 'http://backend.test',
            autoDiscoverInterceptors: false,
            debug: true,
            interceptors: [{
                pathPattern: '*',
                request: async () =>
                {
                    throw thrown;
                },
            }],
        });

        const answer = await answerOf(proxy);

        expect(answer.status).toBe(500);
        expect(JSON.parse(answer.text)).toEqual({
            error: 'Internal Server Error',
            message: 'Internal server error',
            description: JSON.parse(JSON.stringify(describeError(thrown))),
        });
        expect(JSON.parse(answer.text).description).toMatchObject({ kind: 'database', code: '23505' });
        expectNoValues(answer.text);
    });

    it('D2: a fetch TypeError naming an internal host under debug answers its description, not its stack', async () =>
    {
        const thrown = new TypeError(SECRET);
        vi.stubGlobal('fetch', vi.fn(async () =>
        {
            throw thrown;
        }));
        const proxy = createRpcProxy({ routeMap, apiUrl: 'http://backend.test', autoDiscoverInterceptors: false, debug: true });

        const answer = await answerOf(proxy);
        const body = JSON.parse(answer.text);

        expect(answer.status).toBe(502);
        expect(body).toEqual({
            error: 'Bad Gateway',
            message: 'Failed to connect to backend',
            description: JSON.parse(JSON.stringify(describeError(thrown))),
        });
        expect(answer.text).not.toContain(`TypeError: ${SECRET}`);
    });
});
