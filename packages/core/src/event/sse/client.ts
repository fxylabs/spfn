/**
 * SSE Client
 *
 * Type-safe EventSource wrapper for event subscription
 *
 * @example
 * ```typescript
 * import { createSSEClient } from '@spfn/core/event/sse/client';
 * import type { EventRouter } from '@/server/events';
 *
 * // Uses defaults: NEXT_PUBLIC_SPFN_API_URL + /events/stream
 * const client = createSSEClient<EventRouter>();
 *
 * // Or with custom host/pathname
 * const client = createSSEClient<EventRouter>({
 *     host: 'https://api.example.com',
 *     pathname: '/sse',
 * });
 *
 * // With token authentication (recommended: use createAuthSSEClient)
 * import { createAuthSSEClient } from '@spfn/core/event/sse/client';
 * const client = createAuthSSEClient<EventRouter>();
 *
 * const unsubscribe = client.subscribe({
 *     events: ['userCreated', 'orderPlaced'],
 *     handlers: {
 *         userCreated: (payload) => console.log('User:', payload.userId),
 *         orderPlaced: (payload) => console.log('Order:', payload.orderId),
 *     },
 * });
 *
 * // Later: cleanup
 * unsubscribe();
 * ```
 */

import type { EventRouterDef, InferEventNames } from '../router';
import { CSRF_HEADER, csrfHeaderValue, documentCookieEntries } from '../../nextjs/client/csrf';
import type {
    SSEClientConfig,
    SSESubscribeOptions,
    SSEUnsubscribe,
    SSEConnectionState,
    SSEMessage,
} from './types';

/**
 * SSE Client instance
 */
export interface SSEClient<TRouter extends EventRouterDef<any>>
{
    /**
     * Subscribe to events
     */
    subscribe(options: SSESubscribeOptions<TRouter>): SSEUnsubscribe;

    /**
     * Get current connection state
     */
    getState(): SSEConnectionState;

    /**
     * Close all connections
     */
    close(): void;
}

/**
 * Default SSE configuration
 */
const SSE_DEFAULTS = {
    host: typeof process !== 'undefined'
        ? (process.env.NEXT_PUBLIC_SPFN_API_URL || 'http://localhost:8790')
        : 'http://localhost:8790',
    pathname: '/events/stream',
} as const;

/**
 * Create type-safe SSE client
 *
 * @example
 * ```typescript
 * // Uses defaults (NEXT_PUBLIC_SPFN_API_URL + /events/stream)
 * const client = createSSEClient<EventRouter>();
 *
 * // Or with custom configuration
 * const client = createSSEClient<EventRouter>({
 *     host: 'https://api.example.com',
 *     pathname: '/sse',
 *     reconnect: true,
 *     reconnectDelay: 3000,
 * });
 *
 * // Subscribe to events
 * const unsubscribe = client.subscribe({
 *     events: ['userCreated', 'orderPlaced'],
 *     handlers: {
 *         userCreated: (payload) => {
 *             console.log('New user:', payload.userId);
 *         },
 *         orderPlaced: (payload) => {
 *             console.log('New order:', payload.orderId);
 *         },
 *     },
 *     onOpen: () => console.log('Connected'),
 *     onError: (err) => console.error('Error:', err),
 *     onReconnect: (attempt) => console.log('Reconnecting...', attempt),
 * });
 *
 * // Cleanup
 * unsubscribe();
 * ```
 */
/**
 * Per-subscription connection resources.
 *
 * Grouped so an in-flight async connect can be cancelled atomically and
 * `close()` can tear down whichever subscription is currently active —
 * the shared module-level EventSource used to leak across the token await.
 */
interface SSEConnection
{
    eventSource: EventSource | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    reconnectAttempts: number;
    closed: boolean;
    onClose?: () => void;
}

