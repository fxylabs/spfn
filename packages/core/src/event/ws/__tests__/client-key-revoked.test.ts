/**
 * WebSocket client — a revoked key, or a token request answered 401, stops the client.
 *
 * The server closes a revoked device key's socket with `1008 Key revoked`;
 * reconnecting would ask the token endpoint, which the revoked session cannot
 * pass, every `reconnectDelay` until the tab closes. Both are final. So is a
 * refused origin (also 1008, the allow-list does not change between retries),
 * but it is not the credential gone, so `onClose` gets no reason. Any other
 * token request failure, a 403 included, is retried — the rule the SSE client
 * keeps (`isTokenRequestUnauthorized`).
 *
 * | #   | state       | action                                                   | expected                                                                                 |
 * |-----|-------------|----------------------------------------------------------|------------------------------------------------------------------------------------------|
 * | W5  | socket open | the server closes it `1008 Key revoked`                  | no token request and no connect within two reconnect intervals; `onClose('unauthorized')` once; state `closed` |
 * | W5' | socket open | the server closes it `1006`, then the token request answers 401 | one token request, no connect after it; `onClose('unauthorized')` once            |
 * | W5''| same        | the token request answers 403 (`statusCode`)             | a token request every `reconnectDelay` (three in three intervals), no connect; `onClose` not called |
 * | W5o | socket open | the server closes it `1008 Origin not allowed`           | no token request and no connect within two reconnect intervals; `onClose()` once, no reason; one `console.error` |
 * | W6  | socket open | the server closes it `1006`; the token request succeeds  | one token request and one connect after `reconnectDelay`; `onClose` not called           |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineWSRouter } from '../index';
import { createWSClient } from '../client';
import { POLICY_VIOLATION_CLOSE_CODE, KEY_REVOKED_CLOSE_REASON, ORIGIN_NOT_ALLOWED_CLOSE_REASON } from '../../stream-refusal';

const router = defineWSRouter({ events: { e: defineEvent('test.ws-client.e', Type.Object({ n: Type.Number() })) } });

const RECONNECT_DELAY = 3000;

/** A browser `WebSocket` stand-in: records every connect; the test drives open and close. */
class FakeWebSocket
{
    static readonly OPEN = 1;
    static instances: FakeWebSocket[] = [];

    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((evt: { code: number; reason: string }) => void) | null = null;
    onerror: ((evt: unknown) => void) | null = null;
    onmessage: ((evt: unknown) => void) | null = null;

    constructor(readonly url: string)
    {
        FakeWebSocket.instances.push(this);
    }

    open(): void
    {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    serverClose(code: number, reason = ''): void
    {
        this.readyState = 3;
        this.onclose?.({ code, reason });
    }

    close(): void
    {
        this.serverClose(1005);
    }

    send(): void
    {}
}

/** A client whose first token request succeeds and whose next ones answer `next`. */
async function openClient(next: () => Promise<string>)
{
    const acquireToken = vi.fn().mockResolvedValueOnce('first-token').mockImplementation(next);
    const onClose = vi.fn();
    const client = createWSClient<typeof router>({ host: 'ws://test', reconnectDelay: RECONNECT_DELAY, acquireToken });
    client.subscribe({ events: ['e'], handlers: {}, onClose });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].open();

    return { client, acquireToken, onClose };
}

beforeEach(() =>
{
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
});

afterEach(() =>
{
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('a WebSocket client whose key was revoked stops', () =>
{
    it('W5 closed 1008 Key revoked: no token request or connect within two reconnect intervals, onClose(\'unauthorized\') once', async () =>
    {
        const { client, acquireToken, onClose } = await openClient(async () => 'next-token');

        FakeWebSocket.instances[0].serverClose(POLICY_VIOLATION_CLOSE_CODE, KEY_REVOKED_CLOSE_REASON);
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAY * 2);

        expect(acquireToken).toHaveBeenCalledTimes(1);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledWith('unauthorized');
        expect(client.getState()).toBe('closed');
    });

    it('W5o closed 1008 Origin not allowed: no token request or connect within two reconnect intervals, onClose() once with no reason', async () =>
    {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { client, acquireToken, onClose } = await openClient(async () => 'next-token');

        FakeWebSocket.instances[0].serverClose(POLICY_VIOLATION_CLOSE_CODE, ORIGIN_NOT_ALLOWED_CLOSE_REASON);
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAY * 2);

        expect(acquireToken).toHaveBeenCalledTimes(1);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledWith(undefined);
        expect(client.getState()).toBe('closed');
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError.mock.calls[0][0]).toContain(ORIGIN_NOT_ALLOWED_CLOSE_REASON);
    });

    it('W5\' the token request answers 401: no connect after it, onClose(\'unauthorized\') once', async () =>
    {
        const { acquireToken, onClose } = await openClient(() => Promise.reject(Object.assign(new Error('refused'), { status: 401 })));

        FakeWebSocket.instances[0].serverClose(1006);
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAY * 3);

        expect(acquireToken).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledWith('unauthorized');
    });

    it('W5\'\' the token request answers 403: it is asked again every reconnectDelay, onClose not called', async () =>
    {
        const { acquireToken, onClose } = await openClient(() => Promise.reject(Object.assign(new Error('forbidden'), { statusCode: 403 })));

        FakeWebSocket.instances[0].serverClose(1006);
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAY * 3);

        expect(acquireToken).toHaveBeenCalledTimes(1 + 3);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('W6 closed 1006 with the token request succeeding: one token request and one connect after reconnectDelay, onClose not called', async () =>
    {
        const { acquireToken, onClose } = await openClient(async () => 'next-token');

        FakeWebSocket.instances[0].serverClose(1006);
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAY);

        expect(acquireToken).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(onClose).not.toHaveBeenCalled();
    });
});
