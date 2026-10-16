/**
 * Principal at runtime (#138) — a state that declared `.principal()` refuses a
 * write without one, so `canWrite` / `write` can be typed without `undefined`.
 * The subject comes from `x-subject`, so a request can carry a subject and no
 * `auth`; `x-user` sets `auth` through the harness's test middleware.
 *
 * | #  | situation                                                          | expected                                          |
 * |----|--------------------------------------------------------------------|---------------------------------------------------|
 * | R1 | `.principal<Auth>()` state, PUT with `x-subject` and no `auth`     | 401; `canWrite` and `write` not called            |
 * | R2 | same request, state without `.principal()`                         | 200; `write` called with `principal: undefined`   |
 * | R3 | `.principal<Auth>()` state, request with `auth` set                | 200; `write` and `canWrite` receive the `auth` object |
 * | R4 | `.principal<Auth>()` state, `GET /state/consent` and `GET /state` without `auth` | 200; `read` receives `principal: undefined` |
 * | R5 | `.principal()` twice                                               | throws, naming `principal` like the other `assertOnce` refusals |
 * | R6 | `.principal<Auth>()` state, an auth middleware that sets `auth` to `null`, PUT with `x-subject` | 401; `canWrite` and `write` not called |
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { defineRouter } from '../../route/router';
import { defineServerConfig } from '../../server/config-builder';
import { createServer } from '../../server/create-server';
import { defineState } from '../state-builder';
import { defineStateRouter, type StateRouter } from '../state-router';
import { Consent, ConsentInput, serve } from './state-harness';

interface Auth
{
    userId: string;
    role?: string;
}

const input = { termsVersion: '2026-10', marketing: true };

/** A keyless consent state, with or without `.principal<Auth>()`; its callbacks are spies. */
function consentRouter(declared: boolean)
{
    const read = vi.fn(async (_ctx: { principal: unknown }) => ({ value: 'agreed' as const }));
    const canWrite = vi.fn((_ctx: { principal: unknown }) => true);
    const write = vi.fn(async (_ctx: { principal: unknown }) =>
    {
    });
    const base = defineState('consent');
    const consent = (declared ? base.principal<Auth>() : base)
        .value(Consent)
        .canWrite(canWrite)
        .read(read)
        .write(ConsentInput, write);
    const states = defineStateRouter({ consent }, { subject: c => c.req.header('x-subject') ?? null });

    return { states, read, canWrite, write };
}

/** A request as subject `s`, carrying `auth` only when `user` is given. */
function headers(user?: string): Record<string, string>
{
    return { 'x-subject': 's', 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) };
}

/** An auth middleware that answers "nobody" with `null` rather than leaving `auth` unset. */
const nullAuth: MiddlewareHandler = async (c, next) =>
{
    c.set('auth', null);
    await next();
};

function serveWithNullAuth(states: StateRouter<any>)
{
    return createServer(defineServerConfig()
        .infrastructure({ database: false, redis: false })
        .use([nullAuth])
        .routes(defineRouter({}).packages([states.router]))
        .build());
}

describe('principal at runtime', () =>
{
    it('R1 a declared principal and a write without auth: 401, neither canWrite nor write runs', async () =>
    {
        const { states, canWrite, write } = consentRouter(true);
        const app = await serve(states);

        const res = await app.request('/state/consent', { method: 'PUT', headers: headers(), body: JSON.stringify(input) });

        expect(res.status).toBe(401);
        expect((await res.json()).message).toContain('State "consent" declares .principal(), and this request carries none');
        expect(canWrite).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it('R2 no declared principal and a write without auth: 200, write receives principal undefined', async () =>
    {
        const { states, write } = consentRouter(false);
        const app = await serve(states);

        const res = await app.request('/state/consent', { method: 'PUT', headers: headers(), body: JSON.stringify(input) });

        expect(res.status).toBe(200);
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ subject: 's', principal: undefined }));
    });

    it('R3 a declared principal and a write with auth: 200, canWrite and write receive the auth object', async () =>
    {
        const { states, canWrite, write } = consentRouter(true);
        const app = await serve(states);

        const res = await app.request('/state/consent', { method: 'PUT', headers: headers('u1'), body: JSON.stringify(input) });

        expect(res.status).toBe(200);
        expect(canWrite).toHaveBeenCalledWith(expect.objectContaining({ principal: { userId: 'u1', role: undefined } }));
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ principal: { userId: 'u1', role: undefined } }));
    });

    it('R4 a declared principal never refuses a read: the read and snapshot routes answer, read gets undefined', async () =>
    {
        const { states, read } = consentRouter(true);
        const app = await serve(states);

        const one = await app.request('/state/consent', { headers: headers() });
        const all = await app.request('/state', { headers: headers() });

        expect(one.status).toBe(200);
        expect(all.status).toBe(200);
        expect(read).toHaveBeenCalledTimes(2);
        expect(read.mock.calls.map(([ctx]) => ctx.principal)).toEqual([undefined, undefined]);
    });

    it('R5 .principal() twice is refused like every second declaration', () =>
    {
        expect(() => defineState('consent').principal<Auth>().principal<Auth>())
            .toThrow('State "consent" already declares .principal().');
    });

    it('R6 a declared principal and an auth middleware that sets null: 401, neither canWrite nor write runs', async () =>
    {
        const { states, canWrite, write } = consentRouter(true);
        const app = await serveWithNullAuth(states);

        const res = await app.request('/state/consent', { method: 'PUT', headers: headers(), body: JSON.stringify(input) });

        expect(res.status).toBe(401);
        expect((await res.json()).message).toContain('State "consent" declares .principal(), and this request carries none');
        expect(canWrite).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });
});
