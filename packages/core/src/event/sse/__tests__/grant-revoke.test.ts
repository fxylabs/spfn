/**
 * SSE grant / revoke — an operator changes an open connection.
 *
 * | #    | situation                                                       | expected                                                               |
 * |------|-----------------------------------------------------------------|------------------------------------------------------------------------|
 * | G1   | `revoke(s, E)` while E allowed on s's connection                | unsubscribed; `subscription.revoked` `{ event: 'E' }`; emit delivers nothing |
 * | G1'  | same, other event F of the same connection                      | F still delivered; no frame about F                                    |
 * | G1'' | same, subject t connected with E                                | t still receives E; t gets no `subscription.revoked`                   |
 * | G2   | `revoke` on an event already denied, and on one never requested | no frame, no change; an emit of the never-requested one delivers nothing |
 * | G3   | `revoke` for a subject with no connection                       | resolves; nothing thrown                                               |
 * | G4   | subject with two connections (two tabs), `revoke`               | both lose E, both receive the frame                                    |
 * | G5   | `grant(s, E)` while E denied (by `canSubscribe` at connect)     | subscribed; `subscription.granted` `{ event: 'E' }`; emit delivers     |
 * | G5'  | `grant` while E denied by `authorize`                           | same as G5                                                             |
 * | G6   | `grant` while E already allowed                                 | no frame, one subscription (emit delivers exactly once)                |
 * | G7   | `grant` on an event never requested                             | no frame, nothing delivered                                            |
 * | G8   | `grant` for a subject with no connection                        | resolves                                                               |
 * | G9   | `revoke` then `grant` then `emit`                               | both frames in order; emit delivered                                   |
 * | G10  | `revoke` then client disconnect                                 | registry entry gone; no double unsubscribe; live subscriptions back to before connect |
 * | G11  | `grant` does not call `canSubscribe` again                      | predicate call count unchanged by `grant`                              |
 * | G12  | re-grant uses the stored request snapshot                       | per-event `filter` after re-grant still sees `request.query.workspaceId` |
 * | G13  | two handlers on one fake bus (two pods); `revoke` on the other  | the other pod's connection loses E and gets the frame; one publish; the publishing pod applies its own message once |
 * | G14  | no cache attached                                               | `grant` / `revoke` work locally; nothing published; no error           |
 * | G15  | after `revoke`, the client reconnects                           | `canSubscribe` decides afresh; the old denial is not remembered; an emit is delivered |
 * | G16  | control message for an unknown event or subject from another pod | ignored with a debug log; no throw; `s` untouched by subject `u`, changed by its own |
 * | G16' | control message for `s` naming an event its connection never requested | no change, no frame                                              |
 * | G16''| `$control` message without `origin` while `s` is open with E    | E still delivered; no `subscription.revoked`; debug "Malformed"        |
 * | G17  | pod A holds `s` with E; A `revoke`s then `grant`s; its own echoes arrive after both | exactly one revoked then one granted; E allowed; emit delivered once |
 * | G18  | same queued bus; pod B's `revoke(s)` arrives at A               | applied (not mistaken for an echo)                                     |
 * | G19  | `grant(s, { query: { workspaceId: 'w1' } })`, tabs on w1, w2 and one without the field | only the w1 tab activated; the others get no frame and no delivery |
 * | G20  | control message with `match: { query: 5 }`; and a well-formed `match` for an unknown event | malformed, ignored: E stays denied, no frame; the unknown event is ignored as without `match` |
 * | G21  | `grant(s, match)` on pod A, tabs on pod B on w1 and w2          | pod B applies the same query rule: only the w1 tab activated           |
 * | G22  | `grant(s, { query: { workspaceId: undefined } })`, `s` tabs on two pods | rejects; neither pod grants                                     |
 * | G23  | `grant(s, { query: {} })`                                       | rejects locally; nothing published                                     |
 * | G24  | control message with `match: { query: { workspaceId: 5 } }`, and with `match: { query: {} }` | malformed, ignored                       |
 *
 * During admission — a `grant` / `revoke` while the connect still awaits app data:
 *
 * | #    | situation                                                       | expected                                                               |
 * |------|-----------------------------------------------------------------|------------------------------------------------------------------------|
 * | A1   | `revoke(s, E)` while `E.canSubscribe` pending, will return `true` | opens with E in `deniedEvents`; no `subscription.revoked`; emit of E delivers nothing |
 * | A1'  | same, F of the same connection                                  | F allowed and delivered; no frame about F                              |
 * | A2   | `grant(s, E)` while `E.canSubscribe` pending, will return `false` | opens with E allowed; no `subscription.granted`; emit delivers        |
 * | A3   | `revoke` then `grant` during admission (`canSubscribe` → `false`) | last one wins: E allowed; an emit of E delivered exactly once         |
 * | A4   | `revoke` during admission, then `resolvePrincipal` throws → 403 | no pending entry left; no open connection                              |
 * | A5   | the client aborts during admission                              | pending entry removed; no open connection                              |
 * | A6   | `revoke(s, E)` during admission of `s` while `t` is open with E | `t` untouched, no frame to `t`                                         |
 * | A7   | `grant` during admission for an event the client did not request | no change: opens without it                                           |
 * | A8   | `revoke(s, E)` while one tab of `s` is open and another admitting | open tab: revoked at once with the frame; admitting tab opens with E denied, no frame |
 * | A9   | `canSubscribe` never settles; the client aborts                 | pending entry gone at once (predicate not released); no open connection |
 * | A10  | A9, then the predicate settles `true`                           | 499; nothing opens, no frame, no registry entry, no subscription       |
 * | A11  | one tab open, one hung and aborted, one admitting; `revoke(s, E)` | open tab revoked with the frame; aborted tab records nothing and opens nothing; admitting tab opens with E denied |
 * | A12  | a normal open, then the client aborts                           | the normal disconnect path only: cleanup runs once; pending stays 0    |
 * | A13  | `resolvePrincipal` never settles; the client aborts             | same as A9                                                             |
 * | A14  | global `authorize` rejects during admission                     | the connect fails with 500; no pending entry, no open connection       |
 * | A15  | pod A's `revoke(s, E)` arrives over the bus while `s` admits on pod B | B opens with E denied, no frame; an emit of E delivers nothing   |
 * | A16  | two tabs admitting; `revoke` of a never-requested event and of one `canSubscribe` denied | both open independently; `deniedEvents` lists the denied one once, never the unrequested one |
 * | A17  | the request is already aborted when admission begins; `canSubscribe` never settles | no pending entry (predicate not released); no open connection |
 * | A18  | global `authorize` never settles; the client aborts             | same as A9                                                             |
 * | G25  | `grant(s, { query: w1 })` while `s`'s w1 and w2 tabs are both admitting (`canSubscribe` → `false`) | the w2 tab opens without E; the w1 tab opens with it |
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import { createRedisPubSubCache } from '../../cache-transport';
import { FakeBus, FakeRedis } from '../../__tests__/fake-redis';
import { closeAllStreams, countSubscriptions, createStreamApp, until } from './stream-harness';
import type { SubscriptionControl } from '../../types';

vi.mock('@spfn/core/logger', () =>
{
    const sink: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    sink.child = () => sink;

    return { logger: sink };
});
import { logger } from '@spfn/core/logger';

const schema = Type.Object({ n: Type.Number(), ws: Type.Optional(Type.String()) });

/** Fresh events per case: `e` is the event under test, `f` the sentinel. */
function events()
{
    const e = defineEvent('test.e', schema);
    const f = defineEvent('test.f', schema);

    return { e, f, router: defineEventRouter({ e, f }) };
}

