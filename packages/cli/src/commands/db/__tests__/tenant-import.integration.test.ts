/**
 * `spfn db tenant import` against a real PostgreSQL — rows M1–M18 of the #158
 * part 3 design case table, the M-input rows for a folder that lies,
 * M-file-gone, and C1 of the #159/#160 design (a `restrict` self-reference)
 *
 * Each row exports tenant 7 from the seeded source schema as the app role, then
 * recreates the target schema — "migrations only" — in the state the row needs
 * and imports as the owner. Source and target are TEST_DATABASE_URL and
 * TEST_TARGET_DATABASE_URL, or one database for both (see helpers/test-database.ts).
 * A refused import must leave the target as it was: every such row compares
 * each table's row count and checksum before and after.
 */

import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { appUrl, OWNER_URL, requireDatabase, TARGET_URL } from './helpers/test-database';
import { createSchema, createTenantFixtures, seed, snapshot, tenantSnapshot } from './helpers/tenant-fixtures';

vi.mock('@spfn/core/server', () => ({ loadEnv: vi.fn() }));
vi.mock('prompts', () => ({ default: vi.fn(async () => ({ typed: '' })) }));
vi.mock('../tenant/schema', async (importOriginal) => ({
    ...await importOriginal<typeof import('../tenant/schema')>(),
    loadAppSchema: vi.fn(),
}));

const { exportTenant, dbTenantExport } = await import('../tenant/export');
const { dbTenantImport, importTenant, prepareImport } = await import('../tenant/import');
const { buildTenantPlan } = await import('../tenant/plan');
const { loadAppSchema } = await import('../tenant/schema');

const SCHEMA = 'spfn_cli_tenant_import';
const UNREACHABLE_URL = 'postgresql://nobody:unused@127.0.0.1:1/nowhere';

const fixtures = createTenantFixtures(SCHEMA);
const plan = buildTenantPlan(fixtures.imports);

