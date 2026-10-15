/**
 * SSE connection registry
 *
 * What one `createSSEHandler` knows about its open connections, so that
 * `EventDef.grant` / `EventDef.revoke` can change a connection after it opened.
 * One registry per handler: two handlers in one process (tests) never share one.
 *
 * Neither operation consults `canSubscribe` or `authorize`: they are an
 * operator's statement about an open connection. Permission lives in app data
 * and is re-read at the next connect. A `match` narrows either to the
 * connections whose connect query carries its fields.
 *
 * A connect still reading app data (`authorize`, `resolvePrincipal`,
 * `canSubscribe`) is a pending admission: a `grant` / `revoke` that lands then
 * is recorded on it and applied, without a frame, when the connection opens —
 * so a call the app made is never lost to that window.
 */

import { logger } from '@spfn/core/logger';
import type { SubscribeRequest, SubscriptionMatch } from '../types';

const registryLogger = logger.child('@spfn/core:sse');

/** Stream-owned frame: an event was activated on the open connection. */
export const SUBSCRIPTION_GRANTED = 'subscription.granted';

/** Stream-owned frame: an event was deactivated on the open connection. */
export const SUBSCRIPTION_REVOKED = 'subscription.revoked';

export type SubscriptionFrame = typeof SUBSCRIPTION_GRANTED | typeof SUBSCRIPTION_REVOKED;

/**
 * One open SSE connection. `allowed` and `denied` partition `requested`
 * (plus anything `authorize` added); only `allowed` events hold a live
 * subscription in `unsubscribes`.
 */
export interface SSEConnection
{
    /** `undefined` when the stream runs without auth — such a connection is never registered. */
    readonly subject: string | undefined;
    readonly requested: readonly string[];
    readonly allowed: Set<string>;
    readonly denied: Set<string>;
    readonly unsubscribes: Map<string, () => void>;
    readonly request: SubscribeRequest;

    /** The per-event subscribe the connection opened with — `grant` reuses it, never a copy. */
    readonly subscribe: (eventName: string) => () => void;

    /** Enqueue a protocol frame about one event (dropped once the connection is dead). */
    readonly notify: (frame: SubscriptionFrame, eventName: string) => void;
}

export type ConnectionRegistry = ReturnType<typeof createConnectionRegistry>;

type SubscriptionChange = 'grant' | 'revoke';

/**
 * A connect of one subject between its first app-data read and its open.
 * The first of `open` / `cancel` ends it; both are synchronous. A client abort
 * cancels it at once — even while an app predicate never settles.
 */
export interface PendingAdmission
{
    /**
     * Apply the recorded changes to `connection`, then swap this entry for the
     * open connection. `false`, with nothing applied or registered, once cancelled.
     */
    readonly open: (connection: SSEConnection) => boolean;

    /** Drop this entry (refused, aborted, or thrown); idempotent. */
    readonly cancel: () => void;
}

/** One `grant` / `revoke` recorded on a pending admission. */
interface RecordedChange
{
    kind: SubscriptionChange;
    eventName: string;
    match?: SubscriptionMatch;
}

/** The changes recorded on one pending admission, in call order (the last one wins). */
type RecordedChanges = RecordedChange[];

/**
 * Create the registry of one SSE handler, keyed by subject → open connections
 * (a subject with two tabs has two).
 */
export function createConnectionRegistry()
{
    const bySubject = new Map<string, Set<SSEConnection>>();
    const pendingBySubject = new Map<string, Set<RecordedChanges>>();

    /**
     * Register a pending admission of `subject`; `signal` is the connect's
     * abort signal, listened to until the admission ends either way.
     */
    const beginAdmission = (subject: string, signal: AbortSignal): PendingAdmission =>
    {
        const changes: RecordedChanges = [];
        addToSet(pendingBySubject, subject, changes);
        const end = endOnce(signal, () => removeFromSet(pendingBySubject, subject, changes));

        return {
            cancel: end,
            open: (connection: SSEConnection) =>
            {
                if (!end())
                {
                    return false;
                }

                applyRecorded(connection, changes);
                addToSet(bySubject, subject, connection);

                return true;
            },
        };
    };

    const change = (kind: SubscriptionChange, subject: string, eventName: string, match?: SubscriptionMatch): void =>
    {
        const pending = pendingBySubject.get(subject);
        const connections = bySubject.get(subject);
        pending?.forEach(changes => changes.push({ kind, eventName, match }));
        connections?.forEach(connection =>
        {
            if (matchesRequest(match, connection.request))
            {
                (kind === 'grant' ? grantOn : revokeOn)(connection, eventName);
            }
        });

        if (!pending && !connections)
        {
            registryLogger.debug('SSE subscription change for a subject with no open connection ignored', {
                event: eventName,
                subject,
            });
        }
    };

    return {
        beginAdmission,

        remove: (connection: SSEConnection): void =>
        {
            if (connection.subject)
            {
                removeFromSet(bySubject, connection.subject, connection);
            }
        },

        /** Open connections only — a pending admission is not counted. */
        count: (subject: string): number => bySubject.get(subject)?.size ?? 0,

        pendingCount: (subject: string): number => pendingBySubject.get(subject)?.size ?? 0,

        grant: (subject: string, eventName: string, match?: SubscriptionMatch): void =>
            change('grant', subject, eventName, match),

        revoke: (subject: string, eventName: string, match?: SubscriptionMatch): void =>
            change('revoke', subject, eventName, match),
    };
}

