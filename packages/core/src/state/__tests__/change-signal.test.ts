/**
 * Change signal — the app emits `state.changed` after a commit; the module
 * re-reads and sends `state.<id>.changed`. Two subjects `s`, `t` connected;
 * keyed rows put `t` on another key where the row says so.
 *
 * | #    | situation                                                  | expected                                                    |
 * |------|------------------------------------------------------------|-------------------------------------------------------------|
 * | E1   | keyless `consent.changed.emit({ subject: 's' })`           | `read` called once for `s`; `s` receives `{ at, value, data, subject: 's' }` |
 * | E1'  | same                                                       | `t` receives nothing                                        |
 * | E2   | keyed per-subject `member.changed.emit({ workspaceId: 'w1', subject: 's' })` | frame with `key` and `subject` to `s`     |
 * | E2'  | same                                                       | `t` (same key, other subject) nothing                       |
 * | E2'' | same, `s`'s connection declared `workspaceId=w2`           | nothing                                                     |
 * | E3   | keyed shared `runtime.changed.emit({ workspaceId: 'w1' })`, `s` and `t` on `w1` | `read` called once; both receive the frame |
 * | E3'  | same, a third subject on `w2`                              | nothing                                                     |
 * | E4   | emit with a missing field                                  | refused; `read` not called                                  |
 * | E5   | `read` throws on a signal                                  | warn logged with the state id; no frame; the next signal works |
 * | E6   | two signals in a row                                       | second frame's `at` ≥ first's                               |
 * | E7   | a subscriber mutates `data` of the frame it received       | the write route's response is unaffected (the frame is a copy) |
 * | C1   | `changedBy([memberJoined])`, `memberJoined` carries `{ workspaceId, subject }`; emit it | the derived frame is sent exactly as for `changed.emit` |
 * | C1'  | a `.changedBy()` payload missing `workspaceId` at runtime  | warn naming the state and the event; no `read()`; no frame  |
 * | C3   | one event listed by two states                             | both re-read; two frames                                    |
 * | C5   | two pods (two caches on one fake bus), each with the state and its `.changedBy()` event; pod A emits the event | one frame reaches a subscriber of the derived event on pod B; `read()` ran once in total |
 * | C9   | shared state, key schema `additionalProperties: false`, `.changedBy()` payload with one more field | `read()` once with the picked key; one frame |
 * | C10  | same, `changed.emit({ workspaceId, extra: 1 })`             | the extra field ignored; one frame                          |
 */

import { Type } from '@sinclair/typebox';
import { Logger } from '@spfn/core/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedisPubSubCache } from '../../event/cache-transport';
import { defineEvent } from '../../event/event';
import { FakeBus, FakeRedis } from '../../event/__tests__/fake-redis';
import { defineEventRouter } from '../../event/router';
import type { EventDef } from '../../event/types';
import { closeAllStreams, createStreamApp } from '../../event/sse/__tests__/stream-harness';
import type { OpenStream } from '../../event/sse/__tests__/stream-harness';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { Consent, Runtime, consentState, ISO, memberState, request, runtimeState, serve } from './state-harness';

const CONSENT = 'state.consent.changed';
const MEMBER = 'state.member.changed';
const RUNTIME = 'state.runtime.changed';

/** Fresh states, one router, one SSE handler serving their events. */
function setup()
{
    const consent = consentState();
    const member = memberState();
    const runtime = runtimeState();
    const states = defineStateRouter({ consent: consent.state, member: member.state, runtime: runtime.state });
    const app = createStreamApp(defineEventRouter(states.events));
    const connect = async (subject: string, query: string): Promise<OpenStream> =>
    {
        const stream = await app.connect(subject, { query });
        await stream.frame('connected');

        return stream;
    };

    return { consent, member, runtime, connect };
}

afterEach(async () =>
{
    await closeAllStreams();
    vi.restoreAllMocks();
});

