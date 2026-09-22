/**
 * A response interceptor's throw reaches the caller unchanged (issue #104)
 *
 * The interceptors used to run inside the `try` that wraps `fetch`, whose `catch`
 * tells apart only `AbortError` and calls everything else a network failure. Next.js
 * implements `redirect()` and `notFound()` by throwing an error carrying a `digest`,
 * so the pattern the scaffold's own `api-client.ts` suggests —
 * `if (response.status === 401) redirect('/login')` — never navigated: the caller got
 * `ApiError(..., 0, ..., 'network')` for a transport failure that did not happen, and
 * retry and offline handling keyed on that type acted on it.
 *
 * The `try` still classifies what it exists to classify — the fetch and the response
 * body parse — and those regressions are pinned below alongside the fix.
 *
 * 🔗 src/nextjs/client/core.ts (executeCall)
 */

import { describe, it, expect, vi } from 'vitest';

import { createApi } from '../core';
import { ApiError } from '../errors';

vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers({ host: 'app.test' }),
}));

/** A fetch that answers every call with the given JSON body and status. */
function respondWith(body: unknown, status = 200): typeof fetch
{
    return (async () => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** An interceptor that does nothing but throw, which is how `redirect()` and `notFound()` behave. */
function throwing(error: Error): () => never
{
    return () =>
    {
        throw error;
    };
}

/** The error `redirect()` throws: an ordinary Error carrying a Next.js digest. */
function redirectError(): Error & { digest: string }
{
    const error = new Error('NEXT_REDIRECT') as Error & { digest: string };
    error.digest = 'NEXT_REDIRECT;replace;/login;307;';

    return error;
}

describe('api client - an interceptor that throws', () =>
{
    it('lets a NEXT_REDIRECT digest through, so redirect() navigates', async () =>
    {
        const thrown = redirectError();

        // Written `async`, which is the shape the scaffold's template suggests: the
        // rejected promise the interceptor returns has to survive the `await` too.
        const api = createApi<any>({
            fetch: respondWith({ error: 'unauthorized' }, 401),
            onResponse: async () =>
            {
                throw thrown;
            },
        }) as any;

        const caught = await api.getUser.call({}).catch((error: unknown) => error);

        expect(caught).toBe(thrown);
        expect((caught as any).digest).toBe('NEXT_REDIRECT;replace;/login;307;');
    });

    it('lets a plain Error through instead of relabelling it a network failure', async () =>
    {
        const thrown = new Error('session expired');

        const api = createApi<any>({
            fetch: respondWith({ ok: true }),
            onResponse: throwing(thrown),
        }) as any;

        const caught = await api.getUser.call({}).catch((error: unknown) => error);

        expect(caught).toBe(thrown);
        expect(caught).not.toBeInstanceOf(ApiError);
    });

    it('lets a per-call interceptor through too', async () =>
    {
        const thrown = redirectError();

        const api = createApi<any>({ fetch: respondWith({ ok: true }) }) as any;

        const caught = await api.getUser
            .onResponse(throwing(thrown))
            .call({})
            .catch((error: unknown) => error);

        expect(caught).toBe(thrown);
    });

    it('is not swallowed by the error-status handling further down', async () =>
    {
        // A 401 is the case the scaffold's example is written for. The interceptor
        // runs before `handleErrorResponse`, so its throw is what the caller sees —
        // not the ApiError the status would otherwise produce.
        const thrown = redirectError();

        const api = createApi<any>({
            fetch: respondWith({ message: 'unauthorized' }, 401),
            onResponse: throwing(thrown),
        }) as any;

        await expect(api.getUser.call({})).rejects.toBe(thrown);
    });

    it('gives the caller the throw, not a replacement made before it', async () =>
    {
        // The global interceptor replaces the body and the per-call one then
        // navigates. The throw wins: nothing downstream of it runs, so the caller
        // never sees the half-applied replacement.
        const thrown = redirectError();

        const api = createApi<any>({
            fetch: respondWith({ from: 'server' }),
            onResponse: (response: Response) => ({ response, body: { from: 'interceptor' } }),
        }) as any;

        const caught = await api.getUser
            .onResponse(throwing(thrown))
            .call({})
            .catch((error: unknown) => error);

        expect(caught).toBe(thrown);
    });
});

describe('api client - what the try/catch still classifies', () =>
{
    it('calls a failed fetch a network error', async () =>
    {
        const api = createApi<any>({
            fetch: throwing(new TypeError('fetch failed')) as unknown as typeof fetch,
        }) as any;

        const caught = await api.getUser.call({}).catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).errorType).toBe('network');
        expect((caught as ApiError).status).toBe(0);
    });

    it('calls an aborted request a timeout', async () =>
    {
        const api = createApi<any>({
            timeout: 5,
            fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) =>
            {
                init.signal?.addEventListener('abort', () =>
                {
                    const error = new Error('The operation was aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            })) as unknown as typeof fetch,
        }) as any;

        const caught = await api.getUser.call({}).catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).errorType).toBe('timeout');
        expect((caught as ApiError).status).toBe(408);
    });

    it('still calls a malformed body a network error', async () =>
    {
        // `parseResponseBody` stays inside the `try`. A body that is not the JSON its
        // content-type claims is arguably not a network fault either, but moving that
        // is a different change; this pins that it did not move.
        const api = createApi<any>({
            fetch: (async () => new Response('not json', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })) as unknown as typeof fetch,
        }) as any;

        const caught = await api.getUser.call({}).catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).errorType).toBe('network');
    });
});

describe('api client - an interceptor that replaces the response', () =>
{
    it('hands the caller the replacement body', async () =>
    {
        const api = createApi<any>({
            fetch: respondWith({ from: 'server' }),
            onResponse: (response: Response) => ({ response, body: { from: 'interceptor' } }),
        }) as any;

        await expect(api.getUser.call({})).resolves.toEqual({ from: 'interceptor' });
    });

    it('lets a replaced response decide the error-status handling', async () =>
    {
        // The reassignment has to reach `if (!response.ok)`, which is the only reader
        // of `response` after the block. An interceptor that turns a 500 into a 200
        // therefore resolves instead of throwing.
        const api = createApi<any>({
            fetch: respondWith({ message: 'boom' }, 500),
            onResponse: () => ({ response: new Response(null, { status: 200 }), body: { recovered: true } }),
        }) as any;

        await expect(api.getUser.call({})).resolves.toEqual({ recovered: true });
    });

    it('runs the global interceptor before the per-call one', async () =>
    {
        const order: string[] = [];

        const api = createApi<any>({
            fetch: respondWith({ ok: true }),
            onResponse: (response: Response, body: any) =>
            {
                order.push('global');

                return { response, body };
            },
        }) as any;

        await api.getUser
            .onResponse((response: Response, body: any) =>
            {
                order.push('call');

                return { response, body };
            })
            .call({});

        expect(order).toEqual(['global', 'call']);
    });
});