describe('spfn db tenant import (integration)', () =>
{
    const source = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const target = postgres(TARGET_URL, { max: 1, onnotice: () => undefined });
    const targetApp = postgres(appUrl(TARGET_URL), { max: 1, onnotice: () => undefined });
    const appRole = decodeURIComponent(new URL(appUrl()).username);
    const originalCwd = process.cwd();
    let available = false;
    let workDir = '';
    let output: string[] = [];
    let sourceTenant7: Record<string, string | null> = {};

    /** Seed the source, remember tenant 7's rows, export them as the app role. */
    const exportSource = async (prepare?: () => Promise<void>): Promise<string> =>
    {
        const directory = join(workDir, `export-${readdirSync(workDir).length}`);

        await createSchema(source, fixtures, appRole);
        await seed(source, SCHEMA);
        await prepare?.();
        sourceTenant7 = await tenantSnapshot(source, SCHEMA, 7);
        await exportTenant({ tenantId: 7, plan, url: appUrl(), directory });

        return directory;
    };

    /** The target after its migrations: the schema, and the tenants 7 and 9 unless told otherwise. */
    const migrateTarget = async (tenants = [7, 9]): Promise<void> =>
    {
        await createSchema(target, fixtures, appRole);

        for (const tenantId of tenants)
        {
            await target.unsafe(`INSERT INTO ${SCHEMA}.workspaces (id, name) VALUES ($1, 'workspace')`, [tenantId]);
        }
    };

    const runImport = async (directory: string, replace = false) =>
        importTenant(await prepareImport(directory, plan), { url: TARGET_URL, replace });

    const tenantCount = async (sql: postgres.Sql, table: string, tenantId: number) =>
        Number((await sql.unsafe(`select count(*)::int as n from ${SCHEMA}.${table} where tenant_id = $1`, [tenantId]))[0].n);

    /** Rewrite a table file, and with `resign` its sha256 and row count in the manifest too. */
    const editFile = (directory: string, name: string, edit: (text: string) => string, resign: boolean): void =>
    {
        const manifestPath = join(directory, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const entry = manifest.tables.find((table: { name: string }) => table.name === name);
        const text = edit(readFileSync(join(directory, entry.file), 'utf-8'));

        writeFileSync(join(directory, entry.file), text);

        if (resign)
        {
            entry.sha256 = createHash('sha256').update(text).digest('hex');
            entry.rows = text.split('\n').length - 1;
            writeFileSync(manifestPath, JSON.stringify(manifest));
        }
    };

    const editManifest = (directory: string, edit: (manifest: any) => void): void =>
    {
        const manifestPath = join(directory, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        edit(manifest);
        writeFileSync(manifestPath, JSON.stringify(manifest));
    };

    /** Run a refused import: it must reject with `message` and change nothing in the target. */
    const expectRefused = async (attempt: () => Promise<unknown>, message: RegExp): Promise<void> =>
    {
        const before = await snapshot(target, SCHEMA);

        await expect(attempt()).rejects.toThrow(message);
        expect(await snapshot(target, SCHEMA)).toEqual(before);
    };

    beforeAll(async () =>
    {
        available = await requireDatabase(source, 'tenant import integration tests')
            && await requireDatabase(target, 'tenant import integration tests (target)');
    });

    beforeEach(() =>
    {
        output = [];
        mkdirSync(join(originalCwd, 'node_modules', '.cache'), { recursive: true });
        workDir = mkdtempSync(join(originalCwd, 'node_modules', '.cache', 'spfn-tenant-import-'));
        process.chdir(workDir);
        vi.mocked(loadAppSchema).mockResolvedValue(fixtures.imports);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
    });

    afterEach(() =>
    {
        process.chdir(originalCwd);
        rmSync(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
    });

    afterAll(async () =>
    {
        if (available)
        {
            await source.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
            await target.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        }

        await Promise.all([source.end(), target.end(), targetApp.end()]);
    });

    it('M1 into a migrated, empty database with workspace 7, every tenant table gets tenant 7\'s rows, counts equal', async () =>
    {
        if (!available) return;

        const directory = await exportSource();
        const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf-8'));

        await migrateTarget();

        const imported = await runImport(directory);

        expect(imported.tables.map(({ table, rows }) => [table.name, rows])).toEqual([['memos', 2], ['writers', 2], ['notes', 3]]);

        for (const table of manifest.tables)
        {
            expect(await tenantCount(target, table.name, 7)).toBe(table.rows);
        }

        expect(await tenantSnapshot(target, SCHEMA, 7)).toEqual(sourceTenant7);
    });

    it('M2 tenant 7 already has rows and no --replace: refused, the rows stay', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await createSchema(target, fixtures, appRole);
        await seed(target, SCHEMA);
        await target.unsafe(`UPDATE ${SCHEMA}.writers SET name = 'target' WHERE tenant_id = 7`);

        await expectRefused(() => runImport(directory), /Tenant 7 already has rows in .*use --replace/s);
    });

    it('M3 the same with --replace: tenant 7 becomes the file\'s rows, other tenants\' rows unchanged', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await createSchema(target, fixtures, appRole);
        await seed(target, SCHEMA);
        await target.unsafe(`UPDATE ${SCHEMA}.writers SET name = 'target' WHERE tenant_id = 7`);
        await target.unsafe(`INSERT INTO ${SCHEMA}.memos (tenant_id, body) VALUES (7, 'only in the target')`);

        const tenant9 = await tenantSnapshot(target, SCHEMA, 9);

        await runImport(directory, true);

        expect(await tenantSnapshot(target, SCHEMA, 7)).toEqual(sourceTenant7);
        expect(await tenantSnapshot(target, SCHEMA, 9)).toEqual(tenant9);
    });

    it('M4 a file row changed to tenant 9, its sha256 recomputed: refused, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        // memos columns: id, tenant_id, body
        editFile(directory, 'memos', (text) => text.replace('2\t7\tb', '2\t9\tb'), true);
        await migrateTarget();

        await expectRefused(() => runImport(directory), /holds 1 row\(s\) of a tenant other than 7/);
    });

    it('M5 a file changed but its sha256 left: refused, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        editFile(directory, 'memos', (text) => text.replace('\tb', '\tB'), false);
        await migrateTarget();

        await expectRefused(() => runImport(directory), /memos\.copy does not match its sha256/);
    });

    it('M6 a target table with one column more, or one fewer: refused naming the column, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await migrateTarget();
        await target.unsafe(`ALTER TABLE ${SCHEMA}.memos ADD COLUMN pinned boolean`);
        await expectRefused(() => runImport(directory), /memos: column\(s\) pinned only in the target database/);

        await migrateTarget();
        await target.unsafe(`ALTER TABLE ${SCHEMA}.writers DROP COLUMN name`);
        await expectRefused(() => runImport(directory), /writers: column\(s\) name only in the export/);
    });

    it('M7 the target has no workspace 7: refused, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await migrateTarget([9]);

        await expectRefused(() => runImport(directory), /Tenant 7 is not in spfn_cli_tenant_import\.workspaces; create tenant 7 there first/);
    });

    it('M8 after the import the app inserts rows with fresh ids that collide with none, and no sequence moved backwards', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await migrateTarget();
        // Another tenant already drew notes ids up to 500 in the target
        await target.unsafe(`SELECT setval(pg_get_serial_sequence('${SCHEMA}.notes', 'id'), 500)`);
        await runImport(directory);

        const inserted = await targetApp.begin(async (tx) =>
        {
            await tx`select set_config('app.tenant_id', '7', true)`;

            const [writer] = await tx.unsafe(`INSERT INTO ${SCHEMA}.writers (tenant_id, name) VALUES (7, 'new') RETURNING id`);
            const [note] = await tx.unsafe(`INSERT INTO ${SCHEMA}.notes (tenant_id, author_id, title) VALUES (7, $1, 'new') RETURNING id`, [writer.id]);
            const [memo] = await tx.unsafe(`INSERT INTO ${SCHEMA}.memos (tenant_id, body) VALUES (7, 'new') RETURNING id`);

            return { writer: Number(writer.id), note: Number(note.id), memo: Number(memo.id) };
        });

        expect(inserted).toEqual({ writer: 4, note: 501, memo: 3 });
    });

    it('M9 a foreign key error in a later table: refused, the earlier tables rolled back, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        // writers columns: id, tenant_id, name — drop Cid, whom note 4 names as author
        editFile(directory, 'writers', (text) => text.split('\n').filter((line) => !line.startsWith('3\t')).join('\n'), true);
        await migrateTarget();

        await expectRefused(() => runImport(directory), /foreign key constraint "notes_(author|reviewer)_fk"/);
    });

    it('M10 file names sort in another order than the foreign keys: the import follows the plan and succeeds', async () =>
    {
        if (!available) return;

        const directory = await exportSource();
        const files = readdirSync(directory).filter((name) => name.endsWith('.copy')).sort();
        const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf-8'));

        expect(files.indexOf(`${SCHEMA}.notes.copy`)).toBeLessThan(files.indexOf(`${SCHEMA}.writers.copy`));
        expect(manifest.tables.map((table: { name: string }) => table.name)).toEqual(['memos', 'writers', 'notes']);

        await migrateTarget();
        await runImport(directory);

        expect(await tenantSnapshot(target, SCHEMA, 7)).toEqual(sourceTenant7);
    });

    it('M11 a self-referencing table whose child row comes before its parent in the file imports', async () =>
    {
        if (!available) return;

        const directory = await exportSource(async () =>
        {
            await source.unsafe(`INSERT INTO ${SCHEMA}.notes (id, tenant_id, author_id, title) VALUES (6, 7, 1, 'parent')`);
            await source.unsafe(`INSERT INTO ${SCHEMA}.notes (id, tenant_id, author_id, parent_id, title) VALUES (5, 7, 1, 6, 'child')`);
        });

        await migrateTarget();
        await runImport(directory);

        expect(await tenantCount(target, 'notes', 7)).toBe(5);
        expect(await tenantSnapshot(target, SCHEMA, 7)).toEqual(sourceTenant7);
    });

    it('M12 the import connects with DATABASE_OWNER_URL when set, else with DATABASE_URL', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await migrateTarget();
        process.env.DATABASE_OWNER_URL = TARGET_URL;
        process.env.DATABASE_URL = UNREACHABLE_URL;
        await dbTenantImport(directory);
        expect(await tenantCount(target, 'notes', 7)).toBe(3);

        await migrateTarget();
        delete process.env.DATABASE_OWNER_URL;
        process.env.DATABASE_URL = TARGET_URL;
        await dbTenantImport(directory);
        expect(await tenantCount(target, 'notes', 7)).toBe(3);
    });

    it('M13 the same folder twice without --replace: the second is refused, the first result stays', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await migrateTarget();
        await runImport(directory);

        await expectRefused(() => runImport(directory), /already has rows/);
        expect(await tenantSnapshot(target, SCHEMA, 7)).toEqual(sourceTenant7);
    });

    it('M14 export from a point-in-time copy, import --replace into production: tenant 7 is the file, other tenants untouched', async () =>
    {
        if (!available) return;

        // The copy: the seeded source, exported through the command as the app
        await createSchema(source, fixtures, appRole);
        await seed(source, SCHEMA);
        sourceTenant7 = await tenantSnapshot(source, SCHEMA, 7);
        process.env.DATABASE_URL = appUrl();
        await dbTenantExport('7');

        const [folder] = readdirSync(join(workDir, 'backups')).filter((name) => name.startsWith('tenant-7-'));

        // Production since then: tenant 7 changed, tenant 9 changed and grew
        await createSchema(target, fixtures, appRole);
        await seed(target, SCHEMA);
        await target.unsafe(`DELETE FROM ${SCHEMA}.notes WHERE tenant_id = 7 AND id = 4`);
        await target.unsafe(`UPDATE ${SCHEMA}.writers SET name = 'renamed' WHERE tenant_id IN (7, 9)`);
        await target.unsafe(`INSERT INTO ${SCHEMA}.memos (tenant_id, body) VALUES (9, 'later')`);

        const tenant9 = await tenantSnapshot(target, SCHEMA, 9);

        process.env.DATABASE_OWNER_URL = TARGET_URL;
        await dbTenantImport(join('backups', folder), { replace: true });

        expect(await tenantSnapshot(target, SCHEMA, 7)).toEqual(sourceTenant7);
        expect(await tenantSnapshot(target, SCHEMA, 9)).toEqual(tenant9);
    });

    it('M15 a manifest format this spfn does not know: refused, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        editManifest(directory, (manifest) =>
        {
            manifest.format = 2;
        });
        await migrateTarget();

        await expectRefused(() => runImport(directory), /format 2; this spfn reads format 1/);
    });

    it('M16 a manifest row count changed, the file and its sha256 untouched: refused, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        editManifest(directory, (manifest) =>
        {
            manifest.tables[0].rows += 1;
        });
        await migrateTarget();

        await expectRefused(() => runImport(directory), /memos received 2 rows; spfn_cli_tenant_import\.memos\.copy should hold 3/);
    });

    it('M17 a table outside the plan whose foreign keys cascade or set null into plan tables: --replace refused naming each, nothing deleted anywhere', async () =>
    {
        if (!available) return;

        const directory = await exportSource();
        const bookmarks = async () => (await target.unsafe(
            `SELECT count(*)::int AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS checksum FROM ${SCHEMA}.bookmarks t`,
        ))[0];

        await createSchema(target, fixtures, appRole);
        await seed(target, SCHEMA);
        await target.unsafe(`CREATE TABLE ${SCHEMA}.bookmarks (
            id integer PRIMARY KEY,
            note_id bigint CONSTRAINT bookmarks_note_fk REFERENCES ${SCHEMA}.notes (id) ON DELETE CASCADE,
            writer_id bigint CONSTRAINT bookmarks_writer_fk REFERENCES ${SCHEMA}.writers (id) ON DELETE SET NULL)`);
        // Note 2 and writer 3 are tenant 7's
        await target.unsafe(`INSERT INTO ${SCHEMA}.bookmarks (id, note_id, writer_id) VALUES (1, 2, 3)`);

        const before = await bookmarks();

        await expectRefused(
            () => runImport(directory, true),
            new RegExp('--replace would change rows outside the export.*'
                + 'bookmarks_note_fk on spfn_cli_tenant_import\\.bookmarks \\(ON DELETE CASCADE into spfn_cli_tenant_import\\.notes\\).*'
                + 'bookmarks_writer_fk on spfn_cli_tenant_import\\.bookmarks \\(ON DELETE SET NULL into spfn_cli_tenant_import\\.writers\\)', 's'),
        );
        expect(await bookmarks()).toEqual(before);
    });

    it('C1 --replace over a tenant whose self-reference is onDelete restrict succeeds; other tenants unchanged', async () =>
    {
        if (!available) return;

        const restricted = createTenantFixtures(SCHEMA, { parentOnDelete: 'restrict' });
        const directory = await exportSource();

        await createSchema(target, restricted, appRole);
        await seed(target, SCHEMA);

        const [parentKey] = await target.unsafe(
            `SELECT confdeltype FROM pg_constraint WHERE conname = 'notes_parent_fk' AND connamespace = '${SCHEMA}'::regnamespace`,
        );
        const tenant9 = await tenantSnapshot(target, SCHEMA, 9);

        // Tenant 7's notes chain 4 → 2 → 1 through parent_id, so one DELETE removes parents and children together
        expect(parentKey.confdeltype).toBe('r');

        await importTenant(await prepareImport(directory, buildTenantPlan(restricted.imports)), { url: TARGET_URL, replace: true });

        expect(await tenantSnapshot(target, SCHEMA, 7)).toEqual(sourceTenant7);
        expect(await tenantSnapshot(target, SCHEMA, 9)).toEqual(tenant9);
    });

    it('M18 the import prints each sequence it moves, from → to, and nothing for one it leaves', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        await migrateTarget();
        await target.unsafe(`SELECT setval(pg_get_serial_sequence('${SCHEMA}.notes', 'id'), 500)`);
        process.env.DATABASE_OWNER_URL = TARGET_URL;
        await dbTenantImport(directory);

        const text = output.join('\n');

        expect(text).toContain(`${SCHEMA}.writers_id_seq: unused → 3`);
        expect(text).toContain(`${SCHEMA}.memos_id_seq: unused → 2`);
        expect(text).not.toContain('notes_id_seq');
    });

    it('M-file-gone a file removed after its sha256 was checked: refused with ENOENT, nothing written, no uncaught error', async () =>
    {
        if (!available) return;

        const directory = await exportSource();
        const prepared = await prepareImport(directory, plan);

        rmSync(join(directory, `${SCHEMA}.writers.copy`));
        await migrateTarget();

        await expectRefused(() => importTenant(prepared, { url: TARGET_URL, replace: false }), /ENOENT/);
    });

    it('M-input-tenant-id a manifest tenantId "1 OR 1=1" is refused before a connection, through the command too', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        editManifest(directory, (manifest) =>
        {
            manifest.tenantId = '1 OR 1=1';
        });
        await migrateTarget();
        process.env.DATABASE_URL = UNREACHABLE_URL;

        await expectRefused(() => runImport(directory), /tenantId must be a positive integer, received "1 OR 1=1"/);
        await expect(dbTenantImport(directory)).rejects.toThrow('exit 1');
        expect(output.join('\n')).toMatch(/tenantId must be a positive integer/);
    });

    it('M-input-file a manifest naming another file than the plan derives ("../x") is refused, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        editManifest(directory, (manifest) =>
        {
            manifest.tables[0].file = '../x';
        });
        await migrateTarget();

        await expectRefused(() => runImport(directory), /file "\.\.\/x", expected "spfn_cli_tenant_import\.memos\.copy"/);
    });

    it('M-input-table a manifest table or column the app schema does not have is refused, nothing written', async () =>
    {
        if (!available) return;

        const directory = await exportSource();

        editManifest(directory, (manifest) =>
        {
            manifest.tables.push({ ...manifest.tables[0], schema: 'pg_catalog', name: 'pg_authid' });
            manifest.tables[1].columns = [...manifest.tables[1].columns, 'tenant_id); DROP TABLE x; --'];
        });
        await migrateTarget();

        await expectRefused(() => runImport(directory), /pg_catalog\.pg_authid: in manifest\.json, not a tenant table.*writers: columns/s);
    });
});
