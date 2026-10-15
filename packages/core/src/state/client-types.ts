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
 * What the client holds for one `(id, key)`: the latest frame and whether the
 * server still serves it. A state the server stopped serving before any value
 * arrived is `{ status: 'revoked' }` alone.
 */
export type StateEntry<V = unknown, D = unknown> =
    | Readonly<StateFrame<V, D> & { status: 'ready' | 'revoked' }>
    | Readonly<{ at?: undefined; value?: undefined; data?: undefined; status: 'revoked' }>;

/** Called after the entry of a subscribed `(id, key)` changed. */
export type StateListener = () => void;

export interface StateClientConfig
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
     * Watch one `(id, key)`. The first subscriber reads the snapshot, then opens
     * the stream. A key whose fields are not the state's goes to `onError` once
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

    /** Close the stream and drop every listener. */
    close(): void;
}
