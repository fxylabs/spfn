/**
 * Per-call timeout and caller abort (fxylabs/spfn#125)
 *
 * `CallOptions.timeout` was declared but never applied, the builder had no way to set
 * it, and `executeFetchWithTimeout` replaced the caller's signal with its own — so a
 * signal from `.fetchOptions({ signal })` or an `onRequest` interceptor was dropped,
 * and any abort that did reach the catch read as a timeout because it was classified
 * by `error.name`.
 *
 * Each `it` is one row of the issue's case table. The fake server honours its signal
 * the way real fetch does — the pending fetch rejects with the signal's reason, and so
 * does a body read in progress — otherwise every abort row would pass vacuously.
 *
 * 🔗 src/nextjs/client/helpers.ts (fetchInAbortScope)
 * 🔗 src/nextjs/client/core.ts (executeCall, transportError)
 * 🔗 src/nextjs/client/builder.ts (RouteCallBuilder.timeout)
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { Type } from '@sinclair/typebox';

import { defineRouter, route } from '../../../route';
import { createApi } from '../core';
import { ApiError } from '../errors';
import { RouteCallBuilder } from '../builder';
import type { RouteClient } from '../builder';

vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers({ host: 'app.test' }),
}));

/** A server the test drives by hand: headers first, then the body. */
interface FakeServer
{
    fetch: Mock;
    sendHeaders(): void;
    sendBody(body: unknown): void;
}

/**
 * A fetch that answers only when told to, and that honours its signal as real fetch
 * does: an abort rejects a pending fetch and errors a body still being read, both with
 * the signal's reason.
 */
function fakeServer(): FakeServer
{
    let answer: (response: Response) => void = () => undefined;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;

    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) =>
    {
        const signal = init.signal!;

        signal.addEventListener('abort', () =>
        {
            reject(signal.reason);
            stream?.error(signal.reason);
        });
        answer = resolve;
    }));

    const body = new ReadableStream<Uint8Array>({
        start: (controller) =>
        {
            stream = controller;
        },
    });

    return {
        fetch,
        sendHeaders: () => answer(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })),
        sendBody: (body) =>
        {
            stream!.enqueue(new TextEncoder().encode(JSON.stringify(body)));
            stream!.close();
        },
    };
}

/** Start a call and capture its outcome, so a rejection is never left unhandled. */
function settle(call: Promise<unknown>): Promise<unknown>
{
    return call.catch((error: unknown) => error);
}

/**
 * Wait until the call has reached `fetch` — cookie detection and interceptors run first.
 * Yields with `setImmediate`, which is not faked: `vi.waitFor` would advance the fake
 * clock by its polling interval and fire the very timers under test.
 */
async function untilFetched(server: FakeServer): Promise<void>
{
    const deadline = performance.now() + 2000;

    while (server.fetch.mock.calls.length === 0 && performance.now() < deadline)
    {
        await new Promise(resolve => setImmediate(resolve));
    }

    expect(server.fetch).toHaveBeenCalledTimes(1);
}

/** Let the body stream deliver what was enqueued, and the call resolve. */
async function drain(): Promise<void>
{
    for (let i = 0; i < 10; i++)
    {
        await Promise.resolve();
    }
}

function expectApiError(caught: unknown, errorType: ApiError['errorType'], status: number): ApiError
{
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).errorType).toBe(errorType);
    expect((caught as ApiError).status).toBe(status);

    return caught as ApiError;
}

beforeEach(() =>
{
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() =>
{
    vi.useRealTimers();
});

describe('api client - per-call timeout', () =>
{
    it('row 1: a call with neither option returns the body as before', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.call({}));
        await untilFetched(server);
        server.sendHeaders();
        server.sendBody({ id: '1' });

        await expect(outcome).resolves.toEqual({ id: '1' });
    });

    it('row 2: the client-wide timeout elapsing is a 408 timeout naming that value', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ timeout: 30, fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.call({}));
        await untilFetched(server);
        vi.advanceTimersByTime(30);

        const error = expectApiError(await outcome, 'timeout', 408);
        expect(error.message).toBe('Request timeout after 30ms');
    });

    it('row 3: a per-call timeout of 50 fires at 50 ms, not before', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ timeout: 10_000, fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.timeout(50).call({}));
        await untilFetched(server);

        vi.advanceTimersByTime(49);
        expect(server.fetch.mock.calls[0][1].signal.aborted).toBe(false);

        vi.advanceTimersByTime(1);
        const error = expectApiError(await outcome, 'timeout', 408);
        expect(error.message).toBe('Request timeout after 50ms');
    });

    it('row 4: a per-call timeout wins over a shorter client-wide one', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ timeout: 10, fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.timeout(50).call({}));
        await untilFetched(server);

        // Past the client-wide 10 ms: that timer must not be the one running.
        vi.advanceTimersByTime(20);
        expect(server.fetch.mock.calls[0][1].signal.aborted).toBe(false);

        server.sendHeaders();
        server.sendBody({ ok: true });

        await expect(outcome).resolves.toEqual({ ok: true });
    });
});

