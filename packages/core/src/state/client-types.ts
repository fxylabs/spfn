/**
 * State Client Types
 *
 * Everything the browser side knows about a state router is its type,
 * `typeof states`, imported type-only. These types turn it into the ids, keys,
 * values and write inputs the client and the hook accept. Nothing here is
 * runtime: the client bundle never contains server code.
 */

import type { Static, TSchema } from '@sinclair/typebox';
import type { SSEClient } from '@spfn/core/event/sse/client';
import type { ApiConfig } from '@spfn/core/nextjs';
import type { StateRouter, StatesSnapshot } from '@spfn/core/state';

export type { InferStateInput, InferStateKey, InferStateValue } from '@spfn/core/state';

/** Any state router, as `typeof states`. */
export type AnyStateRouter = StateRouter<any>;

type StateOf<TStates extends AnyStateRouter> = TStates['states'][keyof TStates['states']];

type Schema<T> = T extends TSchema ? Static<T> : undefined;

/**
 * What the client needs of each state, computed once per router: key, value,
 * data and write input by id. Every signature below indexes it, rather than
 * re-deriving a state's shape per argument.
 */
export type StateCatalog<TStates extends AnyStateRouter> = {
    [S in StateOf<TStates> as S['id']]: {
        key: Schema<S['_types']['key']>;
        value: Schema<S['_types']['value']>;
        data: Schema<S['_types']['data']>;
        input: S['_types']['input'] extends TSchema ? Static<S['_types']['input']> : never;
    };
};

/** The ids of a router's states. */
export type StateId<TStates extends AnyStateRouter> = keyof StateCatalog<TStates> & string;

/** The data type of state `Id`, `undefined` when it declares no `.data()`. */
export type InferStateData<TStates extends AnyStateRouter, Id extends StateId<TStates>> = StateCatalog<TStates>[Id]['data'];

/** The ids of the states that declare a `.write()`. */
export type WritableStateId<TStates extends AnyStateRouter> = {
    [Id in StateId<TStates>]: [StateCatalog<TStates>[Id]['input']] extends [never] ? never : Id;
}[StateId<TStates>];

/** The key argument of state `Id`: one key object when keyed, none when keyless. */
export type StateKeyArgs<TStates extends AnyStateRouter, Id extends StateId<TStates>> =
    [StateCatalog<TStates>[Id]['key']] extends [undefined] ? [] : [key: StateCatalog<TStates>[Id]['key']];

/** The frame type of state `Id`. */
export type StateFrameOf<TStates extends AnyStateRouter, Id extends StateId<TStates>> =
    StateFrame<StateCatalog<TStates>[Id]['value'], StateCatalog<TStates>[Id]['data']>;

/** A value as a read, a write or the SSE event answers it, stamped with the `at` of its read. */
export interface StateFrame<V = unknown, D = unknown>
{
    at: string;
    value: V;
    data?: D;
}

/**
 * What the client holds for one `(id, key)`: the frame that last changed
 * `status`, `value` or `data` — its `at` is that read's, not the newest `at`
 * the client has seen — and whether the server still serves it. A state the
 * server stopped serving before any value arrived is `{ status: 'revoked' }` alone.
 */
export type StateEntry<V = unknown, D = unknown> =
    | Readonly<StateFrame<V, D> & { status: 'ready' | 'revoked' }>
    | Readonly<{ at?: undefined; value?: undefined; data?: undefined; status: 'revoked' }>;

/** Called after the entry of a subscribed `(id, key)` changed. */
export type StateListener = () => void;

/**
 * Whether the client's stream is live. `'reconnecting'` until a stream opens and while the SSE
 * client retries a dropped one — `attempt` is its count, `0` before its first retry;
 * `'failed'` when the retries are exhausted (the SSE client's `maxReconnectAttempts`, the
 * client's `maxRetries` for the first snapshot), until `retry()`, a new `subscribe` or `online`.
 * `'closed'` with reason `'unauthorized'` when the stream's token mint answered 401 — the
 * session is gone (e.g. its device key was revoked): no retry is set, and neither `online` nor
 * a new `subscribe` reopens it; only the app's own `retry()` (after signing in again) does.
 */
export type ConnectionStatus =
    | { status: 'connected' }
    | { status: 'reconnecting'; attempt: number }
    | { status: 'failed' }
    | { status: 'closed'; reason: 'unauthorized' };

/** Called with the new status after the client's connection status changed. */
export type ConnectionListener = (status: ConnectionStatus) => void;

