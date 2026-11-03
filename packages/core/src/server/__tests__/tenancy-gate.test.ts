/**
 * Tenancy boot check — rows B1–B7 of the #158 part 2 design case table, and
 * O1–O2 of the #162 one (a `visibleThrough` tenant list is checked too)
 *
 * B5 and B7 run first, before this file defines any tenancy table; B7 defines
 * them during `createServer`, as an app whose `app.ts` imports its routes does. The rows that
 * read a real role (B1, B2, B4) use the tenancy test database — the owner
 * connection stands in for an app that connects as the owner — and skip when
 * it is not available; B3 and B6 use a stub, since the test roles cannot be
 * made superuser and a failing query needs no database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgSchema } from 'drizzle-orm/pg-core';
import { serve } from '@hono/node-server';
import { closeDatabase, defineTenancy, id, listTenancyTables } from '../../db';
import { createServer } from '../create-server';
import { serverLogger } from '../logger';
import { startServer } from '../start-server';
import { runTenancyBootGate, TenancyRoleError, type TenancyGateDb } from '../tenancy-gate';
import type { TenancyDb } from '../../db/tenant/__tests__/tenancy-db';

vi.mock('@hono/node-server', () => ({
    serve: vi.fn(),
}));

// An app whose custom app.ts imports its routes: the tenancy tables those
// routes use are defined only while createServer builds the app
vi.mock('../create-server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('../create-server')>();

    return {
        ...actual,
        createServer: vi.fn(async (config?: Parameters<typeof actual.createServer>[0]) =>
        {
            await import('../../db/tenant/__tests__/tenancy-fixtures');

            return actual.createServer(config);
        }),
    };
});

/** A database whose role query answers `row`. */
function stubDb(row: { role: string; superuser: boolean; bypass_rls: boolean; owned: string[] }): TenancyGateDb
{
    return { execute: vi.fn(async () => [row]) };
}

