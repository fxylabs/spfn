/**
 * SSE client — the server's grant / revoke frames reach `onSubscriptionChange`.
 *
 * | #  | situation                                       | expected                                                        |
 * |----|-------------------------------------------------|-----------------------------------------------------------------|
 * | C1 | frame `subscription.revoked` `{ event: 'E' }`   | `onSubscriptionChange({ event: 'E', status: 'revoked' })`       |
 * | C2 | frame `subscription.granted`                    | `{ status: 'granted' }`                                         |
 * | C3 | option absent                                   | no throw, no console error                                      |
 * | C4 | the `?events=` list is unchanged by this feature | the URL names every requested event, as before                 |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import { createSSEClient } from '../client';

// ============================================================================
// Fake EventSource — dispatches raw frame data, as the server writes the
// stream-owned frames (`connected`, `subscription.*`) unwrapped.
// ============================================================================

type FakeListener = (e: { data: string }) => void;

class FakeEventSource
{
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    static instances: FakeEventSource[] = [];

    readyState = FakeEventSource.OPEN;
    onopen: (() => void) | null = null;
    onerror: ((e: Event) => void) | null = null;

    private listeners = new Map<string, FakeListener[]>();

    constructor(public url: string)
    {
        FakeEventSource.instances.push(this);
    }

    addEventListener(name: string, cb: FakeListener)
    {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
    }

    close()
    {
        this.readyState = FakeEventSource.CLOSED;
    }

    dispatch(event: string, data: unknown)
    {
        for (const cb of this.listeners.get(event) ?? [])
        {
            cb({ data: JSON.stringify(data) });
        }
    }
}

const schema = Type.Object({ n: Type.Number() });
const testRouter = defineEventRouter({
    E: defineEvent('client.e', schema),
    F: defineEvent('client.f', schema),
});

type TestRouter = typeof testRouter;

/** Subscribe synchronously (no acquireToken) and return the opened EventSource. */
function open(options: Partial<Parameters<ReturnType<typeof createSSEClient<TestRouter>>['subscribe']>[0]> = {})
{
    createSSEClient<TestRouter>({ url: 'http://test/stream', reconnect: false }).subscribe({
        events: ['E', 'F'],
        handlers: { E: () => undefined },
        ...options,
    });

    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('SSE client — onSubscriptionChange', () =>
{
    beforeEach(() =>
    {
        FakeEventSource.instances = [];
        (globalThis as any).EventSource = FakeEventSource;
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        delete (globalThis as any).EventSource;
    });

    it('C1 a subscription.revoked frame calls onSubscriptionChange with status revoked', async () =>
    {
        const onSubscriptionChange = vi.fn();
        open({ onSubscriptionChange });
        await flush();

        FakeEventSource.instances[0].dispatch('subscription.revoked', { event: 'E' });

        expect(onSubscriptionChange).toHaveBeenCalledExactlyOnceWith({ event: 'E', status: 'revoked' });
    });

    it('C2 a subscription.granted frame calls onSubscriptionChange with status granted', async () =>
    {
        const onSubscriptionChange = vi.fn();
        open({ onSubscriptionChange });
        await flush();

        FakeEventSource.instances[0].dispatch('subscription.granted', { event: 'F' });

        expect(onSubscriptionChange).toHaveBeenCalledExactlyOnceWith({ event: 'F', status: 'granted' });
    });

    it('C3 without the option the frames are ignored: no throw, no console error', async () =>
    {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        open();
        await flush();

        expect(() =>
        {
            FakeEventSource.instances[0].dispatch('subscription.revoked', { event: 'E' });
            FakeEventSource.instances[0].dispatch('subscription.granted', { event: 'E' });
        }).not.toThrow();
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('C4 the ?events= list still names every requested event', async () =>
    {
        open({ onSubscriptionChange: () => undefined });
        await flush();

        expect(new URL(FakeEventSource.instances[0].url).searchParams.get('events')).toBe('E,F');
    });
});
