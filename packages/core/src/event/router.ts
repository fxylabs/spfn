/**
 * Event Router
 *
 * Type-safe event router for SSE subscription
 *
 * @example
 * ```typescript
 * import { defineEvent, defineEventRouter } from '@spfn/core/event';
 * import { Type } from '@sinclair/typebox';
 *
 * const userCreated = defineEvent('user.created', Type.Object({
 *     userId: Type.String(),
 * }));
 *
 * const orderPlaced = defineEvent('order.placed', Type.Object({
 *     orderId: Type.String(),
 *     amount: Type.Number(),
 * }));
 *
 * export const eventRouter = defineEventRouter({
 *     userCreated,
 *     orderPlaced,
 * });
 *
 * export type EventRouter = typeof eventRouter;
 * ```
 */

import type { EventDef } from './types';

/**
 * How a client reaches the contracted events of a router.
 *
 * Declared on the router because it is the stream's promise, not one event's:
 * `createServer` checks it against `.events()` at boot, so the document cannot
 * describe a path or an auth mode the server does not serve.
 */
export interface EventRouterContract
{
    /**
     * `'tokenExchange'` when `.events()` enables `auth` — the client first posts
     * to the token path and opens the stream with `?token=`. `'none'` otherwise.
     */
    auth: 'none' | 'tokenExchange';

    /**
     * The stream path `.events()` registers.
     * @default '/events/stream'
     */
    streamPath?: string;
}

/**
 * What every router of events carries — the SSE event router and the
 * WebSocket router alike.
 *
 * The WebSocket router builds on this rather than on `EventRouterDef`, because
 * only an SSE event router can be contracted.
 */
export interface EventRouterBase<TEvents extends Record<string, EventDef<any>>>
{
    /**
     * Event definitions
     */
    readonly events: TEvents;

    /**
     * Event names as array
     */
    readonly eventNames: (keyof TEvents)[];

    /**
     * Type inference helper - payload types by event name
     */
    readonly _types: {
        [K in keyof TEvents]: TEvents[K]['_payload'];
    };
}

/**
 * Event Router Definition
 */
export interface EventRouterDef<TEvents extends Record<string, EventDef<any>>> extends EventRouterBase<TEvents>
{
    /**
     * The contract declared with `.contract()`, absent when the router declares
     * none. Underscored for the same reason as `EventDef._contract`.
     */
    readonly _contract?: EventRouterContract;

    /**
     * Declare how a client reaches this router's contracted events.
     *
     * Sets the contract on this router and returns it. A `streamPath` that does
     * not start with `/` throws here, where the typo is.
     */
    contract: (contract: EventRouterContract) => EventRouterDef<TEvents>;
}

/**
 * Infer event names from EventRouter
 */
export type InferEventNames<T> = T extends EventRouterBase<infer E>
    ? keyof E & string
    : never;

/**
 * Infer payload type for specific event
 */
export type InferEventPayload<
    T extends EventRouterBase<any>,
    K extends InferEventNames<T>,
> = T['_types'][K];

/**
 * Infer all event payloads map
 */
export type InferEventPayloads<T extends EventRouterBase<any>> = T['_types'];

/**
 * Define an event router for SSE subscription
 *
 * `.contract({ auth })` on the router, together with `.contract({ since })` on
 * its events, publishes those events in `contracts/current.json` — see the
 * contract README.
 *
 * @example
 * ```typescript
 * export const eventRouter = defineEventRouter({
 *     userCreated,
 *     orderPlaced,
 * });
 *
 * // Type inference
 * type Names = InferEventNames<typeof eventRouter>;
 * // 'userCreated' | 'orderPlaced'
 *
 * type Payload = InferEventPayload<typeof eventRouter, 'userCreated'>;
 * // { userId: string }
 * ```
 */
export function defineEventRouter<
    TEvents extends Record<string, EventDef<any>>,
>(events: TEvents): EventRouterDef<TEvents>
{
    let contract: EventRouterContract | undefined;

    const router: EventRouterDef<TEvents> = {
        events,
        eventNames: Object.keys(events) as (keyof TEvents)[],
        get _contract()
        {
            return contract;
        },
        contract: (next) =>
        {
            assertStreamPath(next.streamPath);
            contract = next;

            return router;
        },
        _types: {} as EventRouterDef<TEvents>['_types'],
    };

    return router;
}

/**
 * A stream path is matched against the path `.events()` registers and written
 * into the contract as a URL path, so a relative one can never be right.
 */
function assertStreamPath(streamPath: string | undefined): void
{
    if (streamPath !== undefined && !streamPath.startsWith('/'))
    {
        throw new Error(
            `defineEventRouter(...).contract({ streamPath: "${streamPath}" }) is not an absolute path. `
            + 'The contract publishes it as the URL path a client opens, and createServer compares it with the '
            + 'path .events() registers. Start it with "/".',
        );
    }
}
