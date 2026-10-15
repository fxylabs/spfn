/**
 * State Client
 *
 * The browser side of a state router (`@spfn/core/state`): it calls the derived
 * read, write and snapshot routes, keeps one SSE stream open for every state of
 * the router, and orders snapshots against frames per `(id, key)`. It knows the
 * router by type — `typeof states` — and at runtime by the manifest every
 * snapshot carries; it imports no server code.
 *
 * @example
 * ```typescript
 * import { createStateClient } from '@spfn/core/state/client';
 * import { createAuthSSEClient } from '@spfn/core/event/sse/client';
 * import type { states } from '@/server/states';
 *
 * export const state = createStateClient<typeof states>({ sse: createAuthSSEClient() });
 *
 * const stop = state.subscribe('runtime', { workspaceId }, () => render(state.current('runtime', { workspaceId })));
 * ```
 */

import type { SSESubscriptionChange } from '@spfn/core/event/sse';
import { createApi } from '@spfn/core/nextjs';
import { stableKey, StateStore, type StateKeyFields } from './client-store';
import type {
    AnyStateRouter,
    StateClient,
    StateClientConfig,
    StateEntry,
    StateFrame,
    StateListener,
} from './client-types';

export type {
    AnyStateRouter,
    InferStateData,
    StateCatalog,
    StateFrameOf,
    InferStateInput,
    InferStateKey,
    InferStateValue,
    StateClient,
    StateClientConfig,
    StateEntry,
    StateFrame,
    StateId,
    StateKeyArgs,
    StateListener,
    WritableStateId,
} from './client-types';

/** A frame as the SSE event carries it. */
type WireFrame = StateFrame & { key?: StateKeyFields; subject?: string };

/** Every state of the router, in declaration order: its key fields and whether it has a write. */
type Manifest = Record<string, { key: string[]; write: boolean }>;

interface Snapshot
{
    at: string;
    states: Record<string, { value: unknown; data?: unknown }>;
    manifest: Manifest;
}

type RouteCalls = Record<string, { call(input: object): Promise<unknown> }>;

/** One `(id, key)` someone watches, and how many subscriptions hold it. */
interface Watch
{
    id: string;
    key: StateKeyFields | undefined;
    count: number;
}

/** The stream as one `sse.subscribe` opened it; `generation` names its current connection. */
interface Stream
{
    query: StateKeyFields;
    text: string;
    generation: number;
    close: () => void;
}

/** When an automatic read was started: the connection generation and the client's clock. */
interface ReadTag
{
    generation: number;
    tick: number;
}

/** `get<Id>State` / `put<Id>State`, the names the server router derives. */
function routeName(method: 'get' | 'put', id: string): string
{
    return `${method}${id[0].toUpperCase()}${id.slice(1)}State`;
}

/** Whether `query` carries every field of `key` with its value. */
function carries(query: StateKeyFields, key: StateKeyFields): boolean
{
    return Object.entries(key).every(([field, value]) => query[field] === value);
}

function sortedFields(fields: string[]): string
{
    return [...fields].sort().join(', ');
}

/**
 * Build the client for `typeof states`. The first subscription (or call)
 * reads the snapshot, whose manifest names every state; the stream then
 * requests every state event — the server's `grant` can only activate an
 * event the connection requested.
 */
export function createStateClient<TStates extends AnyStateRouter>(config: StateClientConfig): StateClient<TStates>
{
    return new BrowserStateClient(config) as unknown as StateClient<TStates>;
}

class BrowserStateClient
{
    private readonly store = new StateStore();
    private readonly api: RouteCalls;
    private readonly watched = new Map<string, Watch>();
    private readonly reportError: (error: unknown) => void;
    private manifest: Manifest | undefined;
    private manifestRead: Promise<void> | undefined;
    private stream: Stream | undefined;
    private syncQueued = false;

    /** The lifetime whose subscriptions wait on the first snapshot — its read in flight, or its retry timer set. */
    private waitingLifetime: number | undefined;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    /** Bumped by `close()`: a snapshot started before it is discarded. */
    private lifetime = 0;

    /** Bumped on every connection open; tags the snapshot read for it. */
    private generation = 0;

    /** Bumped on every automatic read and every grant, to tell which came first. */
    private clock = 0;

    /** The clock at the latest grant of each slot. */
    private readonly grants = new Map<string, number>();