export function createSSEClient<TRouter extends EventRouterDef<any>>(
    config: SSEClientConfig = {},
): SSEClient<TRouter>
{
    const {
        url,
        host = SSE_DEFAULTS.host,
        pathname = SSE_DEFAULTS.pathname,
        reconnect = true,
        reconnectDelay = 3000,
        maxReconnectAttempts = 0,
        withCredentials = false,
        acquireToken,
    } = config;

    // Build base URL: url takes precedence, otherwise host + pathname
    const baseUrl = url || `${host}${pathname}`;

    let state: SSEConnectionState = 'closed';
    let active: SSEConnection | null = null;

    // Idempotent teardown: closes the connection, fires onClose exactly once,
    // and clears the active slot if this was the live connection.
    function closeConn(conn: SSEConnection)
    {
        if (conn.closed)
        {
            return;
        }

        conn.closed = true;

        if (conn.reconnectTimer)
        {
            clearTimeout(conn.reconnectTimer);
            conn.reconnectTimer = null;
        }

        if (conn.eventSource)
        {
            conn.eventSource.close();
            conn.eventSource = null;
        }

        if (active === conn)
        {
            active = null;
            state = 'closed';
        }

        conn.onClose?.();
    }

    function subscribe(options: SSESubscribeOptions<TRouter>): SSEUnsubscribe
    {
        const { events, handlers, onOpen, onError, onReconnect, onClose } = options;

        // A new subscription supersedes any previous one on this client.
        if (active)
        {
            closeConn(active);
        }

        const conn: SSEConnection = {
            eventSource: null,
            reconnectTimer: null,
            reconnectAttempts: 0,
            closed: false,
            onClose,
        };
        active = conn;

        const eventNames = events as string[];

        function connect()
        {
            state = 'connecting';

            const init = async () =>
            {
                let tokenParam = '';

                if (acquireToken)
                {
                    const token = await acquireToken();

                    // Cancelled during the token await (e.g. StrictMode cleanup) —
                    // don't open a connection that has no teardown waiting for it.
                    if (conn.closed)
                    {
                        return;
                    }

                    tokenParam = `&token=${encodeURIComponent(token)}`;
                }

                if (conn.closed)
                {
                    return;
                }

                const streamUrl = `${baseUrl}?events=${eventNames.join(',')}${tokenParam}`;

                conn.eventSource = new EventSource(streamUrl, {
                    withCredentials,
                });

                setupEventHandlers(conn.eventSource, eventNames, handlers, onOpen, onError);
                setupReconnect(onReconnect);
            };

            init().catch(() =>
            {
                // Don't resurrect a torn-down subscription via reconnect.
                if (conn.closed)
                {
                    return;
                }

                state = 'error';
                attemptReconnect(onReconnect);
            });
        }

        function setupEventHandlers(
            es: EventSource,
            names: string[],
            handlerMap: SSESubscribeOptions<TRouter>['handlers'],
            onOpenCb?: () => void,
            onErrorCb?: (error: Event) => void,
        )
        {
            es.onopen = () =>
            {
                state = 'open';
                conn.reconnectAttempts = 0;
                onOpenCb?.();
            };

            es.onerror = (error) =>
            {
                state = 'error';
                onErrorCb?.(error);
            };

            // Handle connected event (server sends this on connection)
            es.addEventListener('connected', (e: MessageEvent) =>
            {
                try
                {
                    const data = JSON.parse(e.data);
                    console.debug('[SSE] Connected:', data);
                }
                catch
                {
                    // Ignore parse errors
                }
            });

            // Handle ping (keep-alive)
            es.addEventListener('ping', () =>
            {
                // Ping received, connection is alive
            });

            // Register handlers for each event
            for (const eventName of names)
            {
                const handler = (handlerMap as Record<string, ((payload: unknown) => void) | undefined>)[eventName];

                if (!handler)
                {
                    continue;
                }

                es.addEventListener(eventName, (e: MessageEvent) =>
                {
                    try
                    {
                        const message: SSEMessage = JSON.parse(e.data);
                        handler(message.data);
                    }
                    catch (err)
                    {
                        console.error(`[SSE] Failed to parse event "${eventName}":`, err);
                    }
                });
            }
        }

        function setupReconnect(onReconnectCb?: (attempt: number) => void)
        {
            if (!conn.eventSource)
            {
                return;
            }

            const currentEs = conn.eventSource;
            const originalOnError = currentEs.onerror;

            currentEs.onerror = (error) =>
            {
                if (originalOnError)
                {
                    (originalOnError as (ev: Event) => void)(error);
                }

                // Token-auth 사용 시 브라우저 auto-retry는 소비된 토큰으로 재시도하므로
                // 즉시 close하고 우리 reconnect로 새 토큰 발급받아 재연결
                if (reconnect && acquireToken)
                {
                    currentEs.close();
                    attemptReconnect(onReconnectCb);
                }
                else if (reconnect && currentEs.readyState === EventSource.CLOSED)
                {
                    attemptReconnect(onReconnectCb);
                }
            };
        }

        function attemptReconnect(onReconnectCb?: (attempt: number) => void)
        {
            if (conn.closed || !reconnect)
            {
                return;
            }

            if (maxReconnectAttempts > 0 && conn.reconnectAttempts >= maxReconnectAttempts)
            {
                closeConn(conn);

                return;
            }

            conn.reconnectAttempts++;
            onReconnectCb?.(conn.reconnectAttempts);

            conn.reconnectTimer = setTimeout(() =>
            {
                connect();
            }, reconnectDelay);
        }

        // Start connection
        connect();

        // Return unsubscribe function
        return () =>
        {
            closeConn(conn);
        };
    }

    function getState(): SSEConnectionState
    {
        return state;
    }

    function close()
    {
        if (active)
        {
            closeConn(active);
        }
        else
        {
            state = 'closed';
        }
    }

    return {
        subscribe,
        getState,
        close,
    };
}

