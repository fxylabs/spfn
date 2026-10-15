/**
 * Read route — `GET <path>/<id>`: subject → key → `canRead` → `at` → `read()`.
 *
 * | #  | situation                                  | expected                                                       |
 * |----|--------------------------------------------|----------------------------------------------------------------|
 * | R1 | keyless, subject present, `canRead` absent | 200 `{ at, value, data }`; `at` is ISO and ≤ the time `read()` observed |
 * | R2 | no subject (resolver returns null)         | 401; `read` not called                                         |
 * | R3 | `canRead` → false                          | 403; `read` not called                                         |
 * | R4 | keyed, `?workspaceId=w1`                   | `read` receives `{ subject, principal, key: { workspaceId: 'w1' } }` |
 * | R5 | keyed, key field absent                    | 400; `canRead` not called                                      |
 * | R6 | keyed shared                               | `read` ctx has no `subject` property                           |
 * | R7 | `read` throws                              | the error handler's status for that error (not 403); nothing swallowed |
 * | R8 | `c.get('auth')` set by a test middleware   | `principal` is that object                                     |
 * | R9 | custom `subject` resolver                  | used instead of `auth.userId`                                  |
 */

import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../errors/http-errors';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { Consent, ConsentData, consentState, ISO, memberState, request, runtimeState, serve } from './state-harness';

describe('read route', () =>
{
    it('R1 keyless, subject present, no canRead: 200 { at, value, data }, at ISO and not after read() started', async () =>
    {
        let observed = 0;
        const read = vi.fn(async () =>
        {
            observed = Date.now();

            return { value: 'agreed' as const, data: { marketing: true } };
        });
        const consent = defineState('consent').value(Consent).data(ConsentData).read(read);
        const app = await serve(defineStateRouter({ consent }));

        const res = await request(app, 's').get('/state/consent');
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ at: expect.stringMatching(ISO), value: 'agreed', data: { marketing: true } });
        expect(Date.parse(body.at)).toBeLessThanOrEqual(observed);
        expect(read).toHaveBeenCalledWith({ subject: 's', principal: { userId: 's' } });
    });

    it('R2 no subject: 401, read not called', async () =>
    {
        const { state, read } = consentState();
        const app = await serve(defineStateRouter({ consent: state }));

        expect((await request(app, undefined).get('/state/consent')).status).toBe(401);
        expect(read).not.toHaveBeenCalled();
    });

    it('R3 canRead false: 403, read not called', async () =>
    {
        const read = vi.fn(async () => ({ value: 'agreed' as const }));
        const consent = defineState('consent').value(Consent).canRead(() => false).read(read);
        const app = await serve(defineStateRouter({ consent }));

        expect((await request(app, 's').get('/state/consent')).status).toBe(403);
        expect(read).not.toHaveBeenCalled();
    });

    it('R4 keyed ?workspaceId=w1: read receives { subject, principal, key }', async () =>
    {
        const { state, read } = memberState();
        const app = await serve(defineStateRouter({ member: state }));

        const res = await request(app, 's').get('/state/member?workspaceId=w1');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ at: expect.stringMatching(ISO), value: 'owner' });
        expect(read).toHaveBeenCalledWith({ subject: 's', principal: { userId: 's' }, key: { workspaceId: 'w1' } });
    });

    it('R5 keyed, key field absent: 400, canRead not called', async () =>
    {
        const { state, canRead, read } = memberState();
        const app = await serve(defineStateRouter({ member: state }));

        expect((await request(app, 's').get('/state/member')).status).toBe(400);
        expect(canRead).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });

    it('R6 keyed shared: the read ctx has no subject property', async () =>
    {
        const { state, read, canRead } = runtimeState();
        const app = await serve(defineStateRouter({ runtime: state }));

        expect((await request(app, 's').get('/state/runtime?workspaceId=w1')).status).toBe(200);
        expect(read.mock.calls[0][0]).not.toHaveProperty('subject');
        expect(read.mock.calls[0][0]).toEqual({ principal: { userId: 's' }, key: { workspaceId: 'w1' } });
        expect(canRead.mock.calls[0][0]).toEqual({ subject: 's', principal: { userId: 's' }, key: { workspaceId: 'w1' } });
    });

    it('R7 read throws: the error handler\'s status for that error, not 403', async () =>
    {
        const consent = defineState('consent').value(Consent).read(async () =>
        {
            throw new NotFoundError({ message: 'no consent row' });
        });
        const app = await serve(defineStateRouter({ consent }));

        const res = await request(app, 's').get('/state/consent');

        expect(res.status).toBe(404);
        expect(JSON.stringify(await res.json())).toContain('no consent row');
    });

    it('R8 the auth object a middleware set is the principal', async () =>
    {
        const read = vi.fn(async () => ({ value: 'agreed' as const }));
        const canRead = vi.fn(() => true);
        const consent = defineState('consent').value(Consent).canRead(canRead).read(read);
        const app = await serve(defineStateRouter({ consent }));

        await app.request('/state/consent', { headers: { 'x-user': 's', 'x-role': 'admin' } });

        expect(canRead).toHaveBeenCalledWith({ subject: 's', principal: { userId: 's', role: 'admin' } });
        expect(read).toHaveBeenCalledWith({ subject: 's', principal: { userId: 's', role: 'admin' } });
    });

    it('R9 a custom subject resolver is used instead of auth.userId', async () =>
    {
        const { state, read } = consentState();
        const app = await serve(defineStateRouter({ consent: state }, { subject: c => c.req.header('x-subject') ?? null }));

        expect((await request(app, 's').get('/state/consent')).status).toBe(401);
        await app.request('/state/consent', { headers: { 'x-user': 's', 'x-subject': 'custom' } });

        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0][0]).toMatchObject({ subject: 'custom' });
    });
});
