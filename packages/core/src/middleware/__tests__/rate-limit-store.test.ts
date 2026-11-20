/**
 * @spfn/core - Rate limit store tests
 *
 * The memory store is what stands between "no Redis" and "no limit at all", so
 * what is fixed here is that it actually counts, that a window really resets,
 * and that it cannot grow without bound — a limiter keyed by client IP mints a
 * key per caller.
 *
 * The middleware half covers the cache failing mid-request: that used to escape
 * as a 500 because nothing caught it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const evalMock = vi.fn();
let cacheClient: { eval: typeof evalMock } | undefined = { eval: evalMock };
let cacheDisabled = false;

vi.mock('../../cache', () => ({
    getCache: () => cacheClient,
    isCacheDisabled: () => cacheDisabled,
}));

import { MemoryRateLimitStore, CacheRateLimitStore } from '../rate-limit-store';
import { rateLimit, resetMemoryRateLimitStore } from '../rate-limit';
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

describe('MemoryRateLimitStore', () =>
{
    it('counts hits on the same key', async () =>
    {
        const store = new MemoryRateLimitStore();

        expect((await store.hit('k', 60_000)).count).toBe(1);
        expect((await store.hit('k', 60_000)).count).toBe(2);
        expect((await store.hit('k', 60_000)).count).toBe(3);
    });

    it('counts each key separately', async () =>
    {
        const store = new MemoryRateLimitStore();

        await store.hit('a', 60_000);
        await store.hit('a', 60_000);

        expect((await store.hit('b', 60_000)).count).toBe(1);
    });

    it('reports the window\'s remaining time, shrinking as it runs out', async () =>
    {
        vi.useFakeTimers();
        const store = new MemoryRateLimitStore();

        expect((await store.hit('k', 60_000)).pttl).toBe(60_000);

        vi.advanceTimersByTime(20_000);
        expect((await store.hit('k', 60_000)).pttl).toBe(40_000);

        vi.useRealTimers();
    });

    it('starts a fresh window once the old one has run out', async () =>
    {
        vi.useFakeTimers();
        const store = new MemoryRateLimitStore();

        await store.hit('k', 1_000);
        await store.hit('k', 1_000);

        vi.advanceTimersByTime(1_001);

        expect((await store.hit('k', 1_000)).count).toBe(1);

        vi.useRealTimers();
    });

    it('drops windows that already reset instead of keeping them', async () =>
    {
        vi.useFakeTimers();
        const store = new MemoryRateLimitStore();

        await store.hit('a', 1_000);
        await store.hit('b', 1_000);
        expect(store.size).toBe(2);

        vi.advanceTimersByTime(1_001);
        store.prune(Date.now());

        expect(store.size).toBe(0);

        vi.useRealTimers();
    });

    it('stays under its key bound, evicting the oldest live window when it must', async () =>
    {
        const store = new MemoryRateLimitStore(3);

        for (let i = 0; i < 10; i += 1)
        {
            await store.hit(`key-${i}`, 60_000);
        }

        expect(store.size).toBeLessThanOrEqual(3);
        expect(store.evictionCount).toBeGreaterThan(0);
    });

    it('prefers expired windows over live ones when making room', async () =>
    {
        vi.useFakeTimers();
        const store = new MemoryRateLimitStore(2);

        await store.hit('short', 1_000);
        vi.advanceTimersByTime(1_001);
        await store.hit('long', 60_000);

        // 'short'는 이미 만료됐으므로 자리를 만들 때 그것이 먼저 사라지고,
        // 살아 있는 'long'은 카운트를 잃지 않는다.
        await store.hit('new', 60_000);

        expect(store.evictionCount).toBe(0);
        expect((await store.hit('long', 60_000)).count).toBe(2);

        vi.useRealTimers();
    });
});

describe('CacheRateLimitStore', () =>
{
    it('returns what the Lua counter answered', async () =>
    {
        const eval_ = vi.fn().mockResolvedValue([4, 12_345]);
        const store = new CacheRateLimitStore({ eval: eval_ } as never);

        expect(await store.hit('k', 60_000)).toEqual({ count: 4, pttl: 12_345 });
        expect(eval_).toHaveBeenCalledWith(expect.any(String), 1, 'k', '60000');
    });
});

describe('the limiter when the cache fails mid-request', () =>
{
    beforeEach(() =>
    {
        evalMock.mockReset();
        cacheClient = { eval: evalMock };
        cacheDisabled = false;
        resetMemoryRateLimitStore();
    });

    it('counts locally instead of letting the error escape as a 500', async () =>
    {
        evalMock.mockRejectedValue(new Error('READONLY You can\'t write against a read only replica.'));
        const limiter = rateLimit({ limit: 2, windowMs: 60_000 }).handler;
        const ctx = () => makeCtx({ 'x-forwarded-for': '1.2.3.4' });

        await limiter(ctx(), vi.fn().mockResolvedValue(undefined));
        await limiter(ctx(), vi.fn().mockResolvedValue(undefined));

        // 캐시가 계속 실패해도 제한은 살아 있다.
        await expect(limiter(ctx(), vi.fn())).rejects.toBeInstanceOf(TooManyRequestsError);
    });

    it('refuses instead of counting locally when failClosed is set', async () =>
    {
        evalMock.mockRejectedValue(new Error('connection lost'));
        const next = vi.fn();

        await expect(rateLimit({ limit: 5, windowMs: 60_000, failClosed: true }).handler(makeCtx(), next))
            .rejects.toBeInstanceOf(TooManyRequestsError);
        expect(next).not.toHaveBeenCalled();
    });

    it('goes back to the cache once it recovers', async () =>
    {
        const limiter = rateLimit({ limit: 5, windowMs: 60_000 }).handler;
        const ctx = () => makeCtx({ 'x-forwarded-for': '1.2.3.4' });

        evalMock.mockRejectedValueOnce(new Error('down'));
        await limiter(ctx(), vi.fn().mockResolvedValue(undefined));

        evalMock.mockResolvedValue([1, 60_000]);
        await limiter(ctx(), vi.fn().mockResolvedValue(undefined));

        expect(evalMock).toHaveBeenCalledTimes(2);
    });
});
