/**
 * Event cache transport (Redis/Valkey pub/sub)
 *
 * Wires each event in a router to a shared {@link PubSubCache} so that an
 * `emit` on one pod fans out to subscribers on every pod. This is the runtime
 * glue behind `EventDef.useCache` — applications don't call it directly; the
 * server's `.events()` / `.websockets()` registration calls it at startup when
 * a cache (`CACHE_URL`) is configured. Without a cache, events stay in-process
 * and this is a no-op.
 *
 * Mirrors the auto-detection pattern used by `CacheTokenStore` for SSE tokens.
 */

import { logger } from '@spfn/core/logger';
import type { EventRouterBase } from './router';
import type { PubSubCache } from './types';

const transportLogger = logger.child('@spfn/core:event-transport');

/** Default channel prefix; isolates SPFN event channels from other Redis keys. */
const DEFAULT_CHANNEL_PREFIX = 'spfn:sse:';

/** Cap on the subscriber `quit()` during shutdown so a wedged socket can't stall it. */
const SUBSCRIBER_QUIT_TIMEOUT_MS = 5000;

/** Cap a Redis PUBLISH so a wedged socket (half-open, no FIN) can't hang `emit` forever. */
const PUBLISH_TIMEOUT_MS = 5000;

/** Cap a Redis SUBSCRIBE so a wedged socket can't hang server startup; degrades to in-process. */
const SUBSCRIBE_TIMEOUT_MS = 5000;

/** Fold repeated transport warnings during a sustained outage into one line per window. */
const WARN_THROTTLE_MS = 30000;

/**
 * After a publish failure, skip Redis entirely (deliver locally) for this long before
 * probing again. Without it, a streaming `emit` loop pays the full PUBLISH_TIMEOUT_MS per
 * chunk during a sustained outage (50 chunks × 5s = minutes of request hang).
 */
const PUBLISH_BREAKER_COOLDOWN_MS = 10000;

/**
 * Reject if `promise` doesn't settle within `ms`. ioredis has no command timeout by
 * default, so a half-open socket leaves publish/subscribe pending indefinitely; this
 * bounds it so the caller can fall back instead of hanging.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>
{
    return new Promise<T>((resolve, reject) =>
    {
        const timer = setTimeout(() =>
        {
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        timer.unref?.();

        promise.then(
            (value) =>
            {
                clearTimeout(timer);
                resolve(value);
            },
            (err) =>
            {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

const warnThrottle = new Map<string, { last: number; suppressed: number }>();

/**
 * Warn at most once per {@link WARN_THROTTLE_MS} per key, folding the suppressed count
 * into the next line — a sustained Redis outage must not flood logs (one WARN per emit
 * × a fast stream = thousands/sec).
 */
function throttledWarn(key: string, message: string, fields: Record<string, unknown>): void
{
    const now = Date.now();
    const entry = warnThrottle.get(key);

    if (entry && now - entry.last < WARN_THROTTLE_MS)
    {
        entry.suppressed++;

        return;
    }

    transportLogger.warn(message, entry && entry.suppressed > 0
        ? { ...fields, suppressedSinceLast: entry.suppressed }
        : fields);
    warnThrottle.set(key, { last: now, suppressed: 0 });
}

/**
 * Minimal pub/sub client interface (compatible with ioredis Redis | Cluster).
 * A duplicated connection is required for SUBSCRIBE — ioredis puts a connection
 * into subscriber mode, where regular commands are rejected.
 */
type PubSubClient = {
    publish(channel: string, message: string): Promise<unknown>;
    duplicate(): PubSubClient;
    subscribe(...channels: string[]): Promise<unknown>;
    on(event: string, listener: (...args: any[]) => void): unknown;
    quit?(): Promise<unknown>;
    /** ioredis connection status ('ready' | 'connecting' | 'close' | ...). */
    status?: string;
};

type MessageHandler = (message: unknown) => void | Promise<void>;

