/**
 * SSE Handler for Hono
 *
 * Creates SSE stream endpoint for event subscription
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createSSEHandler } from '@spfn/core/event/sse';
 * import { eventRouter } from './events';
 *
 * const app = new Hono();
 *
 * // GET /events/stream?events=userCreated,orderPlaced
 * app.get('/events/stream', createSSEHandler(eventRouter));
 * ```
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import { logger } from '@spfn/core/logger';
import type { EventRouterDef } from '../router';
import type { EventDef, SubscribeContext, SubscribeRequest, SubscriptionMatch } from '../types';
import type { SSEHandlerConfig, SSEHandlerAuthConfig } from './types';
import type { SSETokenManager } from './token-manager';
import { createBoundedWriter } from './bounded-writer';
import type { BoundedWriter } from './bounded-writer';
import { createConnectionRegistry, unsubscribeAll } from './connection-registry';
import type { ConnectionRegistry, PendingAdmission, SSEConnection } from './connection-registry';

const sseLogger = logger.child('@spfn/core:sse');

/**
 * Serialize a fan-out frame once per (event, payload).
 *
 * One `emit` delivers the same payload object to every subscribed connection, so
 * without memoization each connection re-`JSON.stringify`s the identical payload
 * — O(N) for N subscribers on a hot broadcast. Keyed by the payload object
 * (WeakMap → auto-GC after the emit); primitives are cheap to stringify directly.
 */
const frameCache = new WeakMap<object, Map<string, string>>();

export function serializeFrame(eventName: string, payload: unknown): string
{
    if (payload === null || typeof payload !== 'object')
    {
        return JSON.stringify({ event: eventName, data: payload });
    }

    let byEvent = frameCache.get(payload);
    if (!byEvent)
    {
        byEvent = new Map<string, string>();
        frameCache.set(payload, byEvent);
    }

    let serialized = byEvent.get(eventName);
    if (serialized === undefined)
    {
        serialized = JSON.stringify({ event: eventName, data: payload });
        byEvent.set(eventName, serialized);
    }

    return serialized;
}

/** Default outbound queue cap per connection before a slow consumer is dropped. */
const DEFAULT_MAX_QUEUE = 1000;

// Extend Hono context with SSE subject
declare module 'hono'
{
    interface ContextVariableMap
    {
        sseSubject?: string;
    }
}

/**
 * Create SSE handler for Hono
 *
 * Query parameters:
 * - events: Comma-separated list of event names to subscribe
 * - token: One-time auth token (when auth is enabled)
 *
 * Who receives what, in order: the global `authorize` (once, at connect) →
 * each requested event's `.canSubscribe()` (once per event, at connect) → the
 * global `filter` map and the event's `.filter()` (sync, per frame). An event
 * denied at connect stays in `deniedEvents`, so `EventDef.grant` can activate
 * it later; `EventDef.revoke` deactivates an allowed one. The handler
 * registers that control on every event of the router.
 *
 * @example
 * ```typescript
 * app.get('/events/stream', createSSEHandler(eventRouter, {
 *     pingInterval: 30000,
 * }));
 * ```
 */
export function createSSEHandler<TRouter extends EventRouterDef<any>>(
    router: TRouter,
    config: SSEHandlerConfig = {},
    tokenManager?: SSETokenManager,
)
{
    const {
        // 10s — keep-alive가 중간 프록시(GCP LB/nginx)의 idle 타임아웃(흔히 ~15-30s)보다 자주 와야
        // 첫 ping 전 침묵 구간에 연결이 끊기지 않는다. 30s 기본은 idle 타임아웃보다 길어 SSE가
        // 데이터 없는 동안 끊기던 문제가 있었다.
        pingInterval = 10000,
        auth: authConfig,
        maxQueue = DEFAULT_MAX_QUEUE,
    } = config;

    const registry = createConnectionRegistry();
    registerSubscriptionControls(router, registry);

    const streamConfig: StreamConfig = { router, authConfig, registry, pingInterval, maxQueue };

    const handler = async (c: Context) =>
    {
        const admission = await admitConnection(c, streamConfig, tokenManager);
        if (admission instanceof Response)
        {
            return admission;
        }

        if (c.req.raw.signal.aborted)
        {
            // The client left during admission: nobody reads this response.
            // Its abort listener already cancelled `pending`; cancel is idempotent.
            admission.pending?.cancel();

            return new Response(null, { status: 499 });
        }

        // ── 6. SSE Stream ──
        c.header('X-Accel-Buffering', 'no');

        return streamSSE(c, stream => runStream(c, stream, admission, streamConfig), async (err: Error) =>
        {
            sseLogger.error('SSE stream error', {
                error: err.message,
            });
        });
    };

    return Object.assign(handler, {
        /** @internal Open registered connections of a subject (tests). */
        _openConnections: (subject: string): number => registry.count(subject),

        /** @internal Connects of a subject still in admission (tests). */
        _pendingAdmissions: (subject: string): number => registry.pendingCount(subject),
    });
}

