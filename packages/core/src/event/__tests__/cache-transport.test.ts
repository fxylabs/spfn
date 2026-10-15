/**
 * Event cache transport (Redis pub/sub) tests
 *
 * Simulates multiple pods sharing one Redis bus and asserts that an `emit` on
 * one pod fans out to subscribers on another, that channel prefixes isolate
 * apps, that publish/serialization failures degrade to local delivery rather
 * than dropping or crashing, and that router wiring dedups + degrades gracefully.
 */

import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { Type } from '@sinclair/typebox';
// Import from src (not the '@spfn/core/event' package specifier, which resolves to
// built dist) so these tests exercise the current source and share ONE event-module
// instance with cache-transport — no stale-dist false confidence, no dual singleton.
import { defineEvent } from '../event';
import { defineEventRouter } from '../router';
import { createRedisPubSubCache, wireEventRouterCache, closeEventTransport } from '../cache-transport';
import { FakeBus, FakeRedis } from './fake-redis';

// Mock the cache module so wireEventRouterCache's dynamic getCache() is steerable.
// Defaults to "no cache" (in-process); individual tests opt into a fake client.
vi.mock('@spfn/core/cache', () => ({ getCache: vi.fn(() => undefined) }));
import { getCache } from '@spfn/core/cache';

// Mock the logger so the warn-throttle can be observed (single shared sink).
vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});
import { logger } from '@spfn/core/logger';