/** The slice of EventDef this module wires (kept minimal + duck-typed). */
type WirableEvent = {
    name: string;
    useCache: (cache: PubSubCache) => Promise<unknown>;
    _resetCache?: () => void;
};

// ── globalThis singleton ──────────────────────────────────────────
// Survives the CJS/ESM dual-package hazard (same pattern as cache-manager):
// one subscriber connection and one wired-event registry per process. The
// registry holds the EventDefs (not just names) so closeEventTransport can
// reset their cache binding — otherwise the per-event cacheSubscribed latch
// and this state would diverge across a restart in the same process.
interface TransportState
{
    pubSubCache: PubSubCache | undefined;
    subscriber: PubSubClient | undefined;
    channelPrefix: string | undefined;
    wired: Map<string, WirableEvent>;
}

const STATE_KEY = Symbol.for('@spfn/core:event-transport');

const state: TransportState = ((globalThis as any)[STATE_KEY] ??= {
    pubSubCache: undefined,
    subscriber: undefined,
    channelPrefix: undefined,
    wired: new Map<string, WirableEvent>(),
});

/**
 * Resolve the channel prefix: explicit option → env override → default.
 */
function resolveChannelPrefix(override?: string): string
{
    return override ?? process.env.SPFN_SSE_CHANNEL_PREFIX ?? DEFAULT_CHANNEL_PREFIX;
}

/**
 * Build a {@link PubSubCache} backed by a Redis/Valkey client.
 *
 * One duplicated connection is created lazily and shared across every channel.
 * Publish failures are logged and swallowed — SSE is lossy (at-most-once), so a
 * dropped event during a Redis blip must never crash `emit` or kill a stream.
 */
