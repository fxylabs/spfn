/**
 * The server-side api client forwards the browser's `user-agent` (bundle 8 part 2, au8-A1)
 *
 * A server component's call speaks for the browser it renders for, so it carries
 * that browser's `user-agent` the way it carries its cookies: `@spfn/auth`
 * compares a bound session's browser family against the key row, and Node's
 * `fetch` sending its own `node` would refuse every server-rendered page of a
 * bound account. Without these rows the forwarding could be removed here with
 * auth's suite — the only other row that crosses it — outside core's CI scope.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { createApi } from '../core';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** The inbound request `next/headers` answers; outside a request scope it throws, as Next.js does. */
const inbound = vi.hoisted(() => ({ inScope: true, userAgent: '' }));

vi.mock('next/headers', () =>
{
    function scoped<T>(value: T): T
    {
        if (!inbound.inScope)
        {
            throw new Error('`headers` was called outside a request scope');
        }

        return value;
    }

    return {
        cookies: async () => scoped({ getAll: () => [] }),
        headers: async () => scoped(new Headers({ host: 'app.test', 'user-agent': inbound.userAgent })),
    };
});

/** A server-side client whose `fetch` records the headers of every call. */
function recordingClient(): { api: any; calls: Array<Record<string, string>> }
{
    const calls: Array<Record<string, string>> = [];
    const api = createApi<any>({
        fetch: (async (_url: string, init: RequestInit) =>
        {
            calls.push(init.headers as Record<string, string>);

            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch,
    }) as any;

    return { api, calls };
}

/** Every `user-agent` header a call carried, under any casing. */
function userAgents(headers: Record<string, string>): string[]
{
    return Object.entries(headers)
        .filter(([name]) => name.toLowerCase() === 'user-agent')
        .map(([, value]) => value);
}

describe('api client - the browser\'s user-agent on a server-side call', () =>
{
    afterEach(() =>
    {
        inbound.inScope = true;
        inbound.userAgent = '';
    });

    it('inside a request scope, the inbound user-agent goes out', async () =>
    {
        inbound.userAgent = CHROME;
        const { api, calls } = recordingClient();

        await api.getSession.call({});

        expect(userAgents(calls[0])).toEqual([CHROME]);
    });

    it.each(['User-Agent', 'user-agent', 'USER-AGENT'])('a caller-set %s wins, and exactly one header is sent', async (name) =>
    {
        inbound.userAgent = CHROME;
        const { api, calls } = recordingClient();

        await api.getSession.headers({ [name]: 'caller/1.0' }).call({});

        expect(userAgents(calls[0])).toEqual(['caller/1.0']);
    });

    it('outside a request scope, none is added and the call goes out', async () =>
    {
        inbound.inScope = false;
        const { api, calls } = recordingClient();

        await expect(api.getSession.call({})).resolves.toBeDefined();

        expect(userAgents(calls[0])).toEqual([]);
    });
});