// ============================================================================
// Connect
// ============================================================================

/** What a request that passed every connect check opens the stream with. */
interface Admission
{
    subject: string | undefined;
    requested: string[];
    allowed: string[];
    denied: string[];
    request: SubscribeRequest;

    /** What `resolvePrincipal` returned, for the initial pass; never logged. */
    principal: unknown;

    /** Registered before the first app-data read; `runStream` opens it. Absent without a subject. */
    pending?: PendingAdmission;
}

/** What every stream of one handler shares. */
interface StreamConfig
{
    router: EventRouterDef<any>;
    authConfig: SSEHandlerAuthConfig | undefined;
    registry: ConnectionRegistry;
    pingInterval: number;
    maxQueue: number;
}

/**
 * Let `EventDef.grant` / `revoke` reach this handler's connections, once per
 * router key (an event under two keys gets two controls, each naming its key).
 */
function registerSubscriptionControls(router: EventRouterDef<any>, registry: ConnectionRegistry): void
{
    for (const eventName of router.eventNames as string[])
    {
        router.events[eventName]._registerSubscriptionControl({
            grant: (subject: string, match?: SubscriptionMatch) => registry.grant(subject, eventName, match),
            revoke: (subject: string, match?: SubscriptionMatch) => registry.revoke(subject, eventName, match),
        });
    }
}

/**
 * Run the connect checks; a `Response` is the refusal to return.
 */
async function admitConnection(
    c: Context,
    config: StreamConfig,
    tokenManager: SSETokenManager | undefined,
): Promise<Admission | Response>
{
    const { router, authConfig, registry } = config;

    // ── 1. Token Authentication ──
    const subject = await authenticateToken(c, tokenManager);
    if (subject === false)
    {
        return c.json({ error: 'Missing token parameter' }, 401);
    }
    if (subject === null)
    {
        return c.json({ error: 'Invalid or expired token' }, 401);
    }
    if (subject)
    {
        c.set('sseSubject', subject);
    }

    // ── 2-3. Requested events, validated against the router ──
    const requested = parseRequestedEvents(c);
    if (!requested)
    {
        return c.json({ error: 'Missing events parameter' }, 400);
    }

    const validEventNames = router.eventNames as string[];
    const invalidEvents = requested.filter(e => !validEventNames.includes(e));
    if (invalidEvents.length > 0)
    {
        return c.json({
            error: 'Invalid event names',
            invalidEvents,
            validEvents: validEventNames,
        }, 400);
    }

    return whilePending(
        subject ? registry.beginAdmission(subject, c.req.raw.signal) : undefined,
        () => authorizeConnection(c, router, authConfig, subject, requested),
    );
}

/**
 * Run the app-data checks with the admission already registered — `pending`
 * is written synchronously, before the first `await`, so a `grant` / `revoke`
 * issued meanwhile is recorded on it. A refusal or a throw unregisters it; a
 * client abort already did, the moment it happened; an admitted connection
 * carries it to `runStream`.
 */
