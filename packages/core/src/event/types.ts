/**
 * Event System Types
 */

import type { TSchema } from '@sinclair/typebox';

/**
 * Pub/Sub capable cache interface for multi-instance events
 */
export interface PubSubCache
{
    /**
     * Publish a message to a channel
     */
    publish(channel: string, message: unknown): Promise<void>;

    /**
     * Subscribe to a channel
     */
    subscribe(channel: string, handler: (message: unknown) => void | Promise<void>): Promise<void>;
}

/**
 * Event handler function type
 */
export type EventHandler<TPayload> = (payload: TPayload) => void | Promise<void>;

/**
 * Options for `EventDef.subscribe`.
 */
export interface EventSubscribeOptions
{
    /**
     * Run only for an `emit` made in this process, never for a delivery the
     * cache transport received from another pod. For a handler whose work must
     * happen once per emit, not once per pod (it would otherwise run on every
     * pod the event is cached to). Without a cache it runs on every `emit`.
     */
    localOnly?: boolean;
}

/**
 * Job queue sender function type (used by job module)
 */
export type JobQueueSender = (queueName: string, payload: unknown) => Promise<void>;

/**
 * What a contracted event promises to clients compiled separately from the
 * server, written into `contracts/current.json` by `@spfn/core:contract`.
 *
 * The same version markers a route's `.contract()` carries; the payload shape
 * is the event's own schema, so it is not repeated here.
 */
export interface EventContract
{
    /** Contract version the event first appeared in. */
    since: string;

    /** Contract version the event was announced for removal in. */
    deprecatedIn?: string;

    /** Contract version the event was removed in. */
    removedIn?: string;
}

/**
 * What the stream request asked for, copied once at connect.
 *
 * A plain snapshot, never the live Hono context, so a frame filter can read it
 * on every frame long after the request object is gone. Header names are
 * lowercased. It may hold `cookie` and `authorization` values — never log it.
 */
export interface SubscribeRequest
{
    /** Query parameters of the stream URL (`events`, `token` and any the app adds). */
    query: Record<string, string>;

    /** Request headers, names lowercased. */
    headers: Record<string, string>;
}

/**
 * What `.canSubscribe()` decides on, once per connection per requested event.
 *
 * `P` is whatever the SSE auth config's `resolvePrincipal` returns — core never
 * knows what a principal is.
 */
export interface SubscribeContext<P = unknown>
{
    /** The subject the one-time token was issued to. */
    subject: string;

    /** The value `resolvePrincipal` returned for this connection, `undefined` without one. */
    principal: P | undefined;

    /** The connect request snapshot. */
    request: SubscribeRequest;
}

/**
 * Decides at connect whether a subject may receive an event. `false` or a
 * throw denies the event on that connection; the connection stays open.
 */
export type SubscribePredicate<P = unknown> = (ctx: SubscribeContext<P>) => boolean | Promise<boolean>;

/**
 * The frames a connection receives right after `connected`, for its own
 * subject and query. Asked once per connection, after `canSubscribe` allowed
 * the event; a throw or a rejection sends nothing for the event.
 */
export type InitialProducer<TPayload, P = unknown> = (ctx: SubscribeContext<P>) => TPayload[] | Promise<TPayload[]>;

/**
 * What a per-event `.filter()` sees on every frame.
 */
export interface FrameContext
{
    /** The connection's subject, `undefined` when the stream runs without auth. */
    subject: string | undefined;

    /** The connect request snapshot. */
    request: SubscribeRequest;
}

/**
 * Decides per frame whether one connection receives one payload. Sync: it runs
 * for every connection on every emit, so it matches the payload against what
 * the connection asked for and never reads storage.
 */
export type FramePredicate<TPayload> = (payload: TPayload, ctx: FrameContext) => boolean;

/**
 * Which of a subject's connections a `grant` / `revoke` reaches: those whose
 * connect query carries every named field with exactly that value. A
 * connection that declared no such field never matches. Plain JSON, so it
 * travels to other pods unchanged.
 */
export interface SubscriptionMatch
{
    query: Record<string, string>;
}

/**
 * How an SSE handler lets `grant` / `revoke` reach its open connections.
 * Each handler registers one per router key of the event.
 */
export interface SubscriptionControl
{
    /** Activate the event on every open connection of `subject` (matching `match`, when given) where it is denied. */
    grant: (subject: string, match?: SubscriptionMatch) => void;

    /** Deactivate the event on every open connection of `subject` (matching `match`, when given) where it is allowed. */
    revoke: (subject: string, match?: SubscriptionMatch) => void;
}

/**
 * Event definition interface
 */
export interface EventDef<TPayload = void>
{
    /**
     * Unique event name
     */
    readonly name: string;

    /**
     * TypeBox payload schema (optional)
     */
    readonly schema?: TSchema;

    /**
     * The contract declared with `.contract()`, absent when the event is not
     * part of the published contract.
     *
     * Named with an underscore because `.contract()` holds the plain name, as
     * a router's `_contractVersion` sits beside `.contractVersion()`.
     */
    readonly _contract?: EventContract;

    /**
     * Publish this event in `contracts/current.json`.
     *
     * Sets the contract on this definition and returns it. An event is defined
     * once and shared, so a second call throws instead of one of the two
     * declarations silently winning.
     */
    contract: (contract: EventContract) => EventDef<TPayload>;

