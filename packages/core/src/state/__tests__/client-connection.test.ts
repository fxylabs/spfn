/**
 * State client — connection status. The client derives it from the SSE
 * callbacks it passes to `sse.subscribe` and from its own first-snapshot
 * retry: `'reconnecting'` with the SSE client's attempt until a stream opens,
 * `'connected'` while one is open, `'failed'` when the retries are exhausted.
 * `retry()`, a new `subscribe` and `online` restart a failed client.
 *
 * | #   | situation                                              | expected                                                        |
 * |-----|--------------------------------------------------------|-----------------------------------------------------------------|
 * | S1  | client built, no call                                  | `{ status: 'reconnecting', attempt: 0 }`; same for a client built with `initial` |
 * | S2  | first `subscribe`, the stream opens                    | `connected`; the listener called once with it; `connection()` the same reference on two calls |
 * | S3  | the stream errors; the SSE client's reconnect attempt 1 runs | `reconnecting` 1; then opens → `connected`                  |
 * | S4  | `maxReconnectAttempts: 2`; the stream fails three times | `failed`; the listener saw `reconnecting 1`, `reconnecting 2`, `failed`; no new `EventSource` afterwards |
 * | S5  | S4, then `retry()`                                     | one new `EventSource`; `reconnecting 0`; opens → `connected`    |
 * | S6  | S4, then `subscribe` of another state (same query)     | the stream is reopened; status leaves `failed`                  |
 * | S7  | S4, then `online` dispatched on `globalThis`           | one new `EventSource` (as S5)                                   |
 * | S8  | `maxRetries: 2`, the first snapshot keeps rejecting    | reads at 0, `retryDelay`, 2·`retryDelay`; `onError` three times; `failed`; no fourth read |
 * | S9  | S8, then `retry()`                                     | one read now; it succeeds → the stream opens → `connected`      |
 * | S10 | `maxRetries` absent                                    | the first snapshot is retried past any count, never `failed` (L24–L27b unchanged) |
 * | S11 | `close()`                                              | `reconnecting 0`; the listener not called; no `failed` from the teardown; `online` opens nothing |
 * | S12 | key change: the client reopens the stream itself       | no `failed` from the old stream's `onClose`; `connected` after the new open |
 * | S13 | `retry()` while `connected`                            | no new `EventSource`, no listener call                          |
 * | S14 | two connection listeners; the first throws             | the second is called; a warn logged; no throw escapes           |
 * | S15 | `unsubscribeConnection()` twice                        | idempotent; the listener not called after the first             |
 * | S17 | `retry()` while `reconnecting` (the SSE timer pending) | one new `EventSource` now, none when the old timer would have fired |
 * | S18 | `maxRetries: 1`, the first read fails, the last unsubscribe, the timer fires, a new subscribe | the timer reads nothing; one first read and one retry, then `failed` |
 * | S19 | `retry()` while a failing first read is in flight     | `onError` once; one retry chain: two reads in total after `retryDelay` |
 * | S20 | `retry()` with the retry timer pending, the read failing again | one read now; the old timer fires no read                |
 * | S21 | `maxRetries: 1`; then `retry()`                        | one retry, then `failed`; after `retry()` one first read and one retry, then `failed` again |
 * | S22 | `subscribe` while `failed`, the manifest unknown       | one read now, `reconnecting 0`, the count reset: one retry, then `failed` |
 * | S23 | `connected`, the last unsubscribe; a subscribe again   | `reconnecting 0`, heard once; the reopen opens → `connected`    |
 * | S24 | two subscribers, `failed`; one unsubscribes; a subscribe | no new `EventSource` nor read, still `failed`; the subscribe reopens; the same with the manifest unknown |
 * | S25 | `failed` stream, the last unsubscribe; a subscribe     | `reconnecting 0`, heard once; no new `EventSource`; the subscribe reopens → `connected` |
 * | S25b | `maxRetries: 1`, `failed` first snapshot, the last unsubscribe; a subscribe | `reconnecting 0`, no read; the subscribe gets one read and one retry |
 *
 * S16 (`useConnectionStatus`) is in `react.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../client';
import { at, FakeEventSource, harness, initialOf, opened, servedStates, settle } from './client-harness';

// The api client reads the request's cookies and host on the server-side arm; there is no request here.
vi.mock('next/headers', () => ({
    cookies: async () => ({ getAll: () => [] }),
    headers: async () => new Headers(),
}));

const w1 = { workspaceId: 'w1' };
const w2 = { workspaceId: 'w2' };
const starting = { status: 'reconnecting', attempt: 0 };

/** A `getStates` responder whose first `failures` reads reject as a dropped network would; `times` records each read. */
function failingFirst(failures: number, times: number[] = []): (input: Record<string, any>) => unknown
{
    return input =>
    {
        times.push(performance.now());

        if (times.length <= failures)
        {
            throw new TypeError('fetch failed');
        }

        return { at: at(0), states: servedStates(input.query) };
    };
}

