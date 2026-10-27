/**
 * State client — what the stream says about a slot nobody watches (fxylabs/spfn#152).
 * A frame, a denial in `connected` and a snapshot's omission are applied to
 * every state whose key the stream's query carries, watched or not; only a
 * frame for a key outside the query is dropped. A later subscribe that does
 * not reopen the stream — a keyless state, or a key the query already
 * carries — is then served the newest value, never an older one, never
 * nothing. "Connected complete" is `servedBy(query)`: every allowed event in
 * `initial`, so no snapshot re-read. "No reopen": `FakeEventSource.instances`
 * unchanged by the later subscribe; "no read": `routes(h)` unchanged by it.
 *
 * | #   | entry origin / setup                                   | arrival (slot unwatched)            | then                    | expected                                              |
 * |-----|--------------------------------------------------------|-------------------------------------|-------------------------|-------------------------------------------------------|
 * | F1  | `initial` for w1; `runtime` w1; connected complete     | `consent` frame `at(2)` `'agreed'`  | `subscribe('consent')`  | `at(2)`, `'agreed'`, `'ready'`; no reopen, no read (the issue's reproduction) |
 * | F2  | `initial` for w1; `runtime` w1; connected complete     | `member` w1 frame `at(2)` `'owner'` | `subscribe('member', w1)` | `at(2)`, `'owner'`, `'ready'`; no reopen, no read   |
 * | F3  | no `initial`; `runtime` w1; open re-read stores `consent` | `consent` frame `at(2)`          | `subscribe('consent')`  | `at(2)`; no reopen, no read                           |
 * | F4  | `consent` (L) and `runtime` w1; opened; `consent` unsubscribed | `consent` frame `at(2)`     | `subscribe('consent')` again | L not called by the frame; `at(2)`; no reopen, no read |
 * | F5  | `runtime` w1 and `member` w1 (L); opened; `member` unsubscribed | `member` w1 frame `at(2)`  | `subscribe('member', w1)` again | L not called; `at(2)`; no reopen, no read     |
 * | F6  | no `initial`; `consent`; opened; `runtime` w1 reopens on w1, connected complete | `member` w1 frame `at(2)` `'owner'`, no entry before it | `subscribe('member', w1)` | `'owner'`, `'ready'`; no third `EventSource`, no read |
 * | F7  | `initial` for w1 (`consent` at `at(1)`); `runtime` w1; connected complete | `consent` frame `at(0)` (older) | `subscribe('consent')` | the `at(1)` entry, unchanged             |
 * | F8  | `runtime` w1; opened                                   | `runtime` frame key w2 (no entry)   | —                       | `runtime` w2 undefined (O7, unchanged)                |
 * | F9  | `member` w2; opened; unsubscribed; `runtime` w1 reopens on w1 | a `member` frame key w2 `at(5)` on the w1 stream | — | the `member` w2 entry unchanged: the key must be carried |
 * | F10 | `initial` for w1; `runtime` w1; connected complete but `consent` denied | —                  | `subscribe('consent')`  | `'revoked'`, value kept, before and after; no reopen, no read |
 * | F11 | as F10, `member` denied                                | —                                   | `subscribe('member', w1)` | `member` w1 `'revoked'`; no reopen, no read         |
 * | F12 | `runtime` w1; connected denies `seat` (no `teamId`)    | —                                   | —                       | no `seat` entry under any key                         |
 * | F13 | `initial` for w1; `runtime` w1; connected without `initial`; the re-read omits `consent` | — | `subscribe('consent')` | `'revoked'`, value kept                            |
 * | F14 | as F13, a `subscription.granted` for `consent` lands while the re-read is in flight | —      | —                       | `consent` not `'revoked'`                             |
 * | F15 | F10's state, same connection                           | `subscription.granted` for `consent`, then a frame `at(3)` | `subscribe('consent')` | `'ready'` at `at(3)`; no read for the grant; no reopen |
 * | F16 | `consent` revoked by connection 1; a reconnect         | a frame connection 1 queued, delivered after it | —           | `consent` stays `'revoked'` (K11, unwatched)          |
 *
 * F17 is every other test of this directory passing unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeConnected } from '../../event/sse/__tests__/fake-event-source';
import { at, deferred, FakeEventSource, harness, initialOf, opened, reconnect, routes, servedBy, servedStates, settle, streamQuery } from './client-harness';

// The api client reads the request's cookies and host on the server-side arm; there is no request here.
vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers(),
}));

const w1 = { workspaceId: 'w1' };
const w2 = { workspaceId: 'w2' };
const consentEvent = 'state.consent.changed';
const hydratedConsent = { at: at(1), value: 'pending', data: { marketing: false } };

type Harness = ReturnType<typeof harness>;

/** A client started from the render's snapshot for `w1`. */
function hydrated(responders: Parameters<typeof harness>[0] = {}): Harness
{
    return harness(responders, { initial: { snapshot: initialOf(w1), query: w1 } });
}