// Reset the global transport singleton between tests (wired set, cached pubSubCache).
afterEach(async () =>
{
    vi.useRealTimers(); // restore before closeEventTransport (which uses a real timer race)
    await closeEventTransport();
    (getCache as unknown as Mock).mockReturnValue(undefined);
});

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('createRedisPubSubCache', () =>
{
    it('fans out an emit from one pod to a subscriber on another pod', async () =>
    {
        const bus = new FakeBus();
        const schema = Type.Object({ text: Type.String() });

        // Two independent event instances with the same name = two pods.
        const podA = defineEvent('chatChunk', schema);
        const podB = defineEvent('chatChunk', schema);

        await podA.useCache(createRedisPubSubCache(new FakeRedis(bus), 'spfn:sse:'));
        await podB.useCache(createRedisPubSubCache(new FakeRedis(bus), 'spfn:sse:'));

        const received: { text: string }[] = [];
        podB.subscribe((payload) =>
        {
            received.push(payload);
        });

        await podA.emit({ text: 'hello' });
        await flush();

        expect(received).toEqual([{ text: 'hello' }]);
    });

    it('fans out a void-payload event without dropping it', async () =>
    {
        const bus = new FakeBus();

        const podA = defineEvent('serverStarted');
        const podB = defineEvent('serverStarted');

        await podA.useCache(createRedisPubSubCache(new FakeRedis(bus), 'spfn:sse:'));
        await podB.useCache(createRedisPubSubCache(new FakeRedis(bus), 'spfn:sse:'));

        let received = 0;
        podB.subscribe(() =>
        {
            received++;
        });

        await podA.emit();
        await flush();

        expect(received).toBe(1);
    });

    it('isolates pods that use a different channel prefix', async () =>
    {
        const bus = new FakeBus();
        const schema = Type.Object({ text: Type.String() });

        const podA = defineEvent('chatChunk', schema);
        const podB = defineEvent('chatChunk', schema);

        await podA.useCache(createRedisPubSubCache(new FakeRedis(bus), 'app-a:'));
        await podB.useCache(createRedisPubSubCache(new FakeRedis(bus), 'app-b:'));

        const received: unknown[] = [];
        podB.subscribe((payload) =>
        {
            received.push(payload);
        });

        await podA.emit({ text: 'hello' });
        await flush();

        expect(received).toEqual([]);
    });

    it('swallows publish failures so emit never throws', async () =>
    {
        const failing = {
            publish: vi.fn().mockRejectedValue(new Error('redis down')),
            duplicate: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(failing as any, 'spfn:sse:');

        await expect(cache.publish('chatChunk', { text: 'hi' })).resolves.toBeUndefined();
        expect(failing.publish).toHaveBeenCalledOnce();
    });

    it('delivers locally when publish fails (same-pod stream survives a Redis blip)', async () =>
    {
        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            publish: vi.fn().mockRejectedValue(new Error('redis down')),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const event = defineEvent('chatChunk', Type.Object({ text: Type.String() }));
        await event.useCache(createRedisPubSubCache(client as any, 'spfn:sse:'));

        const received: { text: string }[] = [];
        event.subscribe((payload) =>
        {
            received.push(payload);
        });

        const original = { text: 'hi' };
        await event.emit(original);
        await flush();

        expect(client.publish).toHaveBeenCalledOnce();
        expect(received).toEqual([{ text: 'hi' }]); // delivered despite the publish failure
        expect(received[0]).not.toBe(original); // a JSON copy, same shape as the echo path
    });

    it('delivers locally when the payload is not JSON-serializable', async () =>
    {
        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            publish: vi.fn().mockResolvedValue(1),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('weird', (payload) =>
        {
            received.push(payload);
        });

        await cache.publish('weird', { big: 10n }); // bigint → JSON.stringify throws

        expect(client.publish).not.toHaveBeenCalled(); // never reached the wire
        expect(received).toEqual([{ big: 10n }]); // but local subscriber still got it
    });

    it('never rejects nor publishes when the payload serializes to undefined (function/symbol)', async () =>
    {
        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            publish: vi.fn().mockResolvedValue(1),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('fn', (payload) =>
        {
            received.push(payload);
        });

        const fn = () => 'token';
        // Must not reject (publish-never-kills-emit invariant) and must not reach the wire.
        await expect(cache.publish('fn', fn)).resolves.toBeUndefined();
        expect(client.publish).not.toHaveBeenCalled();
        expect(received[0]).toBe(fn); // delivered locally (live object)
    });

    it('trips a circuit breaker so a sustained outage costs one timeout, not one per emit', async () =>
    {
        vi.useFakeTimers();

        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            status: 'ready',
            publish: vi.fn(() => new Promise(() => undefined)), // hangs every time
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('x', (payload) =>
        {
            received.push(payload);
        });

        const first = cache.publish('x', { n: 1 });
        await vi.advanceTimersByTimeAsync(5000); // chunk1 trips the timeout, opens the breaker
        await first;

        // chunk2 & 3 within the cooldown → breaker open → skip publish → instant local.
        await cache.publish('x', { n: 2 });
        await cache.publish('x', { n: 3 });

        expect(client.publish).toHaveBeenCalledTimes(1); // breaker prevented re-attempts
        expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]); // all delivered locally
    });

    it('delivers same-pod locally on publish success when the subscriber connection is down', async () =>
    {
        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn(), status: 'close' };
        const client = {
            status: 'ready', // write client healthy
            publish: vi.fn().mockResolvedValue(1), // PUBLISH succeeds (remote pods get it)
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('x', (payload) =>
        {
            received.push(payload);
        });

        await cache.publish('x', { n: 1 });

        expect(client.publish).toHaveBeenCalledOnce(); // cross-pod send still happened
        expect(received).toEqual([{ n: 1 }]); // same-pod covered locally (echo can't arrive)
    });

    it('does not double-deliver on publish success when the subscriber is healthy', async () =>
    {
        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn(), status: 'ready' };
        const client = {
            status: 'ready',
            publish: vi.fn().mockResolvedValue(1),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('x', (payload) =>
        {
            received.push(payload);
        });

        await cache.publish('x', { n: 1 });

        // Healthy subscriber → delivery comes via the echo, not local — no local push here.
        expect(client.publish).toHaveBeenCalledOnce();
        expect(received).toEqual([]);
    });

    it('skips publish (no offline-queue duplicate) when the client is not connected', async () =>
    {
        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            status: 'connecting', // not ready
            publish: vi.fn().mockResolvedValue(1),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('x', (payload) =>
        {
            received.push(payload);
        });

        await cache.publish('x', { n: 1 });

        expect(client.publish).not.toHaveBeenCalled(); // never queued → no late echo duplicate
        expect(received).toEqual([{ n: 1 }]); // delivered locally
    });

    it('throttles repeated publish-failure warnings to one per window', async () =>
    {
        vi.useFakeTimers();

        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            status: 'ready',
            publish: vi.fn().mockRejectedValue(new Error('down')),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');
        await cache.subscribe('x', () => undefined);

        const warn = (logger as unknown as { warn: Mock }).warn;
        vi.advanceTimersByTime(31000); // expire any throttle state from earlier tests
        warn.mockClear();

        await cache.publish('x', { n: 1 }); // attempt → fail → WARN #1 (also opens breaker for 10s)
        await vi.advanceTimersByTimeAsync(11000); // breaker expires; throttle window (30s) still open
        await cache.publish('x', { n: 2 }); // half-open probe → attempt → fail → throttled (suppressed)

        // Pin the throttle path: publish #2 must have reached the wire (not skipped by an
        // open breaker — otherwise a lengthened cooldown would silently pass this test).
        expect(client.publish).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('admits a single probe after cooldown — concurrent emits do not each re-probe', async () =>
    {
        vi.useFakeTimers();

        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            status: 'ready',
            publish: vi.fn(() => new Promise(() => undefined)), // hangs every time (sustained outage)
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');
        await cache.subscribe('x', () => undefined);

        const first = cache.publish('x', { n: 1 }); // probe #1
        await vi.advanceTimersByTimeAsync(5000); // times out → breaker opens
        await first;
        expect(client.publish).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(10000); // cooldown elapses → half-open

        // Fire many emits concurrently the instant the breaker reopens.
        const burst = Promise.all([1, 2, 3, 4, 5].map((n) => cache.publish('x', { n })));
        await vi.advanceTimersByTimeAsync(5000);
        await burst;

        // Exactly one of the burst probed; the rest fast-pathed to local.
        expect(client.publish).toHaveBeenCalledTimes(2);
    });

    it('falls back to local delivery when publish hangs (timeout-bound)', async () =>
    {
        vi.useFakeTimers();

        const subscriberStub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            publish: vi.fn(() => new Promise(() => undefined)), // never settles (wedged socket)
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('x', (payload) =>
        {
            received.push(payload);
        });

        const pending = cache.publish('x', { a: 1 });
        await vi.advanceTimersByTimeAsync(5000); // trip the publish timeout
        await expect(pending).resolves.toBeUndefined(); // emit never hangs

        expect(received).toEqual([{ a: 1 }]); // delivered locally after the timeout
    });

    it('rejects (degrades) when SUBSCRIBE hangs (timeout-bound)', async () =>
    {
        vi.useFakeTimers();

        const subscriberStub = {
            subscribe: vi.fn(() => new Promise(() => undefined)), // never settles
            on: vi.fn(),
            quit: vi.fn().mockResolvedValue('OK'),
        };
        const client = {
            publish: vi.fn(),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const pending = cache.subscribe('x', () => undefined);
        const assertion = expect(pending).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;

        expect(subscriberStub.quit).toHaveBeenCalled(); // half-open connection torn down
    });

    it('drops malformed and unknown-channel redis messages without throwing', async () =>
    {
        let onMessage: ((channel: string, raw: string) => void) | undefined;
        let onError: ((err: Error) => void) | undefined;
        const subscriberStub = {
            subscribe: vi.fn().mockResolvedValue(undefined),
            on: vi.fn((event: string, fn: any) =>
            {
                if (event === 'message') onMessage = fn;
                if (event === 'error') onError = fn;
            }),
        };
        const client = {
            publish: vi.fn(),
            duplicate: vi.fn().mockReturnValue(subscriberStub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        const received: unknown[] = [];
        await cache.subscribe('known', (payload) =>
        {
            received.push(payload);
        });

        // Listeners were attached.
        expect(onMessage).toBeTypeOf('function');
        expect(onError).toBeTypeOf('function');

        // No handler for this channel → ignored, no throw.
        expect(() => onMessage!('spfn:sse:unknown', '{"a":1}')).not.toThrow();
        // Malformed JSON on a known channel → parse fails → dropped, no throw.
        expect(() => onMessage!('spfn:sse:known', 'not json{')).not.toThrow();
        // Subscriber error → logged (throttled), no throw.
        expect(() => onError!(new Error('ECONNRESET'))).not.toThrow();
        // A valid message still gets through.
        onMessage!('spfn:sse:known', '{"a":2}');

        expect(received).toEqual([{ a: 2 }]);
    });

    it('tears down the subscriber when the first SUBSCRIBE fails so a retry rebuilds', async () =>
    {
        const deadSub = {
            subscribe: vi.fn().mockRejectedValue(new Error('SUBSCRIBE failed')),
            on: vi.fn(),
            quit: vi.fn().mockResolvedValue('OK'),
        };
        const goodSub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
        const client = {
            publish: vi.fn(),
            duplicate: vi.fn().mockReturnValueOnce(deadSub).mockReturnValueOnce(goodSub),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const cache = createRedisPubSubCache(client as any, 'spfn:sse:');

        await expect(cache.subscribe('a', () => undefined)).rejects.toThrow('SUBSCRIBE failed');
        expect(deadSub.quit).toHaveBeenCalled(); // half-open connection torn down

        // Retry rebuilds a fresh subscriber rather than reusing the dead one.
        await cache.subscribe('a', () => undefined);
        expect(client.duplicate).toHaveBeenCalledTimes(2);
    });
});

/**
 * | #  | situation                                                        | expected                                         |
 * |----|------------------------------------------------------------------|--------------------------------------------------|
 * | C6 | `subscribe(h, { localOnly: true })` on pod B; pod A emits         | `h` not called; a plain handler on B is called   |
 * | C7 | a `localOnly` handler on the emitting pod                         | called once                                      |
 * | C7'| a `localOnly` handler with no cache attached                      | called once per emit, as any handler             |
 * | C8 | `unsubscribeAll()`                                                | clears plain and `localOnly` handlers            |
 * | C11| a `localOnly` handler; the cache's `publish` rejects (local fallback) | called once per emit; a plain handler once per emit |
 */
describe('subscribe({ localOnly })', () =>
{
    const schema = Type.Object({ n: Type.Number() });

    async function twoPods()
    {
        const bus = new FakeBus();
        const podA = defineEvent('test.local', schema);
        const podB = defineEvent('test.local', schema);
        await podA.useCache(createRedisPubSubCache(new FakeRedis(bus), 'spfn:sse:'));
        await podB.useCache(createRedisPubSubCache(new FakeRedis(bus), 'spfn:sse:'));

        return { podA, podB };
    }

    it('C6 a localOnly handler on pod B is not called for pod A\'s emit; a plain handler on B is', async () =>
    {
        const { podA, podB } = await twoPods();
        const local = vi.fn();
        const plain = vi.fn();
        podB.subscribe(local, { localOnly: true });
        podB.subscribe(plain);

        await podA.emit({ n: 1 });
        await flush();

        expect(plain).toHaveBeenCalledWith({ n: 1 });
        expect(local).not.toHaveBeenCalled();
    });

    it('C7 a localOnly handler on the emitting pod is called once', async () =>
    {
        const { podA } = await twoPods();
        const local = vi.fn();
        const plain = vi.fn();
        podA.subscribe(local, { localOnly: true });
        podA.subscribe(plain);

        await podA.emit({ n: 1 });
        await flush();

        expect(local).toHaveBeenCalledTimes(1);
        expect(local).toHaveBeenCalledWith({ n: 1 });
        expect(plain).toHaveBeenCalledTimes(1);
    });

    it('C7\' without a cache a localOnly handler runs on every emit, as any handler', async () =>
    {
        const event = defineEvent('test.local', schema);
        const local = vi.fn();
        event.subscribe(local, { localOnly: true });

        await event.emit({ n: 1 });
        await event.emit({ n: 2 });

        expect(local.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    });

    it('C8 unsubscribeAll clears plain and localOnly handlers', async () =>
    {
        const { podA } = await twoPods();
        const local = vi.fn();
        const plain = vi.fn();
        podA.subscribe(local, { localOnly: true });
        podA.subscribe(plain);

        podA.unsubscribeAll();
        await podA.emit({ n: 1 });
        await flush();

        expect(local).not.toHaveBeenCalled();
        expect(plain).not.toHaveBeenCalled();
    });

    it('C11 when publish fails and delivery falls back to local, a localOnly handler still runs once per emit', async () =>
    {
        const client = {
            publish: vi.fn().mockRejectedValue(new Error('redis down')),
            duplicate: vi.fn().mockReturnValue({ subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() }),
            subscribe: vi.fn(),
            on: vi.fn(),
        };
        const event = defineEvent('test.local', schema);
        await event.useCache(createRedisPubSubCache(client as any, 'spfn:sse:'));
        const local = vi.fn();
        const plain = vi.fn();
        event.subscribe(local, { localOnly: true });
        event.subscribe(plain);

        await event.emit({ n: 1 });
        await event.emit({ n: 2 });
        await flush();

        expect(client.publish).toHaveBeenCalled();
        expect(local.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }]]);
        expect(plain.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    });
});

describe('wireEventRouterCache', () =>
{
    it('stays in-process when multiInstance is disabled', async () =>
    {
        const router = defineEventRouter({
            ping: defineEvent('ping', Type.Object({})),
        });

        const transport = await wireEventRouterCache(router, { multiInstance: false });

        expect(transport).toBe('in-process');
    });

    it('stays in-process when no cache is configured', async () =>
    {
        const router = defineEventRouter({
            ping: defineEvent('ping', Type.Object({})),
        });

        // getCache mock returns undefined → falls back to in-process.
        const transport = await wireEventRouterCache(router);

        expect(transport).toBe('in-process');
    });

    it('wires events to redis when a cache is present and dedups a shared event across routers', async () =>
    {
        const bus = new FakeBus();
        const client = new FakeRedis(bus);
        const duplicateSpy = vi.spyOn(client, 'duplicate');
        (getCache as unknown as Mock).mockReturnValue(client);

        // Same event instance registered on two routers (SSE + WS).
        const shared = defineEvent('sharedEvt', Type.Object({ n: Type.Number() }));
        const sseRouter = defineEventRouter({ shared });
        const wsRouter = defineEventRouter({ shared });

        expect(await wireEventRouterCache(sseRouter)).toBe('redis');
        expect(await wireEventRouterCache(wsRouter)).toBe('redis');

        // Shared event wired exactly once → one subscriber connection, not two.
        expect(duplicateSpy).toHaveBeenCalledTimes(1);

        const received: { n: number }[] = [];
        shared.subscribe((payload) =>
        {
            received.push(payload);
        });

        await shared.emit({ n: 5 });
        await flush();

        expect(received).toEqual([{ n: 5 }]);
    });

    it('rebinds events to a fresh cache after closeEventTransport (same-process restart)', async () =>
    {
        // Server #1: wire with client C1.
        const client1 = new FakeRedis(new FakeBus());
        (getCache as unknown as Mock).mockReturnValue(client1);

        const evt = defineEvent('restartEvt', Type.Object({ n: Type.Number() }));
        const router = defineEventRouter({ evt });
        expect(await wireEventRouterCache(router)).toBe('redis');

        // Shutdown server #1 (clears transport state AND resets the EventDef binding).
        await closeEventTransport();

        // Server #2: a brand-new client C2 (C1 is gone).
        const bus2 = new FakeBus();
        const client2 = new FakeRedis(bus2);
        (getCache as unknown as Mock).mockReturnValue(client2);
        expect(await wireEventRouterCache(router)).toBe('redis');

        const pub1 = vi.spyOn(client1, 'publish');
        const pub2 = vi.spyOn(client2, 'publish');

        const received: { n: number }[] = [];
        evt.subscribe((payload) =>
        {
            received.push(payload);
        });

        await evt.emit({ n: 7 });
        await flush();

        // Rebound to C2 — without _resetCache the event would stay latched on dead C1.
        expect(pub2).toHaveBeenCalled();
        expect(pub1).not.toHaveBeenCalled();
        expect(received).toEqual([{ n: 7 }]);
    });

    it('keeps the first wiring channelPrefix process-global (a later, different prefix is ignored)', async () =>
    {
        const client = new FakeRedis(new FakeBus());
        const pubSpy = vi.spyOn(client, 'publish');
        (getCache as unknown as Mock).mockReturnValue(client);

        const e1 = defineEvent('pfx1', Type.Object({}));
        const e2 = defineEvent('pfx2', Type.Object({}));

        await wireEventRouterCache(defineEventRouter({ e1 }), { channelPrefix: 'app-a:' });
        await wireEventRouterCache(defineEventRouter({ e2 }), { channelPrefix: 'app-b:' });

        await e2.emit({});

        // e2 publishes on the FIRST prefix (app-a:), not its own app-b: — process-global.
        expect(pubSpy).toHaveBeenCalledWith('app-a:pfx2', expect.any(String));
    });

    it('degrades a single event to in-process when its useCache rejects, without throwing', async () =>
    {
        const client = new FakeRedis(new FakeBus());
        (getCache as unknown as Mock).mockReturnValue(client);

        const ok = defineEvent('okEvt', Type.Object({}));
        const bad = defineEvent('badEvt', Type.Object({}));
        // Force this event's wiring to fail at subscribe time.
        bad.useCache = vi.fn().mockRejectedValue(new Error('SUBSCRIBE failed')) as typeof bad.useCache;

        const router = defineEventRouter({ ok, bad });

        // Must not throw — startup survives a per-event SUBSCRIBE failure.
        await expect(wireEventRouterCache(router)).resolves.toBe('redis');
    });

    it('returns in-process (not a false redis) when every event degrades', async () =>
    {
        const client = new FakeRedis(new FakeBus());
        (getCache as unknown as Mock).mockReturnValue(client);

        const a = defineEvent('allBadA', Type.Object({}));
        const b = defineEvent('allBadB', Type.Object({}));
        a.useCache = vi.fn().mockRejectedValue(new Error('SUBSCRIBE failed')) as typeof a.useCache;
        b.useCache = vi.fn().mockRejectedValue(new Error('SUBSCRIBE failed')) as typeof b.useCache;

        // No event wired → honest 'in-process', not a misleading 'redis'.
        await expect(wireEventRouterCache(defineEventRouter({ a, b }))).resolves.toBe('in-process');
    });
});

describe('useCache failure recovery', () =>
{
    it('leaves the event in-process after a failed useCache and allows a later retry', async () =>
    {
        const event = defineEvent('retryEvt', Type.Object({ n: Type.Number() }));

        const failingCache = {
            publish: vi.fn(),
            subscribe: vi.fn().mockRejectedValue(new Error('SUBSCRIBE failed')),
        };

        await expect(event.useCache(failingCache as any)).rejects.toThrow('SUBSCRIBE failed');

        // Degraded to in-process: emit reaches local handlers directly, not the cache.
        const received: { n: number }[] = [];
        event.subscribe((payload) =>
        {
            received.push(payload);
        });

        await event.emit({ n: 1 });
        await flush();

        expect(received).toEqual([{ n: 1 }]);
        expect(failingCache.publish).not.toHaveBeenCalled(); // never entered cache mode

        // Retry with a working cache succeeds — cacheSubscribed was not latched.
        const bus = new FakeBus();
        await event.useCache(createRedisPubSubCache(new FakeRedis(bus), 'spfn:sse:'));

        received.length = 0;
        await event.emit({ n: 2 });
        await flush();

        expect(received).toEqual([{ n: 2 }]); // now delivered via the cache round-trip
    });
});

describe('closeEventTransport', () =>
{
    it('quits the subscriber connection and is a no-op when none was opened', async () =>
    {
        const quit = vi.fn().mockResolvedValue('OK');
        const subscriber = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn(), quit };
        const client = {
            publish: vi.fn().mockResolvedValue(1),
            duplicate: vi.fn().mockReturnValue(subscriber),
            subscribe: vi.fn(),
            on: vi.fn(),
        };

        const stored: any[] = [];
        const cache = createRedisPubSubCache(client as any, 'spfn:sse:', (conn) =>
        {
            stored.push(conn);
        });

        // No subscriber until the first subscribe.
        expect(stored).toHaveLength(0);
        await cache.subscribe('chatChunk', () => undefined);
        expect(stored[0]).toBe(subscriber);

        // closeEventTransport only quits the singleton subscriber, not this local one,
        // so a bare call with nothing wired must not throw.
        await expect(closeEventTransport()).resolves.toBeUndefined();
    });

    it('does not hang shutdown when the subscriber quit() never resolves', async () =>
    {
        vi.useFakeTimers();

        const hangingSub = {
            subscribe: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
            quit: vi.fn(() => new Promise(() => undefined)), // never settles (wedged socket)
        };
        const client = new FakeRedis(new FakeBus());
        vi.spyOn(client, 'duplicate').mockReturnValue(hangingSub as any);
        (getCache as unknown as Mock).mockReturnValue(client);

        const evt = defineEvent('quitHang', Type.Object({}));
        await wireEventRouterCache(defineEventRouter({ evt }));

        const pending = closeEventTransport();
        await vi.advanceTimersByTimeAsync(5000); // trip the quit timeout
        await expect(pending).resolves.toBeUndefined(); // shutdown proceeds anyway

        expect(hangingSub.quit).toHaveBeenCalled();
    });
});
