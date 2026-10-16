/**
 * State client — starting from the server-rendered snapshot (`initial`). A
 * server component reads the snapshot for its first paint and hands it, with
 * its query, to the client: the manifest is installed and every state present
 * applied at construction, under generation 0 — no connection yet. The first
 * subscribe then opens the stream without reading the snapshot; the stream's
 * open still re-reads it. `initialOf(query)` answers as the snapshot route
 * would, at `at(1)`; the harness's own reads answer at `at(0)`.
 *
 * | #   | situation                                              | expected                                                        |
 * |-----|--------------------------------------------------------|-----------------------------------------------------------------|
 * | I1  | built with `initial` for `w1`, no call made            | `consent` and `runtime` w1 ready at `at(1)`; `runtime` w2 undefined; no fetch, no `EventSource` |
 * | I2  | I1, then `subscribe('consent')`                        | no `getStates` before the stream; one `EventSource` with every event; after its open, one `getStates`; the listener not called |
 * | I3  | I1, then `subscribe('runtime', { teamId: 'x' })`       | refused at once naming the state and the fields; `onError` once; no fetch, no `EventSource` |
 * | I4  | I1, then `get('consent')`                              | one `getConsentState`, no `getStates`; the entry updated        |
 * | I5  | `initial` with `query: {}`, then `subscribe('runtime', w1)` | `runtime` w1 undefined at first; the stream opens with `workspaceId=w1`; `'ready'` after its open re-read |
 * | I6  | I2, a frame for `consent` at `at(2)`; then a read answer at `at(0)` | the frame applied, listener called once; the read dropped |
 * | I7  | I2, then `subscription.revoked` for `consent`          | `'revoked'`, value kept — generation 1 is newer than the hydration's 0 |
 * | I7b | I7, then a reconnect whose open re-read carries `consent` | `'ready'` — the new connection's generation lifts the revoke     |
 * | I8  | hand-built `initial` naming `runtime`, its query lacking `workspaceId` | `runtime` skipped under every key; `consent` applied |
 * | I8b | hand-built `initial` naming `ghost`, a state its manifest lacks | construction does not throw; `ghost` skipped; `consent` applied |
 * | I13 | I1, `close()`, then `subscribe('consent')` again       | the manifest kept: the stream reopens with no `getStates` before it; the hydrated entries kept, as `close()` keeps every entry |
 * | I14 | `initial` omitting `consent` (denied at render), then `subscribe('consent')` and an open re-read omitting it too | undefined after construction, not `'revoked'`; `'revoked'` after the stream's own read |
 *
 * Part B — the stream serves each allowed state's current frame right after
 * `connected`, and `connected.initial` names them; the client reads the
 * snapshot only when a state it requested is neither served nor denied.
 * `servedBy(query)` answers `connected` as the server would: a keyed state
 * whose key fields the query lacks denied, every other one served.
 *
 * | #   | situation                                              | expected                                                        |
 * |-----|--------------------------------------------------------|-----------------------------------------------------------------|
 * | K1  | `connected` with `initial` naming every requested state event | no `getStates` fetch after the open (before B: one)       |
 * | K2  | `initial` missing one requested, non-denied event      | one `getStates` fetch, as today                                 |
 * | K3  | `connected.deniedEvents` names a subscribed `consent`  | `'revoked'`, listener called; no fetch when the rest are in `initial` |
 * | K4  | `connected` without `initial` (older server)           | one `getStates` fetch; every existing L, O, N, I, H row unchanged |
 * | K5  | `runtime` subscribed for w1 and w2, stream carries w2, `initial` complete | no `getStates`; one `getRuntimeState` read for the shadowed w1 |
 * | K6  | reconnect; initial frames with a newer `at` and the same values | listeners not called; a changed value → called once    |
 * | K7  | A + B: built with `initial`, first `subscribe`, `connected` with complete `initial` | zero `getStates` in total, one `EventSource`, entries `'ready'` |
 * | K8  | `subscription.revoked` for `consent`, then a reconnect whose initial frame carries it | `'ready'` — the new generation's frame lifts the mark |
 * | K9  | `connected.deniedEvents` names `runtime` while the query carries w1 | w1 `'revoked'`; w2 (subscribed, shadowed) untouched     |
 * | K10 | a `connected` the prior connection queued, delivered after the reconnect, denying `consent` | ignored: the new stream open, `consent` `'ready'` |
 * | K11 | a revoke, a reconnect, then a frame the prior connection queued | ignored: `consent` stays `'revoked'`                  |
 *
 * I9, I10 (`useServerState` on the server and at hydration) are in `react.test.tsx`; I11 is every
 * existing row of `client-subscribe`, `client-ordering` and `react` passing unchanged; I12 (the
 * snapshot's type) is in `client-types.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeConnected } from '../../event/sse/__tests__/fake-event-source';
import { ALL_EVENTS, at, FakeEventSource, harness, initialOf, manifest, opened, reconnect, routes, settle, streamQuery } from './client-harness';

// The api client reads the request's cookies and host on the server-side arm; there is no request here.
vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers(),
}));

const w1 = { workspaceId: 'w1' };
const w2 = { workspaceId: 'w2' };

/** `connected` as the server answers `query`: a keyed state whose key fields it lacks denied, the rest served. */
function servedBy(query: Record<string, string>): Required<FakeConnected>
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

