/**
 * SSE client — a token mint answered 401 stops the client (#153).
 *
 * The server closes the stream of a revoked device key; the client's reconnect
 * then mints a token, which the revoked session cannot get. Retrying would mint
 * and fail every `reconnectDelay` forever, so a 401 is final.
 *
 * | #    | state                    | action                                                       | expected                                                         |
 * |------|--------------------------|--------------------------------------------------------------|------------------------------------------------------------------|
 * | R15  | stream closed by server  | reconnect's `acquireToken` rejects with `statusCode: 401` (`UnauthorizedError`) | no further `connect`, `onClose('unauthorized')` once, state `closed` |
 * | R15' | same                     | rejects with the api client's generic `ApiError`, `status: 401` | the same                                                       |
 * | R15''| `createAuthSSEClient`    | the token route answers 401                                  | the same                                                         |
 * | R16  | same                     | rejects with `statusCode: 500`                               | reconnect after `reconnectDelay` as today; `onClose` not called  |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import { createAuthSSEClient, createSSEClient } from '../client';
import { InternalServerError, UnauthorizedError } from '../../../errors/http-errors';
import { ApiError } from '../../../nextjs/client/errors';
import { FakeEventSource } from './fake-event-source';

const router = defineEventRouter({ e: defineEvent('test.unauthorized.e', Type.Object({ n: Type.Number() })) });

const RECONNECT_DELAY = 10;

/** Long enough for several reconnect delays to pass. */
const wait = (ms = RECONNECT_DELAY * 5) => new Promise(resolve => setTimeout(resolve, ms));

/** Open the first stream, then drop it as a server-side close does: the client's reconnect takes over. */
async function openThenDrop(): Promise<void>
{
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.last.open();
    FakeEventSource.last.fail();
}

/** A client whose first mint succeeds and whose next mints reject with `error`. */
function subscribeMintingThen(error: unknown)
{
    const acquireToken = vi.fn().mockResolvedValueOnce('first-token').mockRejectedValue(error);
    const onClose = vi.fn();
    const onReconnect = vi.fn();
    const client = createSSEClient<typeof router>({ url: 'http://test/stream', reconnectDelay: RECONNECT_DELAY, acquireToken });
    client.subscribe({ events: ['e'], handlers: {}, onClose, onReconnect });

    return { client, acquireToken, onClose, onReconnect };
}

beforeEach(() =>
{
    FakeEventSource.install();
});

afterEach(() =>
{
    vi.unstubAllGlobals();
    FakeEventSource.uninstall();
});

describe('SSE client — a 401 token mint is final', () =>
{
    it('R15 the reconnect mint rejects with statusCode 401: no further connect, onClose(\'unauthorized\') once, state closed', async () =>
    {
        const { client, acquireToken, onClose } = subscribeMintingThen(new UnauthorizedError());

        await openThenDrop();
        await wait();

        expect(acquireToken).toHaveBeenCalledTimes(2);
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledWith('unauthorized');
        expect(client.getState()).toBe('closed');
    });

    it('R15\' the reconnect mint rejects with the api client\'s ApiError status 401: the same', async () =>
    {
        const { client, acquireToken, onClose } = subscribeMintingThen(new ApiError('Unauthorized', 401, '/api/rpc/eventsToken', undefined, 'http'));

        await openThenDrop();
        await wait();

        expect(acquireToken).toHaveBeenCalledTimes(2);
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(onClose.mock.calls).toEqual([['unauthorized']]);
        expect(client.getState()).toBe('closed');
    });

    it('R15\'\' createAuthSSEClient: the token route answering 401 stops it the same way', async () =>
    {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'first-token' }), { status: 200 }))
            .mockResolvedValue(new Response(JSON.stringify({ error: 'Unable to identify subject' }), { status: 401 }));
        vi.stubGlobal('fetch', fetch);
        const onClose = vi.fn();
        const client = createAuthSSEClient<typeof router>({ url: 'http://test/stream', reconnectDelay: RECONNECT_DELAY });
        client.subscribe({ events: ['e'], handlers: {}, onClose });

        await openThenDrop();
        await wait();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(onClose.mock.calls).toEqual([['unauthorized']]);
        expect(client.getState()).toBe('closed');
    });

    it('R16 the reconnect mint rejects with statusCode 500: it reconnects after reconnectDelay as before, onClose not called', async () =>
    {
        const { client, acquireToken, onClose, onReconnect } = subscribeMintingThen(new InternalServerError());
        acquireToken.mockRejectedValueOnce(new InternalServerError()).mockResolvedValue('third-token');

        await openThenDrop();
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

        expect(acquireToken).toHaveBeenCalledTimes(3);
        expect(onReconnect.mock.calls).toEqual([[1], [2]]);
        expect(onClose).not.toHaveBeenCalled();
        expect(client.getState()).toBe('connecting');
        client.close();
    });
});
