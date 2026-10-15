/**
 * SSE client — `query` on `subscribe`: extra connect-query fields, such as the
 * key a state event is filtered on, appended after `events=` and reused on
 * every reconnect.
 *
 * | #  | situation                                | expected                                              |
 * |----|------------------------------------------|-------------------------------------------------------|
 * | Q1 | `query: { workspaceId: 'w 1' }`          | URL contains `&workspaceId=w%201` after `events=`     |
 * | Q2 | `query: { events: 'x' }` / `{ token: 'x' }` | throws naming the reserved name; no connection     |
 * | Q3 | reconnect                                | the same query on the new URL                         |
 * | Q4 | no `query`                               | URL unchanged from today (byte-equal)                 |
 */

import { Type } from '@sinclair/typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import { createSSEClient } from '../client';
import { FakeEventSource } from './fake-event-source';

const ping = defineEvent('ping', Type.Object({ n: Type.Number() }));
const pong = defineEvent('pong', Type.Object({ n: Type.Number() }));
const testRouter = defineEventRouter({ ping, pong });

type TestRouter = typeof testRouter;

const handlers = { ping: () => undefined, pong: () => undefined };

describe('SSE client — query on subscribe', () =>
{
    beforeEach(() =>
    {
        FakeEventSource.install();
    });

    afterEach(() =>
    {
        vi.useRealTimers();
        FakeEventSource.uninstall();
    });

    it('Q1 query fields follow events=, both sides encoded', () =>
    {
        const client = createSSEClient<TestRouter>({ url: 'http://test/stream' });

        client.subscribe({ events: ['ping', 'pong'], handlers, query: { workspaceId: 'w 1', 'a&b': 'c=d' } });

        expect(FakeEventSource.last.url).toBe('http://test/stream?events=ping,pong&workspaceId=w%201&a%26b=c%3Dd');
        client.close();
    });

    it('Q1 query fields come before the token', async () =>
    {
        const client = createSSEClient<TestRouter>({ url: 'http://test/stream', acquireToken: async () => 't 1' });

        client.subscribe({ events: ['ping'], handlers, query: { workspaceId: 'w1' } });
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

        expect(FakeEventSource.last.url).toBe('http://test/stream?events=ping&workspaceId=w1&token=t%201');
        client.close();
    });

    it.each(['events', 'token'])('Q2 query name "%s" is refused by name, and nothing connects', (name) =>
    {
        const client = createSSEClient<TestRouter>({ url: 'http://test/stream' });

        expect(() => client.subscribe({ events: ['ping'], handlers, query: { [name]: 'x' } }))
            .toThrow(new RegExp(`query names "${name}" are reserved`));
        expect(FakeEventSource.instances).toHaveLength(0);
        expect(client.getState()).toBe('closed');
    });

    it('Q2 a refused query leaves the subscription already open untouched', () =>
    {
        const client = createSSEClient<TestRouter>({ url: 'http://test/stream' });
        client.subscribe({ events: ['ping'], handlers });

        expect(() => client.subscribe({ events: ['ping'], handlers, query: { token: 'x' } })).toThrow(/"token"/);
        expect(FakeEventSource.live).toHaveLength(1);
        client.close();
    });

    it('Q3 a reconnect carries the same query', () =>
    {
        vi.useFakeTimers();
        const client = createSSEClient<TestRouter>({ url: 'http://test/stream', reconnectDelay: 10 });

        client.subscribe({ events: ['ping'], handlers, query: { workspaceId: 'w1' } });
        FakeEventSource.last.fail();
        vi.advanceTimersByTime(10);

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(FakeEventSource.instances.map(es => es.url)).toEqual([
            'http://test/stream?events=ping&workspaceId=w1',
            'http://test/stream?events=ping&workspaceId=w1',
        ]);
        client.close();
    });

    it('Q4 without query the URL is byte-equal to before', () =>
    {
        const client = createSSEClient<TestRouter>({ url: 'http://test/stream' });

        client.subscribe({ events: ['ping', 'pong'], handlers });

        expect(FakeEventSource.last.url).toBe('http://test/stream?events=ping,pong');
        client.close();
    });
});
