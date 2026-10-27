/**
 * Revoking a device key closes the SSE streams it opened (#153) — the
 * registry, the token and the cross-pod half, through real handlers.
 *
 * | #   | state                                                        | action                         | expected                                                                 |
 * |-----|--------------------------------------------------------------|--------------------------------|--------------------------------------------------------------------------|
 * | R1  | user U, keys K1·K2, one stream each                          | `closeSSEConnectionsByKey(K1)` | K1 stream closed; K2 stream open, subscriptions intact, still receives frames |
 * | R2  | user U key K1, user V key K3                                 | close K1                       | V's stream open                                                          |
 * | R3  | key K1 with two streams                                      | close K1                       | both closed, count 2                                                     |
 * | R3' | key K1 stream the client is leaving at the same moment       | close K1                       | count 1, no throw, nothing unsubscribed twice                            |
 * | R4  | no streams                                                   | close K9                       | count 0, no throw                                                        |
 * | R5  | token consumed, stream not yet open (pending admission)      | close K1                       | stream ends at open: no `connected` frame, no subscription, registry 0   |
 * | R5b | token taken, `verifyKey` in flight (its read predates the revocation) | close K1, then `verifyKey` answers true | 200, ends at open: no `connected` frame, registry 0, pending 0 |
 * | R5c | token taken, `verifyKey` in flight                           | the client aborts              | the pending admission is cancelled: pending 0                            |
 * | R6  | after R1                                                     | close K1 again                 | count 0, no throw                                                        |
 * | R9  | `verifyKey` returns false                                    | consume                        | `null`; consumed (second consume `null`); 401 identical to an invalid token's, pending 0 |
 * | R10 | `verifyKey` throws                                           | consume                        | `null`, 401, the thrown text in neither the body nor the warning         |
 * | R11 | two handlers on two fake-Redis pods, K1 stream on pod B      | close published by pod A       | pod B's K1 stream closed                                                 |
 * | R12 | pod A receives its own `'close'` message                     | —                              | not applied: A's stream stays open                                       |
 * | R12'| malformed `'close'` messages (no `keyId`, wrong type)         | —                              | ignored, no throw                                                        |
 * | R13 | the cache's `publish` rejects with an error naming the key   | close                          | local stream closed, warn logged with no key id, promise resolves        |
 * | R13'| a cache whose `publish` rejects                              | `publishKeyClose`              | one warning: static message, `{ channel }` only; resolves                |
 * | R13b| the cache's `publish` rejects with an error naming the key   | `publishKeyClose`              | the warning carries no key id                                            |
 * | R13c| the transport client's `publish` rejects echoing the command | `closeSSEConnectionsByKey`     | resolves; the transport's warning carries no key id                      |
 * | R13d| a grant publish failed, the throttle window still open        | a close publish fails          | warned twice: no publish site silences another                           |
 * | R13e| the rejected error's `name` is the key id                    | `publishKeyClose`              | the warning carries no key id                                            |
 * | R13f| through the transport, an event publish failed, breaker cooldown elapsed, throttle window open | `closeSSEConnectionsByKey` | the `$control` failure is warned: an event's never silences it |
 * | R13g| the cache's `publish` rejects with an error naming the subject | `publishSubscriptionControl` | the warning carries no subject                                         |
 * | R13h| pod B has a K1 stream; pod A's breaker open after one failed emit | close K1 on pod A; cooldown elapses; no further traffic | the retry re-publishes; B's K1 stream closes; nothing pending |
 * | R13i| same, breaker open                                          | close K1; pod A emits (the half-open probe succeeds) before the retry | the flush delivers the close; B's stream closes  |
 * | R13j| Redis keeps failing                                         | close K1; the retry fires and fails | K1 still pending, retry re-armed, B's stream open; one deferral warning per window, no key id logged |
 * | R13k| breaker open                                                | close K1 twice, K2 once        | K1 held once and K2; after recovery each published once                  |
 * | R13l| breaker open                                                | 1001 distinct closes           | 1000 held, the oldest dropped, one warning with the count                |
 * | R13m| closes pending                                              | `closeEventTransport()`        | no timer left, nothing held; neither the old cache nor a later one sends them |
 * | R13n| breaker open, a K1 stream on this pod                       | `closeSSEConnectionsByKey(K1)` | this pod's K1 stream closes at once                                      |
 * | R14 | each store (memory, cache)                                   | `issue(subject, { keyId })` → consume | `keyId` round-trips; `verify` still returns the subject string    |
 *
 * Rows 7–8 (the token endpoint's `getKeyId`) are in `server/__tests__/sse-subscription-auth.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import {
    _pendingKeyCloses,
    _resetWarnThrottle,
    closeEventTransport,
    createRedisPubSubCache,
    publishKeyClose,
    publishSubscriptionControl,
    resolveEventPubSubCache,
} from '../../cache-transport';
import { FakeBus, FakeRedis } from '../../__tests__/fake-redis';
import { applyKeyClose } from '../key-close';
import { closeSSEConnectionsByKey } from '../close-by-key';
import { CacheTokenStore, SSETokenManager } from '../token-manager';
import { closeAllStreams, countSubscriptions, createStreamApp, until } from './stream-harness';

vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});
import { logger } from '@spfn/core/logger';

// No cache unless a row opts in: `closeSSEConnectionsByKey` resolves it lazily from here.
vi.mock('@spfn/core/cache', () => ({ getCache: vi.fn(() => undefined) }));
import { getCache } from '@spfn/core/cache';

const schema = Type.Object({ n: Type.Number() });

/** Fresh events per case: `e` is the event under test. */
function events()
{
    const e = defineEvent('test.key.e', schema);

    return { e, router: defineEventRouter({ e }) };
}

