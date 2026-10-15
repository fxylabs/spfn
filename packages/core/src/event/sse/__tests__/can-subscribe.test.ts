/**
 * SSE connect — an event declares who may subscribe (`.canSubscribe()`) and
 * the auth config resolves the principal every predicate sees.
 *
 * | #   | situation                                                       | expected                                                                 |
 * |-----|-----------------------------------------------------------------|--------------------------------------------------------------------------|
 * | S1  | auth disabled (no subject), event with `canSubscribe`           | predicate not called; every requested event allowed and delivered; deniedEvents `[]` |
 * | S2  | subject; event without `canSubscribe`                           | allowed; an emit of it is delivered                                      |
 * | S3  | subject; `canSubscribe` → `true`                                | allowed and delivered; called exactly once with `{ subject, principal, request }` |
 * | S4  | subject; `canSubscribe` → `false`                               | denied; 200, listed in deniedEvents; an emit of it delivers nothing      |
 * | S5  | subject; `canSubscribe` throws                                  | denied, its emit not delivered; warn with event name; the other event still receives its frame |
 * | S6  | subject; every requested event denied by `canSubscribe`         | open with `subscribedEvents: []`; no 403; no emit delivered              |
 * | S7  | global `authorize` returns `[]`                                 | 403, as today                                                            |
 * | S8  | `authorize` allows A and B; `canSubscribe` of B → `false`       | A allowed, B denied (B's emit not delivered)                             |
 * | S9  | `authorize` drops A; `canSubscribe` of A would be `true`        | A denied (its emit not delivered), predicate not called, listed in deniedEvents |
 * | S10 | `resolvePrincipal` set, two events with `canSubscribe`          | resolver called once; both predicates receive the identical object; an emit is delivered |
 * | S11 | `resolvePrincipal` absent                                       | `principal` is `undefined`; an emit is delivered                         |
 * | S12 | `resolvePrincipal` throws                                       | 403 `{ error: 'Principal could not be resolved' }`; nothing registered   |
 * | S13 | connect with `?events=a&workspaceId=w1`                         | `request.query.workspaceId === 'w1'`; `request.headers` names lowercased; an emit is delivered |
 * | S14 | `.canSubscribe` called twice on one event                       | throws at the second call                                                |
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import type { SubscribeContext } from '../../types';
import { closeAllStreams, createStreamApp } from './stream-harness';

vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});
import { logger } from '@spfn/core/logger';

/** Fresh events per case: `.canSubscribe()` may be called once per event. */
function events()
{
    const schema = Type.Object({ n: Type.Number() });
    const a = defineEvent('test.a', schema);
    const b = defineEvent('test.b', schema);

    return { a, b, router: defineEventRouter({ a, b }) };
}

beforeEach(() =>
{
    vi.clearAllMocks();
});

afterEach(async () =>
{
    await closeAllStreams();
});

