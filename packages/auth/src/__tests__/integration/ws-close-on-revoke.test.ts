/**
 * @spfn/auth - a revoked key's WebSockets close (au1-B5)
 *
 * The production path end to end: two signed-in device keys of one account
 * each mint a one-time token at `/_auth/tokens` and open a WebSocket on core's
 * handler sharing auth's token manager; then `POST /_auth/keys/revoke` revokes
 * the first key, which ends in `closeConnectionsByKey` after the commit.
 *
 * | #  | path                                                   | expected                                                                 |
 * |----|--------------------------------------------------------|--------------------------------------------------------------------------|
 * | T5 | revoke K1 while K1 and K2 each hold a socket           | K1's socket closed with 1008 `Key revoked` and receives nothing published afterwards; K2's socket open and receives it; a token K1 minted before the revoke cannot connect (4001) |
 *
 * The cross-pod half is the same `applyKeyClose` the cache transport calls for
 * a close another pod published — core's close-by-key R11 drives that path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { Type } from '@sinclair/typebox';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';
import { authenticate } from '@/server/middleware/authenticate';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { settleLinkMail } = await import('@/server/lib/link-mail-delivery');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { defineEvent, defineWSRouter } = await import('@spfn/core/event');
const { attachWSHandler } = await import('@spfn/core/event/ws');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { initOneTimeTokenManager, getOneTimeTokenManager } = await import('@/server/lib/one-time-token');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';
const CLIENT_IP = '198.51.100.31';

const update = defineEvent('test.ws.revoke.update', Type.Object({ n: Type.Number() }));
const wsRouter = defineWSRouter({ events: { update } });

/** One client socket, with every frame it received and how it closed. */
interface Socket
{
    frames: { type: string; data: unknown }[];
    closed: Promise<{ code: number; reason: string }>;
    isClosed: () => boolean;
}

describe.skipIf(!dbAvailable)('a revoked key\'s WebSockets close (T5)', () =>
{
    let app: Hono;
    let server: Server;
    let closeWS: () => Promise<void>;
    const sockets: WebSocket[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        initOneTimeTokenManager();

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());

        server = createServer();
        closeWS = await attachWSHandler(server, wsRouter, { auth: { enabled: true } }, getOneTimeTokenManager());
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    });

    afterAll(async () =>
    {
        sockets.forEach(socket => socket.close());
        await closeWS();
        await new Promise(resolve => server.close(resolve));
        getOneTimeTokenManager().destroy();
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
    });

    async function post(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': CLIENT_IP };
        if (authorization)
        {
            headers.Authorization = authorization;
        }

        const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
        await settleLinkMail();

        return response;
    }

    /** Sign in a new device of `email`; answers its key id and a request signer. */
    async function signIn(email: string): Promise<{ keyId: string; authorization: () => string }>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });
        expect(response.status).toBe(200);

        return {
            keyId: key.keyId,
            authorization: () => `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256')}`,
        };
    }

    async function mintToken(authorization: string): Promise<string>
    {
        const response = await post('/_auth/tokens', {}, authorization);
        expect(response.status).toBe(200);

        return (await response.json()).token;
    }

    function open(token: string): Socket
    {
        const { port } = server.address() as AddressInfo;
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

    async function until(condition: () => boolean): Promise<void>
    {
        for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
        {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        expect(condition()).toBe(true);
    }

    const received = (socket: Socket) => socket.frames.filter(frame => frame.type === 'update');

    it('T5 revoking K1 closes K1\'s socket (1008 Key revoked) and nothing more reaches it; K2\'s stays open; K1\'s earlier token cannot connect', async () =>
    {
        const role = await getRoleByName('user');
        await getTestDb().insert(users).values({
            email: 't5@example.com',
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: role!.id,
        });
        const k1 = await signIn('t5@example.com');
        const k2 = await signIn('t5@example.com');
        const k1Socket = open(await mintToken(k1.authorization()));
        const k2Socket = open(await mintToken(k2.authorization()));
        const k1Spare = await mintToken(k1.authorization());
        await until(() => k1Socket.frames.length > 0 && k2Socket.frames.length > 0);

        expect((await post('/_auth/keys/revoke', { keyId: k1.keyId }, k2.authorization())).status).toBe(200);

        expect(await k1Socket.closed).toEqual({ code: 1008, reason: 'Key revoked' });
        await update.emit({ n: 1 });
        await until(() => received(k2Socket).length === 1);
        expect(received(k2Socket)[0].data).toEqual({ n: 1 });
        expect(received(k1Socket)).toEqual([]);
        expect(k2Socket.isClosed()).toBe(false);
        expect(await open(k1Spare).closed).toEqual({ code: 4001, reason: 'Invalid or expired token' });
    });
});