/** A `verifyKey` that stays pending until the test calls `release(holds)`; `entered` resolves on its call. */
function pendingKeyCheck()
{
    const gate: { release?: (holds: boolean) => void; entered?: () => void } = {};
    const entered = new Promise<void>((resolve) =>
    {
        gate.entered = resolve;
    });
    const verifyKey = vi.fn(() =>
    {
        gate.entered!();

        return new Promise<boolean>((resolve) =>
        {
            gate.release = resolve;
        });
    });

    return { verifyKey, entered, gate };
}

/** A `canSubscribe` that stays pending until the test calls `release(verdict)`. */
function pendingVerdict()
{
    const gate: { release?: (verdict: boolean) => void } = {};
    const predicate = () => new Promise<boolean>((resolve) =>
    {
        gate.release = resolve;
    });

    return { predicate, gate };
}

/** A Map-backed Redis stand-in for `CacheTokenStore`. */
class FakeCache
{
    store = new Map<string, string>();

    async set(key: string, value: string): Promise<void>
    {
        this.store.set(key, value);
    }

    async get(key: string): Promise<string | null>
    {
        return this.store.get(key) ?? null;
    }

    async getdel(key: string): Promise<string | null>
    {
        const value = this.store.get(key) ?? null;
        this.store.delete(key);

        return value;
    }

    async del(...keys: string[]): Promise<number>
    {
        return keys.filter(key => this.store.delete(key)).length;
    }
}

beforeEach(() =>
{
    vi.clearAllMocks();
    _resetWarnThrottle();
});

afterEach(async () =>
{
    vi.useRealTimers();
    await closeAllStreams();
    await closeEventTransport();
    (getCache as unknown as Mock).mockReturnValue(undefined);
});

