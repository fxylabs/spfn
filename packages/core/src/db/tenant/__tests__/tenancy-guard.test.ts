/**
 * tenancy.guard and tenancy.of — rows A1–A12 of the #158 part 2 design case
 * table, and B1–B5 of the #162 one (the guard binds the transaction)
 *
 * The rows that reach the database (A5, A7, part of A8) run as the app role and
 * skip their database half when no test database is available.
 */

import { describe, it, expect, expectTypeOf, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { UnauthorizedError } from '../../../errors';
import { runInTransaction, Transactional } from '../../transaction';
import type { TenancyGuardOptions } from '../tenancy';
import { createTenancyDb } from './tenancy-db';
import { setAuthorize, tenancy, TENANCY_SCHEMA } from './tenancy-fixtures';
import { NoteRepository, WorkspaceRepository } from './tenancy-repositories';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isBegin = (statement: string) => /^begin\b/i.test(statement);
const isSetConfig = (statement: string) => statement.includes('set_config');

/** An app whose error handler answers `{ name, message }` with the error's status (500 without one). */
function createApp(): Hono
{
    const app = new Hono();

    app.onError((error, c) =>
    {
        const status = (error as { statusCode?: number }).statusCode ?? 500;

        return c.json({ name: error.name, message: error.message }, status as 400);
    });

    return app;
}

describe('tenancy.guard and tenancy.of', () =>
{
    const db = createTenancyDb();
    const noteRepository = new NoteRepository();
    const workspaceRepository = new WorkspaceRepository();
    const tenantSettings = () => db.settingLog.filter((record) => record.setting === 'app.tenant_id');
    const workspaceNames = async () => (await db.owner.unsafe(`select id, name from ${TENANCY_SCHEMA}.workspaces order by id`))
        .map((row) => `${row.id}:${row.name}`);
    const authorize = vi.fn<(tenantId: number) => boolean | Promise<boolean>>((tenantId) => tenantId > 0);
    const handler = vi.fn((c: Context) => c.json({ tenant: tenancy.of(c) }));
    const ids = (rows: { id: number }[]) => rows.map((row) => row.id);

    beforeAll(async () =>
    {
        await db.setup();
    });

    beforeEach(async () =>
    {
        authorize.mockReset().mockImplementation((tenantId) => tenantId > 0);
        handler.mockClear();
        setAuthorize(authorize);

        if (db.isAvailable)
        {
            await db.seed();
        }
    });

    afterAll(async () =>
    {
        setAuthorize(() => true);
        await db.teardown();
    });

    function paramApp(): Hono
    {
        const app = createApp();

        app.get('/w/:workspaceId/notes', tenancy.guard({ param: 'workspaceId' }), handler);
        app.get('/optional/:workspaceId?', tenancy.guard({ param: 'workspaceId' }), handler);

        return app;
    }

    function resolveApp(resolve: (c: Context) => unknown): Hono
    {
        const app = createApp();

        app.get('/me', tenancy.guard({ resolve }), handler);

        return app;
    }

    it('A1 authorize returning true runs the handler with tenancy.of(c) = 7', async () =>
    {
        const response = await paramApp().request('/w/7/notes');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ tenant: 7 });
        expect(authorize).toHaveBeenCalledWith(7);
    });

    it('A2 authorize returning false answers 403 and never runs the handler', async () =>
    {
        authorize.mockImplementation(() => false);

        const response = await paramApp().request('/w/7/notes');

        expect(response.status).toBe(403);
        expect((await response.json()).name).toBe('ForbiddenError');
        expect(handler).not.toHaveBeenCalled();
    });

    it('A3 a parameter that is not a positive safe integer answers 400 without calling authorize', async () =>
    {
        const app = paramApp();
        const paths = ['/w/abc/notes', '/w/0/notes', '/w/-1/notes', '/w/1.5/notes', '/w/9007199254740993/notes', '/optional'];

        for (const path of paths)
        {
            const response = await app.request(path);

            expect({ path, status: response.status, name: (await response.json()).name })
                .toEqual({ path, status: 400, name: 'ValidationError' });
        }

        expect(authorize).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('A4 an error thrown by authorize propagates unchanged and the handler never runs', async () =>
    {
        authorize.mockImplementation(() =>
        {
            throw new UnauthorizedError({ message: 'sign in first' });
        });

        const response = await paramApp().request('/w/7/notes');

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ name: 'UnauthorizedError', message: 'sign in first' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('A5 a handler guarded for 7 calling a method with 9 gets TenantMismatchError before any SQL', async () =>
    {
        const app = createApp();

        app.get('/w/:workspaceId/notes', tenancy.guard({ param: 'workspaceId' }), async (c) =>
            c.json(await noteRepository.list(9)));

        const response = await app.request('/w/7/notes');

        expect(response.status).toBe(500);
        expect((await response.json()).name).toBe('TenantMismatchError');

        if (db.isAvailable)
        {
            expect([...db.readLog, ...db.writeLog]).toEqual([]);
        }
    });

    it('A6 tenancy.of(c) on a route without the guard throws', async () =>
    {
        const app = createApp();

        app.get('/unguarded', handler);

        const response = await app.request('/unguarded');

        expect(response.status).toBe(500);
        expect((await response.json()).message).toContain('without tenancy.guard()');
    });

    it('A7 [guard, Transactional()] and [Transactional(), guard] both bind the transaction to tenant 7', async () =>
    {
        if (!db.isAvailable) return;

        const app = createApp();
        const respond = async (c: Context) =>
        {
            const rows = await noteRepository.list(tenancy.of(c));

            return c.json({ rows: ids(rows), tenant: (await noteRepository.session()).tenant });
        };

        app.get('/guard-first/:workspaceId', tenancy.guard({ param: 'workspaceId' }), Transactional(), respond);
        app.get('/transaction-first/:workspaceId', Transactional(), tenancy.guard({ param: 'workspaceId' }), respond);

        for (const path of ['/guard-first/7', '/transaction-first/7'])
        {
            const response = await app.request(path);

            expect({ path, body: await response.json() }).toEqual({ path, body: { rows: [1, 2], tenant: '7' } });
        }

        expect(db.readLog).toEqual([]);
    });

    it('A8 concurrent requests for tenants 7 and 9 each see their own tenant', async () =>
    {
        authorize.mockImplementation(async (tenantId: number) =>
        {
            await delay(tenantId === 7 ? 30 : 5);

            return true;
        });

        const app = createApp();

        app.get('/w/:workspaceId/notes', tenancy.guard({ param: 'workspaceId' }), async (c) =>
        {
            await delay(tenancy.of(c) === 7 ? 5 : 30);

            const rows = db.isAvailable ? ids(await noteRepository.list(tenancy.of(c))) : null;

            return c.json({ tenant: tenancy.of(c), rows });
        });

        const responses = await Promise.all(['/w/7/notes', '/w/9/notes', '/w/7/notes', '/w/9/notes'].map((path) => app.request(path)));
        const bodies = await Promise.all(responses.map((response) => response.json()));

        expect(bodies.map((body) => body.tenant)).toEqual([7, 9, 7, 9]);

        if (db.isAvailable)
        {
            expect(bodies.map((body) => body.rows)).toEqual([[1, 2], [3], [1, 2], [3]]);
        }
    });

    it('A9 resolve returning 7, with authorize passing, runs the handler with tenancy.of(c) = 7', async () =>
    {
        const response = await resolveApp(async () => 7).request('/me');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ tenant: 7 });
        expect(authorize).toHaveBeenCalledWith(7);
    });

    it('A10 resolve returning 0, NaN, a string or undefined answers 400 without calling authorize', async () =>
    {
        for (const value of [0, NaN, '7', undefined])
        {
            const response = await resolveApp(() => value).request('/me');

            expect({ value, status: response.status }).toEqual({ value, status: 400 });
        }

        expect(authorize).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('A11 an error thrown by resolve propagates; neither authorize nor the handler runs', async () =>
    {
        const response = await resolveApp(() =>
        {
            throw new UnauthorizedError();
        }).request('/me');

        expect(response.status).toBe(401);
        expect(authorize).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    /** A handler renaming the guarded workspace through a plain BaseRepository. */
    const rename = async (c: Context) =>
        c.json({ renamed: (await workspaceRepository.rename(tenancy.of(c), 'renamed')).map((row) => row.id) });

    it('B1 [guard 7, Transactional()]: the transaction is bound to 7 at BEGIN, so a BaseRepository rename of workspace 7 works', async () =>
    {
        if (!db.isAvailable) return;

        const app = createApp();

        app.patch('/w/:workspaceId', tenancy.guard({ param: 'workspaceId' }), Transactional(), rename);

        const response = await app.request('/w/7', { method: 'PATCH' });

        expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { renamed: [7] } });
        expect(await workspaceNames()).toEqual(['7:renamed', '9:nine', '11:eleven']);
        // Bound inside the root's opening statements, before the handler's first query
        expect(db.writeLog.slice(db.writeLog.findIndex(isBegin), db.writeLog.findIndex(isSetConfig)).every((statement) =>
            isBegin(statement) || /^set local/i.test(statement))).toBe(true);
        expect(db.writeLog.findIndex(isSetConfig)).toBeLessThan(db.writeLog.findIndex((statement) => /^update/i.test(statement)));
        expect(tenantSettings()).toEqual([{ pool: 'write', setting: 'app.tenant_id', value: '7' }]);
    });

    it('B2 [Transactional(), guard 7]: the guard binds the open transaction, so the same rename works', async () =>
    {
        if (!db.isAvailable) return;

        const app = createApp();

        app.patch('/w/:workspaceId', Transactional(), tenancy.guard({ param: 'workspaceId' }), rename);

        const response = await app.request('/w/7', { method: 'PATCH' });

        expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { renamed: [7] } });
        expect(await workspaceNames()).toEqual(['7:renamed', '9:nine', '11:eleven']);
        expect(tenantSettings()).toEqual([{ pool: 'write', setting: 'app.tenant_id', value: '7' }]);
    });

    it('B3 runInTransaction({ tenant: 9 }) under guard 7 binds 9 as asked; a TenantRepository call for 9 is refused by the guard', async () =>
    {
        if (!db.isAvailable) return;

        const app = createApp();

        app.get('/w/:workspaceId', tenancy.guard({ param: 'workspaceId' }), async (c) =>
            c.json(await runInTransaction(async () =>
            {
                const session = await noteRepository.session();
                const refused = await noteRepository.list(9).then(() => 'ran', (error: Error) => error.message);

                return { tenant: session.tenant, refused };
            }, { tenant: 9 })));

        const response = await app.request('/w/7');

        expect(await response.json()).toEqual({
            tenant: '9',
            refused: 'Tenant 9 does not match the tenant 7 this request was authorized for by tenancy.guard()',
        });
    });

    it('B4 runInTransaction() under guard 7 is bound at BEGIN; _findMany(7, …) inside sets nothing again', async () =>
    {
        if (!db.isAvailable) return;

        const app = createApp();

        app.get('/w/:workspaceId', tenancy.guard({ param: 'workspaceId' }), async (c) =>
            c.json(ids(await runInTransaction(() => noteRepository.list(tenancy.of(c))))));

        const response = await app.request('/w/7');

        expect(await response.json()).toEqual([1, 2]);
        expect(db.writeLog.filter(isSetConfig)).toHaveLength(1);
        expect(tenantSettings()).toEqual([{ pool: 'write', setting: 'app.tenant_id', value: '7' }]);
    });

    it('B5 Transactional() on a route without the guard is not bound until the first TenantRepository call (R3)', async () =>
    {
        if (!db.isAvailable) return;

        const app = createApp();

        app.get('/unguarded', Transactional(), async (c) =>
        {
            const before = await noteRepository.session();
            const rows = ids(await noteRepository.list(7));

            return c.json({ before: before.tenant ?? '', rows, after: (await noteRepository.session()).tenant });
        });

        const response = await app.request('/unguarded');

        expect(await response.json()).toEqual({ before: '', rows: [1, 2], after: '7' });
        expect(tenantSettings()).toHaveLength(1);
    });

    it('A12 tenancy.guard throws when called with both param and resolve, or with neither', () =>
    {
        expect(() => tenancy.guard({ param: 'workspaceId', resolve: () => 7 } as never))
            .toThrow('tenancy.guard() takes exactly one of { param } or { resolve }');
        expect(() => tenancy.guard({} as never)).toThrow('tenancy.guard() takes exactly one of { param } or { resolve }');
        expect(() => tenancy.guard({ param: '' })).toThrow('takes a route parameter name');

        expectTypeOf<{ param: string; resolve: () => number }>().not.toMatchTypeOf<TenancyGuardOptions>();
        expectTypeOf<{}>().not.toMatchTypeOf<TenancyGuardOptions>();
        expectTypeOf<{ param: string }>().toMatchTypeOf<TenancyGuardOptions>();
        expectTypeOf(tenancy.guard).returns.toEqualTypeOf<MiddlewareHandler>();
    });
});
