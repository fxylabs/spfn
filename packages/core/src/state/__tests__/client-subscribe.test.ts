/**
 * State client — subscription lifecycle. The first subscriber reads the
 * snapshot, whose manifest names every state; then one stream per client,
 * requesting every state event, its query the union of the subscribed keys;
 * reopened (and re-snapshotted) when that union changes. A state the server
 * stops serving to this subject — revoked on the stream, or omitted from a
 * snapshot that asked for it — is `'revoked'` until a grant.
 *
 * | #   | situation                                              | expected                                                        |
 * |-----|--------------------------------------------------------|-----------------------------------------------------------------|
 * | L1  | first `subscribe('consent')`                           | one `EventSource` with `events=` listing **every** state event, after the first `getStates`; another on its open |
 * | L2  | second subscriber on another state                     | no new `EventSource`; no new snapshot                           |
 * | L3  | subscribe `runtime` with `{ workspaceId: 'w1' }`       | the `EventSource` is reopened with `workspaceId=w1`; snapshot re-read with `workspaceId=w1` |
 * | L4  | last subscriber of `w1` leaves, `w2` remains           | reopened with `w2` only                                         |
 * | L5  | last subscriber of the client leaves                   | `EventSource` closed; `close()` idempotent                      |
 * | L6  | `subscription.revoked` for `state.runtime.changed`     | `current('runtime', w1).status === 'revoked'`, value kept, listener called |
 * | L7  | `subscription.granted` for it                          | `getRuntimeState` fetched once for the carried key; status back to `'ready'` |
 * | L8  | `write('consent', input)`                              | the write route called with the body; response applied; `current` reflects it before any frame |
 * | L9  | `get('runtime', w1)` on a client with no subscription  | fetch with `workspaceId=w1`; store entry created; no `EventSource` |
 * | L10 | fetch rejects (network) in `snapshot()`                | the promise rejects; store unchanged; listeners not called      |
 * | L11 | first `subscribe('consent')`                           | one `getStates` before any `EventSource`; its URL lists every id of the manifest |
 * | L12 | `subscribe('runtime', { teamId: 'x' })`, manifest says `['workspaceId']` | refused after the first snapshot, naming the state and the fields; no stream reopen |
 * | L13 | `write('member', …)`, manifest says `write: false`     | rejects naming the state; no fetch                              |
 * | L14 | manifest order                                         | `events=` follows the manifest, not the subscriptions           |
 * | L15 | snapshot without `consent` while subscribed            | `'revoked'`; listener called once                               |
 * | L16 | then `subscription.granted` and a frame for `consent`  | `'ready'` with the value                                        |
 * | L16' | reconnect: `runtime` w1 `'ready'`; the reopen snapshot omits it | `'revoked'`, the old value kept                        |
 * | L17 | keyed state whose key the snapshot query did not carry | not marked revoked                                              |
 * | L18 | snapshot in flight; `subscription.revoked`; snapshot resolves | `{ at, value, status: 'revoked' }`                       |
 * | L19 | L18, then `subscription.granted` and its frame         | `'ready'`                                                       |
 * | L20 | revoke, then a frame with a newer `at`                 | value applied, status stays `'revoked'`                         |
 * | L21 | key change: the old connection's revoke lands before the queued reopen; the reopen snapshot in flight; the old key's read refused | the old key revoked, the new key `'ready'` |
 * | L22 | `runtime` w1 and w2 subscribed, the stream carries w2; `subscription.revoked` | w2 `'revoked'`, w1 stays `'ready'`    |
 * | L23 | keyless `consent`; `subscription.revoked`              | its entry revoked                                               |
 * | L24 | the first snapshot rejects once, then succeeds         | read again after `retryDelay`; the stream opens; `onError` once |
 * | L25 | the first snapshot rejects; then `get('consent')` succeeds | the manifest is installed and the stream opens for the waiting subscription |
 * | L26 | the first snapshot rejects; `close()` before the retry | no retry read, no stream                                        |
 * | L26b | the first snapshot rejects; `close()`; `subscribe` again before the old timer would fire | one new read, by the new subscribe; the stale timer reads nothing |
 * | L27 | the first snapshot keeps rejecting                     | retries spaced by `retryDelay`, not a tight loop; `onError` per attempt |
 * | L27b | a second `subscribe` while the failing first snapshot is in flight | one `onError` per failure, one retry timer              |
 * | L28 | `runtime` w1 carried and revoked; w2 mounts (w1 shadowed); w1's own read answers with a newer `at` | w1 `'ready'` |
 * | L28' | the same, the read answers with an older `at`         | the answer's value dropped; w1 `'ready'` — the lift is by generation, not by age |
 * | L29 | `write('consent', …)`, then `close()` during the first snapshot | rejects: the client was closed; no write fetch           |
 * | L30 | `subscription.granted` while an omitting snapshot read before it is in flight | `'ready'` after the grant                |
 * | L31 | a stale omitting snapshot of an older connection lands after the newer one's snapshot held the state | stays `'ready'` |
 * | L32 | revoked (gen 1); reconnect (gen 2); a frame at `at(6)` lands before the gen-2 snapshot entry at `at(5)` | value `at(6)`, `'ready'` |
 * | L33 | the same window, a `write()` answer at `at(6)` lands first | `'ready'`                                                     |
 * | L34 | revoke at gen 1 while the gen-1 snapshot is in flight; reconnect (gen-2 snapshot held); the gen-1 snapshot lands holding the state | `'revoked'` |
 * | L35 | two revokes across two generations; the gen-2 read lands while gen 3 is current, then the gen-3 read lands | `'revoked'` after the gen-2 read, `'ready'` after the gen-3 read |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_EVENTS, at, FakeEventSource, harness, opened, routes, servedStates, settle, streamQuery } from './client-harness';

// The api client reads the request's cookies and host on the server-side arm; there is no request here.
vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers(),
}));

const w1 = { workspaceId: 'w1' };
const w2 = { workspaceId: 'w2' };
const revoked = { event: 'state.runtime.changed' };
const consentEvent = { event: 'state.consent.changed' };

/** A promise and the function that resolves it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void }
{
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done =>
    {
        resolve = done;
    });

    return { promise, resolve };
}

/** A `getStates` responder whose first `failures` reads reject as a dropped network would. */
function failingFirst(failures: number): (input: Record<string, any>) => unknown
{
    let reads = 0;

    return input =>
    {
        if (reads++ < failures)
        {
            throw new TypeError('fetch failed');
        }

        return { at: at(0), states: servedStates(input.query) };
    };
}

