/**
 * SSE initial frames — each allowed state's current frame, written right
 * after `connected` and before any live frame, through the real handler.
 * The router: `consent` keyless with data, `runtime` keyed and shared.
 *
 * | #   | situation                                                  | expected                                                       |
 * |-----|------------------------------------------------------------|----------------------------------------------------------------|
 * | C1  | connect with `workspaceId=w1`                              | `initial` = both events in declaration order; then `state.consent.changed { at, value, data, subject }`, then `state.runtime.changed { at, value, key: { workspaceId: 'w1' } }` |
 * | C2  | `runtime` without `workspaceId` in the query               | denied as today; `initial` = consent only; runtime never read  |
 * | C3  | `consent.read` throws                                      | warn naming the state, never the error; `initial` = runtime only; runtime's frame written |
 * | C3' | `consent.read` returns a result its declaration refuses    | the same: warn, left out of `initial`, no consent frame        |
 * | C4  | `canRead` false for `consent`                              | in `deniedEvents`; no read attempted                           |
 * | C5  | the frame's `at`                                           | equals the read's start, newer than the render's `at` when the clock advanced |
 */

import { Logger } from '@spfn/core/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineEventRouter } from '../../event/router';
import { closeAllStreams, createStreamApp } from '../../event/sse/__tests__/stream-harness';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { Consent, ConsentData, consentState, ISO, request, runtimeState, serve } from './state-harness';

const CONSENT = 'state.consent.changed';
const RUNTIME = 'state.runtime.changed';

/** One SSE handler serving `states`; `connect` resolves with the stream and its `connected` data. */
function streamApp(states: ReturnType<typeof defineStateRouter<any>>)
{
    const app = createStreamApp(defineEventRouter(states.events));

    return async (query: string) =>
    {
        const stream = await app.connect('s', { query });
        const connected = await stream.frame('connected');

        return { stream, connected: connected.data };
    };
}

afterEach(async () =>
{
    await closeAllStreams();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('SSE initial frames', () =>
{
    it('C1 each allowed state\'s current frame follows connected, in declaration order', async () =>
    {
        const consent = consentState();
        const runtime = runtimeState();
        const connect = streamApp(defineStateRouter({ consent: consent.state, runtime: runtime.state }));

        const { stream, connected } = await connect(`events=${CONSENT},${RUNTIME}&workspaceId=w1`);
        await stream.frame(RUNTIME);

        expect(connected.initial).toEqual([CONSENT, RUNTIME]);
        expect(stream.frames.map(frame => [frame.event, frame.data.data])).toEqual([
            ['connected', undefined],
            [CONSENT, { at: expect.stringMatching(ISO), value: 'agreed', data: { marketing: true }, subject: 's' }],
            [RUNTIME, { at: expect.stringMatching(ISO), value: 'ready', key: { workspaceId: 'w1' } }],
        ]);
    });

    it('C2 runtime without workspaceId: denied as today, never read; initial is consent only', async () =>
    {
        const consent = consentState();
        const runtime = runtimeState();
        const connect = streamApp(defineStateRouter({ consent: consent.state, runtime: runtime.state }));

        const { stream, connected } = await connect(`events=${CONSENT},${RUNTIME}`);
        await stream.frame(CONSENT);

        expect(connected.deniedEvents).toEqual([RUNTIME]);
        expect(connected.initial).toEqual([CONSENT]);
        expect(runtime.read).not.toHaveBeenCalled();
    });

    it('C3 consent.read throws: warned naming the state, never the error; initial is runtime only', async () =>
    {
        const warn = vi.spyOn(Logger.prototype, 'warn');
        const consent = consentState();
        consent.read.mockRejectedValueOnce(new Error('db secret detail'));
        const runtime = runtimeState();
        const connect = streamApp(defineStateRouter({ consent: consent.state, runtime: runtime.state }));

        const { stream, connected } = await connect(`events=${CONSENT},${RUNTIME}&workspaceId=w1`);
        await stream.frame(RUNTIME);

        expect(connected.initial).toEqual([RUNTIME]);
        expect(stream.frames.map(frame => frame.event)).toEqual(['connected', RUNTIME]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('initial frames could not be produced'), { event: CONSENT, subject: 's' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('db secret detail');
    });

    it('C3\' consent.read returns an undeclared result: the same path — warned, left out of initial, no frame', async () =>
    {
        const warn = vi.spyOn(Logger.prototype, 'warn');
        const consent = defineState('consent')
            .value(Consent)
            .data(ConsentData)
            .read(async () => ({ value: 'unknown' as never, data: { marketing: true } }));
        const runtime = runtimeState();
        const connect = streamApp(defineStateRouter({ consent, runtime: runtime.state }));

        const { stream, connected } = await connect(`events=${CONSENT},${RUNTIME}&workspaceId=w1`);
        await stream.frame(RUNTIME);

        expect(connected.initial).toEqual([RUNTIME]);
        expect(stream.named(CONSENT)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('initial frames could not be produced'), { event: CONSENT, subject: 's' });
    });

    it('C4 canRead false for consent: in deniedEvents, no read attempted', async () =>
    {
        const read = vi.fn(async () => ({ value: 'agreed' as const, data: { marketing: true } }));
        const consent = defineState('consent').value(Consent).data(ConsentData).canRead(() => false).read(read);
        const runtime = runtimeState();
        const connect = streamApp(defineStateRouter({ consent, runtime: runtime.state }));

        const { stream, connected } = await connect(`events=${CONSENT},${RUNTIME}&workspaceId=w1`);
        await stream.frame(RUNTIME);

        expect(connected.deniedEvents).toEqual([CONSENT]);
        expect(connected.initial).toEqual([RUNTIME]);
        expect(read).not.toHaveBeenCalled();
    });

    it('C5 the frame\'s at is the read\'s start, newer than the render\'s at once the clock advanced', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const consent = consentState();
        let readStart = '';
        consent.read.mockImplementation(async ({ subject }) =>
        {
            readStart = new Date().toISOString();

            return { value: 'agreed', data: { marketing: subject === 's' } };
        });
        const states = defineStateRouter({ consent: consent.state });
        vi.setSystemTime(new Date('2026-10-16T09:00:00.000Z'));
        const render = await (await request(await serve(states), 's').get('/state')).json();

        vi.setSystemTime(new Date('2026-10-16T09:00:05.000Z'));
        const { stream } = await streamApp(states)(`events=${CONSENT}`);
        const frame = await stream.frame(CONSENT);

        expect(frame.data.data.at).toBe(readStart);
        expect(frame.data.data.at).toBe('2026-10-16T09:00:05.000Z');
        expect(frame.data.data.at > render.at).toBe(true);
    });
});