const REVOKED = 'subscription.revoked';
const GRANTED = 'subscription.granted';

/** A `canSubscribe` that stays pending until the test calls `release(verdict)`. */
function pendingVerdict()
{
    const gate: { release?: (verdict: boolean) => void } = {};
    const predicate = () => new Promise<boolean>((resolve) =>
    {
        gate.release = resolve;
    });

    return { predicate, gate, admitting: () => until(() => gate.release !== undefined) };
}

/** A `canSubscribe` whose every call stays pending; `releases[i]` settles call `i`. */
function pendingVerdicts()
{
    const releases: Array<(verdict: boolean) => void> = [];
    const predicate = () => new Promise<boolean>((resolve) =>
    {
        releases.push(resolve);
    });

    return { predicate, releases, admitting: (calls: number) => until(() => releases.length >= calls) };
}

/** A promise that never settles: an app predicate that hangs. */
function never<T>(): Promise<T>
{
    return new Promise<T>(() => undefined);
}

/** Count the `revoke` calls that reach the controls an event's handlers register. */
function countControlRevokes(event: ReturnType<typeof events>['e'])
{
    const register = event._registerSubscriptionControl;
    const counts = { revokes: 0 };

    vi.spyOn(event, '_registerSubscriptionControl').mockImplementation((control: SubscriptionControl) => register({
        grant: control.grant,
        revoke: (subject) =>
        {
            counts.revokes++;
            control.revoke(subject);
        },
    }));

    return counts;
}

beforeEach(() =>
{
    vi.clearAllMocks();
});

afterEach(async () =>
{
    await closeAllStreams();
});

