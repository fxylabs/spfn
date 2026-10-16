/**
 * Write route — `PUT <path>/<id>`: subject → key → `canWrite ?? canRead` →
 * `write()` → `at` → `read()` → one frame → `{ at, value, data? }`.
 *
 * | #  | situation                       | expected                                                                  |
 * |----|---------------------------------|---------------------------------------------------------------------------|
 * | W1 | valid body, `canWrite` true     | `write` called with `input`; then `read`; response `{ at, value, data }`; exactly one SSE frame with the same `at` and `value` |
 * | W2 | `canWrite` false                | 403; `write` not called; no frame                                         |
 * | W3 | invalid body                    | 400; `write` not called                                                   |
 * | W4 | state without `.write`          | `PUT` answers 404 (route absent)                                          |
 * | W5 | `write` throws                  | error propagates; no frame; `read` not called                             |
 * | W6 | `canWrite` absent, `canRead` false | 403                                                                    |
 * | W7 | keyed write `?workspaceId=w1`   | `write` ctx carries the key; frame carries `key`; a connection on `w2` receives nothing |
 */

import { Type } from '@sinclair/typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../../errors/http-errors';
import { defineEvent } from '../../event/event';
import { defineEventRouter } from '../../event/router';
import type { EventDef } from '../../event/types';
import { closeAllStreams, createStreamApp } from '../../event/sse/__tests__/stream-harness';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import type { StateRouter } from '../state-router';
import { afterInitial, Consent, ConsentData, ConsentInput, consentState, ISO, request, Role, serve, WorkspaceKey } from './state-harness';

const input = { termsVersion: '2026-10', marketing: true };

/** Every payload the state's SSE event emitted. */
function framesOf(states: StateRouter<any>, name: string): unknown[]
{
    const frames: unknown[] = [];
    (states.events as Record<string, EventDef<any>>)[name].subscribe((payload: unknown) =>
    {
        frames.push(payload);
    });

    return frames;
}

afterEach(async () =>
{
    await closeAllStreams();
});

describe('write route', () =>
{
    it('W1 valid body: write gets input, then read; response { at, value, data }; one frame with the same at and value', async () =>
    {
        const order: string[] = [];
        const consent = defineState('consent')
            .value(Consent)
            .data(ConsentData)
            .canWrite(() => true)
            .read(async () =>
            {
                order.push('read');

                return { value: 'agreed' as const, data: { marketing: true } };
            })
            .write(ConsentInput, async ({ input: received }) =>
            {
                order.push(`write ${received.termsVersion}`);
            });
        const states = defineStateRouter({ consent });
        const stream = await createStreamApp(defineEventRouter(states.events)).connect('s', { query: 'events=state.consent.changed' });
        await afterInitial(stream);
        // The connect's own read, for its initial frame: this row counts the write's.
        order.length = 0;
        const app = await serve(states);

        const res = await request(app, 's').put('/state/consent', input);
        const body = await res.json();
        const frame = await stream.frame('state.consent.changed');

        expect(res.status).toBe(200);
        expect(order).toEqual(['write 2026-10', 'read']);
        expect(body).toEqual({ at: expect.stringMatching(ISO), value: 'agreed', data: { marketing: true } });
        expect(frame.data.data).toEqual({ ...body, subject: 's' });
        expect(stream.named('state.consent.changed')).toHaveLength(1);
    });

    it('W2 canWrite false: 403, write not called, no frame', async () =>
    {
        const write = vi.fn();
        const consent = defineState('consent').value(Consent).canWrite(() => false).read(async () => ({ value: 'agreed' as const }))
            .write(ConsentInput, write);
        const states = defineStateRouter({ consent });
        const frames = framesOf(states, 'state.consent.changed');
        const app = await serve(states);

        expect((await request(app, 's').put('/state/consent', input)).status).toBe(403);
        expect(write).not.toHaveBeenCalled();
        expect(frames).toEqual([]);
    });

    it('W3 invalid body: 400, write not called', async () =>
    {
        const { state, write } = consentState();
        const app = await serve(defineStateRouter({ consent: state }));

        expect((await request(app, 's').put('/state/consent', { termsVersion: 3 })).status).toBe(400);
        expect(write).not.toHaveBeenCalled();
    });

    it('W4 a state without .write: PUT answers 404', async () =>
    {
        const consent = defineState('consent').value(Consent).read(async () => ({ value: 'agreed' as const }));
        const app = await serve(defineStateRouter({ consent }));

        expect((await request(app, 's').put('/state/consent', input)).status).toBe(404);
    });

    it('W5 write throws: the error propagates, no frame, read not called', async () =>
    {
        const read = vi.fn(async () => ({ value: 'agreed' as const }));
        const consent = defineState('consent').value(Consent).read(read).write(ConsentInput, async () =>
        {
            throw new ConflictError({ message: 'terms version superseded' });
        });
        const states = defineStateRouter({ consent });
        const frames = framesOf(states, 'state.consent.changed');
        const app = await serve(states);

        const res = await request(app, 's').put('/state/consent', input);

        expect(res.status).toBe(409);
        expect(JSON.stringify(await res.json())).toContain('terms version superseded');
        expect(read).not.toHaveBeenCalled();
        expect(frames).toEqual([]);
    });

    it('W6 canWrite absent and canRead false: 403', async () =>
    {
        const write = vi.fn();
        const consent = defineState('consent').value(Consent).canRead(() => false).read(async () => ({ value: 'agreed' as const }))
            .write(ConsentInput, write);
        const app = await serve(defineStateRouter({ consent }));

        expect((await request(app, 's').put('/state/consent', input)).status).toBe(403);
        expect(write).not.toHaveBeenCalled();
    });

    it('W7 keyed write ?workspaceId=w1: write ctx carries the key, the frame carries key', async () =>
    {
        const write = vi.fn();
        const member = defineState('member')
            .key(WorkspaceKey)
            .value(Role)
            .canRead(() => true)
            .read(async () => ({ value: 'admin' as const }))
            .write(Type.Object({ role: Type.String() }), write);
        const states = defineStateRouter({ member });
        const frames = framesOf(states, 'state.member.changed');
        const app = await serve(states);
        const ping = defineEvent('test.ping', Type.Object({ n: Type.Number() }));
        const onW2 = await createStreamApp(defineEventRouter({ ...states.events, ping }))
            .connect('s', { query: 'events=state.member.changed,ping&workspaceId=w2' });
        await afterInitial(onW2);

        const res = await request(app, 's').put('/state/member?workspaceId=w1', { role: 'admin' });
        await ping.emit({ n: 1 });
        await onW2.frame('ping');

        expect(res.status).toBe(200);
        expect(onW2.named('state.member.changed')).toEqual([]);
        expect(write).toHaveBeenCalledWith({ subject: 's', principal: { userId: 's' }, key: { workspaceId: 'w1' }, input: { role: 'admin' } });
        expect(frames).toEqual([{ at: expect.stringMatching(ISO), value: 'admin', key: { workspaceId: 'w1' }, subject: 's' }]);
    });
});