describe('closing the SSE streams of a device key', () =>
{
    it('R1 close K1: the K1 stream ends; the K2 stream of the same user stays open, subscribed, and receives frames', async () =>
    {
        const { e, router } = events();
        const subscriptions = countSubscriptions(e);
        const { handler, connect } = createStreamApp(router);
        const k1 = await connect('u', { keyId: 'K1', query: 'events=e' });
        const k2 = await connect('u', { keyId: 'K2', query: 'events=e' });
        await k1.frame('connected');
        await k2.frame('connected');

        await closeSSEConnectionsByKey('K1');
        await until(() => k1.ended());
        await e.emit({ n: 1 });

        expect((await k2.frame('e')).data.data).toEqual({ n: 1 });
        expect(k1.named('e')).toEqual([]);
        expect(subscriptions.live).toBe(1);
        expect(handler._openConnections('u')).toBe(1);
        expect(handler._openConnectionsByKey('K1')).toBe(0);
        expect(handler._openConnectionsByKey('K2')).toBe(1);
    });

    it('R2 close K1 of user U leaves user V\'s K3 stream open', async () =>
    {
        const { e, router } = events();
        const { handler, connect } = createStreamApp(router);
        const u = await connect('u', { keyId: 'K1', query: 'events=e' });
        const v = await connect('v', { keyId: 'K3', query: 'events=e' });
        await u.frame('connected');
        await v.frame('connected');

        await closeSSEConnectionsByKey('K1');
        await until(() => u.ended());
        await e.emit({ n: 1 });

        expect((await v.frame('e')).data.data).toEqual({ n: 1 });
        expect(v.ended()).toBe(false);
        expect(handler._openConnections('v')).toBe(1);
    });

    it('R3 close K1 with two K1 streams: both end, count 2, both indexes empty', async () =>
    {
        const { e, router } = events();
        const subscriptions = countSubscriptions(e);
        const { handler, connect } = createStreamApp(router);
        const first = await connect('u', { keyId: 'K1', query: 'events=e' });
        const second = await connect('u', { keyId: 'K1', query: 'events=e' });
        await first.frame('connected');
        await second.frame('connected');

        expect(applyKeyClose('K1')).toBe(2);
        await until(() => first.ended() && second.ended());

        expect(subscriptions.live).toBe(0);
        expect(handler._openConnections('u')).toBe(0);
        expect(handler._openConnectionsByKey('K1')).toBe(0);
    });

    it('R3\' a K1 stream the client is leaving at the same moment: count 1, no throw, nothing unsubscribed twice', async () =>
    {
        const { e, router } = events();
        const subscriptions = countSubscriptions(e);
        const { handler, connect } = createStreamApp(router);
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');

        const leaving = stream.close();
        expect(applyKeyClose('K1')).toBe(1);
        await leaving;

        expect(subscriptions.doubleUnsubscribes).toBe(0);
        expect(subscriptions.live).toBe(0);
        expect(handler._openConnectionsByKey('K1')).toBe(0);
        expect(applyKeyClose('K1')).toBe(0);
    });

    it('R4 close K9 with no stream: count 0, no throw, the promise resolves', async () =>
    {
        const { router } = events();
        createStreamApp(router);

        expect(applyKeyClose('K9')).toBe(0);
        await expect(closeSSEConnectionsByKey('K9')).resolves.toBeUndefined();
        expect(logger.info).not.toHaveBeenCalledWith('SSE connections closed', expect.anything());
    });

    it('R5 close K1 while its connect is still in admission: the stream ends at open with no frame, no subscription and no registry entry', async () =>
    {
        const { e, router } = events();
        const { predicate, gate } = pendingVerdict();
        e.canSubscribe(predicate);
        const subscriptions = countSubscriptions(e);
        const { handler, connect } = createStreamApp(router);

        const opening = connect('u', { keyId: 'K1', query: 'events=e' });
        await until(() => gate.release !== undefined);
        expect(handler._pendingAdmissions('u')).toBe(1);

        expect(applyKeyClose('K1')).toBe(0);
        gate.release!(true);
        const stream = await opening;
        await until(() => stream.ended());

        expect(stream.frames).toEqual([]);
        expect(subscriptions.live).toBe(0);
        expect(handler._pendingAdmissions('u')).toBe(0);
        expect(handler._openConnections('u')).toBe(0);
        expect(handler._openConnectionsByKey('K1')).toBe(0);
    });

    it('R5b close K1 while verifyKey is in flight: the stream ends at open with no connected frame, though the read taken before the revocation answers active', async () =>
    {
        const { router } = events();
        const { verifyKey, entered, gate } = pendingKeyCheck();
        const { handler, connect } = createStreamApp(router, {}, true, { verifyKey });

        const opening = connect('u', { keyId: 'K1', query: 'events=e' });
        await entered;
        expect(handler._pendingAdmissions('u')).toBe(1);

        await closeSSEConnectionsByKey('K1');
        gate.release!(true);
        const stream = await opening;
        await until(() => stream.ended());

        expect(stream.status).toBe(200);
        expect(stream.named('connected')).toEqual([]);
        expect(handler._openConnectionsByKey('K1')).toBe(0);
        expect(handler._pendingAdmissions('u')).toBe(0);
    });

    it('R5c the client aborts while verifyKey is in flight: the pending admission is cancelled', async () =>
    {
        const { router } = events();
        const { verifyKey, entered, gate } = pendingKeyCheck();
        const { handler, connect } = createStreamApp(router, {}, true, { verifyKey });
        const controller = new AbortController();

        const opening = connect('u', { keyId: 'K1', query: 'events=e', controller });
        await entered;
        expect(handler._pendingAdmissions('u')).toBe(1);

        controller.abort();
        expect(handler._pendingAdmissions('u')).toBe(0);
        gate.release!(true);
        await opening.catch(() => undefined);

        expect(handler._pendingAdmissions('u')).toBe(0);
        expect(handler._openConnections('u')).toBe(0);
    });

    it('R6 close K1 again after R1: count 0, no throw', async () =>
    {
        const { router } = events();
        const { handler, connect } = createStreamApp(router);
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');

        expect(applyKeyClose('K1')).toBe(1);
        await until(() => stream.ended());

        expect(applyKeyClose('K1')).toBe(0);
        expect(handler._openConnectionsByKey('K1')).toBe(0);
    });
});

