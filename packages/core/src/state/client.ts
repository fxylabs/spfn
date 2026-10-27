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

import type { ConnectedPayload, SSESubscriptionChange } from '@spfn/core/event/sse';
import { createApi } from '@spfn/core/nextjs';
import { stableKey, StateStore, type StateKeyFields } from './client-store';
import type {
    AnyStateRouter,
    ConnectionListener,
    ConnectionStatus,
    StateClient,
    StateClientConfig,
    StateClientInitial,
    StateEntry,
    StateFrame,
    StateListener,
} from './client-types';

export type {
    AnyStateRouter,
    ConnectionListener,
    ConnectionStatus,
    InferStateData,
    StateCatalog,
    StateFrameOf,
    InferStateInput,
    InferStateKey,
    InferStateValue,
    StateClient,
    StateClientConfig,
    StateClientInitial,
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

/**
 * The stream as one `sse.subscribe` opened it; `generation` names its current
 * connection. `closedByClient`: the client closed it itself, so its `onClose`
 * is no failure; `failed`: the SSE client gave up on it.
 */
interface Stream
{
    query: StateKeyFields;
    text: string;
    generation: number;
    closedByClient: boolean;
    failed: boolean;
    close: () => void;
}

/** When an automatic read was started: the connection generation and the client's clock. */
interface ReadTag
{
    generation: number;
    tick: number;
}

const CONNECTED: ConnectionStatus = Object.freeze({ status: 'connected' });
const FAILED: ConnectionStatus = Object.freeze({ status: 'failed' });
const STARTING: ConnectionStatus = Object.freeze({ status: 'reconnecting', attempt: 0 });

function reconnecting(attempt: number): ConnectionStatus
{
    return attempt === 0 ? STARTING : Object.freeze({ status: 'reconnecting', attempt });
}

function sameStatus(a: ConnectionStatus, b: ConnectionStatus): boolean
{
    return a.status === b.status && (a as { attempt?: number }).attempt === (b as { attempt?: number }).attempt;
}

/** `get<Id>State` / `put<Id>State`, the names the server router derives. */
function routeName(method: 'get' | 'put', id: string): string
{
    return `${method}${id[0].toUpperCase()}${id.slice(1)}State`;
}

/** The wire name of a state's SSE event, as the server derives it. */
function stateEventName(id: string): string
{
    return `state.${id}.changed`;
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
 * reads the snapshot, whose manifest names every state — or takes it from
 * `initial`, the snapshot the server rendered with; the stream then
 * requests every state event — the server's `grant` can only activate an
 * event the connection requested. The router type parameter is what types
 * `initial.snapshot`; without it the client is untyped, as before.
 */
export function createStateClient<TStates extends AnyStateRouter>(config: StateClientConfig<TStates>): StateClient<TStates>
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

    private status = STARTING;
    private readonly connectionListeners = new Set<ConnectionListener>();
    private readonly onOnline = (): void => this.retry();

    /** The retries of the first snapshot since its last start, against `maxRetries`. */
    private retries = 0;

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

        if (config.initial)
        {
            this.hydrate(config.initial);
        }

        // Absent in Node and in a server render.
        if (typeof globalThis.addEventListener === 'function')
        {
            globalThis.addEventListener('online', this.onOnline);
        }
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

    connection(): ConnectionStatus
    {
        return this.status;
    }

    subscribeConnection(listener: ConnectionListener): () => void
    {
        // One wrapper per subscription: the same listener subscribed twice is two subscriptions.
        const notify: ConnectionListener = status => listener(status);
        this.connectionListeners.add(notify);

        return () =>
        {
            this.connectionListeners.delete(notify);
        };
    }

    /**
     * Restart what gave up or is still retrying, now: the first snapshot
     * while the manifest is unknown, else the stream — a new `sse.subscribe`,
     * whose attempt count starts at 0. Nothing to do when connected or with
     * nothing watched — so after `close()`, until a new `subscribe`.
     */
    retry(): void
    {
        if (this.status === CONNECTED || this.watched.size === 0)
        {
            return;
        }

        if (this.manifest)
        {
            this.openStream(this.streamQuery());
        }
        else
        {
            this.rereadManifest();
        }
    }

    close(): void
    {
        this.lifetime++;
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.retries = 0;
        this.closeStream();
        this.watched.clear();
        this.store.clearListeners();
        this.connectionListeners.clear();
        this.status = STARTING;

        if (typeof globalThis.removeEventListener === 'function')
        {
            globalThis.removeEventListener('online', this.onOnline);
        }
    }

    /** The status is `next` from now; each connection listener hears it, a throwing one logged. */
    private setConnection(next: ConnectionStatus): void
    {
        if (sameStatus(next, this.status))
        {
            return;
        }

        this.status = next;

        for (const listener of [...this.connectionListeners])
        {
            try
            {
                listener(next);
            }
            catch (error)
            {
                console.warn('[state] A connection listener threw:', error);
            }
        }
    }

    /**
     * Start from the snapshot the server rendered with: its manifest, then
     * each state present, as a read snapshot applies them, under generation 0
     * — no connection yet. Nothing is marked `'revoked'`: nothing is watched,
     * and an omission in the render's snapshot is not a denial by the stream.
     */
    private hydrate(initial: StateClientInitial): void
    {
        const snapshot = initial.snapshot as Snapshot;
        this.installManifest(snapshot.manifest);
        this.applyPresent(snapshot, initial.query ?? {}, this.tag());
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

    /** The slot of state `id` on the key `query` carries; `undefined` when the query lacks one of its key fields. */
    private carriedSlot(id: string, query: StateKeyFields): string | undefined
    {
        return this.manifest![id].key.every(field => field in query) ? this.slot(id, this.keyIn(id, query)) : undefined;
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
    private serve(slot: string, frame: StateFrame, generation: number): void
    {
        if ((this.store.revokedBy(slot) ?? Infinity) < generation)
        {
            this.store.allow(slot);
        }

        this.store.apply(slot, frame);
    }

    /**
     * A state present is served, under the generation rule of `serve`. A state
     * the manifest does not describe, or a keyed one whose key fields the query
     * lacks, is skipped: the server never serves either, but a hand-built
     * `initial` might.
     */
    private applyPresent(snapshot: Snapshot, query: StateKeyFields, tag: ReadTag): void
    {
        for (const [id, result] of Object.entries(snapshot.states))
        {
            if (this.manifest![id]?.key.every(field => field in query))
            {
                this.serve(this.slot(id, this.keyIn(id, query)), { at: snapshot.at, ...result }, tag.generation);
            }
        }
    }

    /**
     * Every state the snapshot omits whose key the query carried (or a keyless
     * one), watched or not, is not served to this subject: `'revoked'` on that
     * key. Not when a newer connection exists, nor when a grant came after the
     * read started. Every watched slot the query carries is one of these.
     */
    private applyOmitted(snapshot: Snapshot, query: StateKeyFields, tag: ReadTag): void
    {
        if (tag.generation !== this.generation)
        {
            return;
        }

        for (const id of Object.keys(this.manifest!))
        {
            const slot = this.carriedSlot(id, query);
            const grantedSince = slot !== undefined && (this.grants.get(slot) ?? 0) > tag.tick;

            if (slot !== undefined && !(id in snapshot.states) && !grantedSince)
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

        // A removal that leaves subscribers keeps a failed client failed; the last removal closes and resets.
        if (delta === 1 || this.watched.size === 0 || this.status !== FAILED)
        {
            this.queueSync();
        }
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
     * A client built with `initial` knows it from the start. With nothing
     * watched the stream closes, the retry count starts over for the next
     * wait, and the status is the start value: no stream, nothing answered.
     */
    private sync(): void
    {
        if (this.watched.size === 0)
        {
            this.retries = 0;
            this.closeStream();
            this.setConnection(STARTING);

            return;
        }

        if (!this.manifest)
        {
            this.awaitManifest();

            return;
        }

        // A stream the SSE client gave up on counts as absent.
        const query = this.streamQuery();

        if (this.stream?.failed || this.stream?.text !== stableKey(query))
        {
            this.openStream(query);
        }
    }

    /**
     * One waiter per lifetime on the first snapshot. A failure goes to
     * `onError`, and the read is retried after `retryDelay` — the stream that
     * would reconnect on its own does not exist yet. A retry stops on
     * `close()`, when nothing is watched (`sync` closes instead), or after
     * `maxRetries`; a wait started after that last one restarts the count.
     */
    private awaitManifest(): void
    {
        const lifetime = this.lifetime;

        if (this.waitingLifetime === lifetime)
        {
            return;
        }

        if (this.status === FAILED)
        {
            this.retries = 0;
            this.setConnection(STARTING);
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

    /**
     * Read the first snapshot again after `retryDelay`, as the SSE client
     * reconnects a dropped stream — or, with `maxRetries` spent, give up:
     * `'failed'`, no timer, no wait.
     */
    private retryLater(): void
    {
        const maxRetries = this.config.maxRetries ?? 0;

        if (maxRetries > 0 && this.retries >= maxRetries)
        {
            this.waitingLifetime = undefined;
            this.setConnection(FAILED);

            return;
        }

        this.retries++;
        this.retryTimer = setTimeout(() =>
        {
            this.retryTimer = undefined;
            this.resync();
        }, this.config.retryDelay ?? 3000);
        // A timer in Node has `unref`: a pending retry does not keep the process alive.
        (this.retryTimer as { unref?: () => void }).unref?.();
    }

    /**
     * `retry()` before the manifest: the count starts over and the first
     * snapshot is read now, its pending timer cleared. A read in flight is
     * already the retry; it is not doubled.
     */
    private rereadManifest(): void
    {
        this.retries = 0;

        if (this.waitingLifetime === this.lifetime && this.retryTimer === undefined)
        {
            return;
        }

        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.setConnection(STARTING);
        this.resync();
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
     * Unless connected, the status is `'reconnecting'` 0 until it opens: a
     * new subscription counts its attempts from 0. A reopen on a key change
     * while connected stays `'connected'`.
     */
    private openStream(query: StateKeyFields): void
    {
        this.closeStream();

        if (this.status !== CONNECTED)
        {
            this.setConnection(STARTING);
        }

        const ids = Object.keys(this.manifest!);
        const stream: Stream = { query, text: stableKey(query), generation: 0, closedByClient: false, failed: false, close: () => undefined };
        stream.close = this.config.sse.subscribe({
            events: ids.map(stateEventName),
            handlers: Object.fromEntries(ids.map(id => [stateEventName(id), (frame: WireFrame) => this.onFrame(id, frame, stream)])),
            query,
            onOpen: () =>
            {
                stream.generation = ++this.generation;
                this.streamStatus(stream, CONNECTED);
            },
            onReconnect: attempt => this.streamStatus(stream, reconnecting(attempt)),
            onClose: () => this.onStreamClose(stream),
            onConnected: connected => this.onConnected(connected, stream),
            onSubscriptionChange: change => this.onSubscriptionChange(change, stream),
        });

        this.stream = stream;
    }

    /** Flagged first: the SSE client fires `onClose` on this teardown too, and it is no failure. */
    private closeStream(): void
    {
        if (this.stream)
        {
            this.stream.closedByClient = true;
            this.stream.close();
            this.stream = undefined;
        }
    }

    /** The status of a callback of `stream`, when no other stream replaced it. */
    private streamStatus(stream: Stream, status: ConnectionStatus): void
    {
        if (stream === this.stream)
        {
            this.setConnection(status);
        }
    }

    /**
     * The SSE client fires `onClose` on every teardown; one the client did
     * not start is the reconnect attempts exhausted: `'failed'`, and the
     * stream counts as absent for the next `sync`.
     */
    private onStreamClose(stream: Stream): void
    {
        if (!stream.closedByClient && stream === this.stream)
        {
            stream.failed = true;
            this.setConnection(FAILED);
        }
    }

    /**
     * Every connection — the first, a reconnect, a reopen on a key change —
     * must cover the frames sent while no stream was open. The server says in
     * `connected` which states it served their current frame right after it;
     * the snapshot is read only when one it did not serve is neither denied
     * nor served — or when the server predates `initial`. A denied state whose
     * key the stream carries is `'revoked'`, watched or not, as an omission
     * from that snapshot would be. A connection already replaced is ignored.
     */
    private onConnected(connected: ConnectedPayload, stream: Stream): void
    {
        if (stream !== this.stream || stream.generation !== this.generation)
        {
            return;
        }

        const denied = new Set(connected.deniedEvents);
        const served = new Set(connected.initial ?? []);
        const unserved = Object.keys(this.manifest!).map(stateEventName).filter(name => !denied.has(name) && !served.has(name));

        this.revokeDenied(denied, stream);

        if (connected.initial && unserved.length === 0)
        {
            this.readShadowedKeys(stream.query);
        }
        else
        {
            this.refresh(stream.query);
        }
    }

    /**
     * Each state the connection denies, on the key its query carries, marked
     * `'revoked'` by it, watched or not. A keyed state denied because the query
     * lacks one of its key fields has no carried key, so nothing is marked.
     */
    private revokeDenied(denied: Set<string>, stream: Stream): void
    {
        for (const id of Object.keys(this.manifest!))
        {
            const slot = this.carriedSlot(id, stream.query);

            if (slot !== undefined && denied.has(stateEventName(id)))
            {
                this.store.revoke(slot, stream.generation);
            }
        }
    }

    /** The snapshot for the stream's query, and one read for each subscribed key the query shadows. */
    private refresh(query: StateKeyFields): void
    {
        this.readSnapshot(query, this.tag()).catch(this.reportError);
        this.readShadowedKeys(query);
    }

    /** One read for each subscribed key the query shadows: the stream serves one key per field. */
    private readShadowedKeys(query: StateKeyFields): void
    {
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
        this.serve(this.slot(id, key), frame, tag.generation);
    }

    /**
     * A frame on the key the stream's query carries is applied, watched or not,
     * so a later subscribe that does not reopen the stream is served the newest
     * value; a frame for any other key is dropped unless watched — the server's
     * filter is the first guard, this the second. A frame is served under its
     * connection's generation: the server sends one only on a connection that
     * allows the state, so a newer connection's frame lifts an older revoke.
     */
    private onFrame(id: string, frame: WireFrame, stream: Stream): void
    {
        const slot = this.slot(id, frame.key);

        if (slot === this.carriedSlot(id, stream.query) || this.watched.has(slot))
        {
            this.serve(slot, frame, stream.generation);
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