async function whilePending(
    pending: PendingAdmission | undefined,
    check: () => Promise<Admission | Response>,
): Promise<Admission | Response>
{
    let outcome: Admission | Response | undefined;

    try
    {
        outcome = await check();

        return outcome instanceof Response ? outcome : { ...outcome, pending };
    }
    finally
    {
        if (!outcome || outcome instanceof Response)
        {
            pending?.cancel();
        }
    }
}

/**
 * Steps 4-5: the global `authorize`, then the principal and each event's
 * `canSubscribe`. Only an empty `authorize` result or a failed principal
 * refuses; a `canSubscribe` denial only lands the event in `denied`.
 */
async function authorizeConnection(
    c: Context,
    router: EventRouterDef<any>,
    authConfig: SSEHandlerAuthConfig | undefined,
    subject: string | undefined,
    requested: string[],
): Promise<Admission | Response>
{
    // ── 4. Subscription Authorization ──
    const authorized = await authorizeEvents(subject, requested, authConfig);
    if (authorized === null)
    {
        return c.json({ error: 'Not authorized for any requested events' }, 403);
    }

    // ── 5. Principal + per-event canSubscribe ──
    const request: SubscribeRequest = { query: c.req.query(), headers: c.req.header() };
    const resolved = await resolveConnectionPrincipal(subject, request, authConfig);
    if (!resolved)
    {
        return c.json({ error: 'Principal could not be resolved' }, 403);
    }

    const allowed = subject
        ? await checkCanSubscribe(router, authorized, { subject, principal: resolved.principal, request })
        : authorized;
    const denied = requested.filter(e => !allowed.includes(e));

    sseLogger.debug('SSE connection requested', {
        events: allowed,
        deniedEvents: denied,
        subject: subject || undefined,
        clientIp: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    });

    return { subject, requested, allowed, denied, request, principal: resolved.principal };
}

/**
 * Resolve the principal once per connection; `null` refuses the connection.
 * The warning names the subject only — never the thrown error's text, which
 * may carry what the resolver read.
 */
async function resolveConnectionPrincipal(
    subject: string | undefined,
    request: SubscribeRequest,
    authConfig: SSEHandlerAuthConfig | undefined,
): Promise<{ principal: unknown } | null>
{
    if (!subject || !authConfig?.resolvePrincipal)
    {
        return { principal: undefined };
    }

    try
    {
        return { principal: await authConfig.resolvePrincipal(subject, request) };
    }
    catch
    {
        sseLogger.warn('SSE principal could not be resolved — connection refused', { subject });

        return null;
    }
}

/**
 * Ask each authorized event's `canSubscribe`, in parallel; returns the events
 * it allows. An event without a predicate is allowed.
 */
async function checkCanSubscribe(
    router: EventRouterDef<any>,
    events: string[],
    ctx: SubscribeContext,
): Promise<string[]>
{
    const verdicts = await Promise.all(events.map(eventName => askCanSubscribe(eventName, router.events[eventName], ctx)));

    return events.filter((_, i) => verdicts[i]);
}

/**
 * `true` → allowed; `false` or a throw → denied. A throw is warned with the
 * event name and never fails the connection.
 */
async function askCanSubscribe(
    eventName: string,
    eventDef: EventDef<any> | undefined,
    ctx: SubscribeContext,
): Promise<boolean>
{
    if (!eventDef)
    {
        return false;
    }

    if (!eventDef._canSubscribe)
    {
        return true;
    }

    try
    {
        return await eventDef._canSubscribe(ctx) === true;
    }
    catch
    {
        sseLogger.warn('SSE canSubscribe threw — event denied on this connection', {
            event: eventName,
            subject: ctx.subject,
        });

        return false;
    }
}

// ============================================================================
// Stream
// ============================================================================

/**
 * The life of one open connection: connected frame, subscriptions, initial
 * frames, registry entry, keep-alive, and teardown on disconnect or a
 * server-side close.
 */