    /**
     * The predicate declared with `.canSubscribe()`, absent when any subject
     * that passes the global `authorize` may subscribe.
     */
    readonly _canSubscribe?: SubscribePredicate<any>;

    /**
     * Declare who may subscribe to this event over SSE.
     *
     * Runs once per connection, after the global `authorize`, only when the
     * connection has a subject. `P` is the type of the principal the SSE auth
     * config's `resolvePrincipal` returns. Set once: a second call throws.
     *
     * @example
     * ```typescript
     * export const auditLogged = defineEvent('audit.logged', payload)
     *     .canSubscribe<AuthPrincipal>(({ principal }) => principal?.role === 'admin');
     * ```
     */
    canSubscribe: <P = unknown>(predicate: SubscribePredicate<P>) => EventDef<TPayload>;

    /**
     * The per-frame predicate declared with `.filter()`.
     */
    readonly _filter?: FramePredicate<TPayload>;

    /**
     * Declare which frames of this event a connection receives.
     *
     * Runs per frame on every connection subscribed to the event, with or
     * without a subject, beside the global `filter` map (both must pass). Sync.
     * Set once: a second call throws.
     *
     * @example
     * ```typescript
     * export const runtimeChanged = defineEvent('runtime.changed', payload)
     *     .filter((payload, { request }) => payload.workspaceId === request.query.workspaceId);
     * ```
     */
    filter: (predicate: FramePredicate<TPayload>) => EventDef<TPayload>;

    /**
     * The producer declared with `.initial()`, absent when a connection
     * receives only the frames emitted after it opened.
     */
    readonly _initial?: InitialProducer<TPayload, any>;

    /**
     * Declare the frames a connection receives right after `connected`, before
     * any live frame — the event's current value for that connection.
     *
     * Runs once per connection with a subject, for an event `canSubscribe`
     * allowed, with the same context `canSubscribe` receives. Its frames skip
     * the frame filters: they were produced for this connection. A throw sends
     * nothing for the event and leaves it out of `connected.initial`. Never on
     * a `grant`. Set once: a second call throws.
     *
     * @example
     * ```typescript
     * export const runtimeChanged = defineEvent('runtime.changed', payload)
     *     .initial(async ({ request }) => [await readRuntime(request.query.workspaceId)]);
     * ```
     */
    initial: <P = unknown>(producer: InitialProducer<TPayload, P>) => EventDef<TPayload>;

    /**
     * Subscribe to this event (in-memory handler). With the cache transport a
     * handler runs on every pod for every emit, unless `{ localOnly: true }`
     * keeps it to emits made in this process.
     */
    subscribe: (handler: EventHandler<TPayload>, options?: EventSubscribeOptions) => () => void;

    /**
     * Unsubscribe all handlers, `localOnly` ones included
     */
    unsubscribeAll: () => void;

    /**
     * Emit the event (triggers all subscribers and queued jobs)
     */
    emit: TPayload extends void
        ? () => Promise<void>
        : (payload: TPayload) => Promise<void>;

    /**
     * Activate this event on every open SSE connection of `subject` where it is
     * denied — by `canSubscribe` or `authorize` at connect, or by a `revoke`.
     *
     * Reaches every pod when the cache transport is attached. Never re-runs
     * `canSubscribe`: it is an operator's statement about an open connection.
     * An event the connection never requested cannot be granted.
     *
     * With `match`, only the connections whose connect query carries every
     * field of `match.query` with that value are activated.
     */
    grant: (subject: string, match?: SubscriptionMatch) => Promise<void>;

    /**
     * Deactivate this event on every open SSE connection of `subject` where it
     * is allowed; the client receives a `subscription.revoked` frame.
     *
     * Reaches every pod when the cache transport is attached. Affects open
     * connections only — the next connect asks `canSubscribe` afresh.
     *
     * With `match`, only the connections whose connect query carries every
     * field of `match.query` with that value are deactivated.
     */
    revoke: (subject: string, match?: SubscriptionMatch) => Promise<void>;

    /**
     * Enable cache-based pub/sub for multi-instance support
     * Must await before emitting events to ensure subscription is ready
     */
    useCache: (cache: PubSubCache) => Promise<EventDef<TPayload>>;

    /**
     * Internal: Register a job queue to receive this event
     * Called by job registration system
     */
    _registerJobQueue: (queueName: string, sender: JobQueueSender) => void;

    /**
     * Internal: Let an SSE handler's connection registry receive `grant` /
     * `revoke`. Called by `createSSEHandler` once per router key; every
     * registered control receives every call. Returns the unregister function.
     */
    _registerSubscriptionControl: (control: SubscriptionControl) => () => void;

    /**
     * Internal: Drop the cache binding (cache + subscribed flag).
     * Called by the event cache transport on shutdown so a later useCache can
     * rebind a fresh cache in the same process.
     */
    _resetCache: () => void;

    /**
     * Type inference helper
     */
    _payload: TPayload;
}

/**
 * Infer payload type from EventDef
 */
export type InferEventPayload<TEvent> = TEvent extends EventDef<infer TPayload>
    ? TPayload
    : never;
