/**
 * `createApi({ onOutcome })` — one observer for how every call ended (fxylabs/spfn#146)
 *
 * `onRequest` / `onResponse` never run for a call that got no answer, so an app had no
 * single place to learn how its calls ended. Each `it` is one row of the case table:
 *
 * | #  | situation                                   | observer receives                                    | call result                 |
 * |----|---------------------------------------------|------------------------------------------------------|-----------------------------|
 * | 1  | 200 with a body                             | ok: true, response/body as onResponse left them      | body returned               |
 * | 2  | 401 / 404 with a registered `__type` body   | 'http', that status, error toBe the thrown instance  | that error thrown           |
 * | 3  | 403 / 500 with no `__type`                  | 'http', that status, error toBe the thrown ApiError  | that ApiError thrown        |
 * | 4  | fetch rejects with TypeError                | 'network', status 0, error toBe the thrown ApiError  | thrown                      |
 * | 5  | timeout                                     | 'timeout', status 408                                | thrown                      |
 * | 6  | caller abort                                | 'aborted', status 0                                  | thrown                      |
 * | 7  | onRequest throws                            | not called                                           | the interceptor's error     |
 * | 8  | onResponse throws                           | not called                                           | the interceptor's error     |
 * | 9  | observer throws on a successful call        | one apiLogger.error                                  | body returned unchanged     |
 * | 10 | observer throws on a failed call            | one apiLogger.error                                  | the original error thrown   |
 * | 11 | async observer rejects                      | one logged error, no unhandledRejection              | unchanged                   |
 * | 12 | every call of rows 1–6                      | called exactly once                                  | —                           |
 * | 13 | onOutcome unset                             | —                                                    | unchanged                   |
 * | T1 | types                                       | narrowing on ok / errorType                          | —                           |
 *
 * 🔗 src/nextjs/client/core.ts (executeCall, notifyOutcome, transportError)
 * 🔗 src/nextjs/client/helpers.ts (errorFromResponse)
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { NotFoundError, UnauthorizedError } from '@spfn/core/errors';
import { logger } from '@spfn/core/logger';

import { createApi } from '../core';
import { ApiError } from '../errors';
import type { ApiConfig, ApiOutcome } from '../types';

vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});

vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers({ host: 'app.test' }),
}));

type Observer = Mock<(outcome: ApiOutcome) => void>;

/** A fetch that answers every call with the given JSON body and status. */
function respondWith(body: unknown, status = 200): typeof fetch
{
    return (async () => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** A fetch that never answers, and rejects with its signal's reason once aborted, as real fetch does. */
function hangingFetch(onCalled: () => void = () => undefined): typeof fetch
{
    return ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) =>
    {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        onCalled();
    })) as unknown as typeof fetch;
}

function clientWith(fetchImpl: typeof fetch, onOutcome?: ApiConfig['onOutcome'], extra: ApiConfig = {}): any
{
    return createApi<any>({ fetch: fetchImpl, onOutcome, ...extra });
}

/** Capture how a call ended, so a rejection is never left unhandled. */
function settle(call: Promise<unknown>): Promise<unknown>
{
    return call.catch((error: unknown) => error);
}

/** Let detached promise chains — the observer's `.catch` among them — run to the end. */
async function flush(): Promise<void>
{
    for (let i = 0; i < 3; i++)
    {
        await new Promise(resolve => setImmediate(resolve));
    }
}

/** The `apiLogger.error` lines the observer guard wrote. */
function observerFailureLogs(): unknown[][]
{
    return (logger.error as Mock).mock.calls.filter(([message]) => String(message).includes('onOutcome'));
}

function firstOutcome(observer: Observer): ApiOutcome
{
    return observer.mock.calls[0][0];
}

const rewrittenResponse = new Response(null, { status: 200 });

