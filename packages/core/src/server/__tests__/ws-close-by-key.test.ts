/**
 * The WebSocket token endpoint `startServer` registers tags its tokens with
 * the device key, so a key close reaches the sockets they open.
 *
 * Through `startServer` with `.websockets(router, { auth: { enabled: true } })`
 * and an app middleware that sets `c.get('auth')` (`userId`, `keyId`) from a
 * request header — the default `getKeyId` / `getKeyHolder`:
 *
 * | #   | state                                          | action                       | expected                                                           |
 * |-----|------------------------------------------------|------------------------------|--------------------------------------------------------------------|
 * | W1  | sockets of K1 and K2, tokens from `POST /token` | `closeConnectionsByKey(K1)`  | K1's socket closes 1008 `Key revoked`; K2's stays open and receives |
 * | W1' | after W1                                       | the server shuts down        | the process-wide set of stream indexes is back to its size before start |
 */

import { createServer as createNetServer } from 'node:net';
import { Type } from '@sinclair/typebox';
import type { Context, Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@spfn/core/cache', () => ({ getCache: () => undefined, isCacheDisabled: () => true }));

import { defineEvent } from '../../event/event';
import { defineWSRouter } from '../../event/ws';
import { closeConnectionsByKey } from '../../event/close-by-key';
import { defineMiddleware } from '../../route/define-middleware';
import { defineServerConfig } from '../config-builder';
import { startServer } from '../start-server';
import type { ServerInstance } from '../types';

interface Socket
{
    frames: { type: string; data: unknown }[];
    closed: Promise<{ code: number; reason: string }>;
    isClosed: () => boolean;
}

/** The process-wide set of stream indexes `applyKeyClose` reaches (`event/key-close`). */
const streamIndexes = (): Set<unknown> => (globalThis as any)[Symbol.for('@spfn/core:event-streams-by-key')] ?? new Set();

/** The app's authentication: `x-test-auth: <userId>:<keyId>` → `c.get('auth')`. */
const testAuth = defineMiddleware('testAuth', async (c: Context, next: Next) =>
{
    const [userId, keyId] = (c.req.header('x-test-auth') ?? '').split(':');
    if (userId)
    {
        c.set('auth' as never, { userId, keyId } as never);
    }

    await next();
});

async function freePort(): Promise<number>
{
    const probe = createNetServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise(resolve => probe.close(resolve));

    return port;
}

async function until(condition: () => boolean): Promise<void>
{
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
    {
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    expect(condition()).toBe(true);
}

describe('the WebSocket token endpoint of startServer tags its tokens with the device key', () =>
{
    let instance: ServerInstance | undefined;
    let port: number;
    const update = defineEvent('ws-close-by-key.update', Type.Object({ n: Type.Number() }));
    const sockets: WebSocket[] = [];

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
    });

    afterEach(async () =>
    {
        sockets.forEach(socket => socket.close());
        await instance?.close();
        instance = undefined;
        vi.unstubAllEnvs();
    });

    async function mintToken(userId: string, keyId: string): Promise<string>
    {
        const response = await fetch(`http://127.0.0.1:${port}/token`, {
            method: 'POST',
            headers: { 'x-test-auth': `${userId}:${keyId}` },
        });
        expect(response.status).toBe(200);

        return (await response.json() as { token: string }).token;
    }

    function open(token: string): Socket
    {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?events=update&token=${token}`);
        const frames: Socket['frames'] = [];
        let isClosed = false;
        sockets.push(ws);
        ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))));

        return {
            frames,
            isClosed: () => isClosed,
            closed: new Promise((resolve) =>
            {
                ws.addEventListener('close', (event) =>
                {
                    isClosed = true;
                    resolve({ code: event.code, reason: event.reason });
                });
            }),
        };
    }

    it('W1 closeConnectionsByKey(K1) closes K1\'s socket 1008 Key revoked; K2\'s stays open; W1\' after shutdown the index set is back to its size', async () =>
    {
        const indexesBefore = streamIndexes().size;
        port = await freePort();
        instance = await startServer(defineServerConfig()
            .host('127.0.0.1')
            .port(port)
            .infrastructure({ database: false, redis: false })
            .middlewares([testAuth])
            .websockets(defineWSRouter({ events: { update } }), { auth: { enabled: true } })
            .build());

        const k1 = open(await mintToken('7', 'K1'));
        const k2 = open(await mintToken('7', 'K2'));
        await until(() => k1.frames.length > 0 && k2.frames.length > 0);

        await closeConnectionsByKey('K1');

        expect(await k1.closed).toEqual({ code: 1008, reason: 'Key revoked' });
        await update.emit({ n: 1 });
        await until(() => k2.frames.some(frame => frame.type === 'update'));
        expect(k2.isClosed()).toBe(false);

        await instance.close();
        instance = undefined;
        await k2.closed;
        await until(() => streamIndexes().size === indexesBefore);
    });
});