/** A `getStates` responder answering the first call as the server would, and holding every later one until released. */
function holdAfterFirst(): { responder: (input: Record<string, any>) => unknown; release: (body: unknown) => void }
{
    let calls = 0;
    const held = deferred<unknown>();

    return {
        responder: input => calls++ === 0 ? { at: at(0), states: servedStates(input.query) } : held.promise,
        release: held.resolve,
    };
}

/** A `getStates` responder answering the first call as the server would, and holding every later read `n` until `release(n, body)`. */
function heldReads(): { responder: (input: Record<string, any>) => unknown; release: (n: number, body: unknown) => void }
{
    const held: Array<(body: unknown) => void> = [];
    let calls = 0;

    return {
        responder: input => calls++ === 0
            ? { at: at(0), states: servedStates(input.query) }
            : new Promise(resolve => held.push(resolve)),
        release: (n, body) => held[n - 1](body),
    };
}

/** Fails the stream, opens the one that replaces it, and returns it: the next connection generation. */
async function reconnect(es: FakeEventSource): Promise<FakeEventSource>
{
    const before = FakeEventSource.instances.length;
    es.fail();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(before + 1));
    const next = FakeEventSource.last;
    next.open();
    await settle();

    return next;
}

describe('state client — subscription lifecycle', () =>
{
    beforeEach(() =>
    {
        FakeEventSource.install();
    });

    afterEach(() =>
    {
        FakeEventSource.uninstall();
    });

    it('L1 the first subscriber reads the snapshot, opens one stream requesting every state event, and re-reads on its open', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        await settle();

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(new URL(FakeEventSource.last.url).searchParams.get('events')).toBe(ALL_EVENTS);
        expect(routes(h)).toEqual(['getStates']);

        await opened();

        expect(routes(h)).toEqual(['getStates', 'getStates']);
        h.client.close();
    });

    it('L2 a second subscriber on another state with the same keys opens nothing and reads nothing', async () =>
    {
        const h = harness();
        h.client.subscribe('runtime', w1, () => undefined);
        await opened();

        h.client.subscribe('member', w1, () => undefined);
        await settle();

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(routes(h)).toEqual(['getStates', 'getStates']);
        h.client.close();
    });

    it('L3 a new key reopens the stream with it, and the snapshot is re-read with it', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        const first = await opened();

        h.client.subscribe('runtime', w1, () => undefined);
        await opened();

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(first.readyState).toBe(FakeEventSource.CLOSED);
        expect(streamQuery(FakeEventSource.last)).toEqual({ workspaceId: 'w1' });
        expect(h.calls.map(call => [call.route, call.input.query])).toEqual([['getStates', {}], ['getStates', {}], ['getStates', { workspaceId: 'w1' }]]);
        h.client.close();
    });

    it('L4 the last subscriber of w1 leaves while w2 remains: reopened with w2 only', async () =>
    {
        // One connection carries one value per key field; the latest subscribed key wins it.
        const h = harness();
        h.client.subscribe('runtime', w2, () => undefined);
        const leave = h.client.subscribe('runtime', w1, () => undefined);
        await opened();
        expect(streamQuery(FakeEventSource.last)).toEqual({ workspaceId: 'w1' });

        leave();
        await opened();

        expect(FakeEventSource.live).toHaveLength(1);
        expect(streamQuery(FakeEventSource.last)).toEqual({ workspaceId: 'w2' });
        expect(h.calls.at(-1)).toEqual({ route: 'getStates', input: { query: { workspaceId: 'w2' } } });
        h.client.close();
    });

    it('L4 a subscribed key the stream does not carry is read once when it opens', async () =>
    {
        const h = harness({ getRuntimeState: () => ({ at: at(1), value: 'ready' }) });
        h.client.subscribe('runtime', w2, () => undefined);
        h.client.subscribe('runtime', w1, () => undefined);
        await opened();

        expect(h.calls).toContainEqual({ route: 'getRuntimeState', input: { query: { workspaceId: 'w2' } } });
        expect(h.client.current('runtime', w2)).toMatchObject({ value: 'ready', status: 'ready' });
        h.client.close();
    });

    it('L5 the last subscriber leaving closes the stream; close() is idempotent', async () =>
    {
        const h = harness();
        const leave = h.client.subscribe('consent', () => undefined);
        await opened();

        leave();
        leave();
        await settle();

        expect(FakeEventSource.live).toHaveLength(0);
        expect(() =>
        {
            h.client.close();
            h.client.close();
        }).not.toThrow();
    });

    it('L6 subscription.revoked marks the carried runtime entry revoked, keeps its value, notifies', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(1), states: { runtime: { value: 'ready' } } }) });
        const listener = vi.fn();
        h.client.subscribe('runtime', w1, listener);
        const es = await opened();

        es.control('subscription.revoked', revoked);

        expect(h.client.current('runtime', w1)).toEqual({ at: at(1), value: 'ready', status: 'revoked' });
        expect(listener).toHaveBeenCalledTimes(2);
        h.client.close();
    });

    it('L7 subscription.granted reads the carried key once; status is ready again', async () =>
    {
        const h = harness({
            getStates: () => ({ at: at(1), states: { runtime: { value: 'provisioning' } } }),
            getRuntimeState: () => ({ at: at(2), value: 'ready' }),
        });
        h.client.subscribe('runtime', w1, () => undefined);
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();
        es.control('subscription.revoked', revoked);

        es.control('subscription.granted', revoked);
        await settle();

        expect(h.calls.filter(call => call.route === 'getRuntimeState')).toEqual([{ route: 'getRuntimeState', input: { query: w1 } }]);
        expect(h.client.current('runtime', w1)).toEqual({ at: at(2), value: 'ready', status: 'ready' });

        es.emit('state.runtime.changed', { at: at(2), value: 'ready', key: w1 });
        expect(h.client.current('runtime', w1)).toEqual({ at: at(2), value: 'ready', status: 'ready' });
        h.client.close();
    });

    it('L7 the grant frame arriving before subscription.granted also ends ready with the latest value', async () =>
    {
        const h = harness({
            getStates: () => ({ at: at(1), states: { runtime: { value: 'provisioning' } } }),
            getRuntimeState: () => ({ at: at(2), value: 'ready' }),
        });
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();
        es.control('subscription.revoked', revoked);

        // The frame lands before the grant: it supplies the value; only the grant lifts 'revoked' (L20).
        es.emit('state.runtime.changed', { at: at(2), value: 'ready', key: w1 });
        expect(h.client.current('runtime', w1)).toEqual({ at: at(2), value: 'ready', status: 'revoked' });
        es.control('subscription.granted', revoked);
        await settle();

        expect(h.client.current('runtime', w1)).toEqual({ at: at(2), value: 'ready', status: 'ready' });
        h.client.close();
    });

    it('L8 write calls the write route with the body and applies the answer before any frame', async () =>
    {
        const input = { termsVersion: '2026-10', marketing: true };
        const h = harness({ putConsentState: () => ({ at: at(2), value: 'agreed', data: { marketing: true } }) });

        const frame = await h.client.write('consent', input);

        // The manifest comes first. The RPC proxy forwards putConsentState as the route's PUT; the client posts the structured input.
        expect(h.calls).toEqual([{ route: 'getStates', input: { query: {} } }, { route: 'putConsentState', input: { body: input } }]);
        expect(frame).toEqual({ at: at(2), value: 'agreed', data: { marketing: true } });
        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
    });

    it('L8 a keyed write carries the key in the query', async () =>
    {
        const h = harness({ putRuntimeState: () => ({ at: at(2), value: 'provisioning' }) });

        await h.client.write('runtime', { action: 'restart' }, w1);

        expect(h.calls.at(-1)).toEqual({ route: 'putRuntimeState', input: { body: { action: 'restart' }, query: w1 } });
        expect(h.client.current('runtime', w1)?.value).toBe('provisioning');
    });

    it('L9 get on a client with no subscription reads with the key, stores it, opens no stream', async () =>
    {
        const h = harness({ getRuntimeState: () => ({ at: at(1), value: 'ready' }) });

        await h.client.get('runtime', w1);
        await settle();

        expect(h.calls).toEqual([{ route: 'getStates', input: { query: {} } }, { route: 'getRuntimeState', input: { query: w1 } }]);
        expect(h.client.current('runtime', w1)).toEqual({ at: at(1), value: 'ready', status: 'ready' });
        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('L10 a snapshot whose fetch rejects rejects; the store and the listeners are untouched', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(1), states: { consent: { value: 'pending', data: { marketing: false } } } }) });
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        await opened();
        const before = h.client.current('consent');
        listener.mockClear();

        h.responders.getStates = () =>
        {
            throw new TypeError('fetch failed');
        };

        await expect(h.client.snapshot()).rejects.toThrow('fetch failed');
        expect(h.client.current('consent')).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        h.client.close();
    });

    it('L11 the first snapshot is read before any EventSource, and the stream requests every id of its manifest', async () =>
    {
        const first = deferred<unknown>();
        const h = harness({ getStates: () => first.promise });
        h.client.subscribe('consent', () => undefined);
        await settle();

        expect(routes(h)).toEqual(['getStates']);
        expect(FakeEventSource.instances).toHaveLength(0);

        first.resolve({ at: at(0), states: servedStates() });
        await settle();

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(new URL(FakeEventSource.last.url).searchParams.get('events')).toBe(ALL_EVENTS);
        h.client.close();
    });

    it('L11 a subscribe while the first snapshot is in flight waits for it — no second manifest read', async () =>
    {
        const first = deferred<unknown>();
        const h = harness({ getStates: () => first.promise });
        h.client.subscribe('consent', () => undefined);
        await settle();
        h.client.subscribe('runtime', w1, () => undefined);
        await settle();

        expect(routes(h)).toEqual(['getStates']);

        first.resolve({ at: at(0), states: servedStates() });
        await settle();

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(streamQuery(FakeEventSource.last)).toEqual(w1);
        h.client.close();
    });

    it('L11 close() during the first snapshot discards it: no stream, no listener called', async () =>
    {
        const first = deferred<unknown>();
        const h = harness({ getStates: () => first.promise });
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        await settle();

        h.client.close();
        first.resolve({ at: at(1), states: servedStates() });
        await settle();

        expect(FakeEventSource.instances).toHaveLength(0);
        expect(listener).not.toHaveBeenCalled();
        expect(h.client.current('consent')).toBeUndefined();
    });

    it('L12 a key whose fields are not the state\'s is refused once the manifest is known, naming both; the stream opens once without it', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        expect(() => h.client.subscribe('runtime', { teamId: 'x' } as never, () => undefined)).not.toThrow();
        await opened();

        expect(h.onError).toHaveBeenCalledTimes(1);
        expect(h.onError.mock.calls[0][0]).toEqual(new Error('State client: state "runtime" takes the key fields [workspaceId], given [teamId].'));
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(streamQuery(FakeEventSource.last)).toEqual({});

        h.client.subscribe('runtime', { teamId: 'y' } as never, () => undefined);
        await settle();

        expect(h.onError).toHaveBeenCalledTimes(2);
        expect(FakeEventSource.instances).toHaveLength(1);
        h.client.close();
    });

    it('L13 write on a state the manifest marks write: false rejects naming it, and fetches nothing', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        await opened();
        const before = h.calls.length;
        const write = h.client.write.bind(h.client) as unknown as (id: string, input: unknown, key: object) => Promise<unknown>;

        await expect(write('member', { role: 'admin' }, w1)).rejects.toThrow('State client: state "member" declares no .write()');
        expect(h.calls).toHaveLength(before);
        h.client.close();
    });

    it('L14 events= follows the manifest order, not the order of the subscriptions', async () =>
    {
        const h = harness();
        h.client.subscribe('seat', { workspaceId: 'w1', teamId: 't1' }, () => undefined);
        h.client.subscribe('member', w1, () => undefined);
        h.client.subscribe('consent', () => undefined);
        await opened();

        expect(new URL(FakeEventSource.last.url).searchParams.get('events')).toBe(ALL_EVENTS);
        h.client.close();
    });

    it('L15 a subscribed state the snapshot omits is revoked; the listener hears it once', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(1), states: {} }) });
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        await opened();

        expect(h.client.current('consent')).toEqual({ status: 'revoked' });
        expect(listener).toHaveBeenCalledTimes(1);
        h.client.close();
    });

    it('L16 then subscription.granted and its frame: ready with the value', async () =>
    {
        const h = harness({
            getStates: () => ({ at: at(1), states: {} }),
            getConsentState: () => ({ at: at(2), value: 'agreed', data: { marketing: true } }),
        });
        h.client.subscribe('consent', () => undefined);
        const es = await opened();

        es.control('subscription.granted', consentEvent);
        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true } });
        await settle();

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('L16\' a reconnect whose snapshot omits a ready state marks it revoked, the old value kept', async () =>
    {
        const h = harness();
        h.client.subscribe('runtime', w1, () => undefined);
        const first = await opened();
        expect(h.client.current('runtime', w1)).toEqual({ at: at(0), value: 'provisioning', status: 'ready' });

        // canRead turned false while the stream was down: no revoke can reach a dead connection.
        h.responders.getStates = () => ({ at: at(5), states: {} });
        first.fail();
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
        FakeEventSource.last.open();
        await settle();

        expect(h.client.current('runtime', w1)).toEqual({ at: at(0), value: 'provisioning', status: 'revoked' });
        h.client.close();
    });

    it('L16\' a later connection whose snapshot holds the state again lifts the revoke', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(1), states: {} }) });
        h.client.subscribe('consent', () => undefined);
        const first = await opened();
        expect(h.client.current('consent')?.status).toBe('revoked');

        h.responders.getStates = () => ({ at: at(2), states: servedStates() });
        first.fail();
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
        FakeEventSource.last.open();
        await settle();

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'pending', data: { marketing: false }, status: 'ready' });
        h.client.close();
    });

    it('L17 a keyed state whose key the snapshot query did not carry is not marked revoked', async () =>
    {
        const h = harness({
            getStates: () => ({ at: at(1), states: {} }),
            getRuntimeState: () => ({ at: at(1), value: 'ready' }),
        });
        h.client.subscribe('runtime', w2, () => undefined);
        h.client.subscribe('runtime', w1, () => undefined);   // carried: the latest wins
        await opened();

        expect(h.client.current('runtime', w1)?.status).toBe('revoked');
        expect(h.client.current('runtime', w2)).toEqual({ at: at(1), value: 'ready', status: 'ready' });
        expect(h.client.current('member', w2)).toBeUndefined();
        h.client.close();
    });

    it('L18 a revoke while the open snapshot is in flight survives the snapshot landing', async () =>
    {
        const hold = holdAfterFirst();
        const h = harness({ getStates: hold.responder });
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();

        es.control('subscription.revoked', revoked);
        hold.release({ at: at(1), states: { runtime: { value: 'ready' } } });
        await settle();

        expect(h.client.current('runtime', w1)).toEqual({ at: at(1), value: 'ready', status: 'revoked' });
        h.client.close();
    });

    it('L19 then subscription.granted and its frame: ready', async () =>
    {
        const hold = holdAfterFirst();
        const h = harness({ getStates: hold.responder, getRuntimeState: () => ({ at: at(2), value: 'ready' }) });
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();
        es.control('subscription.revoked', revoked);
        hold.release({ at: at(1), states: { runtime: { value: 'ready' } } });
        await settle();

        es.control('subscription.granted', revoked);
        es.emit('state.runtime.changed', { at: at(2), value: 'ready', key: w1 });
        await settle();

        expect(h.client.current('runtime', w1)).toEqual({ at: at(2), value: 'ready', status: 'ready' });
        h.client.close();
    });

    it('L20 a frame with a newer at after a revoke supplies the value; the status stays revoked', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        h.client.subscribe('runtime', w1, listener);
        const es = await opened();
        es.control('subscription.revoked', revoked);
        listener.mockClear();

        es.emit('state.runtime.changed', { at: at(3), value: 'ready', key: w1 });

        expect(h.client.current('runtime', w1)).toEqual({ at: at(3), value: 'ready', status: 'revoked' });
        expect(listener).toHaveBeenCalledTimes(1);
        h.client.close();
    });

    it('L21 a revoke the old connection delivers before the queued key-change reopen revokes the old key; the new key is ready', async () =>
    {
        let reads = 0;
        const held = deferred<unknown>();
        const h = harness({
            getStates: input => ++reads <= 2 ? { at: at(0), states: servedStates(input.query) } : held.promise,
            getRuntimeState: () =>
            {
                throw new Error('403: canRead is false for w1');
            },
        });
        h.client.subscribe('runtime', w1, () => undefined);
        const old = await opened();

        h.client.subscribe('runtime', w2, () => undefined);
        old.control('subscription.revoked', revoked);         // the same task: the reopen is still a queued microtask
        await opened();
        expect(streamQuery(FakeEventSource.last)).toEqual(w2);
        expect(old.readyState).toBe(FakeEventSource.CLOSED);

        held.resolve({ at: at(2), states: { runtime: { value: 'provisioning' } } });
        await settle();

        expect(h.client.current('runtime', w1)).toEqual({ at: at(0), value: 'provisioning', status: 'revoked' });
        expect(h.client.current('runtime', w2)).toEqual({ at: at(2), value: 'provisioning', status: 'ready' });
        h.client.close();
    });

    it('L22 a revoke concerns the key the connection carries — a shadowed key of the same state stays ready', async () =>
    {
        const h = harness({ getRuntimeState: () => ({ at: at(1), value: 'ready' }) });
        h.client.subscribe('runtime', w1, () => undefined);
        h.client.subscribe('runtime', w2, () => undefined);   // carried: the latest wins
        const es = await opened();
        expect(streamQuery(es)).toEqual(w2);

        es.control('subscription.revoked', revoked);

        expect(h.client.current('runtime', w2)?.status).toBe('revoked');
        expect(h.client.current('runtime', w1)).toEqual({ at: at(1), value: 'ready', status: 'ready' });
        h.client.close();
    });

    it('L23 a revoke of a keyless state revokes its one entry', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        const es = await opened();

        es.control('subscription.revoked', consentEvent);

        expect(h.client.current('consent')).toEqual({ at: at(0), value: 'pending', data: { marketing: false }, status: 'revoked' });
        h.client.close();
    });

    it('L24 a first snapshot that rejects once is read again after retryDelay; the stream opens; onError once', async () =>
    {
        const h = harness({ getStates: failingFirst(1) });
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        await settle();
        expect(h.onError).toHaveBeenCalledTimes(1);
        expect(FakeEventSource.instances).toHaveLength(0);

        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        FakeEventSource.last.open();
        await settle();

        expect(routes(h).filter(route => route === 'getStates')).toHaveLength(3);
        expect(h.client.current('consent')?.status).toBe('ready');
        expect(h.onError).toHaveBeenCalledTimes(1);
        h.client.close();
    });

    it('L25 after a failed first snapshot, a get() that reads it opens the stream for the waiting subscription', async () =>
    {
        const h = harness({
            getStates: failingFirst(1),
            getConsentState: () => ({ at: at(1), value: 'pending', data: { marketing: false } }),
        }, { retryDelay: 60_000 });
        h.client.subscribe('consent', () => undefined);
        await settle();
        expect(FakeEventSource.instances).toHaveLength(0);

        await h.client.get('consent');
        await settle();

        expect(FakeEventSource.instances).toHaveLength(1);
        h.client.close();
    });

    it('L26 close() before the retry of a failed first snapshot: no retry read, no stream', async () =>
    {
        const h = harness({ getStates: failingFirst(Infinity) });
        h.client.subscribe('consent', () => undefined);
        await settle();

        h.client.close();
        await new Promise(resolve => setTimeout(resolve, 50));   // five times the harness retryDelay

        expect(routes(h)).toEqual(['getStates']);
        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('L26b a subscribe after close(), before the old retry would fire, makes the only new read; the stale timer reads nothing', async () =>
    {
        const times: number[] = [];
        const failing = failingFirst(Infinity);
        const h = harness({
            getStates: input =>
            {
                times.push(performance.now());

                return failing(input);
            },
        }, { retryDelay: 200 });
        h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1), { interval: 1 });
        await new Promise(resolve => setTimeout(resolve, times[0] + 100 - performance.now()));   // the old retry is due 100 ms from now
        expect(times).toHaveLength(1);
        h.client.close();

        const resubscribed = performance.now();
        h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(times.length).toBeGreaterThanOrEqual(3), { timeout: 1000 });
        h.client.close();

        expect(times[1]).toBeGreaterThanOrEqual(resubscribed);
        // The third read is the new lifetime's retry, not the stale timer of the first.
        expect(times[2] - times[1]).toBeGreaterThanOrEqual(199);
    });

    it('L27 a first snapshot that keeps rejecting is retried every retryDelay, not in a tight loop; onError per attempt', async () =>
    {
        const times: number[] = [];
        const failing = failingFirst(Infinity);
        const h = harness({
            getStates: input =>
            {
                times.push(performance.now());

                return failing(input);
            },
        });
        h.client.subscribe('consent', () => undefined);
        await new Promise(resolve => setTimeout(resolve, 100));
        h.client.close();
        await settle();

        const gaps = times.slice(1).map((time, i) => time - times[i]);
        expect(times.length).toBeGreaterThanOrEqual(3);
        expect(times.length).toBeLessThanOrEqual(11);
        // setTimeout(10) may fire a fraction of a millisecond early against performance.now().
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(9);
        expect(h.onError).toHaveBeenCalledTimes(times.length);
        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('L27b a second subscribe while the failing first snapshot is in flight: one onError per failure, one retry timer', async () =>
    {
        const timers = vi.spyOn(globalThis, 'setTimeout');
        const gate = deferred<void>();
        const h = harness({
            getStates: async () =>
            {
                await gate.promise;
                throw new TypeError('fetch failed');
            },
        }, { retryDelay: 60_000 });
        h.client.subscribe('consent', () => undefined);
        await settle();                                         // the waiter is set, the read in flight
        h.client.subscribe('runtime', w1, () => undefined);
        await settle();

        gate.resolve();
        await settle();

        expect(h.onError).toHaveBeenCalledTimes(1);
        expect(timers.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(1);
        expect(routes(h)).toEqual(['getStates']);
        h.client.close();
        timers.mockRestore();
    });

    it('L28 a shadowed key whose own read, for a connection opened after its revoke, answers newer is ready', async () =>
    {
        const h = harness({ getRuntimeState: () => ({ at: at(4), value: 'ready' }) });
        h.client.subscribe('runtime', w1, () => undefined);
        const first = await opened();
        first.control('subscription.revoked', revoked);
        expect(h.client.current('runtime', w1)?.status).toBe('revoked');

        h.client.subscribe('runtime', w2, () => undefined);   // w2 carried, w1 shadowed and read once
        await opened();
        expect(streamQuery(FakeEventSource.last)).toEqual(w2);

        expect(h.client.current('runtime', w1)).toEqual({ at: at(4), value: 'ready', status: 'ready' });
        h.client.close();
    });

    it('L28\' the same read answering older than the entry has its value dropped, yet lifts the mark', async () =>
    {
        const h = harness({
            getStates: input => ({ at: at(3), states: servedStates(input.query) }),
            getRuntimeState: () => ({ at: at(1), value: 'ready' }),
        });
        h.client.subscribe('runtime', w1, () => undefined);
        const first = await opened();
        first.control('subscription.revoked', revoked);

        h.client.subscribe('runtime', w2, () => undefined);
        await opened();

        expect(h.client.current('runtime', w1)).toEqual({ at: at(3), value: 'provisioning', status: 'ready' });
        h.client.close();
    });

    it('L29 write() waiting on the first snapshot when close() runs rejects: the client was closed; no write fetch', async () =>
    {
        const first = deferred<unknown>();
        const h = harness({ getStates: () => first.promise });
        const pending = h.client.write('consent', { termsVersion: 1, marketing: true } as never);
        const read = h.client.get('consent');
        await settle();

        h.client.close();
        first.resolve({ at: at(1), states: servedStates() });

        await expect(pending).rejects.toThrow(new Error('State client: the client was closed while the first snapshot was in flight.'));
        await expect(read).rejects.toThrow('State client: the client was closed');
        expect(routes(h)).toEqual(['getStates']);
    });

    it('L30 a grant while an omitting snapshot read before it is in flight leaves the state ready', async () =>
    {
        let reads = 0;
        const held = deferred<unknown>();
        const h = harness({
            getStates: input => reads++ === 0 ? { at: at(0), states: servedStates(input.query) } : held.promise,
            getConsentState: () => ({ at: at(2), value: 'agreed', data: { marketing: true } }),
        });
        h.client.subscribe('consent', () => undefined);
        const es = await opened();                             // the open snapshot is now in flight

        es.control('subscription.granted', consentEvent);
        held.resolve({ at: at(1), states: {} });              // read before the grant: omits consent
        await settle();

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('L31 an omitting snapshot of an older connection, landing after a newer one held the state, does not revoke it', async () =>
    {
        let reads = 0;
        const stale = deferred<unknown>();
        const h = harness({ getStates: input => ++reads === 2 ? stale.promise : { at: at(3), states: servedStates(input.query) } });
        h.client.subscribe('consent', () => undefined);
        const first = await opened();                          // generation 1: its snapshot is held

        first.fail();
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
        FakeEventSource.last.open();                           // generation 2: its snapshot holds consent
        await settle();
        expect(h.client.current('consent')?.status).toBe('ready');

        stale.resolve({ at: at(1), states: {} });
        await settle();

        expect(h.client.current('consent')?.status).toBe('ready');
        h.client.close();
    });

    it('L32 a frame of the new connection landing before its older snapshot entry: the frame\'s value, ready', async () =>
    {
        const held = holdAfterFirst();
        const h = harness({ getStates: held.responder });
        h.client.subscribe('consent', () => undefined);
        const first = await opened();                          // generation 1
        first.control('subscription.revoked', consentEvent);

        first.fail();
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
        const second = FakeEventSource.last;
        second.open();                                         // generation 2: its snapshot read is held
        second.emit('state.consent.changed', { at: at(6), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        held.release({ at: at(5), states: servedStates() });
        await settle();

        expect(h.client.current('consent')).toEqual({ at: at(6), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('L33 a write answer landing before the new connection\'s older snapshot entry: ready', async () =>
    {
        const held = holdAfterFirst();
        const h = harness({
            getStates: held.responder,
            putConsentState: () => ({ at: at(6), value: 'agreed', data: { marketing: true } }),
        });
        h.client.subscribe('consent', () => undefined);
        const first = await opened();
        first.control('subscription.revoked', consentEvent);

        first.fail();
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
        FakeEventSource.last.open();
        await h.client.write('consent', { termsVersion: 1, marketing: true } as never);
        held.release({ at: at(5), states: servedStates() });
        await settle();

        expect(h.client.current('consent')).toEqual({ at: at(6), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('L34 a snapshot read before a revoke, landing after a reconnect, does not lift the revoke', async () =>
    {
        const reads = heldReads();
        const h = harness({ getStates: reads.responder });
        h.client.subscribe('consent', () => undefined);
        const first = await opened();                          // generation 1: its snapshot read is held
        first.control('subscription.revoked', consentEvent);
        await reconnect(first);                                // generation 2: its snapshot read is held

        reads.release(1, { at: at(1), states: servedStates() });
        await settle();

        expect(h.client.current('consent')?.status).toBe('revoked');
        h.client.close();
    });

    it('L35 two revokes across two generations: the gen-2 read does not lift the second, the gen-3 read does', async () =>
    {
        const reads = heldReads();
        const h = harness({ getStates: reads.responder });
        h.client.subscribe('consent', () => undefined);
        const first = await opened();                          // generation 1
        first.control('subscription.revoked', consentEvent);
        const second = await reconnect(first);                 // generation 2
        second.control('subscription.revoked', consentEvent);
        await reconnect(second);                               // generation 3

        reads.release(2, { at: at(2), states: servedStates() });
        await settle();
        expect(h.client.current('consent')?.status).toBe('revoked');

        reads.release(3, { at: at(3), states: servedStates() });
        await settle();
        expect(h.client.current('consent')?.status).toBe('ready');
        h.client.close();
    });
});