describe('api client - caller abort', () =>
{
    it('row 5: an already aborted signal rejects as aborted without calling fetch', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;
        const reason = new Error('gone already');

        const caught = await settle(api.getUser.fetchOptions({ signal: AbortSignal.abort(reason) }).call({}));

        expect(expectApiError(caught, 'aborted', 0).cause).toBe(reason);
        expect(server.fetch).toHaveBeenCalledTimes(0);
    });

    it('row 6: an abort before headers is aborted with the signal reason as cause', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;
        const caller = new AbortController();
        const reason = new Error('user navigated away');

        const outcome = settle(api.getUser.fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);
        caller.abort(reason);

        const error = expectApiError(await outcome, 'aborted', 0);
        expect(error.cause).toBe(reason);
        expect(error.errorType).not.toBe('timeout');
        expect(error.errorType).not.toBe('network');
    });

    it('row 7: an abort while the body is being read is aborted', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;
        const caller = new AbortController();

        const outcome = settle(api.getUser.fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);
        server.sendHeaders();
        await drain();
        caller.abort();

        expectApiError(await outcome, 'aborted', 0);
    });

    it('row 8: a caller abort after the timer fired is still a timeout', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;
        const caller = new AbortController();

        const outcome = settle(api.getUser.timeout(50).fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);

        // Both fire before the rejection settles: the first one is the cause.
        vi.advanceTimersByTime(50);
        caller.abort();

        const error = expectApiError(await outcome, 'timeout', 408);
        expect(error.errorType).not.toBe('aborted');
    });

    it('row 9: a caller abort before the timer is aborted', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;
        const caller = new AbortController();

        const outcome = settle(api.getUser.timeout(50).fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);

        vi.advanceTimersByTime(49);
        caller.abort();
        vi.advanceTimersByTime(1);

        const error = expectApiError(await outcome, 'aborted', 0);
        expect(error.errorType).not.toBe('timeout');
    });

    it('row 10: a signal that never aborts keeps no listener of ours and no timer', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;
        const caller = new AbortController();
        const added = vi.spyOn(caller.signal, 'addEventListener');
        const removed = vi.spyOn(caller.signal, 'removeEventListener');

        const outcome = settle(api.getUser.fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);
        server.sendHeaders();
        server.sendBody({ ok: true });

        await expect(outcome).resolves.toEqual({ ok: true });
        expect(added).toHaveBeenCalledTimes(1);
        expect(added.mock.calls[0][0]).toBe('abort');
        expect(removed).toHaveBeenCalledTimes(1);
        expect(removed.mock.calls[0].slice(0, 2)).toEqual(added.mock.calls[0].slice(0, 2));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('row 11: a signal injected by an onRequest interceptor is honoured', async () =>
    {
        const server = fakeServer();
        const caller = new AbortController();
        const api = createApi<any>({
            fetch: server.fetch as unknown as typeof fetch,
            onRequest: (_url: string, init: RequestInit) => ({ ...init, signal: caller.signal }),
        }) as any;

        const outcome = settle(api.getUser.call({}));
        await untilFetched(server);
        caller.abort();

        expectApiError(await outcome, 'aborted', 0);
    });

    it('row 16: a caller abort after headers wins even when the body ignores the signal', async () =>
    {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
            start: (c) =>
            {
                controller = c;
            },
        });

        const unresponsiveFetch = vi.fn(async () => new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const server: FakeServer = {
            fetch: unresponsiveFetch as unknown as Mock,
            sendHeaders: () => undefined,
            sendBody: () => undefined,
        };

        const caller = new AbortController();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);
        await drain();

        caller.abort();
        controller!.enqueue(new TextEncoder().encode(JSON.stringify({ id: '1' })));
        controller!.close();

        expectApiError(await outcome, 'aborted', 0);
    });
});

