/**
 * SSE Module
 *
 * Server-Sent Events for real-time event subscription
 *
 * @example Server (Hono)
 * ```typescript
 * import { createSSEHandler } from '@spfn/core/event/sse';
 * import { eventRouter } from './events';
 *
 * app.get('/events/stream', createSSEHandler(eventRouter));
 * ```
 *
 * @example Client (Browser)
 * ```typescript
 * import { createSSEClient } from '@spfn/core/event/sse/client';
 * import type { EventRouter } from '@/server/events';
 *
 * const client = createSSEClient<EventRouter>({
 *     url: 'http://localhost:8790/events/stream',
 * });
 *
 * client.subscribe({
 *     events: ['userCreated'],
 *     handlers: {
 *         userCreated: (payload) => console.log(payload),
 *     },
 * });
 * ```
 */

// Server-side exports (Hono handler)
export { createSSEHandler } from './handler';

// Token manager
export { SSETokenManager, CacheTokenStore } from './token-manager';
export type { SSEToken, SSETokenStore, SSETokenManagerConfig, SSEKeyVerifier } from './token-manager';

// Close the streams of a revoked device key (this pod and, with a cache, every pod)
export { closeSSEConnectionsByKey } from './close-by-key';

// Types
export type {
    SSEMessage,
    SSEHandlerConfig,
    SSEHandlerAuthConfig,
    SSEAuthConfig,
    SSEClientConfig,
    SSEEventHandler,
    SSEEventHandlers,
    SSESubscribeOptions,
    SSESubscriptionChange,
    SSEConnectionState,
    SSEUnsubscribe,
    ConnectedPayload,
} from './types';