/** A client started from the render's snapshot for `w1`. */
function hydrated(responders: Parameters<typeof harness>[0] = {}): ReturnType<typeof harness>
{
    return harness(responders, { initial: { snapshot: initialOf(w1), query: w1 } });
}

/** I2: `consent` subscribed on a hydrated client, its stream open. */
async function subscribedConsent(): Promise<{ h: ReturnType<typeof harness>; listener: ReturnType<typeof vi.fn>; es: FakeEventSource }>
{
    const h = hydrated();
    const listener = vi.fn();
    h.client.subscribe('consent', listener);
    const es = await opened();

    return { h, listener, es };
}

describe('state client — initial', () =>
{
    beforeEach(() =>
    {
        FakeEventSource.install();
    });

    afterEach(() =>
    {
        FakeEventSource.uninstall();
    });

    it('I1 current() answers from the render\'s snapshot at once, with no fetch and no stream', async () =>
    {
        const h = hydrated();

        expect(h.client.current('consent')).toEqual({ at: at(1), value: 'pending', data: { marketing: false }, status: 'ready' });
        expect(h.client.current('runtime', w1)).toEqual({ at: at(1), value: 'provisioning', status: 'ready' });
        expect(h.client.current('runtime', w2)).toBeUndefined();

        await settle();

        expect(h.calls).toEqual([]);
        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('I2 the first subscribe opens the stream without a read; its open re-reads once; the listener is not called', async () =>
    {
        const h = hydrated();
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        await settle();

        expect(routes(h)).toEqual([]);
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(new URL(FakeEventSource.last.url).searchParams.get('events')).toBe(ALL_EVENTS);

        FakeEventSource.last.open();
        await settle();

        expect(routes(h)).toEqual(['getStates']);
        expect(listener).not.toHaveBeenCalled();
        h.client.close();
    });

    it('I3 a key whose fields are not the state\'s is refused at once, naming both; nothing is read or opened', async () =>
    {
        const h = hydrated();

        h.client.subscribe('runtime', { teamId: 'x' } as never, () => undefined);

        expect(h.onError).toHaveBeenCalledTimes(1);
        expect(String(h.onError.mock.calls[0][0])).toContain('state "runtime" takes the key fields [workspaceId], given [teamId]');

        await settle();

        expect(h.calls).toEqual([]);
        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('I4 get() reads the state\'s own route, never the snapshot', async () =>
    {
        const h = hydrated({ getConsentState: () => ({ at: at(2), value: 'agreed', data: { marketing: true } }) });

        await h.client.get('consent');

        expect(routes(h)).toEqual(['getConsentState']);
        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
    });

    it('I5 a render without a workspace holds no runtime; subscribing w1 opens with it and its open re-read serves it', async () =>
    {
        const h = harness({}, { initial: { snapshot: initialOf(), query: {} } });

        expect(h.client.current('runtime', w1)).toBeUndefined();

        h.client.subscribe('runtime', w1, () => undefined);
        await settle();

        expect(routes(h)).toEqual([]);
        expect(streamQuery(FakeEventSource.last)).toEqual(w1);

        await opened();

        expect(routes(h)).toEqual(['getStates']);
        expect(h.client.current('runtime', w1)).toEqual({ at: at(0), value: 'provisioning', status: 'ready' });
        h.client.close();
    });

    it('I6 a newer frame replaces the hydrated entry; a stale read after it is dropped', async () =>
    {
        const { h, listener, es } = await subscribedConsent();

        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });

        expect(listener).toHaveBeenCalledTimes(1);

        h.responders.getStates = () => ({ at: at(0), states: { consent: { value: 'pending', data: { marketing: false } } } });
        await h.client.snapshot();

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
        expect(listener).toHaveBeenCalledTimes(1);
        h.client.close();
    });

    it('I7 a revoke on the stream marks the hydrated entry revoked and keeps its value', async () =>
    {
        const { h, es } = await subscribedConsent();

        es.control('subscription.revoked', { event: 'state.consent.changed' });

        expect(h.client.current('consent')).toEqual({ at: at(1), value: 'pending', data: { marketing: false }, status: 'revoked' });
        h.client.close();
    });

    it('I7b after that revoke, a reconnect whose open re-read carries consent makes it ready again', async () =>
    {
        const { h, es } = await subscribedConsent();
        es.control('subscription.revoked', { event: 'state.consent.changed' });

        await reconnect(es);

        expect(h.client.current('consent')).toEqual({ at: at(1), value: 'pending', data: { marketing: false }, status: 'ready' });
        h.client.close();
    });

    it('I8b a hand-built initial naming a state the manifest lacks does not crash construction; the rest is applied', () =>
    {
        const snapshot = { ...initialOf(), states: { ...initialOf().states, ghost: { value: 'x' } } };
        let h: ReturnType<typeof harness> | undefined;

        expect(() =>
        {
            h = harness({}, { initial: { snapshot: snapshot as ReturnType<typeof initialOf> } });
        }).not.toThrow();
        expect(h!.client.current('consent')).toEqual({ at: at(1), value: 'pending', data: { marketing: false }, status: 'ready' });
        expect((h!.client as unknown as { current(id: string): unknown }).current('ghost')).toBeUndefined();
    });

    it('I8 a keyed state the query carries no key for is skipped; the keyless one is applied', () =>
    {
        const snapshot = { at: at(1), states: { consent: { value: 'agreed', data: { marketing: true } }, runtime: { value: 'ready' } }, manifest };
        const h = harness({}, { initial: { snapshot: snapshot as ReturnType<typeof initialOf>, query: {} } });

        expect(h.client.current('runtime', w1)).toBeUndefined();
        expect(h.client.current('runtime', { workspaceId: undefined } as never)).toBeUndefined();
        expect(h.client.current('consent')).toEqual({ at: at(1), value: 'agreed', data: { marketing: true }, status: 'ready' });
    });

    it('I13 after close() the manifest and the hydrated entries are kept; a new subscribe reopens without a read', async () =>
    {
        const h = hydrated();
        const entry = h.client.current('consent');
        h.client.subscribe('consent', () => undefined);
        await settle();

        h.client.close();

        expect(FakeEventSource.live).toHaveLength(0);
        expect(h.client.current('consent')).toBe(entry);

        h.client.subscribe('consent', () => undefined);
        await settle();

        expect(routes(h)).toEqual([]);
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(FakeEventSource.live).toHaveLength(1);
        h.client.close();
    });

    it('I14 a state the render\'s snapshot omits is not revoked by it; the stream\'s own read omitting it is', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(2), states: {} }) }, { initial: { snapshot: { ...initialOf(), states: {} } } });

        expect(h.client.current('consent')).toBeUndefined();

        h.client.subscribe('consent', () => undefined);
        await opened();

        expect(h.client.current('consent')).toEqual({ status: 'revoked' });
        h.client.close();
    });

    it('K1 connected names every requested state in initial: no getStates after the open', async () =>
    {
        const h = hydrated();
        h.client.subscribe('consent', () => undefined);

        await opened(servedBy({}));

        expect(routes(h)).toEqual([]);
        h.client.close();
    });

    it('K2 initial misses one requested state that is not denied: one getStates, as today', async () =>
    {
        const h = hydrated();
        h.client.subscribe('consent', () => undefined);
        const connected = servedBy({});

        await opened({ ...connected, initial: connected.initial.filter(event => event !== 'state.consent.changed') });

        expect(routes(h)).toEqual(['getStates']);
        h.client.close();
    });

    it('K3 deniedEvents names a subscribed consent: revoked, listener called; no fetch, the rest served', async () =>
    {
        const h = hydrated();
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        h.client.subscribe('runtime', w1, () => undefined);
        const connected = servedBy(w1);

        await opened({
            deniedEvents: [...connected.deniedEvents, 'state.consent.changed'],
            initial: connected.initial.filter(event => event !== 'state.consent.changed'),
        });

        expect(h.client.current('consent')).toEqual({ at: at(1), value: 'pending', data: { marketing: false }, status: 'revoked' });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(routes(h)).toEqual([]);
        h.client.close();
    });

    it('K4 connected without initial (an older server): one getStates', async () =>
    {
        const h = hydrated();
        h.client.subscribe('consent', () => undefined);

        await opened({ deniedEvents: servedBy({}).deniedEvents });

        expect(routes(h)).toEqual(['getStates']);
        h.client.close();
    });

    it('K5 runtime w1 and w2, the stream on w2, initial complete: no getStates, one read for the shadowed w1', async () =>
    {
        const h = hydrated();
        h.client.subscribe('runtime', w1, () => undefined);
        h.client.subscribe('runtime', w2, () => undefined);

        const es = await opened(servedBy(w2));

        expect(streamQuery(es)).toEqual(w2);
        expect(h.calls).toEqual([{ route: 'getRuntimeState', input: { query: w1 } }]);
        h.client.close();
    });

    it('K6 a reconnect\'s initial frame with a newer at and the same value is silent; a changed value notifies once', async () =>
    {
        const h = hydrated();
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        const es = await opened(servedBy({}));

        const second = await reconnect(es, servedBy({}));
        second.emit('state.consent.changed', { at: at(2), value: 'pending', data: { marketing: false }, subject: 'u1' });

        expect(listener).not.toHaveBeenCalled();

        const third = await reconnect(second, servedBy({}));
        third.emit('state.consent.changed', { at: at(3), value: 'agreed', data: { marketing: true }, subject: 'u1' });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(routes(h)).toEqual([]);
        h.client.close();
    });

    it('K7 A + B: built with initial, first subscribe, complete initial — no getStates at all, one EventSource, ready', async () =>
    {
        const h = hydrated();
        h.client.subscribe('consent', () => undefined);
        h.client.subscribe('runtime', w1, () => undefined);

        const es = await opened(servedBy(w1));
        es.emit('state.consent.changed', { at: at(2), value: 'pending', data: { marketing: false }, subject: 'u1' });
        es.emit('state.runtime.changed', { at: at(2), value: 'provisioning', key: w1 });

        expect(h.calls).toEqual([]);
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(h.client.current('consent')?.status).toBe('ready');
        expect(h.client.current('runtime', w1)?.status).toBe('ready');
        h.client.close();
    });

    it('K8 after a revoke, a reconnect whose initial frame carries consent makes it ready again', async () =>
    {
        const h = hydrated();
        h.client.subscribe('consent', () => undefined);
        const es = await opened(servedBy({}));
        es.control('subscription.revoked', { event: 'state.consent.changed' });

        expect(h.client.current('consent')?.status).toBe('revoked');

        const next = await reconnect(es, servedBy({}));
        next.emit('state.consent.changed', { at: at(2), value: 'pending', data: { marketing: false }, subject: 'u1' });

        expect(h.client.current('consent')).toMatchObject({ value: 'pending', status: 'ready' });
        expect(routes(h)).toEqual([]);
        h.client.close();
    });

    it('K9 deniedEvents names runtime while the query carries w1: w1 revoked, the shadowed w2 untouched', async () =>
    {
        const h = hydrated({ getRuntimeState: () => ({ at: at(2), value: 'ready' }) });
        h.client.subscribe('runtime', w2, () => undefined);
        h.client.subscribe('runtime', w1, () => undefined);
        const connected = servedBy(w1);

        const es = await opened({
            deniedEvents: [...connected.deniedEvents, 'state.runtime.changed'],
            initial: connected.initial.filter(event => event !== 'state.runtime.changed'),
        });

        expect(streamQuery(es)).toEqual(w1);
        expect(h.client.current('runtime', w1)).toEqual({ at: at(1), value: 'provisioning', status: 'revoked' });
        expect(h.client.current('runtime', w2)).toEqual({ at: at(2), value: 'ready', status: 'ready' });
        expect(routes(h)).toEqual(['getRuntimeState']);
        h.client.close();
    });

    it('K10 a connected the prior connection queued, delivered after the reconnect, is ignored', async () =>
    {
        const h = hydrated();
        h.client.subscribe('consent', () => undefined);
        const first = await opened(servedBy({}));
        const oldConnected = (first as any).listeners.get('connected')[0];
        const second = await reconnect(first, servedBy({}));

        oldConnected({ data: JSON.stringify({ subscribedEvents: [], deniedEvents: ['state.consent.changed'], initial: [], timestamp: 0 }) });

        expect(second.readyState).toBe(FakeEventSource.OPEN);
        expect(h.client.current('consent')?.status).toBe('ready');
        h.client.close();
    });

    it('K11 a frame the prior connection queued cannot lift its revoke after the reconnect', async () =>
    {
        const h = hydrated();
        h.client.subscribe('consent', () => undefined);
        const first = await opened(servedBy({}));
        const oldFrame = (first as any).listeners.get('state.consent.changed')[0];
        first.control('subscription.revoked', { event: 'state.consent.changed' });
        await reconnect(first, servedBy({}));

        oldFrame({ data: JSON.stringify({ event: 'state.consent.changed', data: { at: at(2), value: 'pending', data: { marketing: false }, subject: 'u1' } }) });

        expect(h.client.current('consent')?.status).toBe('revoked');
        h.client.close();
    });
});
