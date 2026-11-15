/**
 * Whose address a per-IP limit counts (au9-N3).
 *
 * A direct request used to be keyed on the left-most `X-Forwarded-For` value,
 * which the request itself states: a caller sending a new one each time was a
 * new caller each time and never limited. The header is now read only as far as
 * the operator declared proxies in front of the server, and a declaration that
 * is not a hop count refuses the boot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

vi.mock('../../cache', () => ({
    getCache: () => undefined,
    isCacheDisabled: () => true,
}));

vi.mock('@hono/node-server', () => ({
    serve: vi.fn(),
}));

import { rateLimit, resetMemoryRateLimitStore } from '../rate-limit';
import { getClientIp, setTrustedProxyHops } from '../client-ip';
import { ErrorHandler } from '../error-handler';
import { startServer } from '../../server/start-server';
import { serverLogger } from '../../server/logger';

const LIMIT = 3;

/** The balancer's own address, as the socket shows it to the server. */
const PEER = { incoming: { socket: { remoteAddress: '192.0.2.10' } } };

function limitedApp(): Hono
{
    const app = new Hono();

    app.onError(ErrorHandler({ enableLogging: false }));
    app.post('/_auth/mfa/verify', rateLimit({ limit: LIMIT, windowMs: 60_000 }), c => c.json({ ip: getClientIp(c) }));

    return app;
}

async function statusesFor(forwardedFor: (attempt: number) => string): Promise<{ statuses: number[]; ips: string[] }>
{
    const app = limitedApp();
    const statuses: number[] = [];
    const ips: string[] = [];

    for (let attempt = 0; attempt <= LIMIT; attempt++)
    {
        const response = await app.request('/_auth/mfa/verify', {
            method: 'POST',
            headers: { 'x-forwarded-for': forwardedFor(attempt) },
        }, PEER);

        statuses.push(response.status);

        if (response.status === 200)
        {
            ips.push((await response.json() as { ip: string }).ip);
        }
    }

    return { statuses, ips };
}

beforeEach(() =>
{
    resetMemoryRateLimitStore();
    setTrustedProxyHops(undefined);
    vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
    vi.stubEnv('SERVER_TRUSTED_PROXY_HOPS', '');
});

afterEach(() =>
{
    setTrustedProxyHops(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('T1: a per-IP limit counts the address the request cannot choose', () =>
{
    it('counts direct requests with a new X-Forwarded-For each time as one caller', async () =>
    {
        const { statuses, ips } = await statusesFor(attempt => `198.51.100.${attempt + 1}`);

        expect(statuses).toEqual([200, 200, 200, 429]);
        expect(new Set(ips)).toEqual(new Set(['192.0.2.10']));
    });

    it('with one trusted hop declared, reads the entry the proxy appended and ignores a forged left-most value', async () =>
    {
        vi.stubEnv('SERVER_TRUSTED_PROXY_HOPS', '1');

        const { statuses, ips } = await statusesFor(attempt => `10.66.0.${attempt + 1}, 203.0.113.7`);

        expect(statuses).toEqual([200, 200, 200, 429]);
        expect(new Set(ips)).toEqual(new Set(['203.0.113.7']));
    });

    it('with two trusted hops declared, counts a one-entry chain with a new value each time as the connection peer', async () =>
    {
        vi.stubEnv('SERVER_TRUSTED_PROXY_HOPS', '2');

        const { statuses, ips } = await statusesFor(attempt => `198.51.100.${attempt + 1}`);

        expect(statuses).toEqual([200, 200, 200, 429]);
        expect(new Set(ips)).toEqual(new Set(['192.0.2.10']));
    });
});

describe('T1b: an invalid declaration refuses the boot', () =>
{
    beforeEach(() =>
    {
        vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
        vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        vi.mocked(serve).mockClear();
    });

    it('refuses SERVER_TRUSTED_PROXY_HOPS that is not a whole number of hops', async () =>
    {
        vi.stubEnv('SERVER_TRUSTED_PROXY_HOPS', '-1');

        await expect(startServer({ port: 4391, host: 'localhost' })).rejects.toThrow('process.exit(1)');
        expect(serve).not.toHaveBeenCalled();
    });

    it('refuses a server config whose trustedProxyHops is not a whole number of hops', async () =>
    {
        await expect(startServer({ port: 4391, host: 'localhost', trustedProxyHops: 1.5 }))
            .rejects.toThrow('Invalid trustedProxyHops');
        expect(serve).not.toHaveBeenCalled();
    });
});