/**
 * The snapshot a server render read, for a client to start from (`StateClientConfig.initial`).
 * Pass what `api.getStates` answered: a snapshot whose manifest names a state the server does not
 * serve keeps the stream from opening, as the SSE handler refuses that event. The router type
 * parameter (`StateClientInitial<typeof states>`, `createStateClient<typeof states>`) is what types
 * `snapshot`; without it the client is untyped, as before.
 */
export interface StateClientInitial<TStates extends AnyStateRouter = any>
{
    /** What `api.getStates` (or the snapshot route) answered for the render. */
    snapshot: StatesSnapshot<TStates['states']>;

    /** The query that snapshot was read with; keyed entries are stored under its key. @default {} */
    query?: Record<string, string>;
}

export interface StateClientConfig<TStates extends AnyStateRouter = any>
{
    /**
     * The SSE client the stream is opened on — `createAuthSSEClient()` for an
     * authenticated app. Give the state client its own: an `SSEClient` holds
     * one subscription, and the state client's supersedes any other on it.
     */
    sse: SSEClient<any>;

    /** Passed to `createApi` for the read, write and snapshot routes. */
    api?: ApiConfig;

    /**
     * Something the client ran on its own failed: a snapshot (the first, or the
     * one after a stream opened), the read after a grant, or a `subscribe` the
     * manifest refuses. Calls the app makes reject instead.
     * @default console.error
     */
    onError?: (error: unknown) => void;

    /**
     * Milliseconds before a failed first snapshot is read again, while
     * subscriptions wait on it — the SSE client's `reconnectDelay` for a
     * stream that does not exist yet.
     * @default 3000
     */
    retryDelay?: number;

    /**
     * How many times a failed first snapshot is read again before the client
     * gives up: the status turns `'failed'` and no retry is set, until
     * `retry()`, a new `subscribe` or `online`. The first read is not a retry.
     * `0` retries until the snapshot succeeds.
     * @default 0
     */
    maxRetries?: number;

    /**
     * The snapshot the server rendered with. The client installs its manifest
     * and applies its states at construction, so `current()` answers at once
     * and the first `subscribe` opens the stream without reading the snapshot
     * first. The stream's open still re-reads it.
     */
    initial?: StateClientInitial<TStates>;
}

/**
 * The browser side of a state router: one store per `(id, key)`, one SSE
 * stream for the whole client.
 */
export interface StateClient<TStates extends AnyStateRouter>
{
    /** Read one state; the answer is applied to the store and returned. */
    get<Id extends StateId<TStates>>(id: Id, ...key: StateKeyArgs<TStates, Id>): Promise<StateFrameOf<TStates, Id>>;

    /** Read every state the query names a key for, and the manifest; each entry is applied and the snapshot returned. */
    snapshot(query?: Record<string, string>): Promise<StatesSnapshot<TStates['states']>>;

    /**
     * Watch one `(id, key)`. The first subscriber reads the snapshot — unless
     * the client was built with `initial` — then opens the stream. A key whose fields are not the state's goes to `onError` once
     * the manifest is known. Returns the unsubscribe.
     */
    subscribe<Id extends StateId<TStates>>(
        id: Id,
        ...args: [...key: StateKeyArgs<TStates, Id>, listener: StateListener]
    ): () => void;

    /** Write a state through its write route; the answer is applied at once and returned. */
    write<Id extends WritableStateId<TStates>>(
        id: Id,
        input: StateCatalog<TStates>[Id]['input'],
        ...key: StateKeyArgs<TStates, Id>
    ): Promise<StateFrameOf<TStates, Id>>;

    /** The entry held for `(id, key)`, the same object until it changes. */
    current<Id extends StateId<TStates>>(
        id: Id,
        ...key: StateKeyArgs<TStates, Id>
    ): StateEntry<StateCatalog<TStates>[Id]['value'], StateCatalog<TStates>[Id]['data']> | undefined;

    /** The connection status, a frozen object: the same reference until it changes. */
    connection(): ConnectionStatus;

    /**
     * Call `listener` with the new status on every change of `connection()`.
     * Returns the unsubscribe (idempotent).
     */
    subscribeConnection(listener: ConnectionListener): () => void;

    /**
     * Restart now when `'failed'`, `'reconnecting'` or `'closed'` (unauthorized —
     * call it once the app signed in again): the first snapshot is
     * read again, its retry count reset, or the stream reopened. A no-op when
     * `'connected'`, while the first snapshot is in flight, or with nothing
     * subscribed — so after `close()`, until a new `subscribe`, which `retry()`
     * then restarts as before. `online` is not listened to again after `close()`.
     */
    retry(): void;

    /** Close the stream, drop every listener and stop listening to `online`. */
    close(): void;
}
