/**
 * State client test harness
 *
 * A state client over a fake `fetch` and the fake `EventSource`. The fixture
 * router gives the types and stands for the app's `typeof states`; at runtime
 * the client sees only the manifest the fake `getStates` answers, built by the
 * server's own `stateManifest`:
 *
 * - `consent`: keyless, with data and a write;
 * - `runtime`: keyed `{ workspaceId }`, shared, with a write;
 * - `member`: keyed `{ workspaceId }`, no write;
 * - `seat`: keyed `{ workspaceId, teamId }`, no write — a key of two fields.
 */

import { Type } from '@sinclair/typebox';
import { expect, onTestFinished, vi } from 'vitest';
import { createSSEClient } from '../../event/sse/client';
import { FakeEventSource, type FakeConnected } from '../../event/sse/__tests__/fake-event-source';
import { createStateClient } from '../client';
import type { StateClient, StateClientInitial } from '../client';
import { defineState } from '../state-builder';
import { defineStateRouter, type StatesSnapshot } from '../state-router';
import { stateManifest } from '../state-routes';
import { Consent, ConsentData, ConsentInput, Role, Runtime, WorkspaceKey } from './state-harness';

export { FakeEventSource };

const consent = defineState('consent')
    .value(Consent)
    .data(ConsentData)
    .read(() => ({ value: 'pending' as const, data: { marketing: false } }))
    .write(ConsentInput, () => undefined);

const runtime = defineState('runtime')
    .key(WorkspaceKey, { shared: true })
    .value(Runtime)
    .canRead(() => true)
    .read(() => ({ value: 'ready' as const }))
    .write(Type.Object({ action: Type.Literal('restart') }), () => undefined);

const member = defineState('member')
    .key(WorkspaceKey)
    .value(Role)
    .canRead(() => true)
    .read(() => ({ value: 'member' as const }));

const seat = defineState('seat')
    .key(Type.Object({ workspaceId: Type.String(), teamId: Type.String() }), { shared: true })
    .value(Role)
    .canRead(() => true)
    .read(() => ({ value: 'member' as const }));

export const fixtureStates = defineStateRouter({ consent, runtime, member, seat });

export type FixtureStates = typeof fixtureStates;

/** What the fixture router's snapshot route answers as `manifest`. */
export const manifest = stateManifest(Object.values(fixtureStates.states));

export const ALL_EVENTS = 'state.consent.changed,state.runtime.changed,state.member.changed,state.seat.changed';

/** An ISO `at`, `n` seconds into the day: a larger `n` is a later read. */
export function at(n: number): string
{
    return new Date(Date.UTC(2026, 9, 15, 0, 0, n)).toISOString();
}

/** One RPC call as the fake `fetch` saw it: the route and the structured input. */
export interface RpcCall
{
    route: string;
    input: Record<string, any>;
}

type Responder = (input: Record<string, any>) => unknown;

type RouteCalls = Record<string, { call(input: object): Promise<unknown> }>;

/**
 * The route calls of one client: `open` started and not settled, `held` of
 * those whose answer is a `deferred()` the row has not settled yet.
 */
interface CallCount
{
    open: number;
    held: number;
}

/** The call counts of every harness the running row made; each leaves when its row finishes. */
const live = new Set<CallCount>();

/** Bumped whenever a route call starts or settles anywhere, so `settle()` sees a turn that changed nothing. */
let activity = 0;

/** The promises `deferred()` made: an answer the row holds open on purpose, until it settles it. */
const heldAnswers = new WeakSet<Promise<unknown>>();

export interface Harness
{
    client: StateClient<FixtureStates>;
    calls: RpcCall[];
    responders: Record<string, Responder>;
    onError: ReturnType<typeof vi.fn>;
}

/** The structured input `createApi` sent: `?input=` on GET, the JSON body on POST. */
function inputOf(url: string, init: RequestInit): Record<string, any>
{
    const query = new URL(url, 'http://app.test').searchParams.get('input');

    return JSON.parse(query ?? (init.body as string) ?? '{}');
}

/** A held answer does not count as in flight until the row settles it. */
function holdWhileUnsettled(answer: unknown, count: CallCount): void
{
    if (heldAnswers.has(answer as Promise<unknown>))
    {
        count.held++;
        const release = () =>
        {
            count.held--;
            activity++;
        };
        (answer as Promise<unknown>).then(release, release);
    }
}

