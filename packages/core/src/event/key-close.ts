/**
 * Streams by device key — the one registry both transports close through
 *
 * A live stream opened with a token minted by device key K — an SSE
 * connection or a WebSocket — is indexed under K here, and so is a connect of
 * K still in admission. Every index a handler creates (`createStreamsByKey`)
 * is in one process-wide set while it holds a stream or a connect of a key, so
 * a key revocation reaches every handler of the process, of either transport,
 * and an index whose handler has none — or is gone — is not held there:
 * `applyKeyClose` is the local half of
 * `closeConnectionsByKey`. The cross-pod half lives in the cache transport,
 * which calls `applyKeyClose` for a close another pod published; this module
 * imports nothing from it, so the two never cycle.
 *
 * A stream opened with an untagged token (no key) is never indexed and never
 * closed by key.
 */

import { logger } from '@spfn/core/logger';

const keyCloseLogger = logger.child('@spfn/core:event');

/** The reason a stream is closed with when its key is revoked. */
export const KEY_REVOKED = 'key revoked';

/** One open stream, as the index needs it: a synchronous, idempotent server-side close. */
export interface KeyedStream
{
    readonly close: (reason: string) => void;
}

/**
 * A connect of one key between taking its token and opening. A close of its
 * key that lands meanwhile is recorded; the connect reads it at open.
 */
export interface KeyAdmission
{
    /** Whether a close of its key landed while it was pending. */
    readonly closed: () => boolean;

    /** Leave the pending index (opened, refused, or the client left); idempotent. */
    readonly end: () => void;
}

/** One handler's open streams and pending connects, by device key. */
export interface StreamsByKey
{
    /**
     * Register a pending connect of `keyId`; untagged (`undefined`) → never
     * closed. Call synchronously after the token leaves the store, before the
     * key check awaits, so a close landing during it is recorded.
     */
    readonly beginAdmission: (keyId: string | undefined) => KeyAdmission;

    /** Index an open stream under its key; untagged → not indexed. */
    readonly add: (keyId: string | undefined, stream: KeyedStream) => void;

    readonly remove: (keyId: string | undefined, stream: KeyedStream) => void;

    /**
     * Close every open stream of `keyId` and record the close on its pending
     * connects; answers how many open ones it closed.
     */
    readonly closeByKey: (keyId: string) => number;

    /** Open streams of `keyId`. */
    readonly countByKey: (keyId: string) => number;
}

const REGISTRIES_KEY = Symbol.for('@spfn/core:event-streams-by-key');

// globalThis, like the event transport: one set per process across the CJS/ESM dual package.
const registries: Set<StreamsByKey> = ((globalThis as any)[REGISTRIES_KEY] ??= new Set<StreamsByKey>());

/**
 * Create one handler's index of open streams and pending connects by device
 * key. It is reachable from `applyKeyClose` while it holds one, and leaves the
 * process-wide set with its last — so handlers created and dropped (tests, a
 * second server in one process) never accumulate there.
 */
export function createStreamsByKey(): StreamsByKey
{
    const open = new Map<string, Set<KeyedStream>>();
    const pending = new Map<string, Set<{ closed: boolean }>>();

    const enter = <T>(map: Map<string, Set<T>>, keyId: string | undefined, value: T): void =>
    {
        if (addToSet(map, keyId, value))
        {
            registries.add(index);
        }
    };

    const leave = <T>(map: Map<string, Set<T>>, keyId: string | undefined, value: T): void =>
    {
        removeFromSet(map, keyId, value);

        if (open.size === 0 && pending.size === 0)
        {
            registries.delete(index);
        }
    };

    const index: StreamsByKey = {
        beginAdmission: (keyId: string | undefined): KeyAdmission =>
        {
            const entry = { closed: false };
            enter(pending, keyId, entry);

            return {
                closed: () => entry.closed,
                end: () => leave(pending, keyId, entry),
            };
        },

        add: (keyId: string | undefined, stream: KeyedStream): void => enter(open, keyId, stream),

        remove: (keyId: string | undefined, stream: KeyedStream): void => leave(open, keyId, stream),

        // Iterates a copy: each close removes its stream.
        closeByKey: (keyId: string): number =>
        {
            const streams = [...open.get(keyId) ?? []];
            pending.get(keyId)?.forEach((entry) =>
            {
                entry.closed = true;
            });
            streams.forEach(stream => stream.close(KEY_REVOKED));

            return streams.length;
        },

        countByKey: (keyId: string): number => open.get(keyId)?.size ?? 0,
    };

    return index;
}

/**
 * Close, on this process, every open stream — SSE or WebSocket — whose token
 * was minted with `keyId`, and stop its pending connects from opening.
 * Answers how many open streams it closed. Logs the count and reason only —
 * never the key id.
 */
export function applyKeyClose(keyId: string): number
{
    let closed = 0;
    registries.forEach((registry) =>
    {
        closed += registry.closeByKey(keyId);
    });

    if (closed > 0)
    {
        keyCloseLogger.info('Stream connections closed', { count: closed, reason: KEY_REVOKED });
    }
    else
    {
        keyCloseLogger.debug('Key close reached no open connection', { reason: KEY_REVOKED });
    }

    return closed;
}

/** Add `value` under `key`; an absent key (an untagged token) is not indexed. Answers whether it was. */
function addToSet<T>(map: Map<string, Set<T>>, key: string | undefined, value: T): boolean
{
    if (!key)
    {
        return false;
    }

    const set = map.get(key) ?? new Set<T>();
    set.add(value);
    map.set(key, set);

    return true;
}

/** Remove `value` and drop the key once its set is empty, so the map never grows on reconnects. */
function removeFromSet<T>(map: Map<string, Set<T>>, key: string | undefined, value: T): void
{
    const set = key ? map.get(key) : undefined;
    set?.delete(value);

    if (key && set?.size === 0)
    {
        map.delete(key);
    }
}
