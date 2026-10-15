/**
 * Read validation — every `read()` result is checked against `{ value, data }`
 * as declared, in one place every path uses (read, write, snapshot, change
 * signal, grant).
 *
 * | #  | situation                                                 | expected                                                      |
 * |----|-----------------------------------------------------------|---------------------------------------------------------------|
 * | V1 | `read()` returns `{ value: 'nope' }` for the consent union | `GET` answers 500; body does not contain `'nope'`; the snapshot route 500 too |
 * | V2 | `read()` returns `{}`                                     | 500                                                           |
 * | V3 | `read()` returns `{ value: 'agreed', extra: 1 }`          | 500 (undeclared field)                                        |
 * | V4 | `data` declared, `read()` returns `{ value }` only        | 500                                                           |
 * | V5 | invalid result on a change signal                         | warn with the state id; no frame                              |
 * | V6 | invalid result after a write                              | 500; no frame; the write already ran                          |
 * | V7 | valid result                                              | unchanged behaviour — the existing R / N / W / E / P rows     |
 */

import { Type } from '@sinclair/typebox';
import { Logger } from '@spfn/core/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventDef } from '../../event/types';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { Consent, ConsentData, request, serve } from './state-harness';

/** A keyless consent state whose `read()` returns `result` as is. */
function consentReturning(result: unknown, withData = false)
{
    const read = vi.fn(async () => result as never);
    const base = defineState('consent').value(Consent);
    const declared = withData ? base.data(ConsentData) : base;

    return { state: declared.read(read), read };
}

async function statusOf(result: unknown, withData = false): Promise<number>
{
    const app = await serve(defineStateRouter({ consent: consentReturning(result, withData).state }));

    return (await request(app, 's').get('/state/consent')).status;
}

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('read validation', () =>
{
    it('V1 a value outside the declared union answers 500 on GET and on the snapshot, and the body never carries it', async () =>
    {
        const app = await serve(defineStateRouter({ consent: consentReturning({ value: 'nope' }).state }));

        const res = await request(app, 's').get('/state/consent');
        const snapshot = await request(app, 's').get('/state');

        expect(res.status).toBe(500);
        expect(await res.text()).not.toContain('nope');
        expect(snapshot.status).toBe(500);
    });

    it('V2 an empty result answers 500', async () =>
    {
        expect(await statusOf({})).toBe(500);
    });

    it('V3 an undeclared field answers 500', async () =>
    {
        expect(await statusOf({ value: 'agreed', extra: 1 })).toBe(500);
    });

    it('V4 data declared but missing from the result answers 500', async () =>
    {
        expect(await statusOf({ value: 'agreed' }, true)).toBe(500);
        expect(await statusOf({ value: 'agreed', data: { marketing: true } }, true)).toBe(200);
    });

    it('V5 an invalid result on a change signal warns with the state id and sends no frame', async () =>
    {
        const warn = vi.spyOn(Logger.prototype, 'warn');
        const { state } = consentReturning({ value: 'nope' });
        const states = defineStateRouter({ consent: state });
        const frames: unknown[] = [];
        (states.events as Record<string, EventDef<any>>)['state.consent.changed'].subscribe(payload =>
        {
            frames.push(payload);
        });

        await state.changed.emit({ subject: 's' });

        expect(frames).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            'State "consent" could not be re-read on its change signal; no frame was sent',
            { state: 'consent', error: expect.stringContaining('State "consent" read() returned a result its declaration does not allow: /value') },
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('nope');
    });

    it('V6 an invalid result after a write answers 500 and sends no frame; the write already ran', async () =>
    {
        const write = vi.fn();
        const consent = defineState('consent')
            .value(Consent)
            .read(async () => ({ value: 'nope' as never }))
            .write(Type.Object({ termsVersion: Type.String() }), write);
        const states = defineStateRouter({ consent });
        const frames: unknown[] = [];
        (states.events as Record<string, EventDef<any>>)['state.consent.changed'].subscribe(payload =>
        {
            frames.push(payload);
        });
        const app = await serve(states);

        const res = await request(app, 's').put('/state/consent', { termsVersion: '2026-10' });

        expect(res.status).toBe(500);
        expect(write).toHaveBeenCalledTimes(1);
        expect(frames).toEqual([]);
    });
});
