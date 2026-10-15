/**
 * Snapshot — `GET <path>`: one `at`, every readable state in declaration order.
 *
 * | #   | situation                                 | expected                                                     |
 * |-----|-------------------------------------------|--------------------------------------------------------------|
 * | N1  | two keyless states                        | `{ at, states: { consent, runtime } }` in declaration order, one `at` for both |
 * | N2  | keyed state with its key in the query     | included                                                     |
 * | N2' | same, without the key                     | omitted, no error, the keyless ones still present            |
 * | N3  | `canRead` false for one state             | that one omitted                                             |
 * | N3' | same                                      | the others present                                           |
 * | N4  | no subject                                | 401                                                          |
 * | N5  | one `read` throws                         | whole request fails with that error                          |
 * | N6  | each `read()` observes the clock          | the response `at` ≤ the time each `read()` started           |
 * | N7  | `GET /state`                              | `manifest` in declaration order with `key` and `write`, built once at router build |
 */

import { describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../../errors/http-errors';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { stateManifest } from '../state-routes';
import { consentState, ISO, memberState, request, Runtime, serve } from './state-harness';

// The manifest builder, spied so N7 can count how often it runs.
vi.mock('../state-routes', async (importOriginal) =>
{
    const routes = await importOriginal<typeof import('../state-routes')>();

    return { ...routes, stateManifest: vi.fn(routes.stateManifest) };
});

/** A keyless runtime state, beside the keyless consent of N1. */
function keylessRuntime(canRead: () => boolean = () => true)
{
    const read = vi.fn(async () => ({ value: 'ready' as const }));

    return { state: defineState('runtime').value(Runtime).canRead(canRead).read(read), read };
}

/** A keyless state whose `read()` records when it started, then takes a few milliseconds. */
function clockedState<TId extends string>(id: TId, started: number[])
{
    return defineState(id).value(Runtime).read(async () =>
    {
        started.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 5));

        return { value: 'ready' as const };
    });
}

describe('snapshot route', () =>
{
    it('N1 two keyless states: { at, states } in declaration order, one at for both', async () =>
    {
        const consent = consentState();
        const runtime = keylessRuntime();
        const app = await serve(defineStateRouter({ runtime: runtime.state, consent: consent.state }));

        const res = await request(app, 's').get('/state');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({
            at: expect.stringMatching(ISO),
            states: { runtime: { value: 'ready' }, consent: { value: 'agreed', data: { marketing: true } } },
            manifest: { runtime: { key: [], write: false }, consent: { key: [], write: true } },
        });
        expect(Object.keys(body.states)).toEqual(['runtime', 'consent']);
        expect(JSON.stringify(body.states)).not.toContain('"at"');
        expect(consent.read).toHaveBeenCalledTimes(1);
        expect(runtime.read).toHaveBeenCalledTimes(1);
    });

    it('N2 a keyed state whose key is in the query is included', async () =>
    {
        const member = memberState();
        const app = await serve(defineStateRouter({ consent: consentState().state, member: member.state }));

        const body = await (await request(app, 's').get('/state?workspaceId=w1')).json();

        expect(body.states.member).toEqual({ value: 'owner' });
        expect(member.read).toHaveBeenCalledWith({ subject: 's', principal: { userId: 's' }, key: { workspaceId: 'w1' } });
    });

    it('N2\' without its key the keyed state is omitted, no error, and a later keyless state still runs', async () =>
    {
        const member = memberState();
        const runtime = keylessRuntime();
        const app = await serve(defineStateRouter({ consent: consentState().state, member: member.state, runtime: runtime.state }));

        const res = await request(app, 's').get('/state');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(Object.keys(body.states)).toEqual(['consent', 'runtime']);
        expect(member.read).not.toHaveBeenCalled();
        expect(member.canRead).not.toHaveBeenCalled();
    });

    it('N3 canRead false for one state: that one omitted', async () =>
    {
        const runtime = keylessRuntime(() => false);
        const app = await serve(defineStateRouter({ consent: consentState().state, runtime: runtime.state }));

        const body = await (await request(app, 's').get('/state')).json();

        expect(body.states).not.toHaveProperty('runtime');
        expect(runtime.read).not.toHaveBeenCalled();
    });

    it('N3\' canRead false for one state: the others present', async () =>
    {
        const app = await serve(defineStateRouter({ runtime: keylessRuntime(() => false).state, consent: consentState().state }));

        const body = await (await request(app, 's').get('/state')).json();

        expect(body.states).toEqual({ consent: { value: 'agreed', data: { marketing: true } } });
    });

    it('N4 no subject: 401', async () =>
    {
        const consent = consentState();
        const app = await serve(defineStateRouter({ consent: consent.state }));

        expect((await request(app, undefined).get('/state')).status).toBe(401);
        expect(consent.read).not.toHaveBeenCalled();
    });

    it('N5 one read throws: the whole request fails with that error', async () =>
    {
        const failing = defineState('runtime').value(Runtime).read(async () =>
        {
            throw new ConflictError({ message: 'runtime row locked' });
        });
        const app = await serve(defineStateRouter({ consent: consentState().state, runtime: failing }));

        const res = await request(app, 's').get('/state');

        expect(res.status).toBe(409);
        expect(JSON.stringify(await res.json())).toContain('runtime row locked');
    });

    it('N6 the snapshot at is taken before any read() starts', async () =>
    {
        const started: number[] = [];
        const app = await serve(defineStateRouter({ one: clockedState('one', started), two: clockedState('two', started) }));

        const body = await (await request(app, 's').get('/state')).json();

        expect(started).toHaveLength(2);
        for (const time of started)
        {
            expect(Date.parse(body.at)).toBeLessThanOrEqual(time);
        }
    });

    it('N7 the snapshot carries the manifest in declaration order, built once when the router is built', async () =>
    {
        vi.mocked(stateManifest).mockClear();
        const states = defineStateRouter({ member: memberState().state, consent: consentState().state, runtime: keylessRuntime().state });
        const app = await serve(states);

        const first = await (await request(app, 's').get('/state')).json();
        const second = await (await request(app, 's').get('/state?workspaceId=w1')).json();

        expect(first.manifest).toEqual({
            member: { key: ['workspaceId'], write: false },
            consent: { key: [], write: true },
            runtime: { key: [], write: false },
        });
        expect(Object.keys(first.manifest)).toEqual(['member', 'consent', 'runtime']);
        expect(second.manifest).toEqual(first.manifest);
        expect(stateManifest).toHaveBeenCalledTimes(1);
    });
});