/**
 * The end of one pending admission: `remove` runs on the first call only,
 * which returns `true`; later calls return `false`. An abort of `signal` is a
 * first call; the listener is dropped on every end, so it never outlives the
 * admission (an already aborted signal ends it at once).
 */
function endOnce(signal: AbortSignal, remove: () => void): () => boolean
{
    let ended = false;
    const end = (): boolean =>
    {
        if (ended)
        {
            return false;
        }

        ended = true;
        signal.removeEventListener('abort', end);
        remove();

        return true;
    };

    signal.addEventListener('abort', end, { once: true });
    if (signal.aborted)
    {
        end();
    }

    return end;
}

function addToSet<T>(map: Map<string, Set<T>>, key: string, value: T): void
{
    const set = map.get(key) ?? new Set<T>();
    set.add(value);
    map.set(key, set);
}

/** Remove `value` and drop the key once its set is empty, so neither map grows on reconnects. */
function removeFromSet<T>(map: Map<string, Set<T>>, key: string, value: T): void
{
    const set = map.get(key);
    set?.delete(value);

    if (set?.size === 0)
    {
        map.delete(key);
    }
}

/**
 * Whether `match` reaches a connection: every named field equals the connect
 * query's value, string to string. A field the connection never declared
 * never matches, not even an empty string. No `match` reaches every one.
 */
export function matchesRequest(match: SubscriptionMatch | undefined, request: SubscribeRequest): boolean
{
    return match === undefined || Object.entries(match.query).every(([field, value]) =>
        Object.hasOwn(request.query, field) && request.query[field] === value);
}

/**
 * Apply what was recorded during admission to a connection that has not
 * opened yet: move the event between `allowed` and `denied`, no frame. An
 * event the connection never requested is in neither set and stays out; a
 * change whose `match` the connection's query does not meet is skipped.
 */
function applyRecorded(connection: SSEConnection, changes: RecordedChanges): void
{
    changes.forEach(({ kind, eventName, match }) =>
    {
        if (!matchesRequest(match, connection.request))
        {
            return;
        }

        const [from, to] = kind === 'grant'
            ? [connection.denied, connection.allowed]
            : [connection.allowed, connection.denied];

        if (from.delete(eventName))
        {
            to.add(eventName);
        }
    });
}

/**
 * Activate a denied event on one connection; allowed or never requested → no change.
 */
function grantOn(connection: SSEConnection, eventName: string): void
{
    if (!connection.denied.has(eventName))
    {
        return;
    }

    connection.unsubscribes.set(eventName, connection.subscribe(eventName));
    connection.denied.delete(eventName);
    connection.allowed.add(eventName);
    connection.notify(SUBSCRIPTION_GRANTED, eventName);
}

/**
 * Deactivate an allowed event on one connection; denied or never requested → no change.
 *
 * A frame the event already enqueued before this call may still be written —
 * the queue is not rewritten — but no frame after the unsubscribe is.
 */
function revokeOn(connection: SSEConnection, eventName: string): void
{
    if (!connection.allowed.has(eventName))
    {
        return;
    }

    connection.unsubscribes.get(eventName)?.();
    connection.unsubscribes.delete(eventName);
    connection.allowed.delete(eventName);
    connection.denied.add(eventName);
    connection.notify(SUBSCRIPTION_REVOKED, eventName);
}

/**
 * Drop every live subscription of a closing connection. A revoked event was
 * already removed from `unsubscribes`, so nothing is unsubscribed twice.
 */
export function unsubscribeAll(connection: SSEConnection): void
{
    connection.unsubscribes.forEach(unsubscribe => unsubscribe());
    connection.unsubscribes.clear();
}