/** `servedBy(w1)` with `id` denied instead of served. */
function denying(id: string): ReturnType<typeof servedBy>
{
    const connected = servedBy(w1);
    const event = `state.${id}.changed`;

    return { ...connected, deniedEvents: [...connected.deniedEvents, event], initial: connected.initial.filter(name => name !== event) };
}

/** The snapshot as the server answers `query`, at `at(2)`, `consent` omitted. */
function omittingConsent(query: Record<string, string>): { at: string; states: Record<string, object> }
{
    const { consent: _omitted, ...states } = servedStates(query);

    return { at: at(2), states };
}

/** A hydrated client watching only `runtime` w1, its stream open with `connected` (complete by default). */
async function watchingRuntime(connected: FakeConnected = servedBy(w1), responders: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; es: FakeEventSource }>
{
    const h = hydrated(responders);
    h.client.subscribe('runtime', w1, () => undefined);
    const es = await opened(connected);

    return { h, es };
}

/** Run `subscribe` and let it settle; expect it opened no stream and read nothing. */
async function subscribeQuietly(h: Harness, subscribe: () => void): Promise<void>
{
    const streams = FakeEventSource.instances.length;
    const calls = routes(h);

    subscribe();
    await settle();

    expect(FakeEventSource.instances).toHaveLength(streams);
    expect(routes(h)).toEqual(calls);
}

