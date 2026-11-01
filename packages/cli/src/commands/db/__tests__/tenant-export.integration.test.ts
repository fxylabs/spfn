/**
 * `spfn db tenant export` against a real PostgreSQL — rows X1–X3, X5 and X7–X10
 * of the #158 part 3 design case table
 *
 * The owner (TEST_DATABASE_URL) creates and seeds the fixture schema; the export
 * runs as the app role, which owns nothing and is neither superuser nor
 * BYPASSRLS — the first test proves it, or X7 would test nothing. Skips without
 * a database, except in CI. See helpers/test-database.ts for the URLs.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { appUrl, OWNER_URL, requireDatabase } from './helpers/test-database';
import { createSchema, createTenantFixtures, seed } from './helpers/tenant-fixtures';

vi.mock('@spfn/core/server', () => ({ loadEnv: vi.fn() }));
vi.mock('../tenant/schema', async (importOriginal) => ({
    ...await importOriginal<typeof import('../tenant/schema')>(),
    loadAppSchema: vi.fn(),
}));

const { dbTenantExport, exportTenant } = await import('../tenant/export');
const { buildTenantPlan } = await import('../tenant/plan');
const { loadAppSchema } = await import('../tenant/schema');

const SCHEMA = 'spfn_cli_tenant_export';
const UNREACHABLE_URL = 'postgresql://nobody:unused@127.0.0.1:1/nowhere';

const fixtures = createTenantFixtures(SCHEMA);
const plan = buildTenantPlan(fixtures.imports);

/** The rows of a COPY text file, each split into its columns. */
function readRows(file: string): string[][]
{
    return readFileSync(file, 'utf-8').split('\n').filter((line) => line !== '').map((line) => line.split('\t'));
}

/** The tenant column of every row of a plan table's file. */
function tenantsIn(directory: string, name: string): string[]
{
    const table = plan.tables.find((candidate) => candidate.name === name)!;
    const index = table.columns.indexOf(table.tenantColumn);

    return readRows(join(directory, table.file)).map((row) => row[index]);
}