/** Every status the listener heard, in order. */
function heard(listener: ReturnType<typeof vi.fn>): ConnectionStatus[]
{
    return listener.mock.calls.map(([status]) => status);
}

/** Fail `es` and wait for the SSE client's reconnect to construct the next `EventSource`, left unopened. */
async function failAndReconnect(es: FakeEventSource): Promise<FakeEventSource>
{
    const before = FakeEventSource.instances.length;
    es.fail();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(before + 1));

    return FakeEventSource.last;
}

describe('state client — connection status', () =>
{
    let online: EventTarget;

    beforeEach(() =>
    {
        FakeEventSource.install();
        // Node has no `addEventListener` on globalThis; a browser's window does.
        online = new EventTarget();
        vi.stubGlobal('addEventListener', online.addEventListener.bind(online));
        vi.stubGlobal('removeEventListener', online.removeEventListener.bind(online));
        vi.stubGlobal('dispatchEvent', online.dispatchEvent.bind(online));
    });

    afterEach(() =>
    {
        vi.unstubAllGlobals();
        FakeEventSource.uninstall();
    });

    /** A client on `maxReconnectAttempts: 2` whose stream opened, then failed three times: `'failed'`. */
    async function failedClient(listener = vi.fn()): Promise<ReturnType<typeof harness>>
    {
        const h = harness({}, { maxReconnectAttempts: 2 });
        h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();
        h.client.subscribeConnection(listener);

        const second = await failAndReconnect(es);
        const third = await failAndReconnect(second);
        third.fail();

        return h;
    }

    it('S1 a client starts reconnecting at attempt 0, one built with initial too', () =>
    {
        const h = harness();
        const hydrated = harness({}, { initial: { snapshot: initialOf() } });

        expect(h.client.connection()).toEqual(starting);
        expect(hydrated.client.connection()).toEqual(starting);
        h.client.close();
        hydrated.client.close();
    });

    it('S2 the first stream open is connected, heard once; connection() keeps its reference', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        h.client.subscribeConnection(listener);
        h.client.subscribe('consent', () => undefined);

        await opened();

        expect(h.client.connection()).toEqual({ status: 'connected' });
        expect(heard(listener)).toEqual([{ status: 'connected' }]);
        expect(h.client.connection()).toBe(h.client.connection());
        expect(Object.isFrozen(h.client.connection())).toBe(true);
        h.client.close();
    });

    it('S3 a stream error is reconnecting at the SSE client\'s attempt 1, then connected on the reopen', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        const es = await opened();

        const next = await failAndReconnect(es);
        expect(h.client.connection()).toEqual({ status: 'reconnecting', attempt: 1 });

        next.open();
        expect(h.client.connection()).toEqual({ status: 'connected' });
        h.client.close();
    });

    it('S4 the SSE client\'s attempts exhausted is failed, after reconnecting 1 and 2; no EventSource after it', async () =>
    {
        const listener = vi.fn();
        const h = await failedClient(listener);

        expect(h.client.connection()).toEqual({ status: 'failed' });
        expect(heard(listener)).toEqual([
            { status: 'reconnecting', attempt: 1 },
            { status: 'reconnecting', attempt: 2 },
            { status: 'failed' },
        ]);

        await new Promise(resolve => setTimeout(resolve, 50));   // five times the SSE reconnectDelay
        expect(FakeEventSource.instances).toHaveLength(3);
        h.client.close();
    });

    it('S5 retry() after failed opens one new EventSource, reconnecting 0, then connected', async () =>
    {
        const listener = vi.fn();
        const h = await failedClient(listener);

        h.client.retry();

        expect(FakeEventSource.instances).toHaveLength(4);
        expect(h.client.connection()).toEqual(starting);
        FakeEventSource.last.open();
        expect(h.client.connection()).toEqual({ status: 'connected' });
        expect(heard(listener).slice(3)).toEqual([starting, { status: 'connected' }]);
        h.client.close();
    });

    it('S6 a subscribe of another state with the same query reopens a failed stream', async () =>
    {
        const h = await failedClient();

        h.client.subscribe('member', w1, () => undefined);
        await settle();

        expect(FakeEventSource.instances).toHaveLength(4);
        expect(h.client.connection()).toEqual(starting);
        h.client.close();
    });

    it('S7 online on globalThis after failed opens one new EventSource', async () =>
    {
        const h = await failedClient();

        globalThis.dispatchEvent(new Event('online'));

        expect(FakeEventSource.instances).toHaveLength(4);
        expect(h.client.connection()).toEqual(starting);
        h.client.close();
    });

    it('S8 maxRetries 2: three reads spaced by retryDelay, onError three times, then failed and no fourth read', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) }, { maxRetries: 2, retryDelay: 20 });
        const listener = vi.fn();
        h.client.subscribeConnection(listener);
        h.client.subscribe('consent', () => undefined);

        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });
        await new Promise(resolve => setTimeout(resolve, 3 * 20 + 20));

        expect(times).toHaveLength(3);
        // setTimeout(20) may fire a fraction of a millisecond early against performance.now().
        expect(times[1] - times[0]).toBeGreaterThanOrEqual(19);
        expect(times[2] - times[1]).toBeGreaterThanOrEqual(19);
        expect(h.onError).toHaveBeenCalledTimes(3);
        expect(heard(listener)).toEqual([{ status: 'failed' }]);
        expect(FakeEventSource.instances).toHaveLength(0);
        h.client.close();
    });

    it('S9 retry() after the first snapshot failed reads it now; the stream opens; connected', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(3, times) }, { maxRetries: 2 });
        h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });

        h.client.retry();
        expect(h.client.connection()).toEqual(starting);
        await settle();

        expect(times).toHaveLength(4);
        expect(FakeEventSource.instances).toHaveLength(1);
        FakeEventSource.last.open();
        expect(h.client.connection()).toEqual({ status: 'connected' });
        h.client.close();
    });

    it('S10 without maxRetries the first snapshot is retried past any count and never failed', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) });
        const listener = vi.fn();
        h.client.subscribeConnection(listener);
        h.client.subscribe('consent', () => undefined);

        await vi.waitFor(() => expect(times.length).toBeGreaterThanOrEqual(5), { interval: 1 });

        expect(h.client.connection()).toEqual(starting);
        expect(listener).not.toHaveBeenCalled();
        h.client.close();
    });

    it('S11 close() is reconnecting 0, heard by no listener, no failed from its teardown, online removed', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        await opened();
        const listener = vi.fn();
        h.client.subscribeConnection(listener);

        h.client.close();
        globalThis.dispatchEvent(new Event('online'));
        await settle();

        expect(h.client.connection()).toEqual(starting);
        expect(listener).not.toHaveBeenCalled();
        expect(FakeEventSource.instances).toHaveLength(1);
    });

    it('S12 a reopen on a key change is no failure; connected after the new open', async () =>
    {
        const h = harness();
        h.client.subscribe('runtime', w1, () => undefined);
        await opened();
        const listener = vi.fn();
        h.client.subscribeConnection(listener);

        h.client.subscribe('runtime', w2, () => undefined);
        await opened();

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(heard(listener)).not.toContainEqual({ status: 'failed' });
        expect(h.client.connection()).toEqual({ status: 'connected' });
        h.client.close();
    });

    it('S13 retry() while connected opens nothing and calls no listener', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        await opened();
        const listener = vi.fn();
        h.client.subscribeConnection(listener);

        h.client.retry();
        await settle();

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(listener).not.toHaveBeenCalled();
        h.client.close();
    });

    it('S14 a throwing connection listener is logged at warn and does not stop the next', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        const second = vi.fn();
        h.client.subscribeConnection(() =>
        {
            throw new Error('listener broke');
        });
        h.client.subscribeConnection(second);
        h.client.subscribe('consent', () => undefined);

        await expect(opened()).resolves.toBeDefined();

        expect(heard(second)).toEqual([{ status: 'connected' }]);
        expect(warn).toHaveBeenCalledWith('[state] A connection listener threw:', expect.any(Error));
        h.client.close();
        warn.mockRestore();
    });

    it('S15 the connection unsubscribe is idempotent; the listener is not called after the first', async () =>
    {
        const h = harness();
        const listener = vi.fn();
        const other = vi.fn();
        const off = h.client.subscribeConnection(listener);
        h.client.subscribeConnection(other);

        off();
        off();
        h.client.subscribe('consent', () => undefined);
        await opened();

        expect(listener).not.toHaveBeenCalled();
        expect(heard(other)).toEqual([{ status: 'connected' }]);
        h.client.close();
    });

    it('S17 retry() while the SSE reconnect timer is pending supersedes it: one EventSource now, none later', async () =>
    {
        const h = harness();
        h.client.subscribe('consent', () => undefined);
        const es = await opened();
        es.fail();
        expect(h.client.connection()).toEqual({ status: 'reconnecting', attempt: 1 });

        h.client.retry();

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(h.client.connection()).toEqual(starting);
        await new Promise(resolve => setTimeout(resolve, 50));   // five times the SSE reconnectDelay
        expect(FakeEventSource.instances).toHaveLength(2);
        h.client.close();
    });

    it('S18 maxRetries 1: a wait ended by the last unsubscribe leaves the next wait its one retry', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) }, { maxRetries: 1, retryDelay: 10 });
        const off = h.client.subscribe('consent', () => undefined);
        await settle();

        off();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(times).toHaveLength(1);

        h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });
        expect(times.length - 1).toBe(2);
        h.client.close();
    });

    it('S19 retry() while a failing first read is in flight: onError once, one retry chain', async () =>
    {
        let reject!: () => void;
        const times: number[] = [];
        const h = harness({
            getStates: () =>
            {
                times.push(performance.now());

                return times.length === 1
                    ? new Promise((_, fail) =>
                    {
                        reject = () => fail(new TypeError('fetch failed'));
                    })
                    : Promise.reject(new TypeError('fetch failed'));
            },
        }, { retryDelay: 40 });
        h.client.subscribe('consent', () => undefined);
        await settle();

        h.client.retry();
        reject();
        await settle();
        expect(h.onError).toHaveBeenCalledTimes(1);

        await new Promise(resolve => setTimeout(resolve, 60));
        expect(times).toHaveLength(2);
        h.client.close();
    });

    it('S20 retry() with the retry timer pending and the read failing again: the old timer fires no read', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) }, { retryDelay: 40 });
        h.client.subscribe('consent', () => undefined);
        await settle();
        await new Promise(resolve => setTimeout(resolve, 20));

        h.client.retry();
        await settle();
        expect(times).toHaveLength(2);

        await new Promise(resolve => setTimeout(resolve, 30));
        expect(times).toHaveLength(2);
        h.client.close();
    });

    it('S21 maxRetries 1: one retry, then failed; retry() resets the count for one more retry', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) }, { maxRetries: 1 });
        h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });
        expect(times).toHaveLength(2);

        h.client.retry();
        expect(h.client.connection()).toEqual(starting);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });
        await new Promise(resolve => setTimeout(resolve, 30));

        expect(times).toHaveLength(4);
        h.client.close();
    });

    it('S22 a subscribe while failed with the manifest unknown reads once now, its count reset', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) }, { maxRetries: 1, retryDelay: 40 });
        h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });

        h.client.subscribe('runtime', w1, () => undefined);
        await settle();
        expect(times).toHaveLength(3);
        expect(h.client.connection()).toEqual(starting);

        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });
        expect(times).toHaveLength(4);
        h.client.close();
    });

    it('S23 the last unsubscribe leaves connected for reconnecting 0, heard once; a subscribe reconnects', async () =>
    {
        const h = harness();
        const off = h.client.subscribe('consent', () => undefined);
        await opened();
        const listener = vi.fn();
        h.client.subscribeConnection(listener);

        off();
        await settle();
        expect(h.client.connection()).toEqual(starting);
        expect(heard(listener)).toEqual([starting]);

        h.client.subscribe('consent', () => undefined);
        await opened();
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(h.client.connection()).toEqual({ status: 'connected' });
        h.client.close();
    });

    it('S24 an unsubscribe leaves a failed stream failed; a subscribe reopens it', async () =>
    {
        const h = harness({}, { maxReconnectAttempts: 2 });
        h.client.subscribe('runtime', w1, () => undefined);
        const off = h.client.subscribe('consent', () => undefined);
        const es = await opened();
        const second = await failAndReconnect(es);
        const third = await failAndReconnect(second);
        third.fail();
        expect(h.client.connection()).toEqual({ status: 'failed' });

        off();
        await settle();
        expect(FakeEventSource.instances).toHaveLength(3);
        expect(h.client.connection()).toEqual({ status: 'failed' });

        h.client.subscribe('member', w1, () => undefined);
        await settle();
        expect(FakeEventSource.instances).toHaveLength(4);
        expect(h.client.connection()).toEqual(starting);
        h.client.close();
    });

    it('S24 an unsubscribe leaves a failed first snapshot failed, with no read', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) }, { maxRetries: 1 });
        h.client.subscribe('runtime', w1, () => undefined);
        const off = h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });

        off();
        await settle();
        expect(times).toHaveLength(2);
        expect(h.client.connection()).toEqual({ status: 'failed' });
        h.client.close();
    });

    it('S25 the last unsubscribe of a failed stream resets to reconnecting 0, heard once; a subscribe reconnects', async () =>
    {
        const h = harness({}, { maxReconnectAttempts: 2 });
        const off = h.client.subscribe('runtime', w1, () => undefined);
        const es = await opened();
        const second = await failAndReconnect(es);
        const third = await failAndReconnect(second);
        third.fail();
        expect(h.client.connection()).toEqual({ status: 'failed' });
        const listener = vi.fn();
        h.client.subscribeConnection(listener);

        off();
        await settle();
        expect(FakeEventSource.instances).toHaveLength(3);
        expect(h.client.connection()).toEqual(starting);
        expect(heard(listener)).toEqual([starting]);

        h.client.subscribe('runtime', w1, () => undefined);
        await opened();
        expect(FakeEventSource.instances).toHaveLength(4);
        expect(h.client.connection()).toEqual({ status: 'connected' });
        h.client.close();
    });

    it('S25b the last unsubscribe of a failed first snapshot resets with no read; a subscribe gets one read and one retry', async () =>
    {
        const times: number[] = [];
        const h = harness({ getStates: failingFirst(Infinity, times) }, { maxRetries: 1 });
        const off = h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });

        off();
        await settle();
        expect(times).toHaveLength(2);
        expect(h.client.connection()).toEqual(starting);

        h.client.subscribe('consent', () => undefined);
        await vi.waitFor(() => expect(h.client.connection()).toEqual({ status: 'failed' }), { interval: 1 });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(times).toHaveLength(4);
        h.client.close();
    });
});