    constructor(private readonly config: StateClientConfig)
    {
        this.api = createApi<any>(config.api) as unknown as RouteCalls;
        this.reportError = config.onError ?? (error => console.error('[state] A refresh failed:', error));
    }

    async get(id: string, key?: StateKeyFields): Promise<StateFrame>
    {
        await this.requireManifest();
        const frame = await this.api[routeName('get', id)].call(key ? { query: key } : {}) as StateFrame;
        this.store.apply(this.slot(id, key), frame);

        return frame;
    }

    async write(id: string, input: unknown, key?: StateKeyFields): Promise<StateFrame>
    {
        if (!(await this.requireManifest())[id]?.write)
        {
            throw new Error(`State client: state "${id}" declares no .write(), so it has no write route.`);
        }

        const frame = await this.api[routeName('put', id)].call({ body: input, ...(key ? { query: key } : {}) }) as StateFrame;
        this.store.apply(this.slot(id, key), frame);

        return frame;
    }

    snapshot(query: StateKeyFields = this.streamQuery()): Promise<Snapshot>
    {
        return this.readSnapshot(query, this.tag());
    }

    subscribe(id: string, ...args: [StateListener] | [StateKeyFields, StateListener]): () => void
    {
        const listener = args[args.length - 1] as StateListener;
        const key = args.length === 2 ? args[0] as StateKeyFields : undefined;
        const refusal = this.manifest && this.refusal(id, key);

        if (refusal)
        {
            this.reportError(refusal);

            return () => undefined;
        }

        // One wrapper per subscription: the same listener subscribed twice is two subscriptions.
        const notify = () => listener();
        const slot = this.slot(id, key);
        this.store.listen(slot, notify);
        this.watch(slot, id, key, 1);
        let live = true;

        return () =>
        {
            if (live)
            {
                live = false;
                this.store.unlisten(slot, notify);
                this.watch(slot, id, key, -1);
            }
        };
    }

    current(id: string, key?: StateKeyFields): StateEntry | undefined
    {
        return this.store.current(this.slot(id, key));
    }

    close(): void
    {
        this.lifetime++;
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.closeStream();
        this.watched.clear();
        this.store.clearListeners();
    }

    private slot(id: string, key: StateKeyFields | undefined): string
    {
        return StateStore.slot(id, stableKey(key));
    }

    private tag(): ReadTag
    {
        return { generation: this.generation, tick: ++this.clock };
    }

    /** The key of state `id` the query names; `undefined` for a keyless state. */
    private keyIn(id: string, query: StateKeyFields): StateKeyFields | undefined
    {
        const fields = this.manifest![id].key;

        return fields.length ? Object.fromEntries(fields.map(field => [field, query[field]])) : undefined;
    }

    /** Why the manifest refuses `subscribe(id, key)` — an unknown id, or key fields not the state's. */
    private refusal(id: string, key: StateKeyFields | undefined): Error | undefined
    {
        const state = this.manifest![id];

        if (!state)
        {
            return new Error(`State client: the server's manifest has no state "${id}".`);
        }

        const expected = sortedFields(state.key);
        const given = sortedFields(Object.keys(key ?? {}));

        return expected === given
            ? undefined
            : new Error(`State client: state "${id}" takes the key fields [${expected}], given [${given}].`);
    }

    /** The first snapshot, read once however many callers wait for it. */
    private ensureManifest(): Promise<void>
    {
        if (this.manifest)
        {
            return Promise.resolve();
        }

        this.manifestRead ??= this.snapshot()
            .then(() => undefined)
            .finally(() =>
            {
                this.manifestRead = undefined;
            });

        return this.manifestRead;
    }

    /** The manifest for a call the app made; one whose wait outlived `close()` is refused. */
    private async requireManifest(): Promise<Manifest>
    {
        await this.ensureManifest();

        if (!this.manifest)
        {
            throw new Error('State client: the client was closed while the first snapshot was in flight.');
        }

        return this.manifest;
    }

    /**
     * Read the snapshot and apply it: the manifest first — `keyIn` and the
     * key checks need it — then each state present, then each watched state
     * it omits. A snapshot that resolves after `close()` is discarded.
     */
    private async readSnapshot(query: StateKeyFields, tag: ReadTag): Promise<Snapshot>
    {
        const lifetime = this.lifetime;
        const snapshot = await this.api.getStates.call({ query }) as Snapshot;

        if (lifetime === this.lifetime)
        {
            this.installManifest(snapshot.manifest);
            this.applyPresent(snapshot, query, tag);
            this.applyOmitted(snapshot, query, tag);
        }

        return snapshot;
    }

