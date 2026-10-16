/**
 * Frames after commit (#137) — inside a transaction the frame of a write, a
 * change signal or a grant waits for the root transaction's after-commit queue;
 * outside one it is emitted inline, as before. No database: the transaction is
 * an async context set with `runWithTransaction`, and its queued callbacks are
 * read from `getTransactionContext()`.
 *
 * | #  | situation                                          | expected                                                          |
 * |----|----------------------------------------------------|-------------------------------------------------------------------|
 * | T1 | PUT inside `runWithTransaction`                    | 200 with the snapshot; no emit while the callback is open; exactly one after-commit callback; running it emits once, with the value `read` returned inside |
 * | T2 | PUT with no transaction context                    | emitted inline, before the response resolves; frame byte-equal to the response plus `subject` |
 * | T3 | `changed.emit({ subject })` inside `runWithTransaction` | no frame until the queued callback runs; then one            |
 * | T7 | `emit` throws, no transaction                      | the PUT fails (500), as before                                    |
 * | T9 | `emit` throws, no transaction, `changed.emit({ subject })` | `changed.emit` resolves; the state logger warns once, naming the state |
 *
 * The context is set through `@spfn/core/db`, the entry `state-event.ts`
 * imports: the transaction context is one `AsyncLocalStorage` per module
 * instance, and the state module reads the instance of that entry.
 */

import { getTransactionContext, runWithTransaction } from '@spfn/core/db';
import type { AfterCommitCallback } from '@spfn/core/db';
import { Logger } from '@spfn/core/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventDef } from '../../event/types';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import type { StateRouter } from '../state-router';
import { Consent, ConsentData, ConsentInput, ISO, request, serve } from './state-harness';

const input = { termsVersion: '2026-10', marketing: true };

/** A keyless consent state whose `read` answers what `write` last stored. */
function consentRouter(): StateRouter<any>
{
    let stored: 'pending' | 'agreed' = 'pending';
    const consent = defineState('consent')
        .value(Consent)
        .data(ConsentData)
        .read(async () => ({ value: stored, data: { marketing: false } }))
        .write(ConsentInput, async () =>
        {
            stored = 'agreed';
        });

    return defineStateRouter({ consent });
}

function stateEvent(states: StateRouter<any>): EventDef<any>
{
    return (states.events as Record<string, EventDef<any>>)['state.consent.changed'];
}

/** Every payload the state's SSE event emitted. */
function framesOf(states: StateRouter<any>): unknown[]
{
    const frames: unknown[] = [];
    stateEvent(states).subscribe((payload: unknown) =>
    {
        frames.push(payload);
    });

    return frames;
}

/** Run `fn` inside a transaction context; return its result, the frames seen inside, and the queued callbacks. */
async function inTransaction<T>(frames: unknown[], fn: () => Promise<T>)
{
    return runWithTransaction({} as never, 'tx-test', async () =>
    {
        const result = await fn();

        return { result, framesInside: frames.length, queued: [...getTransactionContext()!.afterCommitCallbacks] };
    });
}

async function runQueued(queued: AfterCommitCallback[]): Promise<void>
{
    for (const callback of queued)
    {
        await callback();
    }
}

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('frames after commit', () =>
{
    it('T1 PUT inside a transaction queues one after-commit emit carrying the value read inside', async () =>
    {
        const states = consentRouter();
        const frames = framesOf(states);
        const app = await serve(states);

        const { result: res, framesInside, queued } = await inTransaction(frames, async () => request(app, 's').put('/state/consent', input));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ at: expect.stringMatching(ISO), value: 'agreed', data: { marketing: false } });
        expect(framesInside).toBe(0);
        expect(queued).toHaveLength(1);

        await runQueued(queued);

        expect(frames).toEqual([{ ...body, subject: 's' }]);
    });

    it('T2 PUT with no transaction emits inline before the response resolves, byte-equal to today', async () =>
    {
        const states = consentRouter();
        const frames = framesOf(states);
        const app = await serve(states);

        const res = await request(app, 's').put('/state/consent', input);
        const framesAtResponse = frames.length;
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(framesAtResponse).toBe(1);
        expect(JSON.stringify(frames[0])).toBe(JSON.stringify({ ...body, subject: 's' }));
    });

    it('T3 changed.emit inside a transaction sends no frame until the queued callback runs', async () =>
    {
        const states = consentRouter();
        const frames = framesOf(states);

        const { framesInside, queued } = await inTransaction(frames, () => states.states.consent.changed.emit({ subject: 's' }));

        expect(framesInside).toBe(0);
        expect(frames).toHaveLength(0);
        expect(queued).toHaveLength(1);

        await runQueued(queued);

        expect(frames).toEqual([{ at: expect.stringMatching(ISO), value: 'pending', data: { marketing: false }, subject: 's' }]);
    });

    it('T7 an emit that throws with no transaction fails the PUT, as before', async () =>
    {
        const states = consentRouter();
        vi.spyOn(stateEvent(states), 'emit').mockRejectedValue(new Error('transport down'));
        const app = await serve(states);

        const res = await request(app, 's').put('/state/consent', input);

        expect(res.status).toBe(500);
    });

    it('T9 an emit that throws on the change signal is logged at warn; changed.emit resolves', async () =>
    {
        const states = consentRouter();
        vi.spyOn(stateEvent(states), 'emit').mockRejectedValue(new Error('transport down'));
        const warn = vi.spyOn(Logger.prototype, 'warn');

        await expect(states.states.consent.changed.emit({ subject: 's' })).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            'State "consent" could not be re-read or published on its change signal; no frame was sent',
            { state: 'consent', error: 'transport down' },
        );
    });
});