describe('tenancy boot check', () =>
{
    const originalNodeEnv = process.env.NODE_ENV;
    let warn: ReturnType<typeof vi.spyOn>;
    let error: ReturnType<typeof vi.spyOn>;

    beforeEach(() =>
    {
        warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);
        error = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() =>
    {
        process.env.NODE_ENV = originalNodeEnv;
        vi.restoreAllMocks();
    });

    it('B5 with no tenancy table it sends no query at all', async () =>
    {
        const db = stubDb({ role: 'postgres', superuser: true, bypass_rls: true, owned: [] });

        expect(await runTenancyBootGate([db])).toEqual({ state: 'skipped', reason: 'no tenancy tables' });
        expect(db.execute).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('B7 tables defined only while the server is built still refuse a production boot before it listens', async () =>
    {
        process.env.NODE_ENV = 'production';
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');

        const owner = stubDb({ role: 'app', superuser: false, bypass_rls: false, owned: ['spfn_tenancy_test.notes'] });

        expect(listTenancyTables()).toEqual([]);

        try
        {
            await expect(startServer({
                host: '127.0.0.1',
                port: 39996,
                infrastructure: { database: true, redis: false },
                database: { provider: { kind: 'test-provider', write: owner as never, close: async () => undefined } },
            })).rejects.toThrow(TenancyRoleError);
        }
        finally
        {
            vi.unstubAllEnvs();
            await closeDatabase();
        }

        expect(createServer).toHaveBeenCalledTimes(1);
        expect(listTenancyTables()).not.toEqual([]);
        expect(serve).not.toHaveBeenCalled();
    });

    describe('with tenancy tables', () =>
    {
        let tenancyDb: TenancyDb;

        beforeAll(async () =>
        {
            const { createTenancyDb } = await import('../../db/tenant/__tests__/tenancy-db');

            tenancyDb = createTenancyDb();
            await tenancyDb.setup();
        });

        afterAll(async () =>
        {
            await tenancyDb.teardown();
        });

        const ownerDb = () => drizzle({ client: tenancyDb.owner }) as unknown as TenancyGateDb;

        it('B1 an app role that owns a tenancy table refuses a production boot, naming the table', async () =>
        {
            if (!tenancyDb.isAvailable) return;

            process.env.NODE_ENV = 'production';

            const result = runTenancyBootGate([ownerDb()]);

            await expect(result).rejects.toThrow(TenancyRoleError);
            await expect(result).rejects.toThrow(/owns spfn_tenancy_test\.workspaces, spfn_tenancy_test\.authors, spfn_tenancy_test\.notes/);
            expect(error).toHaveBeenCalledTimes(1);
        });

        it('B2 the same role outside production logs one warning line and boot continues', async () =>
        {
            if (!tenancyDb.isAvailable) return;

            process.env.NODE_ENV = 'development';

            // Two pools of one role, as a write and a read connection: one finding
            const result = await runTenancyBootGate([ownerDb(), ownerDb()]);

            expect(result.state === 'unprotected' && result.findings).toHaveLength(1);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('spfn_tenancy_test.notes');
            expect(error).not.toHaveBeenCalled();
        });

        it('B3 a superuser or BYPASSRLS app role refuses a production boot', async () =>
        {
            process.env.NODE_ENV = 'production';

            await expect(runTenancyBootGate([stubDb({ role: 'postgres', superuser: true, bypass_rls: false, owned: [] })]))
                .rejects.toThrow('the app role "postgres" is a superuser');
            await expect(runTenancyBootGate([stubDb({ role: 'ops', superuser: false, bypass_rls: true, owned: [] })]))
                .rejects.toThrow('the app role "ops" has BYPASSRLS');
        });

        it('B4 an app role that owns nothing and is an ordinary role passes without a line', async () =>
        {
            if (!tenancyDb.isAvailable) return;

            process.env.NODE_ENV = 'production';

            expect(await runTenancyBootGate()).toEqual({ state: 'ok' });
            expect(warn).not.toHaveBeenCalled();
            expect(error).not.toHaveBeenCalled();
        });

        it('O1 an app role that owns the visibleThrough tenant list finds it among the tables', async () =>
        {
            if (!tenancyDb.isAvailable) return;

            process.env.NODE_ENV = 'development';

            const result = await runTenancyBootGate([ownerDb()]);

            expect(listTenancyTables()).toContainEqual({ schema: 'spfn_tenancy_test', name: 'workspaces', columnName: 'id' });
            expect(result.state === 'unprotected' && result.findings[0].ownedTables).toContain('spfn_tenancy_test.workspaces');
        });

        it('O2 a tenant list declared without visibleThrough is not on the list, as before', async () =>
        {
            process.env.NODE_ENV = 'production';

            const schema = pgSchema('spfn_tenancy_o2');
            const teams = schema.table('teams', { id: id() });
            const teamTenancy = defineTenancy({ tenants: teams, authorize: () => true });

            teamTenancy.table(schema, 'boards', { id: id() });

            const tables = listTenancyTables().map((table) => `${table.schema}.${table.name}`);
            const ownsTeams = stubDb({ role: 'app', superuser: false, bypass_rls: false, owned: ['spfn_tenancy_o2.teams'] });

            expect(tables).toContain('spfn_tenancy_o2.boards');
            expect(tables).not.toContain('spfn_tenancy_o2.teams');
            expect(await runTenancyBootGate([ownsTeams])).toEqual({ state: 'ok' });
        });

        it('B6 a check query that fails logs one warning line and boot continues', async () =>
        {
            process.env.NODE_ENV = 'production';

            const failing: TenancyGateDb = { execute: async () => Promise.reject(new Error('permission denied for pg_roles')) };

            expect(await runTenancyBootGate([failing])).toEqual({ state: 'unavailable', reason: 'permission denied for pg_roles' });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(error).not.toHaveBeenCalled();
        });
    });
});
