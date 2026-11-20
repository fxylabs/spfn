/**
 * The Next.js client's and RPC proxy's failure lines name the route, not the URL (spfn/spfn#164)
 *
 * A GET call carries its params, query and body in the URL — the client puts
 * the whole input in `?input=`, the proxy forwards the query to the backend —
 * and these lines are written at error level, so a token in the query reached
 * every deployment's log. The debug lines dropped the URL too.
 *
 * | #   | situation                                                       | goes unnoticed without the row                    |
 * | --- | --------------------------------------------------------------- | ------------------------------------------------- |
 * | T14 | client timeout and network error, proxy timeout and fetch error, with debug on | a query token in an error-level line           |
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { Logger } from '@spfn/core/logger';
import { captureLoggerClass } from '../../logger/__tests__/helpers/leak-probe';
import { createApi } from '../client/core';
import { createRpcProxy } from '../proxy/rpc';

vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers({ host: 'app.test' }),
}));

const SECRET = 'capability-token-1f3a9c';

const abortError = (): Error => new DOMException('The operation was aborted', 'AbortError');

afterEach(() =>
{
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Next.js failure lines without the URL', () =>
{
    it('T14a: the client\'s timeout and network-error lines carry the route, and no line carries the query', async () =>
    {
        const { lines, output } = captureLoggerClass(Logger);
        // The client's own timer firing, a fetch that aborts by itself, a refused connection
        const failures = [
            (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
            async () => Promise.reject(abortError()),
            async () => Promise.reject(new TypeError('fetch failed')),
        ];
        const api = createApi<any>({
            debug: true,
            timeout: 20,
            fetch: vi.fn((_url: string, init: RequestInit) => failures.shift()!(init.signal!)) as unknown as typeof fetch,
        }) as any;

        for (let call = 0; call < 3; call++)
        {
            const error = await api.getImport.call({ query: { token: SECRET } }).catch((caught: unknown) => caught);
            // The call itself still went to the URL holding the token: the error object keeps it
            expect(error.url).toContain(SECRET);
        }

        const errors = lines.filter(line => line.level === 'error');
        expect(errors.map(line => [line.message, line.context?.route])).toEqual([
            ['Request timeout', 'getImport'],
            ['Request timeout', 'getImport'],
            ['Network error', 'getImport'],
        ]);
        expect(output()).not.toContain(SECRET);
    });

    it('T14b: the proxy\'s timeout and fetch-error lines carry routeName, and no line carries the query', async () =>
    {
        const { lines, output } = captureLoggerClass(Logger);
        const failures = [abortError(), new TypeError('fetch failed')];
        const backend = vi.fn(async (_url: string) =>
        {
            throw failures.shift();
        });
        vi.stubGlobal('fetch', backend);

        const { GET } = createRpcProxy({
            routeMap: { getImport: { method: 'GET', path: '/api/import' } },
            apiUrl: 'http://backend.test',
            autoDiscoverInterceptors: false,
            debug: true,
        });
        const input = encodeURIComponent(JSON.stringify({ query: { token: SECRET } }));

        for (let call = 0; call < 2; call++)
        {
            const request = new NextRequest(`http://localhost:3000/api/rpc/getImport?input=${input}`);
            await GET(request, { params: Promise.resolve({ routeName: 'getImport' }) });
        }

        // The backend was called with the token in its query
        expect(backend.mock.calls.map(([url]) => url)).toEqual([0, 1].map(() => `http://backend.test/api/import?token=${SECRET}`));
        const errors = lines.filter(line => line.level === 'error');
        expect(errors.map(line => [line.message, line.context?.routeName])).toEqual([
            ['Request timeout', 'getImport'],
            ['Fetch error', 'getImport'],
        ]);
        expect(output()).not.toContain(SECRET);
    });
});