async function runStream(
    c: Context,
    stream: SSEStreamingApi,
    admission: Admission,
    config: StreamConfig,
): Promise<void>
{
    const { allowed, denied, subject, request } = admission;
    let connectionDead = false;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    // Resolves the disconnect wait below when the connection is closed
    // server-side (overflow/error), so teardown doesn't wait for the loop.
    let onClosed: (() => void) | undefined;

    const cleanup = (reason?: string) =>
    {
        if (connectionDead) return;
        connectionDead = true;
        clearInterval(pingTimer);
        unsubscribeAll(connection);
        config.registry.remove(connection);
        writer.close();
        onClosed?.();
        sseLogger.info('SSE dead connection cleaned up', {
            events: [...connection.allowed],
            reason,
        });
    };

    // All writes go through one bounded, backpressure-aware drain loop so a
    // slow client can't pile frames up in memory (it's closed on overflow).
    const writer = createBoundedWriter(stream, config.maxQueue, (reason) =>
    {
        sseLogger.warn('SSE connection closed', { events: [...connection.allowed], reason });
        cleanup(reason);
    });

    // Every write after `connected` goes through `hold`, so the initial pass can
    // put `connected` and its frames ahead of whatever arrives while it runs.
    const hold = createFrameHold(writer);
    const subscriberContext: SubscriberContext = {
        router: config.router,
        authConfig: config.authConfig,
        subject,
        request,
        writeFrame: createFrameWriter(writer),
        send: hold.send,
        isDead: () => connectionDead,
    };

    const connection: SSEConnection = {
        subject,
        requested: admission.requested,
        allowed: new Set(allowed),
        denied: new Set(denied),
        unsubscribes: new Map(),
        request,
        subscribe: createEventSubscriber(subscriberContext),
        notify: (frame, eventName) =>
        {
            if (connectionDead) return;

            // A small literal — not routed through serializeFrame's per-payload cache.
            hold.send(() => writer.enqueue({ event: frame, data: JSON.stringify({ event: eventName }) }));
        },
    };

    // Synchronously before the `connected` frame: the changes recorded during
    // admission land in `allowed` / `denied` first, and the entry turns open.
    // A cancelled admission (the client left) opens nothing and sends no frame.
    // Defensive: unreachable today, since `streamSSE` runs this synchronously up
    // to here; the handler's `signal.aborted` → 499 check is the real path.
    if (admission.pending?.open(connection) === false)
    {
        cleanup('aborted during admission');

        return;
    }

    // Not awaited: a producer that hangs holds the frames, never the disconnect wait.
    void openSubscriptions(connection, writer, hold, {
        ...subscriberContext,
        principal: admission.principal,
    });

    // Keep-alive ping
    pingTimer = setInterval(() =>
    {
        if (connectionDead) return;

        hold.send(() => writer.enqueue({
            event: 'ping',
            data: JSON.stringify({ timestamp: Date.now() }),
        }));
    }, config.pingInterval);

    await waitForDisconnect(c.req.raw.signal, () => connectionDead, (resolve) =>
    {
        onClosed = resolve;
    });

    // Cleanup (normal disconnect path; idempotent if already closed)
    cleanup();
}

/**
 * Send the `connected` frame (first in the queue) and subscribe every allowed
 * event. For a connection with a subject whose allowed events declare
 * `.initial()`, `connected` waits for their frames and is followed by them;
 * live frames arriving meanwhile are held and follow both. Without one, all of
 * it happens synchronously, as before.
 */
async function openSubscriptions(
    connection: SSEConnection,
    writer: BoundedWriter,
    hold: FrameHold,
    ctx: InitialContext,
): Promise<void>
{
    const connected = { subscribedEvents: [...connection.allowed], deniedEvents: [...connection.denied] };
    const producing = connected.subscribedEvents.filter(eventName => ctx.router.events[eventName]._initial);

    if (!ctx.subject || producing.length === 0)
    {
        enqueueConnected(writer, { ...connected, initial: [] });
        subscribeAllowed(connection);

        return;
    }

    hold.hold();
    subscribeAllowed(connection);

    const served = await produceInitialFrames(producing, ctx.router, {
        subject: ctx.subject,
        principal: ctx.principal,
        request: ctx.request,
    });
    if (ctx.isDead())
    {
        return;
    }

    enqueueConnected(writer, { ...connected, initial: served.map(({ eventName }) => eventName) });
    served.forEach(({ eventName, frames }) => frames.forEach(data => ctx.writeFrame(eventName, data)));
    hold.release();
}