    /**
     * The manifest is static; the first one stays. Subscriptions made before
     * it are checked now, and the stream opens for those it accepts —
     * whichever call (`subscribe`, `get`, `write`, `snapshot`) brought it.
     */
    private installManifest(manifest: Manifest): void
    {
        if (this.manifest)
        {
            return;
        }

        this.manifest = manifest;

        for (const [slot, watch] of this.watched)
        {
            const refusal = this.refusal(watch.id, watch.key);

            if (refusal)
            {
                this.watched.delete(slot);
                this.store.unlisten(slot);
                this.reportError(refusal);
            }
        }

        if (this.watched.size > 0)
        {
            this.queueSync();
        }
    }

    /**
     * An arrival from a read started for the connection of `tag`: a
     * connection newer than the one that revoked the slot lifts the mark, an
     * older or the same connection leaves `'revoked'`. The lift is by
     * generation alone — a frame or a write answer of the new connection may
     * land first with a newer `at` — and the ordering rule decides only the value.
     */
    private serve(slot: string, frame: StateFrame, tag: ReadTag): void
    {
        if ((this.store.revokedBy(slot) ?? Infinity) < tag.generation)
        {
            this.store.allow(slot);
        }

        this.store.apply(slot, frame);
    }

    /** A state present is served, under the generation rule of `serve`. */
    private applyPresent(snapshot: Snapshot, query: StateKeyFields, tag: ReadTag): void
    {
        for (const [id, result] of Object.entries(snapshot.states))
        {
            this.serve(this.slot(id, this.keyIn(id, query)), { at: snapshot.at, ...result }, tag);
        }
    }

    /**
     * A watched state whose key the query carried (or a keyless one) and that
     * the snapshot omits is not served to this subject: `'revoked'`. Not when
     * a newer connection exists, nor when a grant came after the read started.
     */
    private applyOmitted(snapshot: Snapshot, query: StateKeyFields, tag: ReadTag): void
    {
        if (tag.generation !== this.generation)
        {
            return;
        }

        for (const [slot, watch] of this.watched)
        {
            const asked = !watch.key || carries(query, watch.key);
            const grantedSince = (this.grants.get(slot) ?? 0) > tag.tick;

            if (asked && !(watch.id in snapshot.states) && !grantedSince)
            {
                this.store.revoke(slot, tag.generation);
            }
        }
    }

    private watch(slot: string, id: string, key: StateKeyFields | undefined, delta: 1 | -1): void
    {
        const count = (this.watched.get(slot)?.count ?? 0) + delta;

        if (count > 0)
        {
            this.watched.set(slot, { id, key, count });
        }
        else
        {
            this.watched.delete(slot);
        }

        this.queueSync();
    }

    /**
     * One stream for the client, its query the union of the subscribed keys.
     * Batched to the end of the task, so components mounting together (or a
     * StrictMode unmount-remount) open the stream once.
     */
    private queueSync(): void
    {
        if (!this.syncQueued)
        {
            this.syncQueued = true;
            queueMicrotask(() =>
            {
                this.syncQueued = false;
                this.sync();
            });
        }
    }

    /**
     * Until the manifest is known, subscriptions wait for the first snapshot;
     * the stream opens after it, never before — its `events=` comes from it.
     */
    private sync(): void
    {
        if (this.watched.size === 0)
        {
            this.closeStream();

            return;
        }

        if (!this.manifest)
        {
            this.awaitManifest();

            return;
        }

        const query = this.streamQuery();

        if (this.stream?.text !== stableKey(query))
        {
            this.openStream(query);
        }
    }

    /**
     * One waiter per lifetime on the first snapshot. A failure goes to
     * `onError`, and the read is retried after `retryDelay` — the stream that
     * would reconnect on its own does not exist yet. A retry stops on
     * `close()` or when nothing is watched (`sync` closes instead).
     */
    private awaitManifest(): void
    {
        const lifetime = this.lifetime;

        if (this.waitingLifetime === lifetime)
        {
            return;
        }

        this.waitingLifetime = lifetime;
        this.ensureManifest().then(
            () => lifetime === this.lifetime && this.resync(),
            error =>
            {
                this.reportError(error);

                if (lifetime === this.lifetime)
                {
                    this.retryLater();
                }
            },
        );
    }