describe('SSE connect — canSubscribe and resolvePrincipal', () =>
{
    it('S1 auth disabled: predicate not called, every requested event allowed and delivered, deniedEvents []', async () =>
    {
        const { a, router } = events();
        const predicate = vi.fn(() => false);
        a.canSubscribe(predicate);

        const stream = await createStreamApp(router, {}, false).connect(undefined, { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });

        expect(stream.status).toBe(200);
        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        expect(predicate).not.toHaveBeenCalled();
        expect(connected.data.subscribedEvents).toEqual(['a', 'b']);
        expect(connected.data.deniedEvents).toEqual([]);
    });

    it('S2 subject, event without canSubscribe: allowed', async () =>
    {
        const { a, router } = events();

        const stream = await createStreamApp(router).connect('s');
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });

        expect(connected.data.subscribedEvents).toEqual(['a']);
        expect(connected.data.deniedEvents).toEqual([]);
        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
    });

    it('S3 subject, canSubscribe true: allowed, called exactly once with { subject, principal, request }', async () =>
    {
        const { a, router } = events();
        const predicate = vi.fn(() => true);
        a.canSubscribe(predicate);

        const stream = await createStreamApp(router).connect('s');
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });

        expect(connected.data.subscribedEvents).toEqual(['a']);
        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        expect(predicate).toHaveBeenCalledTimes(1);
        expect(predicate).toHaveBeenCalledWith({
            subject: 's',
            principal: undefined,
            request: { query: expect.objectContaining({ events: 'a' }), headers: expect.any(Object) },
        });
    });

    it('S4 subject, canSubscribe false: denied, connection open, an emit of it delivers nothing', async () =>
    {
        const { a, b, router } = events();
        a.canSubscribe(() => false);

        const stream = await createStreamApp(router).connect('s', { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('b');

        expect(stream.status).toBe(200);
        expect(connected.data.subscribedEvents).toEqual(['b']);
        expect(connected.data.deniedEvents).toEqual(['a']);
        expect(stream.named('a')).toEqual([]);
    });

    it('S5 subject, canSubscribe throws: denied, warned with the event name, the other event still delivered', async () =>
    {
        const { a, b, router } = events();
        a.canSubscribe(() =>
        {
            throw new Error('lookup failed');
        });

        const stream = await createStreamApp(router).connect('s', { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });

        expect((await stream.frame('b')).data.data).toEqual({ n: 2 });
        expect(stream.named('a')).toEqual([]);
        expect(connected.data.deniedEvents).toEqual(['a']);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('canSubscribe threw'),
            expect.objectContaining({ event: 'a' }),
        );
    });

    it('S6 every requested event denied by canSubscribe: open with subscribedEvents [], no 403', async () =>
    {
        const { a, b, router } = events();
        a.canSubscribe(() => false);
        b.canSubscribe(async () => false);

        // No allowed event to use as the sentinel: the next ping is enqueued after both emits.
        const stream = await createStreamApp(router, { pingInterval: 20 }).connect('s', { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('ping');

        expect(stream.status).toBe(200);
        expect(connected.data.subscribedEvents).toEqual([]);
        expect(connected.data.deniedEvents).toEqual(['a', 'b']);
        expect(stream.frames.filter(frame => frame.event === 'a' || frame.event === 'b')).toEqual([]);
    });

    it('S7 global authorize returns []: 403 as today', async () =>
    {
        const { router } = events();

        const stream = await createStreamApp(router, { auth: { authorize: () => [] } }).connect('s');

        expect(stream.status).toBe(403);
        expect(stream.body).toEqual({ error: 'Not authorized for any requested events' });
    });

    it('S8 authorize allows A and B, canSubscribe of B false: A allowed, B denied', async () =>
    {
        const { a, b, router } = events();
        b.canSubscribe(() => false);

        const app = createStreamApp(router, { auth: { authorize: (_s, requested) => requested } });
        const stream = await app.connect('s', { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await b.emit({ n: 2 });
        await a.emit({ n: 1 });
        await stream.frame('a');

        expect(connected.data.subscribedEvents).toEqual(['a']);
        expect(connected.data.deniedEvents).toEqual(['b']);
        expect(stream.named('b')).toEqual([]);
    });

    it('S9 authorize drops A, canSubscribe of A would be true: A denied, predicate never asked', async () =>
    {
        const { a, b, router } = events();
        const predicate = vi.fn(() => true);
        a.canSubscribe(predicate);

        const app = createStreamApp(router, { auth: { authorize: () => ['b'] } });
        const stream = await app.connect('s', { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('b');

        expect(predicate).not.toHaveBeenCalled();
        expect(connected.data.subscribedEvents).toEqual(['b']);
        expect(connected.data.deniedEvents).toEqual(['a']);
        expect(stream.named('a')).toEqual([]);
    });

    it('S10 resolvePrincipal set, two predicates: resolver called once, both receive the identical object', async () =>
    {
        const { a, b, router } = events();
        const principal = { role: 'admin' };
        const resolvePrincipal = vi.fn(async () => principal);
        const seen: unknown[] = [];
        a.canSubscribe(({ principal: p }) => seen.push(p) > 0);
        b.canSubscribe(({ principal: p }) => seen.push(p) > 0);

        const app = createStreamApp(router, { auth: { resolvePrincipal } });
        const stream = await app.connect('s', { query: 'events=a,b' });
        await stream.frame('connected');
        await b.emit({ n: 1 });

        expect((await stream.frame('b')).data.data).toEqual({ n: 1 });
        expect(resolvePrincipal).toHaveBeenCalledTimes(1);
        expect(resolvePrincipal).toHaveBeenCalledWith('s', expect.objectContaining({ query: expect.any(Object) }));
        expect(seen).toHaveLength(2);
        expect(seen[0]).toBe(principal);
        expect(seen[1]).toBe(principal);
    });

    it('S11 resolvePrincipal absent: principal is undefined', async () =>
    {
        const { a, router } = events();
        const predicate = vi.fn((_ctx: SubscribeContext) => true);
        a.canSubscribe(predicate);

        const stream = await createStreamApp(router).connect('s');
        await stream.frame('connected');
        await a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        expect(predicate.mock.calls[0][0]).toHaveProperty('principal', undefined);
    });

    it('S12 resolvePrincipal throws: 403 Principal could not be resolved, no connection registered', async () =>
    {
        const { router } = events();
        const app = createStreamApp(router, {
            auth: {
                resolvePrincipal: () =>
                {
                    throw new Error('db secret detail');
                },
            },
        });

        const stream = await app.connect('s');

        expect(stream.status).toBe(403);
        expect(stream.body).toEqual({ error: 'Principal could not be resolved' });
        expect(app.handler._openConnections('s')).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { subject: 's' });
    });

    it('S13 the predicate sees request.query.workspaceId and lowercased header names', async () =>
    {
        const { a, router } = events();
        const predicate = vi.fn((_ctx: SubscribeContext) => true);
        a.canSubscribe(predicate);

        const stream = await createStreamApp(router).connect('s', {
            query: 'events=a&workspaceId=w1',
            headers: { 'X-Workspace-Hint': 'w1' },
        });
        await stream.frame('connected');
        await a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        const { request } = predicate.mock.calls[0][0];
        expect(request.query.workspaceId).toBe('w1');
        expect(request.headers['x-workspace-hint']).toBe('w1');
        expect(Object.keys(request.headers).every(name => name === name.toLowerCase())).toBe(true);
    });

    it('S14 .canSubscribe called twice on one event throws at the second call', () =>
    {
        const { a } = events();
        a.canSubscribe(() => true);

        expect(() => a.canSubscribe(() => false)).toThrow(/already declares \.canSubscribe\(\)/);
    });
});