describe('a token minted before its key was revoked', () =>
{
    it('R9 verifyKey false: consume is null, the token is gone (a second consume is null, no second check), the stream answers 401', async () =>
    {
        const verifyKey = vi.fn(() => false);
        const manager = new SSETokenManager({ ttl: 5000, verifyKey });
        const token = await manager.issue('u', { keyId: 'K1' });

        expect(await manager.consume(token)).toBeNull();
        expect(await manager.consume(token)).toBeNull();
        expect(verifyKey).toHaveBeenCalledTimes(1);
        expect(verifyKey).toHaveBeenCalledWith('K1');
        manager.destroy();

        const { router } = events();
        const { app, handler, connect } = createStreamApp(router, {}, true, { verifyKey });
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        const invalid = await app.request('/events/stream?events=e&token=not-a-token');

        expect(stream.status).toBe(401);
        expect(JSON.stringify(stream.body)).toBe(await invalid.text());
        expect(handler._pendingAdmissions('u')).toBe(0);
    });

    it('R10 verifyKey throws: consume is null, the stream answers 401, the thrown text is in neither the body nor the warning', async () =>
    {
        const verifyKey = vi.fn(() =>
        {
            throw new Error('row-detail-from-the-verifier');
        });
        const manager = new SSETokenManager({ ttl: 5000, verifyKey });

        expect(await manager.consume(await manager.issue('u', { keyId: 'K1' }))).toBeNull();
        manager.destroy();

        const { router } = events();
        const stream = await createStreamApp(router, {}, true, { verifyKey }).connect('u', { keyId: 'K1', query: 'events=e' });

        expect(stream.status).toBe(401);
        expect(JSON.stringify(stream.body)).not.toContain('row-detail-from-the-verifier');
        expect(logger.warn).toHaveBeenCalledWith('SSE token key check threw — token refused');
        expect(JSON.stringify((logger.warn as Mock).mock.calls)).not.toContain('row-detail-from-the-verifier');
    });

    it('R14 each store round-trips keyId through issue → consume; verify still answers the subject string', async () =>
    {
        for (const store of [undefined, new CacheTokenStore(new FakeCache())])
        {
            const manager = new SSETokenManager({ ttl: 5000, store });

            const consumed = await manager.consume(await manager.issue('u', { keyId: 'K1' }));
            const verified = await manager.verify(await manager.issue('u', { keyId: 'K1' }));

            expect(consumed).toMatchObject({ subject: 'u', keyId: 'K1' });
            expect(verified).toBe('u');
            manager.destroy();
        }
    });
});

