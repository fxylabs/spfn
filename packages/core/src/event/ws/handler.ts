/**
 * WebSocket Handler
 *
 * Attaches a WebSocket server to an existing Node.js http.Server.
 * Handles authentication, event subscription, and client message routing.
 */

import type { Server } from 'node:http';
import type { EventDef } from '../types';
import type {
    WSRouterDef,
    WSHandlerConfig,
    WSHandlerAuthConfig,
    WSMessageHandlers,
    WSRawConnection,
} from './types';
import type { SSEToken, SSETokenManager } from '../sse/token-manager';
import { createStreamsByKey } from '../key-close';
import { POLICY_VIOLATION_CLOSE_CODE, KEY_REVOKED_CLOSE_REASON, ORIGIN_NOT_ALLOWED_CLOSE_REASON } from '../stream-refusal';
import type { KeyedStream, StreamsByKey } from '../key-close';
import { logger } from '@spfn/core/logger';

const wsLogger = logger.child('@spfn/core:ws');

/**
 * Decide whether a WebSocket upgrade's Origin is permitted.
 *
 * - no allow-list configured → allowed (check disabled)
 * - no Origin header (native/non-browser client) → allowed
 * - Origin present → must be in the allow-list
 */
export function isOriginAllowed(
    origin: string | undefined,
    allowList: Set<string> | null,
): boolean
{
    if (!allowList)
    {
        return true;
    }

    if (!origin)
    {
        return true;
    }

    return allowList.has(origin);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Attach a WebSocket server to a Node.js http.Server
 *
 * @returns cleanup function that closes the WebSocket server
 */
export async function attachWSHandler<
    TEvents extends Record<string, EventDef<any>>,
    TMessages extends WSMessageHandlers,
>(
    server: Server,
    router: WSRouterDef<TEvents, TMessages>,
    config: WSHandlerConfig & { path?: string } = {},
    tokenManager?: SSETokenManager,
): Promise<() => Promise<void>>
{
    const WebSocketServer = await loadWSServer();

    const {
        pingInterval = 30000,
        path = '/ws',
        maxPayload = 1_048_576,
        maxBufferedBytes = 1_048_576,
        maxConnections = 10_000,
        maxConnectionsPerSubject = 0,
        allowedOrigins,
        auth: authConfig,
    } = config;

    const originAllowList = allowedOrigins && allowedOrigins.length > 0
        ? new Set(allowedOrigins)
        : null;

    if (authConfig?.enabled && !tokenManager)
    {
        throw new Error(
            'WebSocket auth.enabled=true requires a tokenManager. ' +
            'Pass tokenManager or use .websockets(router, { auth: { enabled: true } }) via startServer.',
        );
    }

    const wss = new WebSocketServer({ server, path, maxPayload });

    // Track live connections for graceful shutdown
    const clients = new Set<any>();
    // Live connection count per authenticated subject (for the per-subject cap)
    const subjectCounts = new Map<string, number>();
    // Open sockets and pending connects by device key, reached by `closeConnectionsByKey`
    const streamsByKey = createStreamsByKey();

    wss.on('connection', (ws: any, req: any) =>
    {
        // Origin allow-list (cross-site WebSocket hijacking protection). Browsers
        // always send Origin on the upgrade; reject one that isn't allowed before
        // doing any work. A missing Origin (native/non-browser client, which can't
        // be CSRF'd into using ambient cookies) passes through.
        if (!isOriginAllowed(req.headers?.origin, originAllowList))
        {
            wsLogger.warn('WebSocket rejected: disallowed origin', { origin: req.headers?.origin });
            ws.close(POLICY_VIOLATION_CLOSE_CODE, ORIGIN_NOT_ALLOWED_CLOSE_REASON);

            return;
        }

        // Global connection cap — reject before doing any work
        if (clients.size >= maxConnections)
        {
            ws.close(1013, 'Server at capacity');

            return;
        }

        clients.add(ws);
        ws.on('close', () => clients.delete(ws));
        handleConnection(ws, req, router, authConfig, tokenManager, {
            pingInterval,
            maxBufferedBytes,
            maxConnectionsPerSubject,
            subjectCounts,
            streamsByKey,
        })
            .catch((err: Error) =>
            {
                wsLogger.error('WebSocket connection handler error', err);
                if (ws.readyState === 1) ws.close(1011, 'Internal server error');
            });
    });

    wss.on('error', (err: Error) =>
    {
        wsLogger.error('WebSocket server error', err);
    });

    wsLogger.info(`✓ WebSocket endpoint registered at ${path}`, {
        events: router.eventNames,
        auth: !!authConfig?.enabled,
    });

    return () => new Promise<void>((resolve, reject) =>
    {
        // Close all existing connections with 1001 Going Away
        for (const client of clients)
        {
            client.close(1001, 'Server shutting down');
        }
        clients.clear();

        wss.close((err?: Error) =>
        {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ============================================================================
// Connection Handler
// ============================================================================

interface ConnectionOptions
{
    pingInterval: number;
    maxBufferedBytes: number;
    maxConnectionsPerSubject: number;
    subjectCounts: Map<string, number>;
    streamsByKey: StreamsByKey;
}

/** What a connect that passed every check opens with, or the close that refuses it. */
type SocketAdmission =
    | { subject: string | undefined; allowedEvents: string[] }
    | { refused: { code: number; reason: string } };

async function handleConnection(
    ws: any,
    req: any,
    router: WSRouterDef<any, any>,
    authConfig: WSHandlerAuthConfig | undefined,
    tokenManager: SSETokenManager | undefined,
    opts: ConnectionOptions,
): Promise<void>
{
    const { pingInterval, maxBufferedBytes, maxConnectionsPerSubject, subjectCounts, streamsByKey } = opts;
    // Register close handler before any await — ensures we never miss the event even during auth
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let connectionUnsubscribes: (() => void)[] = [];
    let subscribedEvents: string[] = [];
    ws.on('close', () =>
    {
        clearInterval(pingTimer);
        connectionUnsubscribes.forEach(fn => fn());
        if (subscribedEvents.length > 0)
            wsLogger.info('WebSocket connection closed', { events: subscribedEvents });
    });

    const url = parseURL(req);
    if (!url)
    {
        ws.close(1002, 'Invalid request URL');

        return;
    }

    // ── 1. Authenticate (the store half) ──
    const token = await takeToken(url, authConfig?.enabled ? tokenManager : undefined);
    if (token === false)
    {
        ws.close(4001, 'Missing token');

        return;
    }
    if (token === null)
    {
        ws.close(4001, INVALID_TOKEN_REASON);

        return;
    }

    // Synchronously after the take: a close of the token's key that lands while
    // the checks below await is recorded, and the socket never opens.
    const keyAdmission = streamsByKey.beginAdmission(token?.keyId);
    const admission = await admitSocket(url, router, authConfig, tokenManager, token).finally(keyAdmission.end);
    if ('refused' in admission)
    {
        ws.close(admission.refused.code, admission.refused.reason);

        return;
    }
    if (keyAdmission.closed())
    {
        ws.close(POLICY_VIOLATION_CLOSE_CODE, KEY_REVOKED_CLOSE_REASON);

        return;
    }

    const { subject, allowedEvents } = admission;

    // ── Per-subject connection cap (authenticated subjects only) ──
    if (maxConnectionsPerSubject > 0 && typeof subject === 'string')
    {
        const current = subjectCounts.get(subject) ?? 0;
        if (current >= maxConnectionsPerSubject)
        {
            ws.close(1013, 'Too many connections for this subject');

            return;
        }

        subjectCounts.set(subject, current + 1);
        ws.on('close', () =>
        {
            const remaining = (subjectCounts.get(subject) ?? 1) - 1;
            if (remaining <= 0) subjectCounts.delete(subject);
            else subjectCounts.set(subject, remaining);
        });
    }

    subscribedEvents = allowedEvents;
    wsLogger.info('WebSocket connection established', {
        events: allowedEvents,
        subject: subject ?? undefined,
    });

    // ── 4. Build connection wrapper ──
    const connection = createConnection(ws, maxBufferedBytes);

    // ── 5. Subscribe to server-push events ──
    connectionUnsubscribes = subscribeEvents(ws, router, allowedEvents, subject, authConfig, maxBufferedBytes);

    // If socket closed during auth awaits, clean up and bail
    if (ws.readyState !== 1)
    {
        connectionUnsubscribes.forEach(fn => fn());
        connectionUnsubscribes = [];

        return;
    }

    // Indexed under its key with no `await` since the admission ended, so no
    // key close falls between the two. Closing drops the subscriptions first:
    // nothing published after the close reaches the socket.
    const keyed: KeyedStream = {
        close: () =>
        {
            connectionUnsubscribes.forEach(fn => fn());
            connectionUnsubscribes = [];
            ws.close(POLICY_VIOLATION_CLOSE_CODE, KEY_REVOKED_CLOSE_REASON);
        },
    };
    streamsByKey.add(token?.keyId, keyed);
    ws.on('close', () => streamsByKey.remove(token?.keyId, keyed));

    // ── 6. Handle incoming messages ──
    ws.on('message', (data: Buffer | string) =>
    {
        // A socket closed server-side (its key revoked) no longer reaches the app's handlers.
        if (ws.readyState !== 1) return;

        onClientMessage(data, router, connection, subject)
            .catch((err: Error) => wsLogger.error('Unhandled message error', err));
    });

    // ── 7. Keep-alive ping with liveness (pong) tracking ──
    // Without reaping un-ponged sockets, a half-open connection (sleeping device,
    // NAT drop with no FIN) lingers with its subscriptions, timer, and buffers.
    if (pingInterval > 0)
    {
        ws.isAlive = true;
        ws.on('pong', () =>
        {
            ws.isAlive = true;
        });

        pingTimer = setInterval(() =>
        {
            if (ws.readyState !== 1) return;

            if (ws.isAlive === false)
            {
                // No pong since the previous tick — drop the dead/half-open socket
                ws.terminate();

                return;
            }

            ws.isAlive = false;
            ws.ping();
        }, pingInterval);
    }

    // ── 9. Send connected ack ──
    connection.send('__connected', {
        subscribedEvents: allowedEvents,
        timestamp: Date.now(),
    });
}

// ============================================================================
// Helpers
// ============================================================================

function parseURL(req: any): URL | null
{
    try
    {
        return new URL(req.url ?? '/', 'ws://localhost');
    }
    catch
    {
        return null;
    }
}

/** The refusal of a token that is unknown, expired, consumed, or whose key is gone. */
const INVALID_TOKEN_REASON = 'Invalid or expired token';

/**
 * Take the one-time token out of the store — its key is checked later, with
 * the connect registered under it (`admitSocket`)
 * @returns what the token was minted with, undefined if no auth required,
 *          false if token missing, null if token invalid/expired/consumed
 */
async function takeToken(
    url: URL,
    tokenManager?: SSETokenManager,
): Promise<SSEToken | undefined | false | null>
{
    if (!tokenManager)
    {
        return undefined;
    }

    const token = url.searchParams.get('token');
    if (!token)
    {
        return false;
    }

    return tokenManager.take(token);
}

/**
 * The checks that run with the connect registered under its key, as the SSE
 * connect runs them: the token's key (`verifyKey`), the requested events, then
 * authorization.
 */
async function admitSocket(
    url: URL,
    router: WSRouterDef<any, any>,
    authConfig: WSHandlerAuthConfig | undefined,
    tokenManager: SSETokenManager | undefined,
    token: SSEToken | undefined,
): Promise<SocketAdmission>
{
    if (token && tokenManager && !await tokenManager.checkKey(token))
    {
        return { refused: { code: 4001, reason: INVALID_TOKEN_REASON } };
    }

    const requestedEvents = parseRequestedEvents(url, router.eventNames as string[]);
    if (requestedEvents.length === 0)
    {
        return { refused: { code: 4000, reason: 'No valid event names specified' } };
    }

    const subject = token?.subject;
    const allowedEvents = await resolveAllowedEvents(subject, requestedEvents, authConfig);
    if (allowedEvents === null)
    {
        return { refused: { code: 4003, reason: 'Not authorized for any requested events' } };
    }

    return { subject, allowedEvents };
}

function parseRequestedEvents(url: URL, validEventNames: string[]): string[]
{
    const eventsParam = url.searchParams.get('events');
    if (!eventsParam)
    {
        return [];
    }

    return eventsParam
        .split(',')
        .map(e => e.trim())
        .filter(e => validEventNames.includes(e));
}

async function resolveAllowedEvents(
    subject: string | undefined,
    requestedEvents: string[],
    authConfig?: WSHandlerAuthConfig,
): Promise<string[] | null>
{
    if (!subject || !authConfig?.authorize)
    {
        return requestedEvents;
    }

    const allowed = await authConfig.authorize(subject, requestedEvents);

    return allowed.length === 0 ? null : allowed;
}

/**
 * Send a JSON frame with backpressure protection. If the socket's outbound
 * buffer is already past the cap, the consumer is too slow — close the
 * connection (1013) instead of buffering more and risking OOM. The client
 * reconnects and re-subscribes.
 */
export function safeSend(ws: any, frame: unknown, maxBufferedBytes: number): void
{
    if (ws.readyState !== 1) return;

    if (ws.bufferedAmount > maxBufferedBytes)
    {
        ws.close(1013, 'Send buffer overflow');

        return;
    }

    try
    {
        ws.send(JSON.stringify(frame));
    }
    catch
    {
        // Socket closed between the readyState check and send — ignore
    }
}

function createConnection(ws: any, maxBufferedBytes: number): WSRawConnection
{
    return {
        send: (type, payload) => safeSend(ws, { type, data: payload }, maxBufferedBytes),
        close: (code, reason) => ws.close(code, reason),
    };
}

function subscribeEvents(
    ws: any,
    router: WSRouterDef<any, any>,
    allowedEvents: string[],
    subject: string | undefined,
    authConfig: WSHandlerAuthConfig | undefined,
    maxBufferedBytes: number,
): (() => void)[]
{
    const unsubscribes: (() => void)[] = [];

    for (const eventName of allowedEvents)
    {
        const eventDef = router.events[eventName];
        if (!eventDef) continue;

        const unsubscribe = eventDef.subscribe((payload: unknown) =>
        {
            if (ws.readyState !== 1) return;

            if (subject && authConfig?.filter?.[eventName])
            {
                if (!authConfig.filter[eventName](subject, payload)) return;
            }

            safeSend(ws, { type: eventName, data: payload }, maxBufferedBytes);
        });

        unsubscribes.push(unsubscribe);
    }

    return unsubscribes;
}

async function onClientMessage(
    data: Buffer | string,
    router: WSRouterDef<any, any>,
    connection: WSRawConnection,
    subject: string | undefined,
): Promise<void>
{
    let message: { type?: string; data?: unknown };

    try
    {
        message = JSON.parse(data.toString());
    }
    catch
    {
        return;
    }

    const { type, data: payload } = message;
    if (!type) return;

    const handler = router.messages[type];
    if (!handler) return;

    try
    {
        await handler({ payload, subject, ws: connection });
    }
    catch (err)
    {
        wsLogger.error(`WebSocket message handler error: ${type}`, err as Error);
    }
}

// ============================================================================
// Dynamic import for optional 'ws' dependency
// ============================================================================

/**
 * Resolve the WebSocketServer constructor from the 'ws' module object.
 *
 * ws is a dual package, so the module shape depends on the loader path:
 * - ESM (exports.import → wrapper.mjs): WebSocketServer is a named export;
 *   the default export is the bare WebSocket class with no properties on it.
 * - CJS (require interop): module.exports = WebSocket with
 *   WebSocket.WebSocketServer attached, surfaced under .default.
 * Named exports must win — checking .default first crashes on the ESM path.
 */
export function resolveWSServerCtor(mod: any): any
{
    return mod.WebSocketServer ?? mod.Server
        ?? mod.default?.WebSocketServer ?? mod.default?.Server;
}

async function loadWSServer(): Promise<any>
{
    let mod: any;

    try
    {
        mod = await import('ws');
    }
    catch
    {
        throw new Error(
            '@spfn/core WebSocket support requires the "ws" package.\n' +
            'Install it with: pnpm add ws',
        );
    }

    const WSS = resolveWSServerCtor(mod);

    if (typeof WSS !== 'function')
    {
        throw new Error(
            'WebSocketServer not found in ws module. ' +
            'Ensure ws@^8 is installed: pnpm add ws',
        );
    }

    return WSS;
}
