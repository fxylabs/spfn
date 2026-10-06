/**
 * WebSocket Types
 */

import type { Context } from 'hono';
import type { EventDef } from '../types';
import type { EventRouterBase, InferEventNames, InferEventPayload } from '../router';
import type { SSETokenStore, SSETokenManager } from '../sse/token-manager';

// ============================================================================
// Router
// ============================================================================

/**
 * WebSocket Router Definition
 *
 * Extends the event router shape with client→server message handlers.
 */
export interface WSRouterDef<
    TEvents extends Record<string, EventDef<any>>,
    TMessages extends WSMessageHandlers = WSMessageHandlers,
> extends EventRouterBase<TEvents>
{
    messages: TMessages;
}

// ============================================================================
// Message Handling (client → server)
// ============================================================================

/**
 * Low-level WS connection handle passed to message handlers
 */
export interface WSRawConnection
{
    send(type: string, payload: unknown): void;
    close(code?: number, reason?: string): void;
}

/**
 * Context passed to each client→server message handler
 */
export interface WSMessageContext<TPayload = unknown>
{
    payload: TPayload;
    subject?: string;
    ws: WSRawConnection;
}

/**
 * Single message handler function
 */
export type WSMessageHandlerFn<TPayload = unknown> =
    (ctx: WSMessageContext<TPayload>) => void | Promise<void>;

/**
 * Map of message type name → handler
 */
export type WSMessageHandlers = Record<string, WSMessageHandlerFn<any>>;

// ============================================================================
// Auth Config
// ============================================================================

/**
 * WebSocket auth configuration (internal, non-generic)
 */
export interface WSHandlerAuthConfig
{
    enabled?: boolean;
    tokenTtl?: number;
    store?: SSETokenStore;
    tokenManager?: SSETokenManager | (() => SSETokenManager);

    /**
     * Extract subject from Hono context (used on token-issue endpoint)
     * @default (c) => c.get('auth')?.userId ?? null
     */
    getSubject?: (c: Context) => string | null;

    /**
     * Authorize event subscriptions on connect
     * Return allowed events subset. Empty array = 403 rejection.
     */
    authorize?: (subject: string, events: string[]) => Promise<string[]> | string[];

    /**
     * Per-event payload filter (called on every emission)
     * Return false to skip sending the event to this client.
     */
    filter?: Record<string, (subject: string, payload: unknown) => boolean>;
}

/**
 * WebSocket auth configuration (user-facing, generic)
 */
export interface WSAuthConfig<TRouter extends WSRouterDef<any, any>>
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
}

// ============================================================================
// Handler Config
// ============================================================================

/**
 * Configuration for the WebSocket server handler
 */
export interface WSHandlerConfig
{
    /**
     * Keep-alive ping interval in ms
     * @default 30000
     */
    pingInterval?: number;

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
     * Maximum inbound message size in bytes. Frames larger than this are
     * rejected by the ws library before they are buffered or parsed.
     * @default 1048576 (1 MiB)
     */
    maxPayload?: number;

    /**
     * Backpressure cap: if a connection's outbound buffer (`bufferedAmount`)
     * exceeds this many bytes, the connection is closed (1013) instead of
     * buffering more — a slow consumer cannot drive the process to OOM.
     * @default 1048576 (1 MiB)
     */
    maxBufferedBytes?: number;

    /**
     * Maximum number of concurrent connections accepted by this server. New
     * connections beyond the cap are rejected with close code 1013.
     * @default 10000
     */
    maxConnections?: number;

    /**
     * Maximum concurrent connections per authenticated subject (0 = unlimited).
     * @default 0
     */
    maxConnectionsPerSubject?: number;

    /**
     * Allow-list of `Origin` header values permitted to open a WebSocket. A
     * browser sends Origin on the upgrade, so this blocks cross-site scripts from
     * connecting with the user's ambient cookies (WebSocket has no same-origin
     * policy / CORS of its own). Connections whose Origin isn't listed are closed
     * with 1008. Undefined/empty = no Origin check (default; non-browser clients
     * such as native apps send no Origin and are always allowed).
     *
     * @example ['https://app.example.com', 'https://admin.example.com']
     * @default undefined (disabled)
     */
    allowedOrigins?: string[];

    /**
     * Authentication and authorization configuration
     */
    auth?: WSHandlerAuthConfig;
}

// ============================================================================
// Client Config
// ============================================================================

/**
 * WebSocket client configuration
 */
export interface WSClientConfig
{
    /**
     * Backend API host URL (ws:// or wss://)
     * @default derived from NEXT_PUBLIC_SPFN_API_URL
     */
    host?: string;

    /**
     * WS endpoint pathname
     * @default '/ws'
     */
    pathname?: string;

    /**
     * Auto reconnect on disconnect
     * @default true
     */
    reconnect?: boolean;

    /**
     * Reconnect delay in ms
     * @default 3000
     */
    reconnectDelay?: number;

    /**
     * Maximum reconnect attempts (0 = infinite)
     * @default 0
     */
    maxReconnectAttempts?: number;

    /**
     * Acquire a one-time token before connecting
     */
    acquireToken?: () => Promise<string>;
}

// ============================================================================
// Client Instance
// ============================================================================

/**
 * WebSocket connection state
 */
export type WSConnectionState = 'connecting' | 'open' | 'closed' | 'error';

/**
 * Event handlers map for WSRouterDef
 */
export type WSEventHandlers<TRouter extends WSRouterDef<any, any>> = {
    [K in InferEventNames<TRouter>]?: (payload: InferEventPayload<TRouter, K>) => void;
};

/**
 * Subscribe options
 */
export interface WSSubscribeOptions<TRouter extends WSRouterDef<any, any>>
{
    events: InferEventNames<TRouter>[];
    handlers: WSEventHandlers<TRouter>;
    onOpen?: () => void;
    onError?: (error: Event) => void;
    onClose?: () => void;
    onReconnect?: (attempt: number) => void;
}

/**
 * Unsubscribe function
 */
export type WSUnsubscribe = () => void;
