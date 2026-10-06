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
     * Subscribe to this event (in-memory handler)
     */
    subscribe: (handler: EventHandler<TPayload>) => () => void;

    /**
     * Unsubscribe all handlers
     */
    unsubscribeAll: () => void;

    /**
     * Emit the event (triggers all subscribers and queued jobs)
     */
    emit: TPayload extends void
        ? () => Promise<void>
        : (payload: TPayload) => Promise<void>;

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