describe('state client — unwatched slots', () =>
{
    beforeEach(() =>
    {
        FakeEventSource.install();
    });

    afterEach(() =>
    {
        FakeEventSource.uninstall();
    });

    it('F1 a consent frame while only runtime is watched serves a later subscribe(\'consent\') the frame', async () =>
    {
        const { h, es } = await watchingRuntime();

        es.emit(consentEvent, { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        await subscribeQuietly(h, () => h.client.subscribe('consent', () => undefined));

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('F2 a member frame on the carried key while only runtime is watched serves a later subscribe(\'member\', w1)', async () =>
    {
        const { h, es } = await watchingRuntime();

        es.emit('state.member.changed', { at: at(2), value: 'owner', key: w1 });
        await subscribeQuietly(h, () => h.client.subscribe('member', w1, () => undefined));

        expect(h.client.current('member', w1)).toEqual({ at: at(2), value: 'owner', status: 'ready' });
        h.client.close();
    });

    it('F3 a frame newer than the snapshot read\'s consent entry replaces it, unwatched', async () =>
    {
        const h = harness();
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();

        expect(h.client.current('consent')?.at).toBe(at(0));

        es.emit(consentEvent, { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        await subscribeQuietly(h, () => h.client.subscribe('consent', () => undefined));

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('F4 after consent is unsubscribed its frame lands without calling the old listener; a resubscribe reads it', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        const stop = h.client.subscribe('consent', listener);
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();
        stop();
        await settle();
        const calls = listener.mock.calls.length;

        es.emit(consentEvent, { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });

        expect(listener).toHaveBeenCalledTimes(calls);

        await subscribeQuietly(h, () => h.client.subscribe('consent', () => undefined));

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('F5 after member w1 is unsubscribed its frame lands without calling the old listener; a resubscribe reads it', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        h.client.subscribe('runtime', w1, () => undefined);
        const stop = h.client.subscribe('member', w1, listener);
        const es = await opened();
        stop();
        await settle();
        const calls = listener.mock.calls.length;

        es.emit('state.member.changed', { at: at(2), value: 'owner', key: w1 });

        expect(listener).toHaveBeenCalledTimes(calls);

        await subscribeQuietly(h, () => h.client.subscribe('member', w1, () => undefined));

        expect(h.client.current('member', w1)).toEqual({ at: at(2), value: 'owner', status: 'ready' });
        h.client.close();
    });

    it('F6 a member frame on a reopened stream, with no entry before it, serves a later subscribe(\'member\', w1)', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        await opened();
        h.client.subscribe('runtime', w1, () => undefined);
        await settle();
        const es = FakeEventSource.last;

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(streamQuery(es)).toEqual(w1);

        es.open(servedBy(w1));
        await settle();

        expect(h.client.current('member', w1)).toBeUndefined();

        es.emit('state.member.changed', { at: at(2), value: 'owner', key: w1 });
        await subscribeQuietly(h, () => h.client.subscribe('member', w1, () => undefined));

        expect(h.client.current('member', w1)).toEqual({ at: at(2), value: 'owner', status: 'ready' });
        expect(FakeEventSource.instances).toHaveLength(2);
        h.client.close();
    });

    it('F7 an unwatched frame older than the entry is dropped by the ordering rule', async () =>
    {
        const { h, es } = await watchingRuntime();

        es.emit(consentEvent, { at: at(0), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        await subscribeQuietly(h, () => h.client.subscribe('consent', () => undefined));

        expect(h.client.current('consent')).toEqual({ ...hydratedConsent, status: 'ready' });
        h.client.close();
    });

    it('F8 a runtime frame for a key the query does not carry is dropped (O7)', async () =>
    {
        const h = harness();
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();

        es.emit('state.runtime.changed', { at: at(2), value: 'ready', key: w2 });

        expect(h.client.current('runtime', w2)).toBeUndefined();
        h.client.close();
    });

    it('F9 a frame for a key the query does not carry is dropped even when an entry exists for it', async () =>
    {
        const h = harness();
        const stop = h.client.subscribe('member', w2, () => undefined);
        await opened();
        stop();
        h.client.subscribe('runtime', w1, () => undefined);
        await settle();
        const es = FakeEventSource.last;

        expect(streamQuery(es)).toEqual(w1);

        es.open();
        await settle();
        const entry = h.client.current('member', w2);

        expect(entry).toEqual({ at: at(0), value: 'member', status: 'ready' });

        es.emit('state.member.changed', { at: at(5), value: 'owner', key: w2 });

        expect(h.client.current('member', w2)).toBe(entry);
        h.client.close();
    });

    it('F10 connected denying an unwatched consent marks it revoked; a later subscribe keeps that', async () =>
    {
        const { h } = await watchingRuntime(denying('consent'));

        expect(h.client.current('consent')).toEqual({ ...hydratedConsent, status: 'revoked' });

        await subscribeQuietly(h, () => h.client.subscribe('consent', () => undefined));

        expect(h.client.current('consent')).toEqual({ ...hydratedConsent, status: 'revoked' });
        h.client.close();
    });

    it('F11 connected denying an unwatched member on the carried key marks it revoked', async () =>
    {
        const { h } = await watchingRuntime(denying('member'));

        await subscribeQuietly(h, () => h.client.subscribe('member', w1, () => undefined));

        expect(h.client.current('member', w1)).toEqual({ at: at(1), value: 'member', status: 'revoked' });
        h.client.close();
    });

    it('F12 seat denied because the query lacks teamId leaves no seat entry under any key', async () =>
    {
        const { h } = await watchingRuntime();

        expect(h.client.current('seat', w1 as never)).toBeUndefined();
        expect(h.client.current('seat', { workspaceId: 'w1', teamId: undefined } as never)).toBeUndefined();
        expect(h.client.current('seat', { workspaceId: 'w1', teamId: 'x' })).toBeUndefined();
        expect((h.client as unknown as { current(id: string): unknown }).current('seat')).toBeUndefined();
        h.client.close();
    });

    it('F13 a re-read omitting an unwatched consent marks it revoked, value kept', async () =>
    {
        const { h } = await watchingRuntime({ deniedEvents: servedBy(w1).deniedEvents }, { getStates: input => omittingConsent(input.query) });

        expect(routes(h)).toEqual(['getStates']);

        await subscribeQuietly(h, () => h.client.subscribe('consent', () => undefined));

        expect(h.client.current('consent')).toEqual({ ...hydratedConsent, status: 'revoked' });
        h.client.close();
    });

    it('F14 a grant landing while that omitting re-read is in flight keeps the unwatched consent ready', async () =>
    {
        const held = deferred<unknown>();
        const { h, es } = await watchingRuntime({ deniedEvents: servedBy(w1).deniedEvents }, { getStates: () => held.promise });

        es.control('subscription.granted', { event: consentEvent });
        held.resolve(omittingConsent(w1));
        await settle();

        expect(routes(h)).toEqual(['getStates']);
        expect(h.client.current('consent')?.status).not.toBe('revoked');
        h.client.close();
    });

    it('F15 a grant then a frame for the revoked, unwatched consent make it ready with the frame; the grant reads nothing', async () =>
    {
        const { h, es } = await watchingRuntime(denying('consent'));
        const calls = routes(h);

        es.control('subscription.granted', { event: consentEvent });
        await settle();

        expect(routes(h)).toEqual(calls);

        es.emit(consentEvent, { at: at(3), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        await subscribeQuietly(h, () => h.client.subscribe('consent', () => undefined));

        expect(h.client.current('consent')).toEqual({ at: at(3), value: 'agreed', data: { marketing: true }, status: 'ready' });
        h.client.close();
    });

    it('F16 a frame the prior connection queued cannot lift the unwatched consent\'s revoke after a reconnect', async () =>
    {
        const { h, es } = await watchingRuntime();
        const oldFrame = (es as any).listeners.get(consentEvent)[0];
        es.control('subscription.revoked', { event: consentEvent });

        expect(h.client.current('consent')?.status).toBe('revoked');

        await reconnect(es, servedBy(w1));
        oldFrame({ data: JSON.stringify({ event: consentEvent, data: { at: at(2), value: 'pending', data: { marketing: false }, subject: 'u1' } }) });

        expect(h.client.current('consent')?.status).toBe('revoked');
        h.client.close();
    });
});
