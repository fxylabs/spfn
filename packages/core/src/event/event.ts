/**
 * Event System
 *
 * Decoupled pub/sub event system with optional cache integration for multi-instance support
 *
 * @example
 * ```typescript
 * // Define event
 * const userCreated = defineEvent('user.created', Type.Object({
 *     userId: Type.String(),
 * }));
 *
 * // Subscribe (in-memory)
 * userCreated.subscribe((payload) => {
 *     console.log('User created:', payload.userId);
 * });
 *
 * // Emit
 * await userCreated.emit({ userId: '123' });
 *
 * // With cache for multi-instance
 * const event = defineEvent('user.created', schema);
 * await event.useCache(cache);  // Must await before emitting
 * await event.emit({ userId: '123' });  // Broadcast to all instances
 * ```
 */

import type { TSchema, Static } from '@sinclair/typebox';
import { logger } from '@spfn/core/logger';
import { bindSubscriptionControl, isSubscriptionMatch, publishSubscriptionControl } from './cache-transport';
import type {
    EventContract,
    EventDef,
    EventHandler,
    EventSubscribeOptions,
    FramePredicate,
    InitialProducer,
    JobQueueSender,
    PubSubCache,
    SubscribePredicate,
    SubscriptionControl,
    SubscriptionMatch,
} from './types';

const eventLogger = logger.child('@spfn/core:event');

/**
 * Log handler error with consistent format
 */
function logHandlerError(eventName: string, error: unknown): void
{
    eventLogger.error(`Event handler error: ${eventName}`, {
        error: error instanceof Error ? error.message : String(error),
    });
}

/**
 * Log job queue error with consistent format
 */
function logJobQueueError(queueName: string, error: unknown): void
{
    eventLogger.error(`Failed to send event to job queue: ${queueName}`, {
        error: error instanceof Error ? error.message : String(error),
    });
}

/**
 * Create handler subscription manager
 */
function createHandlerManager<TPayload>(name: string)
{
    const handlers: Set<EventHandler<TPayload>> = new Set();

    return {
        add: (handler: EventHandler<TPayload>): (() => void) =>
        {
            handlers.add(handler);
            eventLogger.debug(`Subscribed to event: ${name}`, { handlerCount: handlers.size });

            return () =>
            {
                handlers.delete(handler);
                eventLogger.debug(`Unsubscribed from event: ${name}`, { handlerCount: handlers.size });
            };
        },

        clear: (): void =>
        {
            handlers.clear();
            eventLogger.debug(`Unsubscribed all from event: ${name}`);
        },

        trigger: async (payload: TPayload): Promise<void> =>
        {
            const results = await Promise.allSettled(
                [...handlers].map((handler) => handler(payload)),
            );

            for (const result of results)
            {
                if (result.status === 'rejected')
                {
                    logHandlerError(name, result.reason);
                }
            }
        },
    };
}

/**
 * Create job queue manager
 */
function createJobQueueManager(name: string)
{
    const jobQueues: Map<string, JobQueueSender> = new Map();

    return {
        register: (queueName: string, sender: JobQueueSender): void =>
        {
            jobQueues.set(queueName, sender);
            eventLogger.debug(`Registered job queue for event: ${name}`, { queueName });
        },

        send: async (payload: unknown): Promise<void> =>
        {
            if (jobQueues.size === 0)
            {
                return;
            }

            const entries = [...jobQueues.entries()];
            const results = await Promise.allSettled(
                entries.map(([queueName, sender]) => sender(queueName, payload)),
            );

            for (const [i, result] of results.entries())
            {
                if (result.status === 'rejected')
                {
                    logJobQueueError(entries[i][0], result.reason);
                }
            }
        },

        get size(): number
        {
            return jobQueues.size;
        },
    };
}

/**
 * Create the registry of SSE handlers' subscription controls for one event.
 *
 * `grant` / `revoke` apply to every registered control (an event may sit under
 * two router keys, or in two handlers in one process), then — when the event is
 * bound to a cache — publish once so every other pod applies it too.
 */