describe('closing across pods', () =>
{
    /** Two pods on one fake Redis bus, each with its own events and handler. */
    async function twoPods()
    {
        const bus = new FakeBus();
        const clientA = new FakeRedis(bus);
        const podA = { ...events(), cache: createRedisPubSubCache(clientA, 'test:') };
        const podB = { ...events(), cache: createRedisPubSubCache(new FakeRedis(bus), 'test:') };
        await podA.e.useCache(podA.cache);
        await podB.e.useCache(podB.cache);

        return { bus, clientA, podA, podB };
    }

    /**
     * Two pods, a K1 stream on pod B, and pod A's breaker open: its emit failed
     * once (or every time, with `failing: 'always'`). Fake `Date` and `setTimeout`
     * drive the breaker window and the retry; the caller restores real timers
     * before `until`, whose deadline reads `Date`.
     */
    async function podAWithBreakerOpen(failing: 'once' | 'always' = 'once')
    {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const pods = await twoPods();
        const app = createStreamApp(pods.podB.router);
        const stream = await app.connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');
        const publish = vi.spyOn(pods.clientA, 'publish');
        if (failing === 'once')
        {
            publish.mockRejectedValueOnce(new Error('redis down'));
        }
        else
        {
            publish.mockRejectedValue(new Error('ERR publish {"kind":"close","keyId":"K1"} rejected'));
        }

        await pods.podA.e.emit({ n: 1 }); // fails → breaker open for the cooldown

        return { ...pods, handler: app.handler, stream, publish };
    }

    /** The key ids pod A's client published on `$control`, in order. */
    function publishedCloses(publish: Mock): string[]
    {
        return publish.mock.calls
            .filter(([channel]) => String(channel).endsWith('$control'))
            .map(([, raw]) => JSON.parse(raw).keyId);
    }

    /** Let the bus deliveries and stream writes run, without reading `Date`. */
    async function settle(): Promise<void>
    {
        for (let i = 0; i < 20; i++)
        {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    function warnings(message: string): unknown[][]
    {
        return (logger.warn as Mock).mock.calls.filter(([logged]) => logged === message);
    }

    // Published straight from pod A's binding, without its local pass: one
    // process holds both pods, so a local pass would close pod B's stream too.
    it('R11 a close published by pod A reaches pod B through the bus: B\'s K1 stream ends', async () =>
    {
        const { podA, podB } = await twoPods();
        const { handler, connect } = createStreamApp(podB.router);
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');

        await publishKeyClose(podA.cache, 'K1');
        await until(() => stream.ended());

        expect(handler._openConnectionsByKey('K1')).toBe(0);
    });

    // Pod A alone on the bus: any other pod would apply A's message process-wide.
    it('R12 pod A\'s own close message coming back is skipped: A\'s stream stays open', async () =>
    {
        const podA = { ...events(), cache: createRedisPubSubCache(new FakeRedis(new FakeBus()), 'test:') };
        await podA.e.useCache(podA.cache);
        const { handler, connect } = createStreamApp(podA.router);
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');

        await publishKeyClose(podA.cache, 'K1');
        await podA.e.emit({ n: 1 });

        expect((await stream.frame('e')).data.data).toEqual({ n: 1 });
        expect(stream.ended()).toBe(false);
        expect(handler._openConnectionsByKey('K1')).toBe(1);
    });

    it('R12\' a close message without a keyId, or with a keyId that is no string, is ignored', async () =>
    {
        const { bus, podB } = await twoPods();
        const { handler, connect } = createStreamApp(podB.router);
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');

        bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', kind: 'close' }));
        bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', kind: 'close', keyId: 1 }));
        await podB.e.emit({ n: 1 });

        expect((await stream.frame('e')).data.data).toEqual({ n: 1 });
        expect(handler._openConnectionsByKey('K1')).toBe(1);
    });

    it('R13 the cache\'s publish rejects: the local stream still closes, a warning is logged, the promise resolves', async () =>
    {
        (getCache as unknown as Mock).mockReturnValue({
            publish: vi.fn().mockRejectedValue(new Error('ERR publish rejected for K1')),
            duplicate: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
        });
        const { router } = events();
        const { handler, connect } = createStreamApp(router);
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');

        await expect(closeSSEConnectionsByKey('K1')).resolves.toBeUndefined();
        await until(() => stream.ended());

        expect(handler._openConnectionsByKey('K1')).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith('Pub/sub publish failed — local delivery only', expect.anything());
        expect(JSON.stringify((logger.warn as Mock).mock.calls)).not.toContain('K1');
    });

    it('R13\' publishKeyClose on a cache whose publish rejects: warned, resolves', async () =>
    {
        const cache = { publish: vi.fn().mockRejectedValue(new Error('redis down')), subscribe: vi.fn() };

        await expect(publishKeyClose(cache, 'K1')).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('SSE key close publish failed — closed on this pod only', { channel: '$control' });
    });

    it('R13b: a close publish failure never logs the key id from the transport error', async () =>
    {
        const cache = { publish: vi.fn().mockRejectedValue(new Error('publish failed for K1')), subscribe: vi.fn() };

        await publishKeyClose(cache, 'K1');

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify((logger.warn as Mock).mock.calls)).not.toContain('K1');
    });

    it('R13c: closeSSEConnectionsByKey through the cache transport logs no key id when the transport publish fails', async () =>
    {
        (getCache as unknown as Mock).mockReturnValue({
            publish: vi.fn().mockRejectedValue(new Error('ERR publish {"kind":"close","keyId":"K1"} rejected')),
            duplicate: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
        });

        await expect(closeSSEConnectionsByKey('K1')).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalled();
        expect(JSON.stringify((logger.warn as Mock).mock.calls)).not.toContain('K1');
    });

    it('R13d: a grant publish failure does not silence a close publish failure in the same throttle window', async () =>
    {
        const cache = { publish: vi.fn().mockRejectedValue(new Error('redis down')), subscribe: vi.fn() };

        await publishSubscriptionControl(cache, 'grant', 'test.key.e', 'u');
        await publishKeyClose(cache, 'K1');

        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenLastCalledWith('SSE key close publish failed — closed on this pod only', { channel: '$control' });
    });

    it('R13e: a rejected error whose name is the key id never reaches the warning', async () =>
    {
        const error = new Error('redis down');
        error.name = 'K1';
        const cache = { publish: vi.fn().mockRejectedValue(error), subscribe: vi.fn() };

        await publishKeyClose(cache, 'K1');

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify((logger.warn as Mock).mock.calls)).not.toContain('K1');
    });

    it('R13f: through the transport, an event publish failure does not silence a later key-close publish failure', async () =>
    {
        (getCache as unknown as Mock).mockReturnValue({
            publish: vi.fn().mockRejectedValue(new Error('redis down')),
            duplicate: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
        });
        vi.useFakeTimers({ toFake: ['Date'] });
        const cache = (await resolveEventPubSubCache())!;

        await cache.publish('chat.message', { text: 'hi' }); // event publish fails → warn #1, breaker 10s
        vi.setSystemTime(Date.now() + 11_000);              // breaker cooldown elapsed, throttle window (30s) not
        await closeSSEConnectionsByKey('K1');               // half-open probe on $control fails

        const channels = (logger.warn as Mock).mock.calls.map(call => call[1]?.channel);
        expect(channels.some(channel => String(channel).endsWith('$control'))).toBe(true);
    });

    it('R13g: a grant publish failure never logs the subject from the cache\'s error', async () =>
    {
        const cache = { publish: vi.fn().mockRejectedValue(new Error('publish failed for subject user-42')), subscribe: vi.fn() };

        await publishSubscriptionControl(cache, 'grant', 'test.key.e', 'user-42');

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify((logger.warn as Mock).mock.calls)).not.toContain('user-42');
    });

    it('R13h: a close deferred while pod A\'s breaker is open is re-sent when the cooldown ends, with no other traffic', async () =>
    {
        const { podA, handler, stream, publish } = await podAWithBreakerOpen();

        await publishKeyClose(podA.cache, 'K1');   // breaker open → skipped, held
        expect(_pendingKeyCloses(podA.cache)).toEqual(['K1']);
        await vi.advanceTimersByTimeAsync(11_000);  // the retry is the half-open probe, and succeeds
        vi.useRealTimers();
        await until(() => stream.ended());

        expect(handler._openConnectionsByKey('K1')).toBe(0);
        expect(_pendingKeyCloses(podA.cache)).toEqual([]);
        expect(publishedCloses(publish)).toEqual(['K1']);
    });

    it('R13i: a close deferred while the breaker is open goes out with pod A\'s next successful publish, before the retry', async () =>
    {
        const { podA, handler, stream, publish } = await podAWithBreakerOpen();

        await publishKeyClose(podA.cache, 'K1');
        vi.setSystemTime(Date.now() + 10_100);     // cooldown over, the retry (10.5 s) not yet due
        await podA.e.emit({ n: 2 });                // the half-open probe succeeds → flush
        await settle();

        expect(publishedCloses(publish)).toEqual(['K1']);
        expect(_pendingKeyCloses(podA.cache)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);         // nothing left to retry
        vi.useRealTimers();
        await until(() => stream.ended());
        expect(handler._openConnectionsByKey('K1')).toBe(0);
    });

    it('R13j: while Redis keeps failing, the close stays held and the retry re-arms; one warning per window, no key id', async () =>
    {
        const { podA, handler, stream } = await podAWithBreakerOpen('always');

        await publishKeyClose(podA.cache, 'K1');
        await vi.advanceTimersByTimeAsync(11_000);  // retry: the probe fails
        await vi.advanceTimersByTimeAsync(11_000);  // and again, still inside the 30 s warn window
        await settle();

        expect(_pendingKeyCloses(podA.cache)).toEqual(['K1']);
        expect(vi.getTimerCount()).toBe(1);         // one retry armed, no storm
        expect(stream.ended()).toBe(false);
        expect(handler._openConnectionsByKey('K1')).toBe(1);
        expect(warnings('SSE key close deferred — re-sent when the pub/sub transport recovers')).toHaveLength(1);
        const logged = JSON.stringify([logger.warn, logger.info, logger.debug, logger.error].map(log => (log as Mock).mock.calls));
        expect(logged).not.toContain('K1');
    });

    it('R13k: a key closed twice while the breaker is open is held once, and each held key is published once on recovery', async () =>
    {
        const { podA, publish } = await podAWithBreakerOpen();

        await publishKeyClose(podA.cache, 'K1');
        await publishKeyClose(podA.cache, 'K1');
        await publishKeyClose(podA.cache, 'K2');
        expect(_pendingKeyCloses(podA.cache)).toEqual(['K1', 'K2']);
        await vi.advanceTimersByTimeAsync(11_000);
        await settle();

        expect(publishedCloses(publish)).toEqual(['K1', 'K2']);
        expect(_pendingKeyCloses(podA.cache)).toEqual([]);
    });

    it('R13l: past 1000 held closes the oldest is dropped, with one warning giving the count', async () =>
    {
        const { podA } = await podAWithBreakerOpen();

        for (let i = 0; i <= 1000; i++)
        {
            await publishKeyClose(podA.cache, `K${i}`);
        }

        const held = _pendingKeyCloses(podA.cache);
        expect(held).toHaveLength(1000);
        expect(held[0]).toBe('K1');
        expect(held).not.toContain('K0');
        expect(warnings('SSE key closes dropped — too many waiting to be re-sent')).toEqual([
            ['SSE key closes dropped — too many waiting to be re-sent', { dropped: 1 }],
        ]);
    });

    it('R13m: closeEventTransport drops held closes and their retry; neither the old cache nor a later one sends them', async () =>
    {
        const { clientA, podA, stream, publish } = await podAWithBreakerOpen();
        await publishKeyClose(podA.cache, 'K1');

        await closeEventTransport();

        expect(vi.getTimerCount()).toBe(0);
        expect(_pendingKeyCloses(podA.cache)).toEqual([]);
        await vi.advanceTimersByTimeAsync(11_000);
        await podA.e.emit({ n: 2 });                // the old cache publishes fine again
        const later = createRedisPubSubCache(clientA, 'test:');
        await later.publish('test.key.e', { n: 3 });
        await settle();
        expect(publishedCloses(publish)).toEqual([]);
        expect(stream.ended()).toBe(false);
    });

    it('R13n: with the breaker open, closeSSEConnectionsByKey still closes this pod\'s own K1 stream at once', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const client = new FakeRedis(new FakeBus());
        vi.spyOn(client, 'publish').mockRejectedValueOnce(new Error('redis down'));
        (getCache as unknown as Mock).mockReturnValue(client);
        const cache = (await resolveEventPubSubCache())!;
        await cache.publish('test.key.e', { n: 1 }); // fails → breaker open
        const { router } = events();
        const { handler, connect } = createStreamApp(router);
        const stream = await connect('u', { keyId: 'K1', query: 'events=e' });
        await stream.frame('connected');

        await closeSSEConnectionsByKey('K1');
        vi.useRealTimers();
        await until(() => stream.ended());

        expect(handler._openConnectionsByKey('K1')).toBe(0);
    });
});