describe('spfn db tenant export (integration)', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    const appRole = decodeURIComponent(new URL(appUrl()).username);
    const originalCwd = process.cwd();
    let available = false;
    let workDir = '';
    let output: string[] = [];

    const ownerCount = async (table: string, tenantId: number) =>
        Number((await owner.unsafe(`select count(*)::int as n from ${SCHEMA}.${table} where tenant_id = $1`, [tenantId]))[0].n);

    beforeAll(async () =>
    {
        available = await requireDatabase(owner, 'tenant export integration tests');

        if (!available) return;

        await createSchema(owner, fixtures, appRole);
    });

    beforeEach(async () =>
    {
        output = [];
        mkdirSync(join(originalCwd, 'node_modules', '.cache'), { recursive: true });
        workDir = mkdtempSync(join(originalCwd, 'node_modules', '.cache', 'spfn-tenant-export-'));
        process.chdir(workDir);
        vi.mocked(loadAppSchema).mockResolvedValue(fixtures.imports);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));

        if (!available) return;

        await owner.unsafe(`TRUNCATE ${SCHEMA}.notes, ${SCHEMA}.writers, ${SCHEMA}.memos, ${SCHEMA}.workspaces`);
        await seed(owner, SCHEMA);
    });

    afterEach(() =>
    {
        process.chdir(originalCwd);
        rmSync(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_READ_URL;
    });

    afterAll(async () =>
    {
        if (available)
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        }

        await Promise.all([owner.end(), app.end()]);
    });

    it('app connection: owns no test table, is neither superuser nor BYPASSRLS', async () =>
    {
        if (!available) return;

        const [role] = await app`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
        const owned = await owner`select tablename from pg_tables where schemaname = ${SCHEMA} and tableowner = ${role.current_user}`;

        expect(role.current_user).toBe(appRole);
        expect(role.rolsuper).toBe(false);
        expect(role.rolbypassrls).toBe(false);
        expect(owned).toHaveLength(0);
    });

    it('X1 exporting tenant 7 writes a file per tenant table and a manifest whose rows match the database', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'x1');
        const manifest = await exportTenant({ tenantId: 7, plan, url: appUrl(), directory });
        const written = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf-8'));

        expect(readdirSync(directory).sort()).toEqual([
            'manifest.json',
            `${SCHEMA}.memos.copy`,
            `${SCHEMA}.notes.copy`,
            `${SCHEMA}.writers.copy`,
        ]);
        expect(written).toEqual(manifest);
        expect(manifest).toMatchObject({ format: 1, tenantId: 7 });
        expect(manifest.tables.map((table) => table.name)).toEqual(['memos', 'writers', 'notes']);

        for (const table of manifest.tables)
        {
            const content = readFileSync(join(directory, table.file));

            expect(table.rows).toBe(await ownerCount(table.name, 7));
            expect(table.sha256).toBe(createHash('sha256').update(content).digest('hex'));
            expect(table.columns).toEqual(plan.tables.find((candidate) => candidate.name === table.name)!.columns);
        }

        expect(manifest.tables.find((table) => table.name === 'notes')!.columns).not.toContain('title_length');
    });

    it('X2 with another tenant\'s rows in every table, the files hold tenant 7\'s rows only — tenancy tables and the tenantKey()-only table', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'x2');

        await exportTenant({ tenantId: 7, plan, url: appUrl(), directory });

        for (const name of ['writers', 'notes', 'memos'])
        {
            expect(await ownerCount(name, 9)).toBeGreaterThan(0);
            expect(tenantsIn(directory, name).length).toBe(await ownerCount(name, 7));
            expect(new Set(tenantsIn(directory, name))).toEqual(new Set(['7']));
        }
    });

    it('X3 rows another connection adds for tenant 7 between two tables are in no file, and the files\' foreign keys agree', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'x3');
        const notesPlan = plan.tables.find((table) => table.name === 'notes')!;

        await exportTenant({
            tenantId: 7,
            plan,
            url: appUrl(),
            directory,
            afterTable: async (table) =>
            {
                if (table.name !== 'writers') return;

                // Committed on its own connection while the export is between writers and notes
                await owner.unsafe(`INSERT INTO ${SCHEMA}.writers (id, tenant_id, name) VALUES (50, 7, 'late')`);
                await owner.unsafe(`INSERT INTO ${SCHEMA}.notes (id, tenant_id, author_id, title) VALUES (50, 7, 50, 'late')`);
            },
        });

        const writerIds = new Set(readRows(join(directory, `${SCHEMA}.writers.copy`)).map((row) => row[0]));
        const authorIds = readRows(join(directory, notesPlan.file)).map((row) => row[notesPlan.columns.indexOf('author_id')]);

        expect(await ownerCount('notes', 7)).toBe(4);
        expect(writerIds.has('50')).toBe(false);
        expect(authorIds).toHaveLength(3);
        expect(authorIds.every((authorId) => writerIds.has(authorId))).toBe(true);
    });

    it('X1-large tables of more rows than a COPY stream buffers export one after another without stalling the connection', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'x1-large');

        await owner.unsafe(`INSERT INTO ${SCHEMA}.writers (id, tenant_id, name) SELECT g, 7, repeat('w', 40) FROM generate_series(1000, 20999) g`);
        await owner.unsafe(`INSERT INTO ${SCHEMA}.notes (id, tenant_id, author_id, title) SELECT g, 7, 1000 + g % 20000, repeat('n', 40) FROM generate_series(1000, 20999) g`);
        await owner.unsafe(`INSERT INTO ${SCHEMA}.memos (id, tenant_id, body) OVERRIDING SYSTEM VALUE SELECT g, 7, repeat('m', 40) FROM generate_series(1000, 20999) g`);

        const manifest = await exportTenant({ tenantId: 7, plan, url: appUrl(), directory });

        expect(manifest.tables.map((table) => table.rows)).toEqual([20002, 20002, 20003]);
    }, 20_000);

    it('X5 a tenant without rows exports empty files with 0 rows', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'x5');
        const manifest = await exportTenant({ tenantId: 8, plan, url: appUrl(), directory });

        expect(manifest.tables.map((table) => table.rows)).toEqual([0, 0, 0]);

        for (const table of manifest.tables)
        {
            expect(readFileSync(join(directory, table.file), 'utf-8')).toBe('');
        }
    });

    it('X7 policy tables, read as the app role inside the export, admit tenant 7\'s rows only', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'x7');
        const [{ rls }] = await owner`select bool_and(relrowsecurity) as rls from pg_class
            where oid in (${`${SCHEMA}.writers`}::regclass, ${`${SCHEMA}.notes`}::regclass)`;

        await exportTenant({ tenantId: 7, plan, url: appUrl(), directory });

        expect(rls).toBe(true);
        expect(new Set(tenantsIn(directory, 'writers'))).toEqual(new Set(['7']));
        expect(new Set(tenantsIn(directory, 'notes'))).toEqual(new Set(['7']));
        expect(tenantsIn(directory, 'notes')).toHaveLength(3);
    });

    it('X8 with DATABASE_READ_URL set the export connects with it, not DATABASE_URL', async () =>
    {
        if (!available) return;

        process.env.DATABASE_READ_URL = appUrl();
        process.env.DATABASE_URL = UNREACHABLE_URL;

        await dbTenantExport('7');

        const [folder] = readdirSync(join(workDir, 'backups')).filter((name) => name.startsWith('tenant-7-'));

        expect(folder).toMatch(/^tenant-7-\d{4}-\d{2}-\d{2}_\d{6}$/);
        expect(existsSync(join(workDir, 'backups', folder, 'manifest.json'))).toBe(true);
    });

    it('X9 an existing output folder fails the export and keeps its files', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'x9');

        mkdirSync(directory);
        writeFileSync(join(directory, 'manifest.json'), 'kept');

        await expect(exportTenant({ tenantId: 7, plan, url: appUrl(), directory })).rejects.toThrow(/EEXIST/);

        expect(readdirSync(directory)).toEqual(['manifest.json']);
        expect(readFileSync(join(directory, 'manifest.json'), 'utf-8')).toBe('kept');
    });

    it('X10 the connection URL and its password appear in no output, on success or failure', async () =>
    {
        if (!available) return;

        const url = new URL(appUrl());
        const wrong = new URL(appUrl());

        wrong.password = 'x10-not-the-password';
        process.env.DATABASE_URL = wrong.toString();

        await expect(dbTenantExport('7')).rejects.toThrow('exit 1');

        process.env.DATABASE_URL = url.toString();
        await dbTenantExport('7');

        const text = output.join('\n');

        expect(text).toMatch(/Tenant export failed/);
        expect(text).toMatch(/Tenant 7 exported/);

        for (const secret of [wrong.toString(), url.toString(), 'x10-not-the-password', decodeURIComponent(url.password), `${url.username}@`])
        {
            expect(text).not.toContain(secret);
        }
    });
});