describe('SSE grant / revoke', () =>
{
    it('G1 revoke while E allowed: subscription.revoked { event: E }, a following emit delivers nothing', async () =>
    {
        const { e, f, router } = events();
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');

        await e.revoke('s');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect((await stream.frame(REVOKED)).data).toEqual({ event: 'e' });
        expect(stream.named('e')).toEqual([]);
    });

    it('G1\' revoke of E leaves F of the same connection delivered, with no frame about F', async () =>
    {
        const { e, f, router } = events();
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');

        await e.revoke('s');
        await f.emit({ n: 2 });

        expect((await stream.frame('f')).data.data).toEqual({ n: 2 });
        expect(stream.named(REVOKED).map(frame => frame.data)).toEqual([{ event: 'e' }]);
    });

    it('G1\'\' revoke for s leaves subject t receiving E, with no subscription.revoked', async () =>
    {
        const { e, router } = events();
        const app = createStreamApp(router);
        const s = await app.connect('s', { query: 'events=e' });
        const t = await app.connect('t', { query: 'events=e' });
        await s.frame('connected');
        await t.frame('connected');

        await e.revoke('s');
        await e.emit({ n: 1 });

        expect((await t.frame('e')).data.data).toEqual({ n: 1 });
        expect(t.named(REVOKED)).toEqual([]);
    });

    it('G2 revoke of an already denied event and of one never requested: no frame, no change', async () =>
    {
        const { e, f, router } = events();
        e.canSubscribe(() => false);
        const stream = await createStreamApp(router).connect('s', { query: 'events=e' });
        await stream.frame('connected');

        await e.revoke('s');
        await f.revoke('s');
        await f.emit({ n: 2 });
        await e.grant('s');
        await e.emit({ n: 1 });
        await stream.frame('e');

        expect((await stream.frame(GRANTED)).data).toEqual({ event: 'e' });
        expect(stream.named(REVOKED)).toEqual([]);
        expect(stream.named('f')).toEqual([]);
    });

    it('G3 revoke for a subject with no connection resolves', async () =>
    {
        const { e, router } = events();
        createStreamApp(router);

        await expect(e.revoke('nobody')).resolves.toBeUndefined();
    });

    it('G4 a subject with two connections: both lose E and both receive the frame', async () =>
    {
        const { e, f, router } = events();
        const app = createStreamApp(router);
        const tabs = [
            await app.connect('s', { query: 'events=e,f' }),
            await app.connect('s', { query: 'events=e,f' }),
        ];
        await Promise.all(tabs.map(tab => tab.frame('connected')));

        await e.revoke('s');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });

        for (const tab of tabs)
        {
            await tab.frame('f');
            expect((await tab.frame(REVOKED)).data).toEqual({ event: 'e' });
            expect(tab.named('e')).toEqual([]);
        }
    });

    it('G5 grant while E denied by canSubscribe: subscription.granted { event: E }, a following emit delivers', async () =>
    {
        const { e, router } = events();
        e.canSubscribe(() => false);
        const stream = await createStreamApp(router).connect('s', { query: 'events=e' });
        expect((await stream.frame('connected')).data.deniedEvents).toEqual(['e']);

        await e.grant('s');
        await e.emit({ n: 1 });

        expect((await stream.frame(GRANTED)).data).toEqual({ event: 'e' });
        expect((await stream.frame('e')).data.data).toEqual({ n: 1 });
    });

    it('G5\' grant while E denied by authorize: subscription.granted, a following emit delivers', async () =>
    {
        const { e, router } = events();
        const app = createStreamApp(router, { auth: { authorize: () => ['f'] } });
        const stream = await app.connect('s', { query: 'events=e,f' });
        expect((await stream.frame('connected')).data.deniedEvents).toEqual(['e']);

        await e.grant('s');
        await e.emit({ n: 1 });

        expect((await stream.frame(GRANTED)).data).toEqual({ event: 'e' });
        expect((await stream.frame('e')).data.data).toEqual({ n: 1 });
    });

    it('G6 grant while E already allowed: no frame, emit delivers exactly once', async () =>
    {
        const { e, f, router } = events();
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');

        await e.grant('s');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.named('e')).toHaveLength(1);
        expect(stream.named(GRANTED)).toEqual([]);
    });

    it('G7 grant on an event never requested: no frame, nothing delivered', async () =>
    {
        const { e, f, router } = events();
        const stream = await createStreamApp(router).connect('s', { query: 'events=f' });
        await stream.frame('connected');

        await e.grant('s');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.named(GRANTED)).toEqual([]);
        expect(stream.named('e')).toEqual([]);
    });

    it('G8 grant for a subject with no connection resolves', async () =>
    {
        const { e, router } = events();
        createStreamApp(router);

        await expect(e.grant('nobody')).resolves.toBeUndefined();
    });

    it('G9 revoke, grant, emit: both frames in order, then the emit delivered', async () =>
    {
        const { e, router } = events();
        const stream = await createStreamApp(router).connect('s', { query: 'events=e' });
        await stream.frame('connected');

        await e.revoke('s');
        await e.grant('s');
        await e.emit({ n: 1 });
        await stream.frame('e');

        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', REVOKED, GRANTED, 'e']);
    });

    it('G10 revoke then disconnect: registry entry gone, no double unsubscribe, live subscriptions back to zero', async () =>
    {
        const { e, router } = events();
        const subscriptions = countSubscriptions(e);
        const app = createStreamApp(router);
        const stream = await app.connect('s', { query: 'events=e,f' });
        await stream.frame('connected');
        expect(subscriptions.live).toBe(1);

        await e.revoke('s');
        expect(subscriptions.live).toBe(0);
        await stream.close();
        await until(() => app.handler._openConnections('s') === 0);

        expect(subscriptions.live).toBe(0);
        expect(subscriptions.doubleUnsubscribes).toBe(0);
    });

    it('G11 grant does not call canSubscribe again', async () =>
    {
        const { e, router } = events();
        const predicate = vi.fn(() => false);
        e.canSubscribe(predicate);
        const stream = await createStreamApp(router).connect('s', { query: 'events=e' });
        await stream.frame('connected');
        expect(predicate).toHaveBeenCalledTimes(1);

        await e.grant('s');
        await stream.frame(GRANTED);

        expect(predicate).toHaveBeenCalledTimes(1);
    });

    it('G12 a re-granted event filters against the stored request snapshot', async () =>
    {
        const { e, router } = events();
        e.filter((payload, { request }) => payload.ws === request.query.workspaceId);
        const stream = await createStreamApp(router).connect('s', { query: 'events=e&workspaceId=w1' });
        await stream.frame('connected');

        await e.revoke('s');
        await e.grant('s');
        await e.emit({ n: 1, ws: 'w2' });
        await e.emit({ n: 2, ws: 'w1' });

        expect((await stream.frame('e')).data.data).toEqual({ n: 2, ws: 'w1' });
        expect(stream.named('e')).toHaveLength(1);
    });

    it('G13 revoke on pod A reaches the connection on pod B through the bus, published once', async () =>
    {
        const bus = new FakeBus();
        const podA = events();
        const podB = events();
        const redisA = new FakeRedis(bus);
        const publishA = vi.spyOn(redisA, 'publish');
        const controlsA = countControlRevokes(podA.e);
        await podA.e.useCache(createRedisPubSubCache(redisA, 'test:'));
        await podB.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        createStreamApp(podA.router);
        const stream = await createStreamApp(podB.router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');

        await podA.e.revoke('s');
        await podB.e.emit({ n: 1 });
        await podB.f.emit({ n: 2 });
        await stream.frame('f');

        expect((await stream.frame(REVOKED)).data).toEqual({ event: 'e' });
        expect(stream.named('e')).toEqual([]);
        expect(publishA.mock.calls.filter(([channel]) => channel === 'test:$control')).toHaveLength(1);
        expect(controlsA.revokes).toBe(1);
    });

    it('G14 without a cache grant and revoke work locally and publish nothing', async () =>
    {
        const bus = new FakeBus();
        const busPublish = vi.spyOn(bus, 'publish');
        const { e, router } = events();
        const stream = await createStreamApp(router).connect('s', { query: 'events=e' });
        await stream.frame('connected');

        await expect(e.revoke('s')).resolves.toBeUndefined();
        await expect(e.grant('s')).resolves.toBeUndefined();
        await stream.frame(GRANTED);

        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', REVOKED, GRANTED]);
        expect(busPublish).not.toHaveBeenCalled();
    });

    it('G15 after a revoke, a reconnect asks canSubscribe afresh', async () =>
    {
        const { e, router } = events();
        const predicate = vi.fn(() => true);
        e.canSubscribe(predicate);
        const app = createStreamApp(router);
        const first = await app.connect('s', { query: 'events=e' });
        await first.frame('connected');
        await e.revoke('s');
        await first.frame(REVOKED);
        await first.close();

        const second = await app.connect('s', { query: 'events=e' });
        const connected = await second.frame('connected');

        await e.emit({ n: 1 });

        expect(predicate).toHaveBeenCalledTimes(2);
        expect(connected.data.subscribedEvents).toEqual(['e']);
        expect(connected.data.deniedEvents).toEqual([]);
        expect((await second.frame('e')).data.data).toEqual({ n: 1 });
    });

    it('G16 a control message for an unknown event or subject is ignored with a debug log; s changes only by its own', async () =>
    {
        const bus = new FakeBus();
        const { e, f, router } = events();
        await e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');
        const send = (message: object) => bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', ...message }));

        expect(() => send({ kind: 'revoke', event: 'no.such.event', subject: 's' })).not.toThrow();
        expect(() => send({ kind: 'revoke', event: 'test.e', subject: 'u' })).not.toThrow();
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.named('e')).toHaveLength(1);
        expect(stream.named(REVOKED)).toEqual([]);
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('does not serve'), { event: 'no.such.event' });
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining('no open connection'),
            { event: 'e', subject: 'u' },
        );

        send({ kind: 'revoke', event: 'test.e', subject: 's' });

        expect((await stream.frame(REVOKED)).data).toEqual({ event: 'e' });
    });

    it('G16\' a control message for s naming an event its connection never requested: no change, no frame', async () =>
    {
        const bus = new FakeBus();
        const { e, f, router } = events();
        await e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const stream = await createStreamApp(router).connect('s', { query: 'events=f' });
        await stream.frame('connected');
        const send = (kind: string) => bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', kind, event: 'test.e', subject: 's' }));

        send('grant');
        send('revoke');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', 'f']);
    });

    it('G16\'\' a control message without origin is malformed and ignored', async () =>
    {
        const bus = new FakeBus();
        const { e, f, router } = events();
        await e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');

        bus.publish('test:$control', JSON.stringify({ kind: 'revoke', event: 'test.e', subject: 's' }));
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.named('e')).toHaveLength(1);
        expect(stream.named(REVOKED)).toEqual([]);
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Malformed'));
    });

    it('G17 a pod\'s own echoes delivered after its revoke and grant are skipped: one revoked, one granted, one delivery', async () =>
    {
        const bus = new FakeBus();
        const { e, f, router } = events();
        await e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');
        bus.deliverLater();

        await e.revoke('s');
        await e.grant('s');
        bus.flush();
        await e.emit({ n: 1 });
        bus.flush();
        await stream.frame('e');
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', REVOKED, GRANTED, 'e', 'f']);
    });

    it('G18 on the same queued bus, pod B\'s revoke arriving at pod A is applied', async () =>
    {
        const bus = new FakeBus();
        const podA = events();
        const podB = events();
        await podA.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        await podB.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        createStreamApp(podB.router);
        const stream = await createStreamApp(podA.router).connect('s', { query: 'events=e,f' });
        await stream.frame('connected');
        bus.deliverLater();

        await podB.e.revoke('s');
        bus.flush();
        await podA.e.emit({ n: 1 });
        bus.flush();
        await podA.f.emit({ n: 2 });
        await stream.frame('f');

        expect((await stream.frame(REVOKED)).data).toEqual({ event: 'e' });
        expect(stream.named('e')).toEqual([]);
    });

    it('G19 grant with a query match activates only the matching connection', async () =>
    {
        const { e, router } = events();
        e.canSubscribe(() => false);
        const app = createStreamApp(router);
        const onW1 = await app.connect('s', { query: 'events=e&workspaceId=w1' });
        const onW2 = await app.connect('s', { query: 'events=e&workspaceId=w2' });
        const keyless = await app.connect('s', { query: 'events=e' });
        await Promise.all([onW1.frame('connected'), onW2.frame('connected'), keyless.frame('connected')]);

        await e.grant('s', { query: { workspaceId: 'w1' } });
        await onW1.frame(GRANTED);
        await e.emit({ n: 1 });
        await onW1.frame('e');

        expect(onW2.frames.map(frame => frame.event)).toEqual(['connected']);
        expect(keyless.frames.map(frame => frame.event)).toEqual(['connected']);
    });

    it('G20 a control message whose match query is not a string record is malformed and ignored', async () =>
    {
        const bus = new FakeBus();
        const { e, f, router } = events();
        e.canSubscribe(() => false);
        await e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f&workspaceId=w1' });
        await stream.frame('connected');

        bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', kind: 'grant', event: 'test.e', subject: 's', match: { query: 5 } }));
        bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', kind: 'grant', event: 'no.such.event', subject: 's', match: { query: { workspaceId: 'w1' } } }));
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', 'f']);
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Malformed'));
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('does not serve'), { event: 'no.such.event' });
    });

    it('G21 a match published by pod A is applied by pod B with the same query rule', async () =>
    {
        const bus = new FakeBus();
        const podA = events();
        const podB = events();
        podB.e.canSubscribe(() => false);
        await podA.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        await podB.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        createStreamApp(podA.router);
        const appB = createStreamApp(podB.router);
        const onW1 = await appB.connect('s', { query: 'events=e,f&workspaceId=w1' });
        const onW2 = await appB.connect('s', { query: 'events=e,f&workspaceId=w2' });
        await Promise.all([onW1.frame('connected'), onW2.frame('connected')]);

        await podA.e.grant('s', { query: { workspaceId: 'w1' } });
        await onW1.frame(GRANTED);
        await podB.f.emit({ n: 1 });
        await onW2.frame('f');

        expect(onW2.named(GRANTED)).toEqual([]);
    });
});

