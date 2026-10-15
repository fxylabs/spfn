/**
 * SSE connection registry — the end of one pending admission, against
 * `createConnectionRegistry` directly (no handler, no stream).
 *
 * | #   | situation                                                       | expected                                                               |
 * |-----|-----------------------------------------------------------------|------------------------------------------------------------------------|
 * | CR1 | `beginAdmission` with an already-aborted signal                 | ended at once; listener count 0; `open()` returns `false`; nothing registered |
 * | CR2 | cancelled, then `open()`                                        | `false`; nothing applied, notified or registered                       |
 * | CR3 | opened, then `cancel()`; then `grant`                           | stays registered; one frame                                            |
 * | CR4 | signal aborts twice                                             | `end` runs once; listener removed                                      |
 * | CR5 | one subject: open + pending + cancelled; `revoke`               | open one notified once; pending one records; cancelled one records nothing; counts 2 open / 0 pending after the pending opens |
 * | CR6 | a `grant` recorded on a pending handle, then `cancel()`, then `open()` | `false`; the recorded change is discarded                       |
 */

import { describe, it, expect, vi } from 'vitest';
import { createConnectionRegistry, type SSEConnection } from '../connection-registry';

vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});

/** A connection of `subject` that requested `e`, with `e` in `allowed` or in `denied`. */
function connection(subject: string, e: 'allowed' | 'denied'): SSEConnection
{
    return {
        subject,
        requested: ['e'],
        allowed: new Set(e === 'allowed' ? ['e'] : []),
        denied: new Set(e === 'denied' ? ['e'] : []),
        unsubscribes: new Map(),
        request: { query: {}, headers: {} },
        subscribe: () => () => undefined,
        notify: vi.fn(),
    };
}

/** An abort signal whose live `abort` listeners are counted (`once` removal is not counted). */
function countedSignal(controller = new AbortController())
{
    const { signal } = controller;
    const live = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);

    signal.addEventListener = ((type: string, listener: any, options?: any) =>
    {
        live.add(listener);
        add(type, listener, options);
    }) as typeof signal.addEventListener;

    signal.removeEventListener = ((type: string, listener: any, options?: any) =>
    {
        live.delete(listener);
        remove(type, listener, options);
    }) as typeof signal.removeEventListener;

    return { controller, signal, live };
}

describe('SSE connection registry: pending admission', () =>
{
    it('CR1 an already-aborted signal ends the admission at once: no listener, open() false, nothing registered', () =>
    {
        const registry = createConnectionRegistry();
        const aborted = new AbortController();
        aborted.abort();
        const { signal, live } = countedSignal(aborted);

        const pending = registry.beginAdmission('s', signal);
        registry.grant('s', 'e');
        const conn = connection('s', 'denied');

        expect(registry.pendingCount('s')).toBe(0);
        expect(live.size).toBe(0);
        expect(pending.open(conn)).toBe(false);
        expect(conn.allowed.size).toBe(0);
        expect(registry.count('s')).toBe(0);
    });

    it('CR2 cancelled, then open(): false, nothing applied, notified or registered', () =>
    {
        const registry = createConnectionRegistry();
        const { signal, live } = countedSignal();
        const pending = registry.beginAdmission('s', signal);
        expect(live.size).toBe(1);

        pending.cancel();
        registry.grant('s', 'e');
        const conn = connection('s', 'denied');

        expect(live.size).toBe(0);
        expect(pending.open(conn)).toBe(false);
        expect(conn.allowed.size).toBe(0);
        expect(conn.notify).not.toHaveBeenCalled();
        expect(registry.count('s')).toBe(0);
        expect(registry.pendingCount('s')).toBe(0);
    });

    it('CR3 opened, then cancel(): stays registered, and a later grant reaches it with one frame', () =>
    {
        const registry = createConnectionRegistry();
        const { signal, live } = countedSignal();
        const pending = registry.beginAdmission('s', signal);
        const conn = connection('s', 'denied');

        expect(pending.open(conn)).toBe(true);
        expect(live.size).toBe(0);
        pending.cancel();
        registry.grant('s', 'e');

        expect(registry.count('s')).toBe(1);
        expect(conn.allowed.has('e')).toBe(true);
        expect(conn.notify).toHaveBeenCalledTimes(1);
    });

    it('CR4 the signal aborts twice: the admission ends once and its listener is removed', () =>
    {
        const registry = createConnectionRegistry();
        const { controller, signal, live } = countedSignal();
        const pending = registry.beginAdmission('s', signal);
        const other = registry.beginAdmission('s', new AbortController().signal);

        controller.abort();
        controller.abort();

        expect(live.size).toBe(0);
        expect(registry.pendingCount('s')).toBe(1);
        expect(pending.open(connection('s', 'denied'))).toBe(false);
        expect(other.open(connection('s', 'denied'))).toBe(true);
        expect(registry.count('s')).toBe(1);
    });

    it('CR5 one subject open, pending and cancelled; revoke: only the open one is notified, only the pending one records', () =>
    {
        const registry = createConnectionRegistry();
        const cancelled = new AbortController();
        const openHandle = registry.beginAdmission('s', new AbortController().signal);
        const pendingHandle = registry.beginAdmission('s', new AbortController().signal);
        const cancelledHandle = registry.beginAdmission('s', cancelled.signal);
        const openConn = connection('s', 'allowed');
        expect(openHandle.open(openConn)).toBe(true);
        cancelled.abort();
        expect(registry.pendingCount('s')).toBe(1);

        registry.revoke('s', 'e');
        const late = connection('s', 'allowed');
        const second = connection('s', 'allowed');

        expect(openConn.denied.has('e')).toBe(true);
        expect(openConn.notify).toHaveBeenCalledTimes(1);
        expect(cancelledHandle.open(late)).toBe(false);
        expect(late.allowed.has('e')).toBe(true);
        expect(late.notify).not.toHaveBeenCalled();
        expect(pendingHandle.open(second)).toBe(true);
        expect(second.denied.has('e')).toBe(true);
        expect(second.notify).not.toHaveBeenCalled();
        expect(registry.count('s')).toBe(2);
        expect(registry.pendingCount('s')).toBe(0);
    });

    it('CR6 a grant recorded on a pending handle, then cancel(), then open(): false, the recorded change discarded', () =>
    {
        const registry = createConnectionRegistry();
        const pending = registry.beginAdmission('s', new AbortController().signal);
        registry.grant('s', 'e');

        pending.cancel();
        const conn = connection('s', 'denied');

        expect(pending.open(conn)).toBe(false);
        expect(conn.denied.has('e')).toBe(true);
        expect(conn.allowed.size).toBe(0);
        expect(registry.count('s')).toBe(0);
    });
});
