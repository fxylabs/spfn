/**
 * SSE connect — an event declares the frames a connection receives right after
 * `connected` (`.initial()`), written before any live frame.
 *
 * | #   | situation                                                  | expected                                                                 |
 * |-----|------------------------------------------------------------|--------------------------------------------------------------------------|
 * | E1  | `defineEvent(...).initial(p)`                              | `_initial` is `p`; a second `.initial()` throws naming the event         |
 * | E2  | a plain event without `.initial()` on a connection         | `connected.initial` is `[]`; no extra frame                              |
 * | E3  | an event with `.initial()` returning two payloads          | both written after `connected` with consecutive `messageId`s, before any live frame |
 * | E4  | the producer throws                                        | warn naming the event; `connected.initial` omits it; the other events' frames written; the stream stays open and live frames flow |
 * | E5  | an `emit` of that event while the producer is awaiting     | the live frame is written after `connected` and after the initial frames |
 * | E5' | a `revoke` while the producer is awaiting                  | `connected` (listing it subscribed), its initial frame, then `subscription.revoked`; a later emit delivers nothing |
 * | E5''| the client leaves while the producer is awaiting           | the producer settles into a dead connection: nothing written, no rejection, no connection left registered |
 * | E6  | connection without a subject (no auth)                     | `initial: []`; no producer called                                        |
 * | E7  | event denied by `canSubscribe`                             | no producer called; it is in `deniedEvents`, not in `initial`            |
 * | E8  | `grant` after connect                                      | as today: the subscription opens; no initial frame                       |
 * | E9  | `resolvePrincipal` returns `{ role: 'admin' }`             | the producer's `ctx.principal` deep-equals it; `ctx.subject` is the connection's |
 * | E10 | a hung producer, `maxQueue: 3`, 30 spaced live emits       | the held frames count against `maxQueue`: the connection is closed       |
 * | E10b| E10's emits with no producer                               | a fast client stays open                                                 |
 * | E11 | `maxQueue: 10`, 5 spaced emits held, then the producer answers one frame | the client stays open and receives 6 frames of `a` after `connected` |
 * | E12 | `pingInterval: 5`, a producer that waits 30 ms             | the ping is held: the first frame is `connected`                         |
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import { closeAllStreams, createStreamApp, until } from './stream-harness';

vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});
import { logger } from '@spfn/core/logger';

/** `count` live emits of `a`, 2 ms apart, so the writer drains between them. */
async function spacedEmits(a: { emit: (payload: { n: number }) => Promise<void> }, count: number): Promise<void>
{
    for (let n = 0; n < count; n++)
    {
        await a.emit({ n });
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

/** A producer that answers only when the test calls `answer`. */
function waitingProducer()
{
    let answer: (payloads: { n: number }[]) => void = () => undefined;
    const producer = vi.fn(() => new Promise<{ n: number }[]>(resolve =>
    {
        answer = resolve;
    }));

    return { producer, answer: (payloads: { n: number }[]) => answer(payloads) };
}

/** Fresh events per case: `.initial()` may be called once per event. */
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

describe('SSE connect — initial frames', () =>
{
    it('E1 .initial(p) sets _initial to p; a second .initial() throws naming the event', () =>
    {
        const { a } = events();
        const producer = () => [{ n: 1 }];

        a.initial(producer);

        expect(a._initial).toBe(producer);
        expect(() => a.initial(() => [])).toThrow(/Event "test\.a" already declares \.initial\(\)/);
    });

    it('E2 a plain event: connected.initial is [], no extra frame', async () =>
    {
        const { a, router } = events();

        const stream = await createStreamApp(router).connect('s');
        const connected = await stream.frame('connected');
        await a.emit({ n: 1 });
        await stream.frame('a');

        expect(connected.data.initial).toEqual([]);
        expect(stream.frames.map(frame => [frame.event, frame.id])).toEqual([['connected', undefined], ['a', '1']]);
    });

    it('E3 two initial payloads: written after connected with consecutive messageIds, before a live frame', async () =>
    {
        const { a, router } = events();
        a.initial(() => [{ n: 1 }, { n: 2 }]);

        const stream = await createStreamApp(router).connect('s');
        const connected = await stream.frame('connected');
        await stream.frame('a', 2);
        await a.emit({ n: 3 });
        await stream.frame('a', 3);

        expect(connected.data.initial).toEqual(['a']);
        expect(stream.frames.map(frame => [frame.event, frame.id, frame.data.data])).toEqual([
            ['connected', undefined, undefined],
            ['a', '1', { n: 1 }],
            ['a', '2', { n: 2 }],
            ['a', '3', { n: 3 }],
        ]);
    });

    it('E4 a producer that throws: warned with the event name, left out of initial; the rest written; live frames flow', async () =>
    {
        const { a, b, router } = events();
        a.initial(() =>
        {
            throw new Error('db secret detail');
        });
        b.initial(async () => [{ n: 9 }]);

        const stream = await createStreamApp(router).connect('s', { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await stream.frame('b');
        await a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
        expect(connected.data.initial).toEqual(['b']);
        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', 'b', 'a']);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('initial frames could not be produced'), { event: 'a', subject: 's' });
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('db secret detail');
    });

    it('E5 an emit while the producer is awaiting: written after connected and after the initial frames', async () =>
    {
        const { a, router } = events();
        let answer: (payloads: { n: number }[]) => void = () => undefined;
        const producer = vi.fn(() => new Promise<{ n: number }[]>(resolve =>
        {
            answer = resolve;
        }));
        a.initial(producer);

        const stream = await createStreamApp(router).connect('s');
        await until(() => producer.mock.calls.length === 1);
        await a.emit({ n: 5 });
        answer([{ n: 1 }]);
        await stream.frame('a', 2);

        expect(stream.frames.map(frame => [frame.event, frame.id, frame.data.data])).toEqual([
            ['connected', undefined, undefined],
            ['a', '1', { n: 1 }],
            ['a', '2', { n: 5 }],
        ]);
    });

    it('E5\' a revoke while the producer is awaiting: connected, the initial frame, then subscription.revoked; nothing after', async () =>
    {
        const { a, b, router } = events();
        let answer: (payloads: { n: number }[]) => void = () => undefined;
        const producer = vi.fn(() => new Promise<{ n: number }[]>(resolve =>
        {
            answer = resolve;
        }));
        a.initial(producer);

        const stream = await createStreamApp(router).connect('s', { query: 'events=a,b' });
        await until(() => producer.mock.calls.length === 1);
        await a.revoke('s');
        await a.emit({ n: 5 });
        answer([{ n: 1 }]);
        await stream.frame('subscription.revoked');
        await a.emit({ n: 6 });
        await b.emit({ n: 7 });
        await stream.frame('b');

        expect((await stream.frame('connected')).data.subscribedEvents).toEqual(['a', 'b']);
        expect(stream.frames.map(frame => [frame.event, frame.data.data])).toEqual([
            ['connected', undefined],
            ['a', { n: 1 }],
            ['subscription.revoked', undefined],
            ['b', { n: 7 }],
        ]);
    });

    it('E5\'\' the client leaves while the producer is awaiting: nothing written, nothing left registered', async () =>
    {
        const { a, router } = events();
        let answer: (payloads: { n: number }[]) => void = () => undefined;
        const producer = vi.fn(() => new Promise<{ n: number }[]>(resolve =>
        {
            answer = resolve;
        }));
        a.initial(producer);
        const app = createStreamApp(router);

        const stream = await app.connect('s');
        await until(() => producer.mock.calls.length === 1);
        await stream.close();
        answer([{ n: 1 }]);
        await new Promise(resolve => setImmediate(resolve));

        expect(stream.frames).toEqual([]);
        expect(app.handler._openConnections('s')).toBe(0);
    });

    it('E6 a connection without a subject: initial [], no producer called', async () =>
    {
        const { a, router } = events();
        const producer = vi.fn(() => [{ n: 1 }]);
        a.initial(producer);

        const stream = await createStreamApp(router, {}, false).connect(undefined);
        const connected = await stream.frame('connected');
        await a.emit({ n: 2 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 2 });
        expect(connected.data.initial).toEqual([]);
        expect(producer).not.toHaveBeenCalled();
    });

    it('E7 an event canSubscribe denies: no producer called; in deniedEvents, not in initial', async () =>
    {
        const { a, b, router } = events();
        const producer = vi.fn(() => [{ n: 1 }]);
        a.canSubscribe(() => false).initial(producer);
        b.initial(() => [{ n: 2 }]);

        const stream = await createStreamApp(router).connect('s', { query: 'events=a,b' });
        const connected = await stream.frame('connected');
        await stream.frame('b');

        expect(producer).not.toHaveBeenCalled();
        expect(connected.data.deniedEvents).toEqual(['a']);
        expect(connected.data.initial).toEqual(['b']);
        expect(stream.named('a')).toEqual([]);
    });

    it('E8 a grant after connect opens the subscription as today, with no initial frame', async () =>
    {
        const { a, router } = events();
        const producer = vi.fn(() => [{ n: 1 }]);
        a.canSubscribe(() => false).initial(producer);

        const stream = await createStreamApp(router).connect('s');
        await stream.frame('connected');
        await a.grant('s');
        await stream.frame('subscription.granted');
        await a.emit({ n: 2 });
        await stream.frame('a');

        expect(producer).not.toHaveBeenCalled();
        expect(stream.frames.map(frame => [frame.event, frame.data.data])).toEqual([
            ['connected', undefined],
            ['subscription.granted', undefined],
            ['a', { n: 2 }],
        ]);
    });

    it('E9 the producer receives the resolved principal and the connection\'s subject', async () =>
    {
        const { a, router } = events();
        const seen: { subject?: string; principal: unknown }[] = [];
        a.initial((ctx) =>
        {
            seen.push(ctx);

            return [];
        });

        const app = createStreamApp(router, { auth: { resolvePrincipal: async () => ({ role: 'admin' }) } });
        await (await app.connect('s')).frame('connected');

        expect(seen).toHaveLength(1);
        expect(seen[0].principal).toEqual({ role: 'admin' });
        expect(seen[0].subject).toBe('s');
    });

    it('E10 a hung producer: held live frames count against maxQueue, and the connection is closed', async () =>
    {
        const { a, router } = events();
        const { producer } = waitingProducer();
        a.initial(producer);
        const app = createStreamApp(router, { maxQueue: 3 });

        await app.connect('s');
        await until(() => producer.mock.calls.length === 1);
        await spacedEmits(a, 30);

        expect(app.handler._openConnections('s')).toBe(0);
    });

    it('E10b the same emits with no producer keep a fast client open', async () =>
    {
        const { a, router } = events();
        const app = createStreamApp(router, { maxQueue: 3 });

        const stream = await app.connect('s');
        await stream.frame('connected');
        await spacedEmits(a, 30);
        await stream.frame('a', 30);

        expect(app.handler._openConnections('s')).toBe(1);
    });

    it('E11 frames held within maxQueue are released to a fast client, which stays open', async () =>
    {
        const { a, router } = events();
        const { producer, answer } = waitingProducer();
        a.initial(producer);
        const app = createStreamApp(router, { maxQueue: 10 });

        const stream = await app.connect('s');
        await until(() => producer.mock.calls.length === 1);
        await spacedEmits(a, 5);
        answer([{ n: 99 }]);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(app.handler._openConnections('s')).toBe(1);
        expect(stream.frames[0].event).toBe('connected');
        expect(stream.named('a')).toHaveLength(6);
    });

    it('E12 a ping while the producer is awaiting is held: the first frame is connected', async () =>
    {
        const { a, router } = events();
        a.initial(async () =>
        {
            await new Promise(resolve => setTimeout(resolve, 30));

            return [];
        });

        const stream = await createStreamApp(router, { pingInterval: 5 }).connect('s');
        await stream.frame('connected');

        expect(stream.frames[0].event).toBe('connected');
    });
});