/** Each call of rows 1–6, run against the given observer and settled. */
const callsThatReachFetch: Record<string, (onOutcome: Observer) => Promise<unknown>> = {
    'row 1: 200': onOutcome => settle(clientWith(respondWith({ id: '1' }), onOutcome, {
        onResponse: (_response, body) => ({ response: rewrittenResponse, body: { ...body, seen: true } }),
    }).getUser.call({})),
    'row 2: 401 UnauthorizedError': onOutcome => settle(clientWith(
        respondWith({ __type: 'UnauthorizedError', message: 'session ended' }, 401), onOutcome,
    ).getUser.call({})),
    'row 2: 404 NotFoundError': onOutcome => settle(clientWith(
        respondWith({ __type: 'NotFoundError', message: 'no such user' }, 404), onOutcome,
    ).getUser.call({})),
    'row 3: 403 no __type': onOutcome => settle(clientWith(
        respondWith({ message: 'forbidden' }, 403), onOutcome,
    ).getUser.call({})),
    'row 3: 500 no __type': onOutcome => settle(clientWith(
        respondWith({ message: 'boom' }, 500), onOutcome,
    ).getUser.call({})),
    'row 4: network': onOutcome => settle(clientWith((async () =>
    {
        throw new TypeError('fetch failed');
    }) as unknown as typeof fetch, onOutcome).getUser.call({})),
    'row 5: timeout': onOutcome => settle(clientWith(hangingFetch(), onOutcome, { timeout: 5 }).getUser.call({})),
    'row 6: caller abort': (onOutcome) =>
    {
        const caller = new AbortController();
        const api = clientWith(hangingFetch(() => queueMicrotask(() => caller.abort('superseded'))), onOutcome);

        return settle(api.getUser.fetchOptions({ signal: caller.signal }).call({}));
    },
};

/** Run one call of rows 1–6 and return what the call produced and what the observer saw. */
async function observe(row: string): Promise<{ result: unknown; outcome: ApiOutcome; observer: Observer }>
{
    const observer: Observer = vi.fn();
    const result = await callsThatReachFetch[row](observer);

    return { result, outcome: firstOutcome(observer), observer };
}

beforeEach(() =>
{
    vi.clearAllMocks();
});

describe('createApi onOutcome - answers', () =>
{
    it('row 1: a 200 is observed with the response and body onResponse left, and the body is returned', async () =>
    {
        const { result, outcome } = await observe('row 1: 200');

        expect(result).toEqual({ id: '1', seen: true });
        expect(outcome).toEqual({ ok: true, response: rewrittenResponse, body: { id: '1', seen: true } });
        expect((outcome as { response: Response }).response).toBe(rewrittenResponse);
        expect((outcome as { body: unknown }).body).toBe(result);
    });

    it('row 2: a registered __type is observed as the very instance the call throws', async () =>
    {
        for (const [row, ErrorClass, status] of [
            ['row 2: 401 UnauthorizedError', UnauthorizedError, 401],
            ['row 2: 404 NotFoundError', NotFoundError, 404],
        ] as const)
        {
            const { result, outcome } = await observe(row);

            expect(result).toBeInstanceOf(ErrorClass);
            expect(outcome).toMatchObject({ ok: false, errorType: 'http', status });
            expect((outcome as { error: Error }).error).toBe(result);
        }
    });

    it('row 3: an answer without __type is observed as the very ApiError the call throws', async () =>
    {
        for (const [row, status] of [['row 3: 403 no __type', 403], ['row 3: 500 no __type', 500]] as const)
        {
            const { result, outcome } = await observe(row);

            expect(result).toBeInstanceOf(ApiError);
            expect((result as ApiError).errorType).toBe('http');
            expect(outcome).toMatchObject({ ok: false, errorType: 'http', status });
            expect((outcome as { error: Error }).error).toBe(result);
        }
    });

    it('row 3: the observed status is the final response\'s, after onResponse replaced it', async () =>
    {
        const observer: Observer = vi.fn();
        const api = clientWith(respondWith({ message: 'boom' }, 500), observer, {
            onResponse: (_response, body) => ({ response: new Response(null, { status: 503 }), body }),
        });

        const result = await settle(api.getUser.call({}));

        expect((result as ApiError).status).toBe(503);
        expect(firstOutcome(observer)).toMatchObject({ errorType: 'http', status: 503, error: result });
    });
});

describe('createApi onOutcome - no answer', () =>
{
    it('row 4: a fetch rejecting with TypeError is observed as network, status 0, the thrown ApiError', async () =>
    {
        const { result, outcome } = await observe('row 4: network');

        expect(result).toBeInstanceOf(ApiError);
        expect(outcome).toMatchObject({ ok: false, errorType: 'network', status: 0 });
        expect((outcome as { error: Error }).error).toBe(result);
    });

    it('row 5: a timeout is observed as timeout, status 408, the thrown ApiError', async () =>
    {
        const { result, outcome } = await observe('row 5: timeout');

        expect((result as ApiError).errorType).toBe('timeout');
        expect(outcome).toMatchObject({ ok: false, errorType: 'timeout', status: 408 });
        expect((outcome as { error: Error }).error).toBe(result);
    });

    it('row 6: a caller abort is observed as aborted, status 0, the thrown ApiError', async () =>
    {
        const { result, outcome } = await observe('row 6: caller abort');

        expect((result as ApiError).errorType).toBe('aborted');
        expect((result as ApiError).cause).toBe('superseded');
        expect(outcome).toMatchObject({ ok: false, errorType: 'aborted', status: 0 });
        expect((outcome as { error: Error }).error).toBe(result);
    });
});