    /** The wait is over; `sync` opens the stream, or waits again when a closed lifetime's read was discarded. */
    private resync(): void
    {
        this.waitingLifetime = undefined;
        this.sync();
    }

    /** Read the first snapshot again after `retryDelay`, as the SSE client reconnects a dropped stream. */
    private retryLater(): void
    {
        this.retryTimer = setTimeout(() =>
        {
            this.retryTimer = undefined;
            this.resync();
        }, this.config.retryDelay ?? 3000);
        // A timer in Node has `unref`: a pending retry does not keep the process alive.
        (this.retryTimer as { unref?: () => void }).unref?.();
    }

    /**
     * Every subscribed key's fields; one connection carries one value per
     * field, so on a conflict the latest subscribed key wins. The keys it
     * shadows are read once when the stream opens and get no frames.
     */
    private streamQuery(): StateKeyFields
    {
        return Object.assign({}, ...[...this.watched.values()].map(watch => watch.key ?? {}));
    }

    /**
     * Open (or reopen) the stream. `events` is every state of the manifest, in
     * its order, never only the subscribed ones: a state subscribed later would
     * otherwise be unrequested, and the server's `grant` cannot activate it.
     */
    private openStream(query: StateKeyFields): void
    {
        this.closeStream();

        const ids = Object.keys(this.manifest!);
        const stream: Stream = { query, text: stableKey(query), generation: 0, close: () => undefined };
        stream.close = this.config.sse.subscribe({
            events: ids.map(id => `state.${id}.changed`),
            handlers: Object.fromEntries(ids.map(id => [`state.${id}.changed`, (frame: WireFrame) => this.onFrame(id, frame)])),
            query,
            // Every open — the first, a reconnect, a reopen on a key change — re-reads the
            // snapshot. A frame sent while no stream was open is lost, whether its key
            // changed or not; the snapshot read after the open covers that gap.
            onOpen: () =>
            {
                stream.generation = ++this.generation;
                this.refresh(query);
            },
            onSubscriptionChange: change => this.onSubscriptionChange(change, stream),
        });

        this.stream = stream;
    }

    private closeStream(): void
    {
        this.stream?.close();
        this.stream = undefined;
    }

    /** The snapshot for the stream's query, and one read for each subscribed key the query shadows. */
    private refresh(query: StateKeyFields): void
    {
        this.readSnapshot(query, this.tag()).catch(this.reportError);

        for (const watch of this.watched.values())
        {
            if (watch.key && !carries(query, watch.key))
            {
                this.readShadowed(watch.id, watch.key, this.tag()).catch(this.reportError);
            }
        }
    }

    /**
     * A shadowed key gets no frames, no grant and no snapshot entry; the
     * server answering its own read is the evidence of access instead.
     */
    private async readShadowed(id: string, key: StateKeyFields, tag: ReadTag): Promise<void>
    {
        const frame = await this.api[routeName('get', id)].call({ query: key }) as StateFrame;
        this.serve(this.slot(id, key), frame, tag);
    }

    /** A frame for a key nobody here subscribed is dropped — the server's filter is the first guard, this the second. */
    private onFrame(id: string, frame: WireFrame): void
    {
        const slot = this.slot(id, frame.key);

        if (this.watched.has(slot))
        {
            this.store.apply(slot, frame);
        }
    }

    /**
     * A revoke or a grant concerns the key the connection carries — the
     * server scopes both by the connect query — and so does the read after a
     * grant. Revoked: the entry keeps its value, marked `'revoked'`, until a
     * grant. Granted: the mark is cleared and the key read once; the server
     * sends a frame too, in either order, and both arrive `'ready'`.
     */
    private onSubscriptionChange(change: SSESubscriptionChange<any>, stream: Stream): void
    {
        const id = /^state\.(.+)\.changed$/.exec(change.event as string)?.[1];

        if (id === undefined || !this.manifest![id])
        {
            return;
        }

        const key = this.keyIn(id, stream.query);
        const slot = this.slot(id, key);

        if (change.status === 'revoked')
        {
            this.store.revoke(slot, stream.generation);

            return;
        }

        this.grants.set(slot, ++this.clock);
        this.store.allow(slot);

        if (this.watched.has(slot))
        {
            this.get(id, key).catch(this.reportError);
        }
    }
}
