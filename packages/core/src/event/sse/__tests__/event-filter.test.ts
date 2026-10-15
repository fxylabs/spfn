/**
 * SSE frames — an event declares which frames a connection receives (`.filter()`).
 *
 * | #  | situation                                                    | expected                                                   |
 * |----|--------------------------------------------------------------|------------------------------------------------------------|
 * | F1 | per-event `filter` → `true`                                  | frame sent                                                 |
 * | F1'| partner: per-event `filter` → `false`                        | frame not sent                                             |
 * | F2 | per-event `filter` → `false`                                 | frame not sent; connection alive; next matching frame sent |
 * | F3 | per-event `filter` throws                                    | frame not sent; warn; connection alive                     |
 * | F4 | global `filter` map `true`, per-event `false` (and reverse)  | not sent in both orders; both `true` → sent                |
 * | F4'| partner of both `true`: same global map, per-event `false`   | not sent — the global `true` does not override it          |
 * | F5 | auth disabled (no subject), per-event `filter`               | runs with `subject: undefined`; matches `request.query`    |
 * | F6 | event denied at connect, per-event `filter`                  | never called                                               |
 * | F7 | `.filter` called twice                                       | throws at the second call                                  |
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import { closeAllStreams, createStreamApp } from './stream-harness';

vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});
import { logger } from '@spfn/core/logger';

/** Fresh events per case: `.filter()` may be called once per event. `b` is the sentinel. */
function events()
{
    const schema = Type.Object({ n: Type.Number(), ws: Type.Optional(Type.String()) });
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

describe('SSE frames — per-event filter', () =>
{
    it('F1 per-event filter true: frame sent', async () =>
    {
        const { a, router } = events();
        a.filter(() => true);

        const stream = await createStreamApp(router).connect('s');
        await stream.frame('connected');
        await a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
    });

    it('F1\' partner: per-event filter false: frame not sent', async () =>
    {
        const { a, b, router } = events();
        a.filter(() => false);

        const stream = await createStreamApp(router).connect('s', { query: 'events=a,b' });
        await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('b');

        expect(stream.named('a')).toEqual([]);
    });

    it('F2 per-event filter false: frame not sent, connection alive, next matching frame sent', async () =>
    {
        const { a, router } = events();
        a.filter(payload => payload.n === 2);

        const stream = await createStreamApp(router).connect('s');
        await stream.frame('connected');
        await a.emit({ n: 1 });
        await a.emit({ n: 2 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 2 });
        expect(stream.named('a')).toHaveLength(1);
    });

    it('F3 per-event filter throws: frame not sent, warned, connection alive', async () =>
    {
        const { a, router } = events();
        a.filter((payload) =>
        {
            if (payload.n === 1)
            {
                throw new Error('bad payload');
            }

            return true;
        });

        const stream = await createStreamApp(router).connect('s');
        await stream.frame('connected');
        await a.emit({ n: 1 });
        await a.emit({ n: 2 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 2 });
        expect(stream.named('a')).toHaveLength(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('filter threw'),
            expect.objectContaining({ event: 'a' }),
        );
    });

    it('F4 global filter true, per-event false: not sent', async () =>
    {
        const { a, b, router } = events();
        a.filter(() => false);

        const stream = await createStreamApp(router, { auth: { filter: { a: () => true } } })
            .connect('s', { query: 'events=a,b' });
        await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('b');

        expect(stream.named('a')).toEqual([]);
    });

    it('F4 global filter false, per-event true: not sent', async () =>
    {
        const { a, b, router } = events();
        a.filter(() => true);

        const stream = await createStreamApp(router, { auth: { filter: { a: () => false } } })
            .connect('s', { query: 'events=a,b' });
        await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('b');

        expect(stream.named('a')).toEqual([]);
    });

    it('F4 global filter and per-event filter both true: sent', async () =>
    {
        const { a, router } = events();
        a.filter(() => true);

        const stream = await createStreamApp(router, { auth: { filter: { a: () => true } } }).connect('s');
        await stream.frame('connected');
        await a.emit({ n: 1 });

        expect((await stream.frame('a')).data.data).toEqual({ n: 1 });
    });

    it('F4\' partner of both true: the same global true with a per-event false drops the frame', async () =>
    {
        const { a, b, router } = events();
        a.filter(() => false);

        const stream = await createStreamApp(router, { auth: { filter: { a: () => true, b: () => true } } })
            .connect('s', { query: 'events=a,b' });
        await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('b');

        expect(stream.named('a')).toEqual([]);
    });

    it('F5 auth disabled: the filter runs with subject undefined and matches request.query', async () =>
    {
        const { a, router } = events();
        const subjects: unknown[] = [];
        a.filter((payload, { subject, request }) =>
        {
            subjects.push(subject);

            return payload.ws === request.query.workspaceId;
        });

        const stream = await createStreamApp(router, {}, false).connect(undefined, { query: 'events=a&workspaceId=w1' });
        await stream.frame('connected');
        await a.emit({ n: 1, ws: 'w2' });
        await a.emit({ n: 2, ws: 'w1' });

        expect((await stream.frame('a')).data.data).toEqual({ n: 2, ws: 'w1' });
        expect(subjects).toEqual([undefined, undefined]);
    });

    it('F6 event denied at connect: its filter is never called', async () =>
    {
        const { a, b, router } = events();
        const filter = vi.fn(() => true);
        a.canSubscribe(() => false).filter(filter);

        const stream = await createStreamApp(router).connect('s', { query: 'events=a,b' });
        await stream.frame('connected');
        await a.emit({ n: 1 });
        await b.emit({ n: 2 });
        await stream.frame('b');

        expect(filter).not.toHaveBeenCalled();
    });

    it('F7 .filter called twice throws at the second call', () =>
    {
        const { a } = events();
        a.filter(() => true);

        expect(() => a.filter(() => false)).toThrow(/already declares \.filter\(\)/);
    });
});