/** The `connected` frame's data, as the client's `ConnectedPayload` reads it. */
interface ConnectedFrame
{
    subscribedEvents: string[];
    deniedEvents: string[];
    initial: string[];
}

function enqueueConnected(writer: BoundedWriter, connected: ConnectedFrame): void
{
    writer.enqueue({
        event: 'connected',
        data: JSON.stringify({ ...connected, timestamp: Date.now() }),
    });
}

function subscribeAllowed(connection: SSEConnection): void
{
    for (const eventName of connection.allowed)
    {
        connection.unsubscribes.set(eventName, connection.subscribe(eventName));
    }

    sseLogger.info('SSE connection established', {
        events: [...connection.allowed],
        deniedEvents: [...connection.denied],
        subscriptionCount: connection.unsubscribes.size,
    });
}

/** What the initial pass of one connection reads: the subscriber's context and the `canSubscribe` one. */
type InitialContext = SubscriberContext & { principal: unknown };

/** The serialized initial frames of one event whose producer returned. */
interface InitialFrames
{
    eventName: string;
    frames: string[];
}

/**
 * Ask every producing event for its initial frames, in parallel; returns, in
 * `events` order, those whose producer returned — an empty list counts.
 */
async function produceInitialFrames(
    events: string[],
    router: EventRouterDef<any>,
    ctx: SubscribeContext,
): Promise<InitialFrames[]>
{
    const results = await Promise.all(events.map(eventName => askInitial(eventName, router.events[eventName], ctx)));

    return results.filter((frames): frames is InitialFrames => frames !== null);
}

/**
 * One event's producer, its payloads serialized here so that a payload that
 * cannot be written fails like a throw: warned with the event name — never the
 * error text — and `null`, so nothing of the event is written.
 */
async function askInitial(eventName: string, eventDef: EventDef<any>, ctx: SubscribeContext): Promise<InitialFrames | null>
{
    try
    {
        const payloads = await eventDef._initial!(ctx);

        return { eventName, frames: payloads.map(payload => serializeFrame(eventName, payload)) };
    }
    catch
    {
        sseLogger.warn('SSE initial frames could not be produced — none sent for this event', {
            event: eventName,
            subject: ctx.subject,
        });

        return null;
    }
}

/**
 * The writes of one connection, held in arrival order between `hold()` and
 * `release()`; written at once outside. Released once: `release()` writes the
 * held ones and every later write goes straight through.
 *
 * A held write reserves its place in the writer's queue, so held and queued
 * frames share one `maxQueue`: a hold that outgrows it closes the connection
 * as a slow consumer, and what the initial pass enqueues before `release()`
 * counts the held frames too.
 */
interface FrameHold
{
    send: (write: () => void) => void;
    hold: () => void;
    release: () => void;
}

function createFrameHold(writer: BoundedWriter): FrameHold
{
    let pending: (() => void)[] | null = null;

    return {
        send: (write) =>
        {
            if (!pending)
            {
                write();
            }
            else if (writer.reserve())
            {
                pending.push(write);
            }
        },
        hold: () =>
        {
            pending = [];
        },
        release: () =>
        {
            const held = pending ?? [];
            pending = null;
            writer.clearReserved();
            held.forEach(write => write());
        },
    };
}

/**
 * Enqueue an event frame with the connection's next `messageId` — one counter
 * for initial and live frames, numbered in the order they are written.
 */
function createFrameWriter(writer: BoundedWriter): (eventName: string, data: string) => void
{
    let messageId = 0;

    return (eventName, data) =>
    {
        messageId++;

        sseLogger.debug('SSE sending event', {
            event: eventName,
            messageId,
        });

        writer.enqueue({ id: String(messageId), event: eventName, data });
    };
}

/**
 * Wait for client disconnect (abort) or a server-side close. Waiting on the
 * abort event instead of polling sleep(pingInterval) means a dropped client is
 * torn down immediately, not up to one ping interval later.
 */
