/**
 * @spfn/core - Rate limit middleware tests
 *
 * The cache is mocked so the limiter logic is tested without Redis. eval()
 * returns the [count, pttl] the Lua counter would produce.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const evalMock = vi.fn();
let cacheClient: { eval: typeof evalMock } | undefined = { eval: evalMock };
let cacheDisabled = false;

vi.mock('../../cache', () => ({
    getCache: () => cacheClient,
    isCacheDisabled: () => cacheDisabled,
}));

import {
    rateLimit, rateLimitPolicy, setRateLimitPolicies, getRateLimitPolicy,
    setRateLimitFailClosedDefault, resetMemoryRateLimitStore,
} from '../rate-limit';
import { getClientIp } from '../client-ip';
import { TooManyRequestsError } from '../../errors';

function makeCtx(headers: Record<string, string> = {})
{
    const setHeaders: Record<string, string> = {};

    return {
        req: {
            header: (name: string) => headers[name.toLowerCase()],
            path: '/_auth/login',
            method: 'POST',
            routePath: '/_auth/login',
        },
        get: () => undefined,
        header: (name: string, value: string) => 
        {
            setHeaders[name] = value; 
        },
        _setHeaders: setHeaders,
    } as never;
}

describe('rateLimit middleware', () =>
{
    beforeEach(() =>
    {
        evalMock.mockReset();
        cacheClient = { eval: evalMock };
        cacheDisabled = false;
        resetMemoryRateLimitStore();
    });

    it('allows a request under the limit', async () =>
    {
        evalMock.mockResolvedValue([1, 60_000]);
        const next = vi.fn().mockResolvedValue(undefined);

        await rateLimit({ limit: 5, windowMs: 60_000 }).handler(makeCtx({ 'x-forwarded-for': '1.2.3.4' }), next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects with 429 and Retry-After when over the limit', async () =>
    {
        evalMock.mockResolvedValue([6, 30_000]);
        const ctx = makeCtx({ 'x-forwarded-for': '1.2.3.4' }) as never as { _setHeaders: Record<string, string> };
        const next = vi.fn();

        await expect(rateLimit({ limit: 5, windowMs: 60_000 }).handler(ctx as never, next))
            .rejects.toBeInstanceOf(TooManyRequestsError);
        expect(next).not.toHaveBeenCalled();
        expect(ctx._setHeaders['Retry-After']).toBe('30');
    });

    it('counts in the process when the cache is unavailable, rather than not counting', async () =>
    {
        cacheClient = undefined;
        const limiter = rateLimit({ limit: 2, windowMs: 60_000 }).handler;
        const ctx = () => makeCtx({ 'x-forwarded-for': '1.2.3.4' });

        await limiter(ctx(), vi.fn().mockResolvedValue(undefined));
        await limiter(ctx(), vi.fn().mockResolvedValue(undefined));

        // 세 번째는 한도를 넘는다 — 캐시가 없어도 제한이 사라지지 않는다.
        await expect(limiter(ctx(), vi.fn())).rejects.toBeInstanceOf(TooManyRequestsError);
        expect(evalMock).not.toHaveBeenCalled();
    });

    it('refuses instead of counting locally when failClosed is set', async () =>
    {
        cacheClient = undefined;
        const next = vi.fn();

        await expect(rateLimit({ limit: 5, windowMs: 60_000, failClosed: true }).handler(makeCtx(), next))
            .rejects.toBeInstanceOf(TooManyRequestsError);
        expect(next).not.toHaveBeenCalled();
    });

    it('limits each dimension independently — the strictest wins', async () =>
    {
        // IP is fine (1), but the account dimension is over (6)
        evalMock.mockResolvedValueOnce([1, 60_000]).mockResolvedValueOnce([6, 20_000]);
        const next = vi.fn();

        await expect(
            rateLimit({ limit: 5, windowMs: 60_000, by: () => ['1.2.3.4', 'user@example.com'] }).handler(makeCtx(), next),
        ).rejects.toBeInstanceOf(TooManyRequestsError);
        expect(next).not.toHaveBeenCalled();
        expect(evalMock).toHaveBeenCalledTimes(2);
    });

    it('honors a per-dimension limit — loose IP passes, tight account trips', async () =>
    {
        evalMock.mockResolvedValue([6, 30_000]);
        const next = vi.fn();

        await expect(
            rateLimit({
                limit: 5,
                windowMs: 60_000,
                by: () => [{ key: 'ip:1.2.3.4', limit: 100 }, 'acct:a@b.com'],
            }).handler(makeCtx(), next),
        ).rejects.toBeInstanceOf(TooManyRequestsError);

        // IP dim (limit 100) allowed at count 6; account dim (top-level limit 5) tripped.
        expect(evalMock).toHaveBeenCalledTimes(2);
        expect(next).not.toHaveBeenCalled();
    });

    it('a loose per-dimension limit lets through what the top-level limit would reject', async () =>
    {
        evalMock.mockResolvedValue([6, 30_000]);
        const next = vi.fn().mockResolvedValue(undefined);

        await rateLimit({
            limit: 5,
            windowMs: 60_000,
            by: () => [{ key: 'ip:1.2.3.4', limit: 100 }],
        }).handler(makeCtx(), next);

        expect(next).toHaveBeenCalledTimes(1); // 6 <= 100
    });
});

describe('rateLimitPolicy named policies', () =>
{
    beforeEach(() =>
    {
        evalMock.mockReset();
        cacheClient = { eval: evalMock };
        cacheDisabled = false;
        setRateLimitPolicies(undefined);
        setRateLimitFailClosedDefault(false);
    });

    it('registers under a distinct name and layers over (does not skip) the global default', () =>
    {
        const tag = rateLimitPolicy('p', { limit: 5, windowMs: 60_000 });

        expect(tag.name).toBe('rateLimit:p');
        expect(tag.skips).toBeUndefined();
        expect(typeof tag.handler).toBe('function');
    });

    it('defaults the counter scope to the policy name (shared bucket, no collision with global)', async () =>
    {
        evalMock.mockResolvedValue([1, 60_000]);

        await rateLimitPolicy('auth-login', { limit: 5, windowMs: 60_000 })
            .handler(makeCtx(), vi.fn());

        // key is `ratelimit:${scope}:${dimension}` — scope defaults to the policy name
        expect(evalMock.mock.calls[0][2]).toBe('ratelimit:auth-login:unknown');
    });

    it('uses the fallback when the app configured no policy', async () =>
    {
        // fallback limit 1, count 2 → over → reject
        evalMock.mockResolvedValue([2, 60_000]);
        const next = vi.fn();

        await expect(
            rateLimitPolicy('p', { limit: 1, windowMs: 60_000 }).handler(makeCtx(), next),
        ).rejects.toBeInstanceOf(TooManyRequestsError);
        expect(next).not.toHaveBeenCalled();
    });

    it('lets a configured policy override the fallback', async () =>
    {
        // app raises the limit to 10; count 2 is now under → allowed
        setRateLimitPolicies({ p: { limit: 10, windowMs: 60_000 } });
        evalMock.mockResolvedValue([2, 60_000]);
        const next = vi.fn().mockResolvedValue(undefined);

        await rateLimitPolicy('p', { limit: 1, windowMs: 60_000 }).handler(makeCtx(), next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it('shallow-merges configured fields over the fallback', () =>
    {
        setRateLimitPolicies({ p: { limit: 50 } as never });

        expect(getRateLimitPolicy('p')).toEqual({ limit: 50 });
        expect(getRateLimitPolicy('missing')).toBeUndefined();
    });

    it('applies the app-wide fail-closed default to a tag (reaches named policies)', async () =>
    {
        setRateLimitFailClosedDefault(true);
        cacheClient = undefined; // cache unavailable

        await expect(rateLimitPolicy('p', { limit: 5, windowMs: 60_000 }).handler(makeCtx(), vi.fn()))
            .rejects.toBeInstanceOf(TooManyRequestsError);
    });

    it('a tag/policy may still opt out of fail-closed despite the default', async () =>
    {
        setRateLimitFailClosedDefault(true);
        cacheClient = undefined;
        const next = vi.fn().mockResolvedValue(undefined);

        await rateLimitPolicy('p', { limit: 5, windowMs: 60_000, failClosed: false }).handler(makeCtx(), next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it('setRateLimitPolicies(undefined) clears the registry', () =>
    {
        setRateLimitPolicies({ p: { limit: 1, windowMs: 1000 } });
        expect(getRateLimitPolicy('p')).toBeDefined();

        setRateLimitPolicies(undefined);
        expect(getRateLimitPolicy('p')).toBeUndefined();
    });
});

describe('getClientIp socket fallback', () =>
{
    function ipCtx(opts: { headers?: Record<string, string>; env?: unknown; clientType?: string } = {})
    {
        const headers = opts.headers ?? {};

        return {
            req: { header: (name: string) => headers[name.toLowerCase()] },
            get: (key: string) => (key === 'clientType' ? opts.clientType : undefined),
            env: opts.env,
        } as never;
    }

    it('uses the TCP peer address when no forwarding header is present', () =>
    {
        expect(getClientIp(ipCtx({ env: { incoming: { socket: { remoteAddress: '203.0.113.9' } } } }))).toBe('203.0.113.9');
    });

    it('reads the socket via env.server when the adapter nests bindings', () =>
    {
        expect(getClientIp(ipCtx({ env: { server: { incoming: { socket: { remoteAddress: '203.0.113.9' } } } } }))).toBe('203.0.113.9');
    });

    it('keeps the socket address over an X-Forwarded-For no declared proxy vouches for', () =>
    {
        const c = ipCtx({
            headers: { 'x-forwarded-for': '198.51.100.1' },
            env: { incoming: { socket: { remoteAddress: '203.0.113.9' } } },
        });

        expect(getClientIp(c)).toBe('203.0.113.9');
    });

    it('returns "unknown" only when nothing identifies the client', () =>
    {
        expect(getClientIp(ipCtx())).toBe('unknown');
    });
});
