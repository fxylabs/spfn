/**
 * Event Module
 *
 * Decoupled pub/sub event system with optional cache integration and SSE support
 *
 * @example Basic Event
 * ```typescript
 * import { defineEvent } from '@spfn/core/event';
 * import { Type } from '@sinclair/typebox';
 *
 * // Define event with payload
 * export const userCreated = defineEvent('user.created', Type.Object({
 *     userId: Type.String(),
 * }));
 *
 * // Subscribe to event (in-memory)
 * userCreated.subscribe((payload) => {
 *     console.log('User created:', payload.userId);
 * });
 *
 * // Emit event
 * await userCreated.emit({ userId: '123' });
 * ```
 *
 * @example Event Router for SSE
 * ```typescript
 * import { defineEvent, defineEventRouter } from '@spfn/core/event';
 *
 * export const eventRouter = defineEventRouter({
 *     userCreated,
 *     orderPlaced,
 * });
 *
 * export type EventRouter = typeof eventRouter;
 * ```
 *
 * @example SSE Server (Hono)
 * ```typescript
 * import { createSSEHandler } from '@spfn/core/event/sse';
 * app.get('/events/stream', createSSEHandler(eventRouter));
 * ```
 *
 * @example SSE Client (Browser)
 * ```typescript
 * import { createSSEClient } from '@spfn/core/event/sse/client';
 * const client = createSSEClient<EventRouter>({ url: '/events/stream' });
 * client.subscribe({ events: ['userCreated'], handlers: { ... } });
 * ```
 */

// Event definition
export { defineEvent } from './event';

// SSE route map
export { eventRouteMap } from './sse/route-map';

// Event router (SSE)
export { defineEventRouter } from './router';

// WebSocket router
export { defineWSRouter } from './ws';
export type {
    EventRouterContract,
    EventRouterDef,
    InferEventNames,
    InferEventPayload as InferRouterEventPayload,
    InferEventPayloads,
} from './router';

// Types
export type {
    EventContract,
    EventDef,
    EventHandler,
    InferEventPayload,
    PubSubCache,
    JobQueueSender,
} from './types';
