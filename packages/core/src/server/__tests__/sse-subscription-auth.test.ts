/**
 * `.events()` carries the per-event subscription checks to the SSE handler.
 *
 * | #  | situation                                                         | expected                                             |
 * |----|-------------------------------------------------------------------|------------------------------------------------------|
 * | B1 | `.events(router, { auth: { enabled: true, resolvePrincipal } })`  | typed; the resolver reaches the handler (S10 through the server); the allowed event is delivered, the denied one is not |
 * | B2 | `.events(router)` with no auth                                    | S1 through the server; an emit is delivered          |
 * | R7 | `getKeyId` unset, `auth` has no `keyId`                           | the token is untagged; no key close ever ends the stream |
 * | R7'| `getKeyId` unset, no `auth` at all (`getSubject` from the app)     | the token is issued, untagged                        |
 * | R7''| `getKeyId` unset, `auth.keyId` set                               | the token carries that `keyId`                       |
 * | R8 | `getKeyId` returns `''`                                           | the token has no `keyId`; consume runs no `verifyKey` |
 */

import { Type } from '@sinclair/typebox';
import type { Context, Next } from 'hono';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { defineEvent } from '../../event/event';
import { defineEventRouter } from '../../event/router';
import type { SubscribeRequest } from '../../event/types';
import { SSETokenManager } from '../../event/sse/token-manager';
import { applyKeyClose } from '../../event/sse/key-close';
import { closeAllStreams, openStream } from '../../event/sse/__tests__/stream-harness';
import { defineServerConfig } from '../config-builder';
import { defineMiddleware } from '../../route/define-middleware';
import { createServer } from '../create-server';

type EventsOptions = Parameters<ReturnType<typeof defineServerConfig>['events']>[1];

/** Fresh events per case: `.canSubscribe()` may be called once per event. */
function eventRouter()
{
    const schema = Type.Object({ n: Type.Number() });

    return defineEventRouter({
        a: defineEvent('server.a', schema),
        b: defineEvent('server.b', schema),
    });
}

function serve(router: ReturnType<typeof eventRouter>, options?: EventsOptions)
{
    return createServer(defineServerConfig()
        .infrastructure({ database: false, redis: false })
        .events(router, options)
        .build());
}

afterEach(async () =>
{
    await closeAllStreams();
});

describe('.events() carries canSubscribe and resolvePrincipal to the stream', () =>
{
    it('B1 a typed resolvePrincipal reaches the handler: called once, both predicates get its object, a allowed and delivered, b denied', async () =>
    {
        const router = eventRouter();
        const principal = { role: 'admin' };
        const resolvePrincipal = vi.fn(async (subject: string, request: SubscribeRequest) =>
        {
            expectTypeOf(subject).toEqualTypeOf<string>();
            expectTypeOf(request).toEqualTypeOf<SubscribeRequest>();

            return principal;
        });
        const seen: unknown[] = [];
        router.events.a.canSubscribe(({ principal: p }) => seen.push(p) > 0);
        router.events.b.canSubscribe(({ principal: p }) => seen.push(p) < 0);
        const tokenManager = new SSETokenManager({ ttl: 5000 });

        const app = await serve(router, { auth: { enabled: true, tokenManager, resolvePrincipal } });
        const token = await tokenManager.issue('s');
        const stream = await openStream(app, `/events/stream?events=a,b&token=${token}`);
        const connected = await stream.frame('connected');
        await router.events.b.emit({ n: 2 });
        await router.events.a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        expect(stream.named('b')).toEqual([]);
        expect(connected.data.subscribedEvents).toEqual(['a']);
        expect(connected.data.deniedEvents).toEqual(['b']);
        expect(resolvePrincipal).toHaveBeenCalledTimes(1);
        expect(seen).toHaveLength(2);
        expect(seen[0]).toBe(principal);
        expect(seen[1]).toBe(principal);
        tokenManager.destroy();
    });

    it('B2 without auth the predicate is not called and every requested event is allowed', async () =>
    {
        const router = eventRouter();
        const predicate = vi.fn(() => false);
        router.events.a.canSubscribe(predicate);

        const app = await serve(router);
        const stream = await openStream(app, '/events/stream?events=a,b');
        const connected = await stream.frame('connected');
        await router.events.a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        expect(predicate).not.toHaveBeenCalled();
        expect(connected.data.subscribedEvents).toEqual(['a', 'b']);
        expect(connected.data.deniedEvents).toEqual([]);
    });
});

describe('the token endpoint tags a token with the caller\'s device key', () =>
{
    /** A server whose middleware sets `auth` to `principal` (none when `undefined`) before the token endpoint. */
    function serveAs(router: ReturnType<typeof eventRouter>, principal: Record<string, string> | undefined, options: EventsOptions)
    {
        const setAuth = async (c: Context, next: Next) =>
        {
            if (principal)
            {
                c.set('auth' as never, principal as never);
            }

            await next();
        };

        return createServer(defineServerConfig()
            .infrastructure({ database: false, redis: false })
            .middlewares([defineMiddleware('testAuth', setAuth)])
            .events(router, options)
            .build());
    }

    async function mint(app: Awaited<ReturnType<typeof serve>>): Promise<string>
    {
        const response = await app.request('/events/token', { method: 'POST' });
        expect(response.status).toBe(200);

        return (await response.json()).token;
    }

    it('R7 getKeyId unset and auth without keyId: the token is untagged, and no key close ends its stream', async () =>
    {
        const router = eventRouter();
        const tokenManager = new SSETokenManager({ ttl: 5000 });
        const app = await serveAs(router, { userId: 'u' }, { auth: { enabled: true, tokenManager } });

        const stream = await openStream(app, `/events/stream?events=a&token=${await mint(app)}`);
        await stream.frame('connected');
        applyKeyClose('undefined');
        applyKeyClose('null');
        applyKeyClose('service');
        await router.events.a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        expect(stream.ended()).toBe(false);
        tokenManager.destroy();
    });

    it('R7\' getKeyId unset and no auth at all: the default tolerates it, the token is issued untagged', async () =>
    {
        const tokenManager = new SSETokenManager({ ttl: 5000 });
        const app = await serveAs(eventRouter(), undefined, { auth: { enabled: true, tokenManager, getSubject: () => 'u' } });

        expect(await tokenManager.consume(await mint(app))).toEqual({ subject: 'u', expiresAt: expect.any(Number) });
        tokenManager.destroy();
    });

    it('R7\'\' getKeyId unset and auth.keyId set: the token carries that keyId', async () =>
    {
        const tokenManager = new SSETokenManager({ ttl: 5000 });
        const app = await serveAs(eventRouter(), { userId: 'u', keyId: 'K1' }, { auth: { enabled: true, tokenManager } });

        expect(await tokenManager.consume(await mint(app))).toMatchObject({ subject: 'u', keyId: 'K1' });
        tokenManager.destroy();
    });

    it('R8 getKeyId returns an empty string: the token has no keyId, and consume runs no verifyKey', async () =>
    {
        const verifyKey = vi.fn(() => false);
        const tokenManager = new SSETokenManager({ ttl: 5000, verifyKey });
        const app = await serveAs(eventRouter(), { userId: 'u', keyId: 'K1' }, { auth: { enabled: true, tokenManager, getKeyId: () => '' } });

        const consumed = await tokenManager.consume(await mint(app));

        expect(consumed).toEqual({ subject: 'u', expiresAt: expect.any(Number) });
        expect(verifyKey).not.toHaveBeenCalled();
        tokenManager.destroy();
    });
});
