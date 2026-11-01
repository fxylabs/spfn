/**
 * `spfn db tenant export` / `import` before any connection — rows X4, X6, X11
 * and Z1 of the #158 part 3 design case table
 *
 * Every row here fails or plans before a database is reached: no URL is set,
 * and the folder the export would write is checked to be absent.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { bigint, pgSchema, pgTable, text, type PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { tenantKey } from '@spfn/core/db';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTenantFixtures } from './helpers/tenant-fixtures';

vi.mock('@spfn/core/server', () => ({ loadEnv: vi.fn() }));
vi.mock('../tenant/schema', async (importOriginal) => ({
    ...await importOriginal<typeof import('../tenant/schema')>(),
    loadAppSchema: vi.fn(),
}));

const { dbTenantExport } = await import('../tenant/export');
const { dbTenantImport } = await import('../tenant/import');
const { buildTenantPlan } = await import('../tenant/plan');
const { loadAppSchema } = await import('../tenant/schema');
const { loadEnv } = await import('@spfn/core/server');

describe('tenant export and import before a connection', () =>
{
    const originalCwd = process.cwd();
    let workDir = '';
    let errors: string[] = [];

    beforeEach(() =>
    {
        mkdirSync(join(originalCwd, 'node_modules', '.cache'), { recursive: true });
        workDir = mkdtempSync(join(originalCwd, 'node_modules', '.cache', 'spfn-tenant-plan-'));
        process.chdir(workDir);
        errors = [];
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_READ_URL;
        delete process.env.DATABASE_OWNER_URL;
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() =>
    {
        process.chdir(originalCwd);
        rmSync(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.mocked(loadAppSchema).mockReset();
        vi.mocked(loadEnv).mockClear();
    });

    it.each(['0', '-1', 'abc', '1.5', '', '1e3', '9007199254740993'])('X4 tenant id "%s" fails before the schema or a connection, and writes no folder', async (tenantId) =>
    {
        await expect(dbTenantExport(tenantId)).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toMatch(/Tenant id must be a positive integer/);
        expect(loadEnv).not.toHaveBeenCalled();
        expect(loadAppSchema).not.toHaveBeenCalled();
        expect(existsSync(join(workDir, 'backups'))).toBe(false);
    });

    it('X6 an app without tenant tables: both commands print "No tenant tables" and exit 1, no folder', async () =>
    {
        const schema = pgSchema('spfn_cli_no_tenants');

        vi.mocked(loadAppSchema).mockResolvedValue({ users: schema.table('users', { id: bigint('id', { mode: 'number' }).primaryKey() }) });

        await expect(dbTenantExport('42')).rejects.toThrow('exit 1');
        await expect(dbTenantImport(workDir)).rejects.toThrow('exit 1');

        expect(errors).toHaveLength(2);
        expect(errors.every((message) => message.includes('No tenant tables'))).toBe(true);
        expect(existsSync(join(workDir, 'backups'))).toBe(false);
    });

    it('X11 a foreign key cycle between tenant tables fails before a connection and prints the path, no folder', async () =>
    {
        const schema = pgSchema('spfn_cli_cycle');
        const alpha: PgTable = schema.table('alpha', {
            id: bigint('id', { mode: 'number' }).primaryKey(),
            tenantId: tenantKey(),
            betaId: bigint('beta_id', { mode: 'number' }).references(() => (beta as any).id),
        });
        const beta: PgTable = schema.table('beta', {
            id: bigint('id', { mode: 'number' }).primaryKey(),
            tenantId: tenantKey(),
            alphaId: bigint('alpha_id', { mode: 'number' }).references(() => (alpha as any).id),
        });

        vi.mocked(loadAppSchema).mockResolvedValue({ alpha, beta });

        await expect(dbTenantExport('42')).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain('form a cycle: spfn_cli_cycle.alpha → spfn_cli_cycle.beta → spfn_cli_cycle.alpha');
        expect(existsSync(join(workDir, 'backups'))).toBe(false);
    });

    it('X11 (plan) a reference of a table to itself is not a cycle, and referenced tables come first', () =>
    {
        const plan = buildTenantPlan(createTenantFixtures('spfn_cli_plan').imports);

        expect(plan.tables.map((table) => table.name)).toEqual(['memos', 'writers', 'notes']);
        expect(plan.tables.find((table) => table.name === 'notes')!.columns).not.toContain('title_length');
        expect(plan.tenantLists).toEqual([{ schema: 'spfn_cli_plan', name: 'workspaces', idColumn: 'id' }]);
    });

    it('Z1 tables marked by another @spfn/core instance — Symbol.for markers only, no registry entry — are found', () =>
    {
        // What a second copy of core leaves on the objects it builds: the
        // markers, under the global symbols, and nothing in this copy's registry
        const tenants = pgTable('z1_accounts', { id: bigint('id', { mode: 'number' }).primaryKey() });
        const projects = pgTable('z1_projects', {
            id: bigint('id', { mode: 'number' }).primaryKey(),
            accountId: bigint('account_id', { mode: 'number' }).notNull().references(() => tenants.id),
            name: text('name'),
        });
        const events = pgTable('z1_events', {
            id: bigint('id', { mode: 'number' }).primaryKey(),
            workspace: bigint('workspace', { mode: 'number' }).notNull(),
        });

        markTenantColumn(projects, 'account_id');
        (projects as unknown as Record<symbol, unknown>)[Symbol.for('spfn.tenancy.table')] = {
            columnName: 'account_id',
            tenants: { schema: undefined, name: 'z1_accounts' },
        };
        markTenantColumn(events, 'workspace');

        const plan = buildTenantPlan({ tenants, projects, events });

        expect(plan.tables.map((table) => [table.schema, table.name, table.tenantColumn])).toEqual([
            ['public', 'z1_events', 'workspace'],
            ['public', 'z1_projects', 'account_id'],
        ]);
        expect(plan.tenantLists).toEqual([{ schema: 'public', name: 'z1_accounts', idColumn: 'id' }]);
    });
});

function markTenantColumn(table: PgTable, name: string): void
{
    const column = getTableConfig(table).columns.find((candidate) => candidate.name === name)!;

    (column as unknown as Record<symbol, boolean>)[Symbol.for('spfn.tenant.column')] = true;
}
