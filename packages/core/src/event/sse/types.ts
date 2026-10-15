/**
 * SSE Types
 *
 * Type definitions for Server-Sent Events
 */

import type { Context } from 'hono';
import type { EventRouterDef, InferEventNames, InferEventPayload } from '../router';
import type { SubscribeRequest } from '../types';
import type { SSETokenStore, SSETokenManager } from './token-manager';

/**
 * SSE message sent from server
 */
export interface SSEMessage<TEvent extends string = string, TPayload = unknown>
{
    /** Event name */
    event: TEvent;

    /** Event payload */
    data: TPayload;

    /** Optional message ID for reconnection */
    id?: string;
}

// ============================================================================
// Auth Config Types
// ============================================================================

/**
 * SSE auth configuration (internal, non-generic)
 *
 * Stored in SSEHandlerConfig. Generic user-facing version is SSEAuthConfig.
 */
export interface SSEHandlerAuthConfig
{
    /**
     * Enable SSE token authentication
     * @default false
     */
    enabled?: boolean;

    /**
     * Token TTL in milliseconds
     * @default 30000
     */
    tokenTtl?: number;

    /**
     * Custom token store (e.g., Redis for multi-instance)
     */
    store?: SSETokenStore;

    /**
     * External token manager instance or lazy resolver.
     *
     * When provided, the SSE system uses this manager instead of creating its own.
     * Useful for sharing a single token manager with auth package's one-time token system.
     *
     * Use a function when the manager is not available at module load time
     * (e.g. initialized in a lifecycle hook that runs after config evaluation).
     *
     * @example
     * ```typescript
     * import { getOneTimeTokenManager } from '@spfn/auth/server';
     *
     * // Lazy resolver (recommended — avoids timing issues)
     * .events(eventRouter, {
     *     auth: {
     *         enabled: true,
     *         tokenManager: () => getOneTimeTokenManager(),
     *     },
     * })
     * ```
     */
    tokenManager?: SSETokenManager | (() => SSETokenManager);

    /**
     * Extract subject (user ID) from Hono context
     * @default (c) => c.get('auth')?.userId ?? null
     */
    getSubject?: (c: Context) => string | null;

    /**
     * Subscription authorization hook (called once on connect)
     *
     * Return allowed events subset. Empty array = 403 rejection.
     */
    authorize?: (subject: string, events: string[]) => Promise<string[]> | string[];

    /**
     * Per-event payload filter map (called on every event emission)
     *
     * Return false to skip sending the event to this user.
     */
    filter?: Record<string, (subject: string, payload: unknown) => boolean>;

    /**
     * Resolve the principal every `.canSubscribe()` of a connection receives
     * (called once per connection, after the subject is known).
     *
     * The stream request carries no `AuthContext`: the subject comes from the
     * one-time token, and the stream is mounted without the app's middleware.
     * So an app that decides on roles or memberships loads them here, once,
     * instead of in every predicate. Absent → predicates see
     * `principal: undefined`. A throw refuses the connection with 403.
     */
    resolvePrincipal?: (subject: string, request: SubscribeRequest) => unknown | Promise<unknown>;
}

/**
 * SSE auth configuration (user-facing, generic)
 *
 * Provides type-safe event names and payload inference from EventRouter.
 *
 * @example
 * ```typescript
 * .events(eventRouter, {
 *     auth: {
 *         enabled: true,
 *         authorize: async (subject, events) => {
 *             // events: ('userCreated' | 'orderUpdated')[]
 *             return events.filter(e => hasPermission(subject, e));
 *         },
 *         filter: {
 *             orderUpdated: (subject, payload) => {
 *                 // payload: { orderId: string; userId: string }
 *                 return payload.userId === subject;
 *             },
 *         },
 *     },
 * })
 * ```
 */
export interface SSEAuthConfig<TRouter extends EventRouterDef<any>>
{
    enabled?: boolean;
    tokenTtl?: number;
    store?: SSETokenStore;
    tokenManager?: SSETokenManager | (() => SSETokenManager);
    getSubject?: (c: Context) => string | null;
    authorize?: (
        subject: string,
        events: InferEventNames<TRouter>[],
    ) => Promise<InferEventNames<TRouter>[]> | InferEventNames<TRouter>[];
    filter?: {
        [K in InferEventNames<TRouter>]?: (
            subject: string,
            payload: InferEventPayload<TRouter, K>,
        ) => boolean;
    };
    resolvePrincipal?: (subject: string, request: SubscribeRequest) => unknown | Promise<unknown>;
}

// ============================================================================
// Handler Config
// ============================================================================

/**
 * SSE Handler configuration
 */
export interface SSEHandlerConfig
{
    /**
     * Keep-alive ping interval in milliseconds
     * @default 10000
     */
    pingInterval?: number;

    /**
     * Custom headers for SSE response
     */
    headers?: Record<string, string>;

    /**
     * Max outbound frames buffered per connection before a slow consumer is
     * dropped (connection closed). Bounds memory under a fast producer + slow
     * client; the client reconnects rather than receiving corrupted/partial data.
     * @default 1000
     */
    maxQueue?: number;