describe('api client - failures and validation', () =>
{
    it('row 12: a rejected fetch is a network error and leaves no timer pending', async () =>
    {
        const failing = vi.fn(async () =>
        {
            throw new TypeError('fetch failed');
        });
        const api = createApi<any>({ fetch: failing as unknown as typeof fetch }) as any;

        const caught = await settle(api.getUser.call({}));

        expectApiError(caught, 'network', 0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('row 13: .timeout() of 0, -1, NaN, Infinity or 2147483648 throws a TypeError; the bounds are inclusive', () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;

        for (const value of [0, -1, NaN, Infinity, 2147483648])
        {
            expect(() => api.getUser.timeout(value)).toThrow(TypeError);
            expect(() => api.getUser.timeout(value)).toThrow(`got ${value}`);
        }

        expect(api.getUser.timeout(2147483647)).toBeInstanceOf(RouteCallBuilder);
        expect(api.getUser.timeout(1)).toBeInstanceOf(RouteCallBuilder);
    });

    it('row 14: the timer stops at headers, so a body arriving after it succeeds', async () =>
    {
        const server = fakeServer();
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.timeout(50).call({}));
        await untilFetched(server);
        vi.advanceTimersByTime(10);
        server.sendHeaders();
        await drain();

        vi.advanceTimersByTime(100);
        server.sendBody({ late: true });

        await expect(outcome).resolves.toEqual({ late: true });
    });

    it('row 15: an uncaused AbortError from a custom fetch stays a timeout; a plain TypeError stays network', async () =>
    {
        const abortingFetch = async () =>
        {
            throw new DOMException('x', 'AbortError');
        };
        const abortingApi = createApi<any>({ fetch: abortingFetch as unknown as typeof fetch }) as any;

        expectApiError(await settle(abortingApi.getUser.call({})), 'timeout', 408);

        const failingFetch = async () =>
        {
            throw new TypeError('x');
        };
        const failingApi = createApi<any>({ fetch: failingFetch as unknown as typeof fetch }) as any;

        expectApiError(await settle(failingApi.getUser.call({})), 'network', 0);
    });
});

describe('api client - listener cleanup on failure', () =>
{
    it('row 17a: a timeout removes the caller listener and leaves no timer', async () =>
    {
        const server = fakeServer();
        const caller = new AbortController();
        const added = vi.spyOn(caller.signal, 'addEventListener');
        const removed = vi.spyOn(caller.signal, 'removeEventListener');
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.timeout(50).fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);
        vi.advanceTimersByTime(50);

        expectApiError(await outcome, 'timeout', 408);
        expect(removed).toHaveBeenCalledTimes(1);
        expect(removed.mock.calls[0].slice(0, 2)).toEqual(added.mock.calls[0].slice(0, 2));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('row 17b: a caller abort removes the listener and leaves no timer', async () =>
    {
        const server = fakeServer();
        const caller = new AbortController();
        const added = vi.spyOn(caller.signal, 'addEventListener');
        const removed = vi.spyOn(caller.signal, 'removeEventListener');
        const api = createApi<any>({ fetch: server.fetch as unknown as typeof fetch }) as any;

        const outcome = settle(api.getUser.fetchOptions({ signal: caller.signal }).call({}));
        await untilFetched(server);
        caller.abort();

        expectApiError(await outcome, 'aborted', 0);
        expect(removed).toHaveBeenCalledTimes(1);
        expect(removed.mock.calls[0].slice(0, 2)).toEqual(added.mock.calls[0].slice(0, 2));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('row 17c: a network rejection removes the listener and leaves no timer', async () =>
    {
        const caller = new AbortController();
        const added = vi.spyOn(caller.signal, 'addEventListener');
        const removed = vi.spyOn(caller.signal, 'removeEventListener');
        const failing = vi.fn(async () =>
        {
            throw new TypeError('fetch failed');
        });
        const api = createApi<any>({ fetch: failing as unknown as typeof fetch }) as any;

        const caught = await settle(api.getUser.fetchOptions({ signal: caller.signal }).call({}));

        expectApiError(caught, 'network', 0);
        expect(removed).toHaveBeenCalledTimes(1);
        expect(removed.mock.calls[0].slice(0, 2)).toEqual(added.mock.calls[0].slice(0, 2));
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('api client - .timeout() type', () =>
{
    const getUser = route.get('/users/:id')
        .input({ params: Type.Object({ id: Type.String() }) })
        .handler(async (): Promise<{ id: string }> => ({ id: '1' }));

    const appRouter = defineRouter({ getUser });

    it('returns the same RouteClient, chainable into .call', () =>
    {
        const api = createApi<typeof appRouter>({ fetch: fakeServer().fetch as unknown as typeof fetch });

        expectTypeOf(api.getUser.timeout(1000)).toEqualTypeOf<RouteClient<typeof getUser>>();
        expectTypeOf(api.getUser.timeout(1000).call).returns.toEqualTypeOf<Promise<{ id: string }>>();
    });
});