function createSubscriptionControls(name: string, getCache: () => PubSubCache | undefined)
{
    const controls: Set<SubscriptionControl> = new Set();

    const applyLocal = (kind: 'grant' | 'revoke', subject: string, match?: SubscriptionMatch): void =>
    {
        controls.forEach(control => control[kind](subject, match));
    };

    const change = (kind: 'grant' | 'revoke') => async (subject: string, match?: SubscriptionMatch): Promise<void> =>
    {
        assertMatch(name, kind, match);
        applyLocal(kind, subject, match);

        const cache = getCache();
        if (cache)
        {
            await publishSubscriptionControl(cache, kind, name, subject, match);
        }
    };

    return {
        applyLocal,
        grant: change('grant'),
        revoke: change('revoke'),
        register: (control: SubscriptionControl): (() => void) =>
        {
            controls.add(control);

            return () => controls.delete(control);
        },
    };
}

/**
 * Refuse a `match` before it is applied or published. JSON drops an
 * `undefined` field, so `{ workspaceId: undefined }` would open nothing here
 * and every connection of the subject on every other pod; an empty `query`
 * would open every connection everywhere.
 */
function assertMatch(name: string, kind: 'grant' | 'revoke', match: SubscriptionMatch | undefined): void
{
    if (match !== undefined && !isSubscriptionMatch(match))
    {
        throw new Error(
            `Event "${name}" .${kind}() refused its match: match.query must name at least one field, each with a string value. `
            + 'A match only ever narrows a grant or revoke to the connections that declared those values; '
            + 'omit match to reach every connection of the subject.',
        );
    }
}

/**
 * Throw when a set-once declaration of a shared event is made a second time.
 */
function assertDeclaredOnce(name: string, method: string, declared: boolean): void
{
    if (declared)
    {
        throw new Error(
            `Event "${name}" already declares .${method}(). `
            + 'An event is defined once and shared, so a second declaration would silently replace the first. '
            + `Declare .${method}() once, where the event is defined.`,
        );
    }
}

/**
 * Internal: Create event implementation
 */