export function createRedisPubSubCache(
    client: PubSubClient,
    channelPrefix: string,
    onSubscriber?: (connection: PubSubClient) => void,
): PubSubCache
{
    let subscriber: PubSubClient | undefined;
    const handlers = new Map<string, MessageHandler>();
    // Circuit breaker: epoch-ms until which Redis is treated as down (skip publish).
    let degradedUntil = 0;

    const ensureSubscriber = (): PubSubClient =>
    {
        if (subscriber)
        {
            return subscriber;
        }

        // ioredis re-issues SUBSCRIBE after a reconnect (autoResubscribe, default
        // true). Don't pass it as a duplicate() option — Cluster.duplicate()'s
        // first positional arg is the startup-nodes array, so an options object
        // lands in the wrong slot and is silently dropped. The 'message' listener
        // is attached once and survives reconnects.
        subscriber = client.duplicate();
        onSubscriber?.(subscriber);

        subscriber.on('message', (channel: string, raw: string) =>
        {
            const handler = handlers.get(channel);
            if (!handler)
            {
                return;
            }

            let payload: unknown;
            try
            {
                payload = JSON.parse(raw);
            }
            catch
            {
                transportLogger.warn('Pub/sub message parse failed — dropped', { channel });

                return;
            }

            void handler(payload);
        });

        // ioredis auto-reconnects (and re-subscribes via autoResubscribe above);
        // surface the blip, throttled so a sustained outage's reconnect loop can't
        // flood logs.
        subscriber.on('error', (err: Error) =>
        {
            throttledWarn('subscriber-error', 'Pub/sub subscriber error', { error: err.message });
        });

        return subscriber;
    };

    // Deliver to this pod's own subscribers without the Redis round-trip — the
    // fallback when publish can't reach Redis. Mostly avoids double-delivery (a
    // failed publish usually means Redis never echoed back), but a reply-lost
    // race — Redis broadcast, then the publisher's reply dropped — can deliver
    // both here and via the echo. We accept that rare duplicate over dropping,
    // since SSE is lossy and a frozen stream is worse than a repeated chunk.
    // Same-pod subscribers are fed ONLY by the echo on the subscriber connection
    // (a separate socket from the write client). If it isn't connected, a successful
    // publish still won't reach this pod's own streams — so they need the local
    // fallback. A status-less subscriber (test mocks) is treated as healthy.
    const subscriberHealthy = (): boolean =>
        !!subscriber && (subscriber.status === undefined || subscriber.status === 'ready');

    const deliverLocal = (channel: string, message: unknown): void =>
    {
        const handler = handlers.get(channel);
        if (handler)
        {
            void handler(message);
        }
    };

    return {
        publish: async (name: string, message: unknown): Promise<void> =>
        {
            const channel = channelPrefix + name;

            // `string | undefined`: JSON.stringify returns undefined (no throw) for a
            // top-level function/symbol, and throws for bigint/circular. Both mean
            // "can't cross Redis" — handle each as a local-only delivery.
            let serialized: string | undefined;
            try
            {
                // `?? null` so void-payload events serialize to "null" rather than
                // `undefined` (JSON.stringify(undefined) → undefined → publish breaks).
                serialized = JSON.stringify(message ?? null);
            }
            catch (err)
            {
                // Non-serializable payload (bigint, circular ref). Cross-pod is
                // impossible; deliver the live object locally (best effort — a
                // downstream JSON.stringify may re-throw, but better than dropping).
                transportLogger.warn('Pub/sub payload serialization failed — local delivery only', {
                    channel,
                    error: err instanceof Error ? err.message : String(err),
                });
                deliverLocal(channel, message ?? null);

                return;
            }

            if (serialized === undefined)
            {
                // Top-level function/symbol payload — JSON.stringify yields undefined.
                // Publishing that is meaningless and re-parsing it later would throw,
                // so deliver locally and stop (guards the "publish never kills emit").
                transportLogger.warn('Pub/sub payload not serializable (function/symbol) — local delivery only', {
                    channel,
                });
                deliverLocal(channel, message ?? null);

                return;
            }

            // Skip Redis when the breaker is open (recent failure) or the client isn't
            // connected. This (a) bounds a sustained outage to one timeout per cooldown
            // instead of one per emit, and (b) avoids ioredis's offline queue buffering
            // the publish and re-sending it on reconnect — which would deliver the event
            // twice (local fallback now + echo later). Treat a status-less client (test
            // mocks) as ready so behavior is unchanged there.
            const ready = client.status === undefined || client.status === 'ready';
            const now = Date.now();
            if (!ready || (degradedUntil > 0 && now < degradedUntil))
            {
                // Not connected, or breaker open → skip Redis, deliver locally.
                deliverLocal(channel, JSON.parse(serialized));

                return;
            }

            // Healthy (degradedUntil === 0) → publish directly; concurrent emits all
            // fan out. Half-open (breaker tripped but cooldown elapsed) → this emit is
            // the single probe: arm the breaker for the probe's duration so CONCURRENT
            // emits fast-path to local instead of each launching their own 5s probe.
            if (degradedUntil > 0)
            {
                degradedUntil = now + PUBLISH_TIMEOUT_MS;
            }

            try
            {
                // Timeout-bound: a wedged socket would otherwise leave this pending
                // forever and hang `emit` (and the request that called it).
                await withTimeout(client.publish(channel, serialized), PUBLISH_TIMEOUT_MS, 'pub/sub publish');
                degradedUntil = 0; // success → close the breaker

                // Publish reached Redis (remote pods get it via their echo), but if THIS
                // pod's subscriber socket is down its echo won't arrive — cover same-pod
                // subscribers locally. No double-delivery: Redis doesn't buffer for a
                // disconnected subscriber, so the missed echo never arrives later.
                if (!subscriberHealthy())
                {
                    throttledWarn('subscriber-down', 'Subscriber connection down — same-pod local fallback', {
                        channel,
                    });
                    deliverLocal(channel, JSON.parse(serialized));
                }
            }
            catch (err)
            {
                // Redis blip/timeout: open the breaker so subsequent emits fast-path to
                // local delivery instead of each paying the timeout. The cross-pod echo
                // won't arrive, so deliver to this pod's subscribers directly. Parse the
                // serialized copy so handlers see the SAME shape as the echo path (a JSON
                // round-trip), never the live mutable object. Throttled WARN — a sustained
                // outage emits one line per window, not one per chunk.
                degradedUntil = Date.now() + PUBLISH_BREAKER_COOLDOWN_MS;
                throttledWarn('publish-failed', 'Pub/sub publish failed — local delivery only', {
                    channel,
                    error: err instanceof Error ? err.message : String(err),
                });
                deliverLocal(channel, JSON.parse(serialized));
            }
        },

        subscribe: async (name: string, handler: MessageHandler): Promise<void> =>
        {
            const channel = channelPrefix + name;
            const sub = ensureSubscriber();

            try
            {
                // Timeout-bound: at startup this is awaited before the HTTP listener,
                // so a wedged subscriber would otherwise hang the entire boot.
                await withTimeout(sub.subscribe(channel), SUBSCRIBE_TIMEOUT_MS, 'pub/sub subscribe');
            }
            catch (err)
            {
                // SUBSCRIBE failed. If nothing else is live on this connection it
                // may be half-open — drop the memo (and quit it) so a later retry
                // rebuilds a fresh subscriber instead of reusing a dead one.
                if (handlers.size === 0 && subscriber === sub)
                {
                    subscriber = undefined;
                    void sub.quit?.().catch(() => undefined);
                }

                throw err;
            }

            // Register only after a confirmed subscribe — never leave a handler
            // bound to a channel the broker hasn't acknowledged.
            handlers.set(channel, handler);
        },
    };
}