describe('change signal', () =>
{
    it('E1 keyless signal for s: read once for s, s receives { at, value, data, subject }', async () =>
    {
        const { consent, connect } = setup();
        const s = await connect('s', `events=${CONSENT}`);

        await consent.state.changed.emit({ subject: 's' });

        expect(consent.read).toHaveBeenCalledTimes(1);
        expect(consent.read).toHaveBeenCalledWith({ subject: 's', principal: undefined });
        expect((await s.frame(CONSENT)).data.data).toEqual({
            at: expect.stringMatching(ISO),
            value: 'agreed',
            data: { marketing: true },
            subject: 's',
        });
    });

    it('E1\' keyless signal for s: t receives nothing', async () =>
    {
        const { consent, connect } = setup();
        await connect('s', `events=${CONSENT}`);
        const t = await connect('t', `events=${CONSENT}`);

        await consent.state.changed.emit({ subject: 's' });
        await consent.state.changed.emit({ subject: 't' });
        await t.frame(CONSENT);

        expect(t.named(CONSENT).map(frame => frame.data.data.subject)).toEqual(['t']);
    });

    it('E2 keyed per-subject signal: the frame carries key and subject, to s', async () =>
    {
        const { member, connect } = setup();
        const s = await connect('s', `events=${MEMBER}&workspaceId=w1`);

        await member.state.changed.emit({ workspaceId: 'w1', subject: 's' });

        expect(member.read).toHaveBeenCalledWith({ subject: 's', principal: undefined, key: { workspaceId: 'w1' } });
        expect((await s.frame(MEMBER)).data.data).toEqual({
            at: expect.stringMatching(ISO),
            value: 'owner',
            key: { workspaceId: 'w1' },
            subject: 's',
        });
    });

    it('E2\' keyed per-subject signal for s: t on the same key receives nothing', async () =>
    {
        const { member, connect } = setup();
        await connect('s', `events=${MEMBER}&workspaceId=w1`);
        const t = await connect('t', `events=${MEMBER}&workspaceId=w1`);

        await member.state.changed.emit({ workspaceId: 'w1', subject: 's' });
        await member.state.changed.emit({ workspaceId: 'w1', subject: 't' });
        await t.frame(MEMBER);

        expect(t.named(MEMBER).map(frame => frame.data.data.subject)).toEqual(['t']);
    });

    it('E2\'\' keyed per-subject signal on w1: s\'s connection on w2 receives nothing', async () =>
    {
        const { member, connect } = setup();
        const sOnW2 = await connect('s', `events=${MEMBER}&workspaceId=w2`);

        await member.state.changed.emit({ workspaceId: 'w1', subject: 's' });
        await member.state.changed.emit({ workspaceId: 'w2', subject: 's' });
        await sOnW2.frame(MEMBER);

        expect(sOnW2.named(MEMBER).map(frame => frame.data.data.key)).toEqual([{ workspaceId: 'w2' }]);
    });

    it('E3 keyed shared signal: read once, s and t on w1 both receive the frame', async () =>
    {
        const { runtime, connect } = setup();
        const s = await connect('s', `events=${RUNTIME}&workspaceId=w1`);
        const t = await connect('t', `events=${RUNTIME}&workspaceId=w1`);

        await runtime.state.changed.emit({ workspaceId: 'w1' });
        const frames = [await s.frame(RUNTIME), await t.frame(RUNTIME)];

        expect(runtime.read).toHaveBeenCalledTimes(1);
        expect(runtime.read).toHaveBeenCalledWith({ principal: undefined, key: { workspaceId: 'w1' } });
        expect(frames.map(frame => frame.data.data)).toEqual([
            { at: expect.stringMatching(ISO), value: 'ready', key: { workspaceId: 'w1' } },
            frames[0].data.data,
        ]);
    });

    it('E3\' keyed shared signal on w1: a third subject on w2 receives nothing', async () =>
    {
        const { runtime, connect } = setup();
        await connect('s', `events=${RUNTIME}&workspaceId=w1`);
        const u = await connect('u', `events=${RUNTIME}&workspaceId=w2`);

        await runtime.state.changed.emit({ workspaceId: 'w1' });
        await runtime.state.changed.emit({ workspaceId: 'w2' });
        await u.frame(RUNTIME);

        expect(u.named(RUNTIME).map(frame => frame.data.data.key)).toEqual([{ workspaceId: 'w2' }]);
    });

    it('E4 a signal missing a field is refused; read not called', async () =>
    {
        const { member, runtime } = setup();

        await expect(member.state.changed.emit({ subject: 's' } as never)).rejects.toThrow('/workspaceId');
        await expect(runtime.state.changed.emit({} as never)).rejects.toThrow('/workspaceId');

        expect(member.read).not.toHaveBeenCalled();
        expect(runtime.read).not.toHaveBeenCalled();
    });

    it('E5 read throws on a signal: warn with the state id, no frame, the next signal works', async () =>
    {
        const warn = vi.spyOn(Logger.prototype, 'warn');
        const { consent, connect } = setup();
        const s = await connect('s', `events=${CONSENT}`);
        consent.read.mockRejectedValueOnce(new Error('db down'));

        await consent.state.changed.emit({ subject: 's' });
        await consent.state.changed.emit({ subject: 's' });
        await s.frame(CONSENT);

        expect(warn).toHaveBeenCalledWith(
            'State "consent" could not be re-read on its change signal; no frame was sent',
            { state: 'consent', error: 'db down' },
        );
        expect(consent.read).toHaveBeenCalledTimes(2);
        expect(s.named(CONSENT)).toHaveLength(1);
    });

    it('E6 two signals in a row: the second frame\'s at is not before the first\'s', async () =>
    {
        const { consent, connect } = setup();
        const s = await connect('s', `events=${CONSENT}`);

        await consent.state.changed.emit({ subject: 's' });
        await consent.state.changed.emit({ subject: 's' });
        const [first, second] = [await s.frame(CONSENT, 1), await s.frame(CONSENT, 2)];

        expect(second.data.data.at >= first.data.data.at).toBe(true);
    });

    it('E7 a subscriber mutating the data of its frame leaves the write route\'s response unchanged', async () =>
    {
        const consent = consentState();
        const states = defineStateRouter({ consent: consent.state });
        (states.events as Record<string, EventDef<any>>)[CONSENT].subscribe((payload: { data: { marketing: boolean } }) =>
        {
            payload.data.marketing = false;
        });
        const app = await serve(states);

        const res = await request(app, 's').put('/state/consent', { termsVersion: '2026-10', marketing: true });

        expect((await res.json()).data).toEqual({ marketing: true });
    });

    it('C1 an event listed in .changedBy() sends the frame changed.emit would', async () =>
    {
        const memberJoined = defineEvent('member.joined', Type.Object({ workspaceId: Type.String(), subject: Type.String() }));
        const member = memberState();
        const states = defineStateRouter({ member: member.state.changedBy([memberJoined]) });
        const app = createStreamApp(defineEventRouter(states.events));
        const s = await app.connect('s', { query: `events=${MEMBER}&workspaceId=w1` });
        await s.frame('connected');

        await memberJoined.emit({ workspaceId: 'w1', subject: 's' });
        await states.states.member.changed.emit({ workspaceId: 'w1', subject: 's' });
        const [byEvent, bySignal] = [(await s.frame(MEMBER, 1)).data.data, (await s.frame(MEMBER, 2)).data.data];

        expect(byEvent).toEqual({ at: expect.stringMatching(ISO), value: 'owner', key: { workspaceId: 'w1' }, subject: 's' });
        expect({ ...byEvent, at: undefined }).toEqual({ ...bySignal, at: undefined });
        expect(member.read).toHaveBeenCalledTimes(2);
    });

    it('C3 one event listed by two states: both re-read, two frames', async () =>
    {
        const memberJoined = defineEvent('member.joined', Type.Object({ workspaceId: Type.String(), subject: Type.String() }));
        const member = memberState();
        const runtime = runtimeState();
        const states = defineStateRouter({
            member: member.state.changedBy([memberJoined]),
            runtime: runtime.state.changedBy([memberJoined]),
        });
        const app = createStreamApp(defineEventRouter(states.events));
        const s = await app.connect('s', { query: `events=${MEMBER},${RUNTIME}&workspaceId=w1` });
        await s.frame('connected');

        await memberJoined.emit({ workspaceId: 'w1', subject: 's' });
        await Promise.all([s.frame(MEMBER), s.frame(RUNTIME)]);

        expect(member.read).toHaveBeenCalledTimes(1);
        expect(runtime.read).toHaveBeenCalledTimes(1);
        expect(s.frames.filter(frame => frame.event === MEMBER || frame.event === RUNTIME)).toHaveLength(2);
    });

    it('C1\' a .changedBy() payload missing a key field at runtime: warn naming the state and the event, no read, no frame', async () =>
    {
        const warn = vi.spyOn(Logger.prototype, 'warn');
        const deployFinished = defineEvent('deploy.finished', Type.Object({ workspaceId: Type.String() }));
        const runtime = runtimeState();
        const states = defineStateRouter({ runtime: runtime.state.changedBy([deployFinished]) });
        const frames = vi.fn();
        states.events[RUNTIME].subscribe(frames);

        await deployFinished.emit({ deploymentId: 'd1' } as never);

        expect(warn).toHaveBeenCalledWith(
            'State "runtime" skipped an "deploy.finished" payload that names no value to re-read',
            expect.objectContaining({ state: 'runtime', event: 'deploy.finished' }),
        );
        expect(runtime.read).not.toHaveBeenCalled();
        expect(frames).not.toHaveBeenCalled();
    });

    it('C5 a cached .changedBy() event emitted on pod A: one frame on pod B, one read in total', async () =>
    {
        const bus = new FakeBus();
        const pod = () =>
        {
            const recorded = defineEvent('consent.recorded', Type.Object({ subject: Type.String() }));
            const read = vi.fn(async () => ({ value: 'agreed' as const }));
            const states = defineStateRouter({ consent: defineState('consent').value(Consent).read(read).changedBy([recorded]) });

            return { recorded, read, frame: states.events[CONSENT] };
        };
        const [podA, podB] = [pod(), pod()];
        const [cacheA, cacheB] = [createRedisPubSubCache(new FakeRedis(bus), 'c5:'), createRedisPubSubCache(new FakeRedis(bus), 'c5:')];
        await Promise.all([
            podA.recorded.useCache(cacheA), podA.frame.useCache(cacheA),
            podB.recorded.useCache(cacheB), podB.frame.useCache(cacheB),
        ]);
        const received: unknown[] = [];
        podB.frame.subscribe(payload =>
        {
            received.push(payload);
        });

        await podA.recorded.emit({ subject: 's' });
        await new Promise(resolve => setImmediate(resolve));

        expect(received).toEqual([{ at: expect.stringMatching(ISO), value: 'agreed', subject: 's' }]);
        expect(podA.read.mock.calls.length + podB.read.mock.calls.length).toBe(1);
    });

    /** A shared state whose key schema refuses extra properties, and the frames its event sends. */
    function strictRuntime()
    {
        const deployFinished = defineEvent('deploy.finished', Type.Object({ workspaceId: Type.String(), deploymentId: Type.String() }));
        const read = vi.fn(async () => ({ value: 'ready' as const }));
        const runtime = defineState('runtime')
            .key(Type.Object({ workspaceId: Type.String() }, { additionalProperties: false }), { shared: true })
            .value(Runtime)
            .canRead(() => true)
            .changedBy([deployFinished])
            .read(read);
        const states = defineStateRouter({ runtime });
        const frames = vi.fn();
        states.events[RUNTIME].subscribe(frames);

        return { deployFinished, runtime, read, frames };
    }

    it('C9 a strict key schema: a .changedBy() payload with one more field re-reads the picked key, one frame', async () =>
    {
        const { deployFinished, read, frames } = strictRuntime();

        await deployFinished.emit({ workspaceId: 'w1', deploymentId: 'd1' });

        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith({ principal: undefined, key: { workspaceId: 'w1' } });
        expect(frames).toHaveBeenCalledTimes(1);
        expect(frames.mock.calls[0][0]).toEqual({ at: expect.stringMatching(ISO), value: 'ready', key: { workspaceId: 'w1' } });
    });

    it('C10 a strict key schema: changed.emit with one more field ignores it, one frame', async () =>
    {
        const { runtime, read, frames } = strictRuntime();

        await runtime.changed.emit({ workspaceId: 'w1', extra: 1 } as never);

        expect(read).toHaveBeenCalledWith({ principal: undefined, key: { workspaceId: 'w1' } });
        expect(frames).toHaveBeenCalledTimes(1);
        expect(frames.mock.calls[0][0].key).toEqual({ workspaceId: 'w1' });
    });
});