async function waitForDisconnect(
    abortSignal: AbortSignal,
    isDead: () => boolean,
    onServerClose: (resolve: () => void) => void,
): Promise<void>
{
    if (abortSignal.aborted || isDead())
    {
        return;
    }

    await new Promise<void>((resolve) =>
    {
        const onAbort = () => resolve();
        abortSignal.addEventListener('abort', onAbort, { once: true });
        // Server-side close (cleanup) resolves the wait and drops the listener.
        onServerClose(() =>
        {
            abortSignal.removeEventListener('abort', onAbort);
            resolve();
        });
    });
}

/** What the per-event subscribe of one connection closes over. */
interface SubscriberContext
{
    router: EventRouterDef<any>;
    authConfig: SSEHandlerAuthConfig | undefined;
    subject: string | undefined;
    request: SubscribeRequest;

    /** Enqueue an event frame with the next `messageId`. */
    writeFrame: (eventName: string, data: string) => void;

    /** Write now, or hold until the initial pass ends. */
    send: (write: () => void) => void;

    isDead: () => boolean;
}

/**
 * The per-event subscribe of one connection, used at connect and by `grant`
 * alike, so filter order and `messageId` numbering are one code path.
 *
 * The returned unsubscribe also deactivates the callback, so a frame of an
 * `emit` already fanning out when `revoke` lands is not enqueued after it.
 */
function createEventSubscriber(ctx: SubscriberContext): (eventName: string) => () => void
{
    return (eventName: string) =>
    {
        const eventDef = ctx.router.events[eventName];
        let active = true;

        const unsubscribe = eventDef.subscribe((payload: unknown) =>
        {
            if (!active || ctx.isDead() || !passesFrameFilters(eventName, eventDef, payload, ctx))
            {
                return;
            }

            const data = serializeFrame(eventName, payload);
            ctx.send(() => ctx.writeFrame(eventName, data));
        });

        return () =>
        {
            active = false;
            unsubscribe();
        };
    };
}

/**
 * The global `filter` map (with a subject, as before) and the event's own
 * `.filter()` — both must pass.
 */
function passesFrameFilters(
    eventName: string,
    eventDef: EventDef<any>,
    payload: unknown,
    ctx: SubscriberContext,
): boolean
{
    const globalFilter = ctx.authConfig?.filter?.[eventName];
    if (ctx.subject && globalFilter && !globalFilter(ctx.subject, payload))
    {
        return false;
    }

    if (!eventDef._filter)
    {
        return true;
    }

    try
    {
        return eventDef._filter(payload, { subject: ctx.subject, request: ctx.request }) === true;
    }
    catch
    {
        sseLogger.warn('SSE event filter threw — frame dropped', { event: eventName, subject: ctx.subject });

        return false;
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Authenticate via one-time token
 * @returns subject string if authenticated, undefined if no auth required,
 *          false if token missing, null if token invalid/expired
 */
async function authenticateToken(
    c: Context,
    tokenManager?: SSETokenManager,
): Promise<string | undefined | false | null>
{
    if (!tokenManager)
    {
        return undefined;
    }

    const token = c.req.query('token');
    if (!token)
    {
        return false;
    }

    return await tokenManager.verify(token);
}

/**
 * Parse requested events from query parameter
 */
function parseRequestedEvents(c: Context): string[] | null
{
    const eventsParam = c.req.query('events');
    if (!eventsParam)
    {
        return null;
    }

    // Deduplicated: one subscription per event, keyed by name in the registry.
    return [...new Set(eventsParam.split(',').map(e => e.trim()))];
}

/**
 * Authorize event subscription via auth hook
 * @returns allowed events array, or null if rejected
 */
async function authorizeEvents(
    subject: string | undefined,
    requestedEvents: string[],
    authConfig?: SSEHandlerAuthConfig,
): Promise<string[] | null>
{
    if (!subject || !authConfig?.authorize)
    {
        return requestedEvents;
    }

    const allowed = await authConfig.authorize(subject, requestedEvents);

    if (allowed.length === 0)
    {
        return null;
    }

    return allowed;
}