function fakeFetch(calls: RpcCall[], responders: Record<string, Responder>, count: CallCount): typeof fetch
{
    return (async (url: string, init: RequestInit) =>
    {
        const route = new URL(url, 'http://app.test').pathname.split('/').pop()!;
        const input = inputOf(url, init);
        calls.push({ route, input });
        const reply = responders[route]?.(input);
        holdWhileUnsettled(reply, count);
        const body = await reply ?? {};
        const answer = route === 'getStates' ? { ...body as object, manifest } : body;

        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
}

const fixtureValues: Record<string, object> = {
    consent: { value: 'pending', data: { marketing: false } },
    runtime: { value: 'provisioning' },
    member: { value: 'member' },
    seat: { value: 'member' },
};

/** As the server answers: every state whose key fields the query carries, each readable. */
export function servedStates(query: Record<string, string> = {}): Record<string, object>
{
    return Object.fromEntries(Object.entries(fixtureValues).filter(([id]) => manifest[id].key.every(field => field in query)));
}

/** The snapshot a server render read with `query`, at `at(1)`: what the real snapshot route answers. */
export function initialOf(query: Record<string, string> = {}): StatesSnapshot<FixtureStates['states']>
{
    return { at: at(1), states: servedStates(query), manifest } as StatesSnapshot<FixtureStates['states']>;
}

/**
 * A client whose snapshot answers, at `at(0)`, every state whose key the query carries, unless a
 * responder says otherwise. A failed first snapshot is retried after 10 ms, the SSE client's
 * `reconnectDelay` here, unless `config` says otherwise; `maxReconnectAttempts` and `acquireToken` go to the SSE client.
 */
export function harness(
    responders: Record<string, Responder> = {},
    config: {
        retryDelay?: number;
        maxRetries?: number;
        initial?: StateClientInitial<FixtureStates>;
        maxReconnectAttempts?: number;
        acquireToken?: () => Promise<string>;
    } = {},
): Harness
{
    const calls: RpcCall[] = [];
    const all: Record<string, Responder> = { getStates: input => ({ at: at(0), states: servedStates(input.query) }), ...responders };
    const onError = vi.fn();
    const count: CallCount = { open: 0, held: 0 };
    const { maxReconnectAttempts, acquireToken, ...clientConfig } = config;
    const client = createStateClient<FixtureStates>({
        sse: createSSEClient({ url: 'http://test/stream', reconnectDelay: 10, maxReconnectAttempts, acquireToken }),
        api: { baseUrl: '/api/rpc', fetch: fakeFetch(calls, all, count) },
        onError,
        retryDelay: 10,
        ...clientConfig,
    });
    countCalls(client, count);
    live.add(count);
    onTestFinished(() =>
    {
        live.delete(count);
    });

    return { client, calls, responders: all, onError };
}

/**
 * Count each route call of `client` from `.call()` until it settles. Not in
 * the fake `fetch`: `createApi` first awaits `import('next/headers.js')`, and
 * for the second of two calls started in one tick vitest's module runner
 * answers that import over an RPC to its main process — a real round trip of
 * any length, before `fetch` is reached. The client keeps its route calls in
 * its private `api`; the count wraps them there.
 */
function countCalls(client: StateClient<FixtureStates>, count: CallCount): void
{
    const target = client as unknown as { api: RouteCalls };
    target.api = new Proxy(target.api, {
        get: (routes, route: string) => ({
            call: (input: object) =>
            {
                count.open++;
                activity++;

                return routes[route].call(input).finally(() =>
                {
                    count.open--;
                    activity++;
                });
            },
        }),
    });
}

/** `connected` as the server answers `query`: a keyed state whose key fields it lacks denied, the rest served. */
export function servedBy(query: Record<string, string>): Required<FakeConnected>
{
    const ids = Object.keys(manifest);
    const denied = ids.filter(id => !manifest[id].key.every(field => field in query));
    const name = (id: string) => `state.${id}.changed`;

    return {
        subscribedEvents: ids.filter(id => !denied.includes(id)).map(name),
        deniedEvents: denied.map(name),
        initial: ids.filter(id => !denied.includes(id)).map(name),
    };
}

/**
 * A promise and the functions that settle it. A responder that returns it
 * holds its call open: `settle()` does not wait for it until it is settled.
 */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
{
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) =>
    {
        resolve = done;
        reject = fail;
    });
    heldAnswers.add(promise);

    return { promise, resolve, reject };
}

/** The routes called so far, in order. */
export function routes(h: Harness): string[]
{
    return h.calls.map(call => call.route);
}

/** One macrotask turn: every queued microtask runs first. Under fake timers the clock does not move. */
function turn(): Promise<unknown>
{
    return vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise(resolve => setTimeout(resolve, 0));
}

/** Whether a client of the running row has a route call in flight that no `deferred()` holds. */
function callsInFlight(): boolean
{
    return [...live].some(count => count.open > count.held);
}

/**
 * Wait until the clients of the running row are quiescent: every route call
 * they started has settled — except one whose answer is a `deferred()` the row
 * has not settled, which the row holds on purpose — and a whole turn has then
 * passed in which no call started or settled. That is sufficient because
 * between route calls the client runs only synchronous code and microtasks
 * (the batched sync, the stream open, applying an answer), and a turn runs
 * every queued microtask: what the last answer set off has run, and any call
 * it started was seen. Real timers (`retryDelay`, the SSE `reconnectDelay`)
 * are not waited for; under fake timers the clock does not move.
 */
export async function settle(): Promise<void>
{
    let seen: number;

    do
    {
        seen = activity;
        await turn();
    }
    while (activity !== seen || callsInFlight());
}

/**
 * Let the first snapshot and the queued stream open land, fire its `onopen` and its `connected` frame
 * (`initial` absent unless `connected` names it), and let the snapshot it triggers land.
 */
export async function opened(connected?: FakeConnected): Promise<FakeEventSource>
{
    await settle();
    FakeEventSource.last.open(connected);
    await settle();

    return FakeEventSource.last;
}

/** Fails the stream, opens the one that replaces it, and returns it: the next connection generation. */
export async function reconnect(es: FakeEventSource, connected?: FakeConnected): Promise<FakeEventSource>
{
    const before = FakeEventSource.instances.length;
    es.fail();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(before + 1));
    const next = FakeEventSource.last;
    next.open(connected);
    await settle();

    return next;
}

/** The query fields of an `EventSource` URL, without `events`. */
export function streamQuery(es: FakeEventSource): Record<string, string>
{
    const params = Object.fromEntries(new URL(es.url).searchParams);
    delete params.events;

    return params;
}