describe('createApi onOutcome - the app\'s own throws', () =>
{
    it('row 7: an onRequest throw is not observed and reaches the caller unchanged', async () =>
    {
        const observer: Observer = vi.fn();
        const thrown = new Error('no session');
        const fetchSpy = vi.fn(respondWith({ id: '1' }));
        const api = clientWith(fetchSpy as unknown as typeof fetch, observer, {
            onRequest: () =>
            {
                throw thrown;
            },
        });

        expect(await settle(api.getUser.call({}))).toBe(thrown);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(observer).not.toHaveBeenCalled();
    });

    it('row 8: an onResponse throw is not observed and reaches the caller unchanged', async () =>
    {
        for (const status of [200, 401])
        {
            const observer: Observer = vi.fn();
            const thrown = new Error('NEXT_REDIRECT');
            const api = clientWith(respondWith({ id: '1' }, status), observer, {
                onResponse: async () =>
                {
                    throw thrown;
                },
            });

            expect(await settle(api.getUser.call({}))).toBe(thrown);
            expect(observer).not.toHaveBeenCalled();
        }
    });
});

describe('createApi onOutcome - a failing observer', () =>
{
    it('row 9: an observer throwing on a successful call is logged once and the body is returned', async () =>
    {
        const api = clientWith(respondWith({ id: '1' }), () =>
        {
            throw new RangeError('observer broke');
        });

        await expect(api.getUser.call({})).resolves.toEqual({ id: '1' });
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(observerFailureLogs()).toEqual([[
            expect.stringContaining('onOutcome'),
            { errorName: 'RangeError', errorMessage: 'observer broke' },
        ]]);
    });

    it('row 10: an observer throwing on a failed call is logged once and the original error is thrown', async () =>
    {
        const observer: Observer = vi.fn(() =>
        {
            throw new Error('observer broke');
        });
        const api = clientWith(respondWith({ message: 'boom' }, 500), observer);

        const result = await settle(api.getUser.call({}));

        expect(result).toBeInstanceOf(ApiError);
        expect(result).toBe((firstOutcome(observer) as { error: Error }).error);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(observerFailureLogs()).toHaveLength(1);
    });

    it('row 11: an async observer rejecting is logged once and leaves no unhandled rejection', async () =>
    {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);

        try
        {
            const api = clientWith(respondWith({ id: '1' }), async () =>
            {
                throw new Error('observer rejected');
            });

            await expect(api.getUser.call({})).resolves.toEqual({ id: '1' });
            await flush();

            expect(unhandled).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(observerFailureLogs()).toEqual([[
                expect.stringContaining('onOutcome'),
                { errorName: 'Error', errorMessage: 'observer rejected' },
            ]]);
        }
        finally
        {
            process.off('unhandledRejection', unhandled);
        }
    });
});

describe('createApi onOutcome - once, and only when set', () =>
{
    it('row 12: every call of rows 1–6 is observed exactly once', async () =>
    {
        for (const row of Object.keys(callsThatReachFetch))
        {
            const { observer } = await observe(row);

            expect(observer, row).toHaveBeenCalledTimes(1);
        }
    });

    it('row 13: without onOutcome, calls return and throw as before', async () =>
    {
        await expect(clientWith(respondWith({ id: '1' })).getUser.call({})).resolves.toEqual({ id: '1' });
        await expect(clientWith(respondWith({ __type: 'NotFoundError' }, 404)).getUser.call({}))
            .rejects.toBeInstanceOf(NotFoundError);
        await expect(clientWith(respondWith({ message: 'boom' }, 500)).getUser.call({}))
            .rejects.toMatchObject({ errorType: 'http', status: 500 });
    });

    it('T1: the outcome narrows on ok and on errorType', () =>
    {
        const onOutcome = (outcome: ApiOutcome) =>
        {
            if (outcome.ok)
            {
                expectTypeOf(outcome.body).toEqualTypeOf<unknown>();
                expectTypeOf(outcome.response).toEqualTypeOf<Response>();

                return;
            }

            if (outcome.errorType === 'http')
            {
                expectTypeOf(outcome.error).toEqualTypeOf<Error>();

                return;
            }

            expectTypeOf(outcome.errorType).toEqualTypeOf<'network' | 'timeout' | 'aborted'>();
            expectTypeOf(outcome.error).toEqualTypeOf<ApiError>();
        };

        expectTypeOf(onOutcome).toMatchTypeOf<NonNullable<ApiConfig['onOutcome']>>();
    });
});