/**
 * Options controlling event cache transport wiring.
 */
export interface WireEventCacheOptions
{
    /**
     * Force in-process mode even when a cache is configured.
     * @default true (auto: Redis when CACHE_URL is set, else in-process)
     */
    multiInstance?: boolean;

    /**
     * Channel prefix override (env `SPFN_SSE_CHANNEL_PREFIX`, else `spfn:sse:`).
     * Use distinct prefixes to isolate apps/tenants sharing one Redis.
     */
    channelPrefix?: string;
}

/**
 * Wire every event in a router to the shared Redis pub/sub cache.
 *
 * Returns the transport that ended up active. Idempotent per event name across
 * routers (an event shared by the SSE and WS routers is wired once), so it is
 * safe to call for both `.events()` and `.websockets()`.
 */
export async function wireEventRouterCache(
    router: EventRouterBase<any>,
    options: WireEventCacheOptions = {},
): Promise<'in-process' | 'redis'>
{
    // Logged at INFO (not debug): operators must be able to confirm from prod logs
    // whether cross-pod fan-out is actually live, and whether any event degraded.
    if (options.multiInstance === false)
    {
        // A sibling router may have already wired shared events to Redis — this flag
        // is process-global and can't un-wire them, so be honest about that.
        const events = router.events as Record<string, WirableEvent>;
        const stillRedis = Object.keys(events).filter(k => state.wired.has(events[k].name)).length;

        if (stillRedis > 0)
        {
            transportLogger.warn('multiInstance:false has no effect on events already wired to redis by another router', {
                redisWired: stillRedis,
            });
        }
        else
        {
            transportLogger.info('Event transport: in-process (multiInstance disabled)');
        }

        return 'in-process';
    }

    const pubSubCache = await resolvePubSubCache(options.channelPrefix);
    if (!pubSubCache)
    {
        transportLogger.info('Event transport: in-process (no cache configured)');

        return 'in-process';
    }

    const events = router.events as Record<string, WirableEvent>;
    let wired = 0;
    let degraded = 0;
    let alreadyWired = 0;

    for (const key of Object.keys(events))
    {
        const event = events[key];
        if (state.wired.has(event.name))
        {
            alreadyWired++; // e.g. an event shared by the SSE and WS routers
            continue;
        }

        try
        {
            await event.useCache(pubSubCache);
            state.wired.set(event.name, event);
            wired++;
        }
        catch (err)
        {
            // Degrade this event to in-process rather than aborting startup — a
            // transient SUBSCRIBE failure must not crash the pod. Not marked
            // wired, so a later wiring pass can retry it.
            degraded++;
            transportLogger.warn('Event cache wiring failed — staying in-process for this event', {
                event: event.name,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Every event degraded (and none were already wired) → fan-out is effectively
    // dead for this router; report in-process honestly instead of a false 'redis'.
    if (wired + alreadyWired === 0)
    {
        transportLogger.warn('Event transport: redis configured but no event wired — running in-process', {
            total: Object.keys(events).length,
            degraded,
        });

        return 'in-process';
    }

    transportLogger.info('Event transport: redis (cross-pod fan-out)', {
        total: Object.keys(events).length,
        wired,
        degraded,
        alreadyWired,
    });

    return 'redis';
}

/**
 * Resolve (and cache) the shared pub/sub cache from the global cache instance.
 * Returns undefined when no cache is available.
 */
async function resolvePubSubCache(channelPrefix?: string): Promise<PubSubCache | undefined>
{
    const resolvedPrefix = resolveChannelPrefix(channelPrefix);

    if (state.pubSubCache)
    {
        // The transport (and its prefix) is process-global, resolved once on the
        // first wiring. Warn if a later router (.websockets() after .events())
        // asks for a different prefix — it's silently ignored, not applied.
        if (state.channelPrefix !== resolvedPrefix)
        {
            transportLogger.warn('Conflicting channelPrefix ignored — the transport prefix is process-global (first wiring wins).', {
                active: state.channelPrefix,
                ignored: resolvedPrefix,
            });
        }

        return state.pubSubCache;
    }

    let client: PubSubClient | undefined;
    try
    {
        const { getCache } = await import('@spfn/core/cache');
        client = getCache() as PubSubClient | undefined;
    }
    catch
    {
        // Cache module unavailable — fall back to in-process.
        return undefined;
    }

    if (!client)
    {
        return undefined;
    }

    // Cross-app isolation depends on the channel prefix. The default is shared by
    // every SPFN app, so warn (once, on first resolve) when running on it — apps
    // sharing one Redis with colliding event names would otherwise leak payloads.
    if (!channelPrefix && !process.env.SPFN_SSE_CHANNEL_PREFIX)
    {
        transportLogger.warn(
            'Event fan-out is on the default channel prefix (spfn:sse:). Apps sharing one '
            + 'Redis must set channelPrefix or SPFN_SSE_CHANNEL_PREFIX to avoid cross-app leakage.',
        );
    }

    state.channelPrefix = resolvedPrefix;
    state.pubSubCache = createRedisPubSubCache(
        client,
        resolvedPrefix,
        (connection) =>
        {
            state.subscriber = connection;
        },
    );

    return state.pubSubCache;
}

/**
 * Close the shared pub/sub subscriber connection and reset transport state.
 *
 * Called during graceful shutdown — the subscriber is a `duplicate()` of the
 * cache write connection and is not tracked by the cache manager, so it must be
 * quit explicitly (before `closeCache`). No-op when no subscriber was opened.
 *
 * Also resets each wired EventDef's cache binding. EventDefs are module
 * singletons that outlive a server instance; without this, a second server start
 * in the same process (tests, hot-reload) hits the `cacheSubscribed` latch, never
 * rebinds, and silently runs with cross-pod fan-out dead.
 */
export async function closeEventTransport(): Promise<void>
{
    const subscriber = state.subscriber;

    for (const event of state.wired.values())
    {
        event._resetCache?.();
    }

    state.subscriber = undefined;
    state.pubSubCache = undefined;
    state.channelPrefix = undefined;
    state.wired.clear();

    if (!subscriber?.quit)
    {
        return;
    }

    // Bound the quit: a wedged connection (broken socket, no FIN) must not stall
    // shutdown past this timeout — the process exits and the OS reclaims the socket.
    await Promise.race([
        subscriber.quit().catch(() => undefined),
        new Promise<void>((resolve) =>
        {
            const timer = setTimeout(resolve, SUBSCRIBER_QUIT_TIMEOUT_MS);
            timer.unref?.();
        }),
    ]);
}