/**
 * Simple subscribe function for one-off subscriptions
 *
 * @example
 * ```typescript
 * import { subscribeToEvents } from '@spfn/core/event/sse/client';
 * import type { EventRouter } from '@/server/events';
 *
 * // Using defaults
 * const unsubscribe = subscribeToEvents<EventRouter>(
 *     ['userCreated', 'orderPlaced'],
 *     {
 *         userCreated: (payload) => console.log('User:', payload),
 *         orderPlaced: (payload) => console.log('Order:', payload),
 *     }
 * );
 *
 * // With custom host
 * const unsubscribe = subscribeToEvents<EventRouter>(
 *     ['userCreated'],
 *     { userCreated: (payload) => console.log('User:', payload) },
 *     { host: 'https://api.example.com' }
 * );
 * ```
 */
export function subscribeToEvents<TRouter extends EventRouterDef<any>>(
    events: InferEventNames<TRouter>[],
    handlers: SSESubscribeOptions<TRouter>['handlers'],
    options?: SSEClientConfig,
): SSEUnsubscribe
{
    const client = createSSEClient<TRouter>(options);

    return client.subscribe({
        events,
        handlers,
    });
}

// ============================================================================
// Auth SSE Client
// ============================================================================

/**
 * SSE client configuration for authenticated connections
 *
 * Same as SSEClientConfig but without acquireToken (auto-configured).
 */
export interface AuthSSEClientConfig extends Omit<SSEClientConfig, 'acquireToken'>
{
    /**
     * RPC proxy base URL for token acquisition
     * @default '/api/rpc'
     */
    rpcBaseUrl?: string;
}

/**
 * Headers of the one-time token request.
 *
 * The token route is a cookie-authenticated POST through the RPC proxy, so the
 * @spfn/auth CSRF rule applies to it exactly as to any other mutation: the
 * readable `spfn_csrf` cookie family is mirrored into `x-spfn-csrf`, the way
 * the api client does. Without the header, `SPFN_AUTH_CSRF=enforce` refuses
 * the request and the stream never opens.
 *
 * @internal Exported for tests
 */
export function tokenRequestHeaders(cookies: Iterable<[string, string]> = documentCookieEntries()): Record<string, string>
{
    const csrf = csrfHeaderValue(cookies);

    return csrf === undefined
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json', [CSRF_HEADER]: csrf };
}

/**
 * Create SSE client with built-in token authentication
 *
 * Acquires one-time SSE tokens via RPC proxy automatically, sending the
 * `x-spfn-csrf` header whenever a `spfn_csrf` cookie is present.
 * Requires eventRouteMap to be merged into RPC proxy config.
 *
 * @example
 * ```typescript
 * import { createAuthSSEClient } from '@spfn/core/event/sse/client';
 * import type { EventRouter } from '@/server/events';
 *
 * const client = createAuthSSEClient<EventRouter>();
 *
 * client.subscribe({
 *     events: ['userCreated'],
 *     handlers: {
 *         userCreated: (payload) => console.log(payload),
 *     },
 * });
 * ```
 */
export function createAuthSSEClient<TRouter extends EventRouterDef<any>>(
    config: AuthSSEClientConfig = {},
): SSEClient<TRouter>
{
    const { rpcBaseUrl = '/api/rpc', ...sseConfig } = config;

    return createSSEClient<TRouter>({
        ...sseConfig,
        acquireToken: async () =>
        {
            const res = await fetch(`${rpcBaseUrl}/eventsToken`, {
                method: 'POST',
                credentials: 'include',
                headers: tokenRequestHeaders(),
                body: JSON.stringify({}),
            });

            if (!res.ok)
            {
                throw new Error(`Failed to acquire SSE token: ${res.status}`);
            }

            const data = await res.json();

            return data.token;
        },
    });
}