    /**
     * Cross-pod event broadcast via the cache (Redis/Valkey) pub/sub.
     *
     * When `true` (default) and a cache is configured (`CACHE_URL`), each event
     * is auto-wired so an `emit` on one pod reaches subscribers on every pod.
     * Without a cache this is a no-op (events stay in-process). Set `false` to
     * force in-process even when a cache is present.
     *
     * @default true
     */
    multiInstance?: boolean;

    /**
     * Pub/sub channel prefix for cross-pod broadcast.
     *
     * Defaults to env `SPFN_SSE_CHANNEL_PREFIX`, else `spfn:sse:`. Use distinct
     * prefixes to isolate apps/tenants that share one Redis instance.
     */
    channelPrefix?: string;

    /**
     * Authentication and authorization configuration
     */
    auth?: SSEHandlerAuthConfig;
}

// ============================================================================
// Client Config
// ============================================================================

/**
 * SSE Client configuration
 */
export interface SSEClientConfig
{
    /**
     * Backend API host URL
     * @default NEXT_PUBLIC_SPFN_API_URL || 'http://localhost:8790'
     * @example 'http://localhost:8790'
     * @example 'https://api.example.com'
     */
    host?: string;

    /**
     * SSE endpoint pathname
     * @default '/events/stream'
     */
    pathname?: string;

    /**
     * Full URL (overrides host + pathname)
     * @deprecated Use host and pathname instead
     * @example 'http://localhost:8790/events/stream'
     */
    url?: string;

    /**
     * Auto reconnect on disconnect
     * @default true
     */
    reconnect?: boolean;

    /**
     * Reconnect delay in milliseconds
     * @default 3000
     */
    reconnectDelay?: number;

    /**
     * Maximum reconnect attempts (0 = infinite)
     * @default 0
     */
    maxReconnectAttempts?: number;

    /**
     * Include credentials (cookies) in request
     * @default false
     */
    withCredentials?: boolean;

    /**
     * Acquire a one-time SSE token before connecting.
     *
     * Called on every (re)connect. The returned token is appended
     * to the SSE URL as `?token=...`.
     *
     * For automatic token acquisition via RPC proxy, use `createAuthSSEClient` instead.
     *
     * @example
     * ```typescript
     * // Recommended: use createAuthSSEClient for automatic token handling
     * import { createAuthSSEClient } from '@spfn/core/event/sse/client';
     * const client = createAuthSSEClient<EventRouter>();
     *
     * // Manual: provide acquireToken directly
     * acquireToken: async () => {
     *     const res = await fetch('/api/rpc/eventsToken', {
     *         method: 'POST',
     *         credentials: 'include',
     *     });
     *     const data = await res.json();
     *     return data.token;
     * }
     * ```
     */
    acquireToken?: () => Promise<string>;
}

/**
 * Event handler function
 */
export type SSEEventHandler<TPayload> = (payload: TPayload) => void;

/**
 * Event handlers map for EventRouter
 */
export type SSEEventHandlers<TRouter extends EventRouterDef<any>> = {
    [K in InferEventNames<TRouter>]?: SSEEventHandler<InferEventPayload<TRouter, K>>;
};

/**
 * Subscription options
 */
export interface SSESubscribeOptions<TRouter extends EventRouterDef<any>>
{
    /**
     * Events to subscribe
     */
    events: InferEventNames<TRouter>[];

    /**
     * Event handlers
     */
    handlers: SSEEventHandlers<TRouter>;

    /**
     * Extra connect-query fields, e.g. the key a state event is filtered on
     * (`{ workspaceId: 'w1' }`). Appended to the stream URL after `events=`,
     * both sides URI-encoded, and reused on every reconnect. `events` and
     * `token` are reserved: subscribe throws naming them.
     */
    query?: Record<string, string>;

    /**
     * Called when connection opens
     */
    onOpen?: () => void;

    /**
     * Called on connection error
     */
    onError?: (error: Event) => void;

    /**
     * Called when connection is permanently closed
     *
     * Triggered when:
     * - unsubscribe() is called
     * - client.close() is called
     * - Max reconnect attempts exceeded
     */
    onClose?: () => void;

    /**
     * Called when reconnecting
     */
    onReconnect?: (attempt: number) => void;

    /**
     * Called when the server grants or revokes one event on the open connection
     * (`subscription.granted` / `subscription.revoked` frames). Only events in
     * `events` can change: an event never requested cannot be granted.
     */
    onSubscriptionChange?: (change: SSESubscriptionChange<TRouter>) => void;
}

/**
 * A `grant` / `revoke` the server applied to the open connection.
 */
export interface SSESubscriptionChange<TRouter extends EventRouterDef<any>>
{
    event: InferEventNames<TRouter>;
    status: 'granted' | 'revoked';
}

/**
 * SSE connection state
 */
export type SSEConnectionState = 'connecting' | 'open' | 'closed' | 'error';

/**
 * Unsubscribe function
 */
export type SSEUnsubscribe = () => void;
