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
 * I9, I10 (`useServerState` on the server and at hydration) are in `react.test.tsx`; I11 is every
 * existing row of `client-subscribe`, `client-ordering` and `react` passing unchanged; I12 (the
 * snapshot's type) is in `client-types.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_EVENTS, at, FakeEventSource, harness, initialOf, manifest, opened, reconnect, routes, settle, streamQuery } from './client-harness';

// The api client reads the request's cookies and host on the server-side arm; there is no request here.
vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers(),
}));

const w1 = { workspaceId: 'w1' };
const w2 = { workspaceId: 'w2' };

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
});