describe('SSE grant / revoke: a match never widens', () =>
{
    it('G22 a match with an undefined value rejects, and neither pod grants', async () =>
    {
        const bus = new FakeBus();
        const podA = events();
        const podB = events();
        podA.e.canSubscribe(() => false);
        podB.e.canSubscribe(() => false);
        await podA.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        await podB.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const onA = await createStreamApp(podA.router).connect('s', { query: 'events=e,f&workspaceId=w2' });
        const onB = await createStreamApp(podB.router).connect('s', { query: 'events=e,f&workspaceId=w2' });
        await Promise.all([onA.frame('connected'), onB.frame('connected')]);

        await expect(podA.e.grant('s', { query: { workspaceId: undefined as unknown as string } }))
            .rejects.toThrow('Event "test.e" .grant() refused its match');
        await podA.f.emit({ n: 1 });
        await podB.f.emit({ n: 1 });
        await Promise.all([onA.frame('f'), onB.frame('f')]);

        expect(onA.named(GRANTED)).toEqual([]);
        expect(onB.named(GRANTED)).toEqual([]);
    });

    it('G23 a match with an empty query rejects locally and publishes nothing', async () =>
    {
        const bus = new FakeBus();
        const { e, f, router } = events();
        e.canSubscribe(() => false);
        await e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f&workspaceId=w1' });
        await stream.frame('connected');
        const publish = vi.spyOn(bus, 'publish');

        await expect(e.grant('s', { query: {} })).rejects.toThrow('match.query must name at least one field');
        await expect(e.revoke('s', { query: {} })).rejects.toThrow('Event "test.e" .revoke() refused its match');
        expect(publish).not.toHaveBeenCalled();
        await f.emit({ n: 1 });
        await stream.frame('f');

        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', 'f']);
    });

    it('G24 a control message whose match query holds a non-string value, or no field, is malformed and ignored', async () =>
    {
        const bus = new FakeBus();
        const { e, f, router } = events();
        e.canSubscribe(() => false);
        await e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        const stream = await createStreamApp(router).connect('s', { query: 'events=e,f&workspaceId=w1' });
        await stream.frame('connected');

        bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', kind: 'grant', event: 'test.e', subject: 's', match: { query: { workspaceId: 5 } } }));
        bus.publish('test:$control', JSON.stringify({ origin: 'other-pod', kind: 'grant', event: 'test.e', subject: 's', match: { query: {} } }));
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', 'f']);
        expect(vi.mocked(logger.debug).mock.calls.filter(([message]) => String(message).includes('Malformed'))).toHaveLength(2);
    });
});

