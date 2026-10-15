/**
 * State client — store and ordering. Per `(id, key)` an arrival replaces the
 * entry only when its `at` is newer, or equal and saying something different;
 * an applied change replaces the frozen entry and notifies, nothing else does.
 * One keyless state `consent`, one keyed `runtime`, one two-field key `seat`.
 * Listener counts start after the stream opened (the snapshots it read).
 *
 * | #  | arrival                                              | expected                                              |
 * |----|------------------------------------------------------|-------------------------------------------------------|
 * | O1 | snapshot(at 1) then frame(at 2)                      | value = frame; listener called twice                  |
 * | O2 | frame(at 2) then snapshot(at 1) for both states      | `consent` keeps the frame; `runtime` takes the snapshot |
 * | O3 | frame(at 2) then frame(at 1)                         | second dropped; listener called once                  |
 * | O4 | write response(at 2) then frame(at 2) same value     | listener called once                                  |
 * | O5 | frame(at 2) then frame(at 2) different data          | applied; listener called twice                        |
 * | O6 | reconnect                                            | `getStates` fetched again; newer entries applied      |
 * | O7 | frame for `runtime` with key `w2` while only `w1` subscribed | dropped                                       |
 * | O8 | `current()` returns the same reference between changes | `Object.is` holds across two calls; changes after a frame |
 * | O9 | a two-field key subscribed in one field order, a frame carrying the other | one entry; listener called once |
 * | O10 | two listeners, the first throws                     | the second is called; no throw escapes the frame        |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, FakeEventSource, harness, opened, routes, settle } from './client-harness';

// The api client reads the request's cookies and host on the server-side arm; there is no request here.
vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers(),
}));

const w1 = { workspaceId: 'w1' };
const w2 = { workspaceId: 'w2' };

describe('state client — ordering', () =>
{
    beforeEach(() =>
    {
        FakeEventSource.install();
    });

    afterEach(() =>
    {
        FakeEventSource.uninstall();
    });

    it('O1 snapshot(at 1) then frame(at 2): the frame wins; listener called twice', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(1), states: { consent: { value: 'pending', data: { marketing: false } } } }) });
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        const es = await opened();

        expect(h.client.current('consent')?.value).toBe('pending');
        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });

        expect(h.client.current('consent')).toEqual({ at: at(2), value: 'agreed', data: { marketing: true }, status: 'ready' });
        expect(listener).toHaveBeenCalledTimes(2);
        h.client.close();
    });

    it('O2 frame(at 2) then snapshot(at 1): consent keeps the frame, runtime takes the snapshot', async () =>
    {
        const h = harness({
            getStates: () => ({ at: at(0), states: { consent: { value: 'pending', data: { marketing: false } }, runtime: { value: 'provisioning' } } }),
        });
        h.client.subscribe('consent', () => undefined);
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();
        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });

        h.responders.getStates = () => ({ at: at(1), states: { consent: { value: 'pending', data: { marketing: false } }, runtime: { value: 'ready' } } });
        await h.client.snapshot();

        expect(h.client.current('consent')).toMatchObject({ at: at(2), value: 'agreed' });
        expect(h.client.current('runtime', w1)).toMatchObject({ at: at(1), value: 'ready' });
        h.client.close();
    });

    it('O3 frame(at 2) then frame(at 1): the second is dropped; listener called once', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        const es = await opened();
        listener.mockClear();

        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        es.emit('state.consent.changed', { at: at(1), value: 'pending', data: { marketing: false }, subject: 'u1' });

        expect(h.client.current('consent')).toMatchObject({ at: at(2), value: 'agreed' });
        expect(listener).toHaveBeenCalledTimes(1);
        h.client.close();
    });

    it('O4 write response(at 2) then its frame(at 2) with the same value: listener called once', async () =>
    {
        const h = harness({ putConsentState: () => ({ at: at(2), value: 'agreed', data: { marketing: true } }) });
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        const es = await opened();
        listener.mockClear();

        await h.client.write('consent', { termsVersion: '2026-10', marketing: true });
        const applied = h.client.current('consent');
        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(h.client.current('consent')).toBe(applied);
        h.client.close();
    });

    it('O5 frame(at 2) then frame(at 2) with different data: applied; listener called twice', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        h.client.subscribe('consent', listener);
        const es = await opened();
        listener.mockClear();

        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: false }, subject: 'u1' });
        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });

        expect(h.client.current('consent')?.data).toEqual({ marketing: true });
        expect(listener).toHaveBeenCalledTimes(2);
        h.client.close();
    });

    it('O6 reconnect: getStates is fetched again once the new stream opens; newer entries applied', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(1), states: { consent: { value: 'pending', data: { marketing: false } } } }) });
        h.client.subscribe('consent', () => undefined);
        const first = await opened();
        expect(routes(h)).toEqual(['getStates', 'getStates']);

        h.responders.getStates = () => ({ at: at(3), states: { consent: { value: 'agreed', data: { marketing: true } } } });
        first.fail();
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
        FakeEventSource.last.open();
        await settle();

        expect(routes(h)).toEqual(['getStates', 'getStates', 'getStates']);
        expect(h.client.current('consent')).toMatchObject({ at: at(3), value: 'agreed' });
        h.client.close();
    });

    it('O7 a runtime frame for w2 while only w1 is subscribed is dropped', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        h.client.subscribe('runtime', w1, listener);
        const es = await opened();
        const before = h.client.current('runtime', w1);
        listener.mockClear();

        es.emit('state.runtime.changed', { at: at(2), value: 'ready', key: w2 });

        expect(h.client.current('runtime', w2)).toBeUndefined();
        expect(h.client.current('runtime', w1)).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        h.client.close();
    });

    it('O8 current() is the same object until a change, and a new one after', async () =>
    {
        const h = harness({ getStates: () => ({ at: at(1), states: { consent: { value: 'pending', data: { marketing: false } } } }) });
        h.client.subscribe('consent', () => undefined);
        const es = await opened();

        const before = h.client.current('consent');
        expect(Object.is(before, h.client.current('consent'))).toBe(true);
        expect(Object.isFrozen(before)).toBe(true);

        es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        const after = h.client.current('consent');

        expect(after).not.toBe(before);
        expect(Object.is(after, h.client.current('consent'))).toBe(true);
        h.client.close();
    });

    it('O9 a two-field key names one entry whatever the field order of the subscriber and the frame', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        h.client.subscribe('seat', { teamId: 't1', workspaceId: 'w1' }, listener);
        const es = await opened();
        listener.mockClear();

        es.emit('state.seat.changed', { at: at(2), value: 'owner', key: { workspaceId: 'w1', teamId: 't1' } });

        expect(h.client.current('seat', { workspaceId: 'w1', teamId: 't1' })).toBe(h.client.current('seat', { teamId: 't1', workspaceId: 'w1' }));
        expect(h.client.current('seat', { workspaceId: 'w1', teamId: 't1' })).toMatchObject({ at: at(2), value: 'owner' });
        expect(listener).toHaveBeenCalledTimes(1);
        h.client.close();
    });

    it('O10 a listener that throws does not stop the next one, and nothing escapes the frame', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        const second = vi.fn();
        h.client.subscribe('consent', () =>
        {
            throw new Error('render failed');
        });
        h.client.subscribe('consent', second);
        const es = await opened();
        second.mockClear();
        warn.mockClear();

        expect(() => es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true } })).not.toThrow();

        expect(second).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBe('[state] A listener of state "consent" threw:');
        warn.mockRestore();
        h.client.close();
    });
});