function createEventImpl<TPayload>(
    name: string,
    schema?: TSchema,
): EventDef<TPayload>
{
    const handlerManager = createHandlerManager<TPayload>(name);
    // `localOnly` handlers: run by this process's emit, never by a cache delivery.
    const localHandlerManager = createHandlerManager<TPayload>(name);
    const jobQueueManager = createJobQueueManager(name);
    let cache: PubSubCache | undefined;
    let cacheSubscribed = false;
    const subscriptionControls = createSubscriptionControls(name, () => cache);

    const emit = async (payload?: TPayload): Promise<void> =>
    {
        eventLogger.debug(`Emitting event: ${name}`, {
            payload,
            hasCache: !!cache,
            jobQueueCount: jobQueueManager.size,
        });

        if (cache)
        {
            await cache.publish(name, payload);
        }
        else
        {
            await handlerManager.trigger(payload as TPayload);
        }

        await localHandlerManager.trigger(payload as TPayload);

        await jobQueueManager.send(payload);
        eventLogger.debug(`Event emitted: ${name}`);
    };

    const useCache = async (newCache: PubSubCache): Promise<EventDef<TPayload>> =>
    {
        if (cacheSubscribed)
        {
            eventLogger.warn(`Cache already configured for event: ${name}`);

            return self;
        }

        // Subscribe FIRST, then flip to cache mode. If subscribe rejects, the
        // event stays in-process (cache undefined) and cacheSubscribed stays
        // false — so emit keeps delivering locally and a later useCache can retry.
        // Setting these before the await would latch a half-broken state: emit
        // would publish to a channel this instance never subscribed to.
        // A delivery from the cache — this pod's own emit echoed back, or another
        // pod's — reaches the plain handlers only; `localOnly` ones ran in emit.
        await newCache.subscribe(name, async (message: unknown) =>
        {
            eventLogger.debug(`Received event from cache: ${name}`);
            await handlerManager.trigger(message as TPayload);
        });

        cache = newCache;
        cacheSubscribed = true;

        await bindSubscriptionControl(newCache, name, subscriptionControls.applyLocal);

        eventLogger.debug(`Cache subscription ready for event: ${name}`);

        return self;
    };

    // Drop the cache binding so a later useCache can rebind a fresh transport.
    // Without this, the cacheSubscribed latch would make a second server start in
    // the same process (tests, hot-reload) a no-op while the event still points at
    // a torn-down cache — cross-pod fan-out would silently stay dead.
    const resetCache = (): void =>
    {
        cache = undefined;
        cacheSubscribed = false;
    };

    let contract: EventContract | undefined;

    const declareContract = (next: EventContract): EventDef<TPayload> =>
    {
        if (contract)
        {
            throw new Error(
                `Event "${name}" already declares .contract({ since: '${contract.since}' }). `
                + 'An event is defined once and shared, so a second declaration would silently replace one of the '
                + 'two. Declare the contract once, where the event is defined.',
            );
        }

        contract = next;

        return self;
    };

    let canSubscribe: SubscribePredicate<any> | undefined;
    let filter: FramePredicate<TPayload> | undefined;
    let initial: InitialProducer<TPayload, any> | undefined;

    const declareCanSubscribe = <P>(predicate: SubscribePredicate<P>): EventDef<TPayload> =>
    {
        assertDeclaredOnce(name, 'canSubscribe', !!canSubscribe);
        canSubscribe = predicate;

        return self;
    };

    const declareFilter = (predicate: FramePredicate<TPayload>): EventDef<TPayload> =>
    {
        assertDeclaredOnce(name, 'filter', !!filter);
        filter = predicate;

        return self;
    };

    const declareInitial = <P>(producer: InitialProducer<TPayload, P>): EventDef<TPayload> =>
    {
        assertDeclaredOnce(name, 'initial', !!initial);
        initial = producer;

        return self;
    };

    const subscribe = (handler: EventHandler<TPayload>, options?: EventSubscribeOptions): (() => void) =>
        (options?.localOnly ? localHandlerManager : handlerManager).add(handler);

    const unsubscribeAll = (): void =>
    {
        handlerManager.clear();
        localHandlerManager.clear();
    };

    const self: EventDef<TPayload> = {
        name,
        schema,
        get _contract()
        {
            return contract;
        },
        contract: declareContract,
        get _canSubscribe()
        {
            return canSubscribe;
        },
        canSubscribe: declareCanSubscribe,
        get _filter()
        {
            return filter;
        },
        filter: declareFilter,
        get _initial()
        {
            return initial;
        },
        initial: declareInitial,
        grant: subscriptionControls.grant,
        revoke: subscriptionControls.revoke,
        _registerSubscriptionControl: subscriptionControls.register,
        subscribe,
        unsubscribeAll,
        emit: emit as EventDef<TPayload>['emit'],
        useCache,
        _registerJobQueue: jobQueueManager.register,
        _resetCache: resetCache,
        _payload: undefined as unknown as TPayload,
    };

    return self;
}

/**
 * Define an event without payload
 */
export function defineEvent(name: string): EventDef<void>;

/**
 * Define an event with typed payload
 */
export function defineEvent<T extends TSchema>(
    name: string,
    schema: T,
): EventDef<Static<T>>;

/**
 * Define an event for decoupled pub/sub
 *
 * @example
 * ```typescript
 * // Define event with payload
 * export const userCreated = defineEvent('user.created', Type.Object({
 *     userId: Type.String(),
 * }));
 *
 * // Subscribe to event (in-memory)
 * const unsubscribe = userCreated.subscribe((payload) => {
 *     console.log('User created:', payload.userId);
 * });
 *
 * // Emit event
 * await userCreated.emit({ userId: '123' });
 *
 * // Unsubscribe when done
 * unsubscribe();
 *
 * // Multi-instance with cache
 * await userCreated.useCache(cache);
 * await userCreated.emit({ userId: '123' });  // Broadcast to all instances
 * ```
 */
export function defineEvent<T extends TSchema>(
    name: string,
    schema?: T,
): EventDef<Static<T>> | EventDef
{
    if (schema)
    {
        return createEventImpl<Static<T>>(name, schema);
    }

    return createEventImpl<void>(name);
}