describe('SSE grant / revoke during admission', () =>
{
    it('G25 a matched grant during admission opens only the matching tab with E', async () =>
    {
        const { e, f, router } = events();
        const { predicate, releases, admitting } = pendingVerdicts();
        e.canSubscribe(predicate);
        const app = createStreamApp(router);
        const connectingW1 = app.connect('s', { query: 'events=e,f&workspaceId=w1' });
        const connectingW2 = app.connect('s', { query: 'events=e,f&workspaceId=w2' });
        await admitting(2);

        await e.grant('s', { query: { workspaceId: 'w1' } });
        releases.forEach(release => release(false));
        const [onW1, onW2] = await Promise.all([connectingW1, connectingW2]);
        const [connectedW1, connectedW2] = await Promise.all([onW1.frame('connected'), onW2.frame('connected')]);
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await Promise.all([onW1.frame('f'), onW2.frame('f')]);

        expect(connectedW1.data.deniedEvents).toEqual([]);
        expect(connectedW2.data.deniedEvents).toEqual(['e']);
        expect(onW1.named('e')).toHaveLength(1);
        expect(onW2.named('e')).toEqual([]);
        expect([...onW1.named(GRANTED), ...onW2.named(GRANTED)]).toEqual([]);
    });

    it('A1 revoke while canSubscribe is pending (will say true): opens with E denied, no frame, emit delivers nothing', async () =>
    {
        const { e, f, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        e.canSubscribe(predicate);
        const connecting = createStreamApp(router).connect('s', { query: 'events=e,f' });
        await admitting();

        await e.revoke('s');
        gate.release!(true);
        const stream = await connecting;
        const connected = await stream.frame('connected');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(connected.data.subscribedEvents).toEqual(['f']);
        expect(connected.data.deniedEvents).toEqual(['e']);
        expect(stream.named(REVOKED)).toEqual([]);
        expect(stream.named('e')).toEqual([]);
    });

    it('A1\' the revoke of E during admission leaves F allowed and delivered, with no frame about F', async () =>
    {
        const { e, f, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        e.canSubscribe(predicate);
        const connecting = createStreamApp(router).connect('s', { query: 'events=e,f' });
        await admitting();

        await e.revoke('s');
        gate.release!(true);
        const stream = await connecting;
        await stream.frame('connected');
        await f.emit({ n: 2 });

        expect((await stream.frame('f')).data.data).toEqual({ n: 2 });
        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', 'f']);
    });

    it('A2 grant while canSubscribe is pending (will say false): opens with E allowed, no frame, emit delivers', async () =>
    {
        const { e, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        e.canSubscribe(predicate);
        const connecting = createStreamApp(router).connect('s', { query: 'events=e' });
        await admitting();

        await e.grant('s');
        gate.release!(false);
        const stream = await connecting;
        const connected = await stream.frame('connected');
        await e.emit({ n: 1 });

        expect((await stream.frame('e')).data.data).toEqual({ n: 1 });
        expect(connected.data.subscribedEvents).toEqual(['e']);
        expect(connected.data.deniedEvents).toEqual([]);
        expect(stream.named(GRANTED)).toEqual([]);
    });

    it('A3 revoke then grant during admission: the last one wins, E allowed and delivered once', async () =>
    {
        const { e, f, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        e.canSubscribe(predicate);
        const connecting = createStreamApp(router).connect('s', { query: 'events=e,f' });
        await admitting();

        await e.revoke('s');
        await e.grant('s');
        gate.release!(false);
        const stream = await connecting;
        const connected = await stream.frame('connected');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect([...connected.data.subscribedEvents].sort()).toEqual(['e', 'f']);
        expect(connected.data.deniedEvents).toEqual([]);
        expect(stream.named('e').map(frame => frame.data.data)).toEqual([{ n: 1 }]);
    });

    it('A4 revoke during admission, then resolvePrincipal throws: 403 and no pending entry left', async () =>
    {
        const { e, router } = events();
        const gate: { fail?: () => void } = {};
        const resolvePrincipal = () => new Promise((_, reject) =>
        {
            gate.fail = () => reject(new Error('no principal'));
        });
        const app = createStreamApp(router, { auth: { resolvePrincipal } });
        const connecting = app.connect('s', { query: 'events=e' });
        await until(() => gate.fail !== undefined);
        expect(app.handler._pendingAdmissions('s')).toBe(1);

        await e.revoke('s');
        gate.fail!();
        const stream = await connecting;

        expect(stream.status).toBe(403);
        expect(app.handler._openConnections('s')).toBe(0);
        expect(app.handler._pendingAdmissions('s')).toBe(0);
    });

    it('A5 the client aborts during admission: the pending entry is removed', async () =>
    {
        const { e, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        e.canSubscribe(predicate);
        const app = createStreamApp(router);
        const controller = new AbortController();
        const connecting = app.connect('s', { query: 'events=e', controller });
        await admitting();
        expect(app.handler._pendingAdmissions('s')).toBe(1);

        controller.abort();
        gate.release!(true);
        const stream = await connecting;

        expect(stream.status).not.toBe(200);
        expect(app.handler._openConnections('s')).toBe(0);
        expect(app.handler._pendingAdmissions('s')).toBe(0);
    });

    it('A6 revoke for s during its admission leaves t, open with E, untouched', async () =>
    {
        const { e, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        const app = createStreamApp(router);
        e.canSubscribe(({ subject }) => subject === 't' || predicate());
        const t = await app.connect('t', { query: 'events=e' });
        await t.frame('connected');
        const connecting = app.connect('s', { query: 'events=e' });
        await admitting();

        await e.revoke('s');
        gate.release!(true);
        await (await connecting).frame('connected');
        await e.emit({ n: 1 });

        expect((await t.frame('e')).data.data).toEqual({ n: 1 });
        expect(t.frames.map(frame => frame.event)).toEqual(['connected', 'e']);
    });

    it('A7 grant during admission for an event the client did not request: opens without it', async () =>
    {
        const { e, f, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        f.canSubscribe(predicate);
        const connecting = createStreamApp(router).connect('s', { query: 'events=f' });
        await admitting();

        await e.grant('s');
        gate.release!(true);
        const stream = await connecting;
        const connected = await stream.frame('connected');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await stream.frame('f');

        expect(connected.data.subscribedEvents).toEqual(['f']);
        expect(connected.data.deniedEvents).toEqual([]);
        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', 'f']);
    });

    it('A8 revoke with one tab open and one admitting: the open tab is revoked at once, the other opens with E denied', async () =>
    {
        const { e, f, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        const app = createStreamApp(router);
        let calls = 0;
        e.canSubscribe(() => ++calls === 1 || predicate());
        const open = await app.connect('s', { query: 'events=e,f' });
        await open.frame('connected');
        const connecting = app.connect('s', { query: 'events=e,f' });
        await admitting();

        await e.revoke('s');
        expect((await open.frame(REVOKED)).data).toEqual({ event: 'e' });
        gate.release!(true);
        const second = await connecting;
        const connected = await second.frame('connected');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await second.frame('f');
        await open.frame('f');

        expect(connected.data.deniedEvents).toEqual(['e']);
        expect(second.named(REVOKED)).toEqual([]);
        expect(second.named('e')).toEqual([]);
        expect(open.named('e')).toEqual([]);
        expect(app.handler._openConnections('s')).toBe(2);
        expect(app.handler._pendingAdmissions('s')).toBe(0);
    });

    it('A9 canSubscribe never settles, the client aborts: the pending entry is gone at once', async () =>
    {
        const { e, router } = events();
        const { predicate, admitting } = pendingVerdict();
        e.canSubscribe(predicate);
        const app = createStreamApp(router);
        const controller = new AbortController();
        void app.connect('s', { query: 'events=e', controller });
        await admitting();
        expect(app.handler._pendingAdmissions('s')).toBe(1);

        controller.abort();

        expect(app.handler._pendingAdmissions('s')).toBe(0);
        expect(app.handler._openConnections('s')).toBe(0);
    });

    it('A10 the predicate settles true after the abort: 499, nothing opens, no frame, no subscription', async () =>
    {
        const { e, router } = events();
        const { predicate, gate, admitting } = pendingVerdict();
        e.canSubscribe(predicate);
        const subscriptions = countSubscriptions(e);
        const app = createStreamApp(router);
        const controller = new AbortController();
        const connecting = app.connect('s', { query: 'events=e', controller });
        await admitting();

        controller.abort();
        gate.release!(true);
        const stream = await connecting;
        await e.emit({ n: 1 });

        expect(stream.status).toBe(499);
        expect(stream.frames).toEqual([]);
        expect(subscriptions.live).toBe(0);
        expect(app.handler._openConnections('s')).toBe(0);
        expect(app.handler._pendingAdmissions('s')).toBe(0);
    });

    it('A11 revoke with one tab open, one hung and aborted, one admitting: only the live tabs change', async () =>
    {
        const { e, f, router } = events();
        const { predicate, releases, admitting } = pendingVerdicts();
        let calls = 0;
        e.canSubscribe(() => ++calls === 1 || predicate());
        const app = createStreamApp(router);
        const open = await app.connect('s', { query: 'events=e,f' });
        await open.frame('connected');
        const controller = new AbortController();
        const aborted = app.connect('s', { query: 'events=e,f', controller });
        await admitting(1);
        const admittingTab = app.connect('s', { query: 'events=e,f' });
        await admitting(2);

        controller.abort();
        expect(app.handler._pendingAdmissions('s')).toBe(1);
        await e.revoke('s');
        expect((await open.frame(REVOKED)).data).toEqual({ event: 'e' });
        releases.forEach(release => release(true));
        const late = await aborted;
        const second = await admittingTab;
        const connected = await second.frame('connected');
        await e.emit({ n: 1 });
        await f.emit({ n: 2 });
        await second.frame('f');
        await open.frame('f');

        expect(late.status).toBe(499);
        expect(open.frames.map(frame => frame.event)).toEqual(['connected', REVOKED, 'f']);
        expect(connected.data.deniedEvents).toEqual(['e']);
        expect(second.frames.map(frame => frame.event)).toEqual(['connected', 'f']);
        expect(app.handler._openConnections('s')).toBe(2);
        expect(app.handler._pendingAdmissions('s')).toBe(0);
    });

    it('A12 after a normal open, a client abort takes the normal disconnect path only: cleanup runs once', async () =>
    {
        const { e, router } = events();
        const subscriptions = countSubscriptions(e);
        const app = createStreamApp(router);
        const stream = await app.connect('s', { query: 'events=e' });
        await stream.frame('connected');
        expect(app.handler._pendingAdmissions('s')).toBe(0);

        await stream.close();
        await until(() => app.handler._openConnections('s') === 0);

        const cleanups = vi.mocked(logger.info).mock.calls.filter(([message]) => message === 'SSE dead connection cleaned up');
        expect(cleanups).toHaveLength(1);
        expect(subscriptions).toEqual({ live: 0, doubleUnsubscribes: 0 });
        expect(app.handler._pendingAdmissions('s')).toBe(0);
    });

    it('A13 resolvePrincipal never settles, the client aborts: the pending entry is gone at once', async () =>
    {
        const { router } = events();
        const resolvePrincipal = vi.fn(() => never());
        const app = createStreamApp(router, { auth: { resolvePrincipal } });
        const controller = new AbortController();
        void app.connect('s', { query: 'events=e', controller });
        await until(() => resolvePrincipal.mock.calls.length === 1);
        expect(app.handler._pendingAdmissions('s')).toBe(1);

        controller.abort();

        expect(app.handler._pendingAdmissions('s')).toBe(0);
        expect(app.handler._openConnections('s')).toBe(0);
    });

    it('A14 the global authorize rejects during admission: the connect fails with 500, no pending entry left', async () =>
    {
        const { router } = events();
        const gate: { fail?: () => void } = {};
        const authorize = () => new Promise<string[]>((_, reject) =>
        {
            gate.fail = () => reject(new Error('db down'));
        });
        const app = createStreamApp(router, { auth: { authorize } });
        const connecting = app.connect('s', { query: 'events=e' });
        await until(() => gate.fail !== undefined);
        expect(app.handler._pendingAdmissions('s')).toBe(1);

        gate.fail!();
        const stream = await connecting;

        expect(stream.status).toBe(500);
        expect(app.handler._pendingAdmissions('s')).toBe(0);
        expect(app.handler._openConnections('s')).toBe(0);
    });

    it('A15 pod A\'s revoke reaches s admitting on pod B: B opens with E denied, no frame, emit delivers nothing', async () =>
    {
        const bus = new FakeBus();
        const podA = events();
        const podB = events();
        await podA.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        await podB.e.useCache(createRedisPubSubCache(new FakeRedis(bus), 'test:'));
        createStreamApp(podA.router);
        const { predicate, gate, admitting } = pendingVerdict();
        podB.e.canSubscribe(predicate);
        const connecting = createStreamApp(podB.router).connect('s', { query: 'events=e,f' });
        await admitting();

        await podA.e.revoke('s');
        gate.release!(true);
        const stream = await connecting;
        const connected = await stream.frame('connected');
        await podB.e.emit({ n: 1 });
        await podB.f.emit({ n: 2 });
        await stream.frame('f');

        expect(connected.data.deniedEvents).toEqual(['e']);
        expect(stream.named(REVOKED)).toEqual([]);
        expect(stream.named('e')).toEqual([]);
    });

    it('A16 two tabs admitting; revoke of a never-requested event and of a denied one: both open, each denial listed once', async () =>
    {
        const { e, f } = events();
        const g = defineEvent('test.g', schema);
        const router = defineEventRouter({ e, f, g });
        const { predicate, releases, admitting } = pendingVerdicts();
        e.canSubscribe(() => false);
        f.canSubscribe(predicate);
        const app = createStreamApp(router);
        const connecting = [app.connect('s', { query: 'events=e,f' }), app.connect('s', { query: 'events=e,f' })];
        await admitting(2);
        expect(app.handler._pendingAdmissions('s')).toBe(2);

        await g.revoke('s');
        await e.revoke('s');
        releases.forEach(release => release(true));
        const tabs = await Promise.all(connecting);
        const connected = await Promise.all(tabs.map(tab => tab.frame('connected')));
        await e.emit({ n: 1 });
        await g.emit({ n: 2 });
        await f.emit({ n: 3 });
        await Promise.all(tabs.map(tab => tab.frame('f')));

        connected.forEach((frame) =>
        {
            expect(frame.data.subscribedEvents).toEqual(['f']);
            expect(frame.data.deniedEvents).toEqual(['e']);
        });
        tabs.forEach(tab => expect(tab.frames.map(frame => frame.event)).toEqual(['connected', 'f']));
        expect(app.handler._openConnections('s')).toBe(2);
        expect(app.handler._pendingAdmissions('s')).toBe(0);
    });

    it('A17 the request is already aborted when admission begins, canSubscribe never settles: no pending entry', async () =>
    {
        const { e, router } = events();
        const predicate = vi.fn(() => never<boolean>());
        e.canSubscribe(predicate);
        const app = createStreamApp(router);
        const controller = new AbortController();
        controller.abort();
        void app.connect('s', { query: 'events=e', controller }).catch(() => undefined);
        await until(() => predicate.mock.calls.length === 1);

        expect(app.handler._pendingAdmissions('s')).toBe(0);
        expect(app.handler._openConnections('s')).toBe(0);
    });

    it('A18 the global authorize never settles, the client aborts: the pending entry is gone at once', async () =>
    {
        const { router } = events();
        const authorize = vi.fn(() => never<string[]>());
        const app = createStreamApp(router, { auth: { authorize } });
        const controller = new AbortController();
        void app.connect('s', { query: 'events=e', controller });
        await until(() => authorize.mock.calls.length === 1);
        expect(app.handler._pendingAdmissions('s')).toBe(1);

        controller.abort();

        expect(app.handler._pendingAdmissions('s')).toBe(0);
        expect(app.handler._openConnections('s')).toBe(0);
    });
});
