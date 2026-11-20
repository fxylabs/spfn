/**
 * One rule for pending function package migrations (#357)
 *
 * `collectMigrationStatus` (db status, the boot gate, health) and
 * `pendingFunctionMigrations` (the CLI's push preview and every apply) must
 * give the same pending list on a database whose records sit only in the
 * legacy shared `__spfn_fn_migrations` table.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    collectMigrationStatus,
    functionMigrationsTable,
    pendingFunctionMigrations,
    readMigrationEntries,
    type FunctionMigrationEntry,
    type MigrationStatusDb,
} from '../index';
import { TEST_DATABASE_URL } from '../../__tests__/helpers/db-fixture';

const PACKAGE_NAME = '@spfn/r357pkg';
const TAGS = ['20260101000000_one', '20260102000000_two', '20260103000000_three'];

/** A project with one installed package that ships TAGS; returns its cwd. */
function makeProject(): string
{
    const cwd = mkdtempSync(join(tmpdir(), 'spfn-pending-fn-'));
    const pkgDir = join(cwd, 'node_modules', '@spfn', 'r357pkg');

    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: PACKAGE_NAME,
        spfn: { migrations: { dir: 'drizzle' } },
    }));

    for (const tag of TAGS)
    {
        mkdirSync(join(pkgDir, 'drizzle', tag), { recursive: true });
        writeFileSync(join(pkgDir, 'drizzle', tag, 'migration.sql'), `CREATE TABLE "t_${tag}" ("id" integer);`);
    }

    return cwd;
}

describe('pending function package migrations on a legacy-recorded database', () =>
{
    const owner = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    const db = drizzle({ client: owner }) as unknown as MigrationStatusDb;
    let available = false;
    let cwd: string;

    beforeAll(async () =>
    {
        available = await owner`select 1`.then(() => true, () => false);
    });

    afterAll(async () =>
    {
        await owner.end();
    });

    beforeEach(async (context) =>
    {
        if (!available)
        {
            context.skip();
        }

        cwd = makeProject();
        await owner.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
        await owner.unsafe(`CREATE SCHEMA drizzle`);
        await owner.unsafe(`CREATE TABLE drizzle."__spfn_fn_migrations" (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    });

    afterEach(async () =>
    {
        rmSync(cwd, { recursive: true, force: true });
        await owner.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    });

    it.each([
        ['legacy table only', false],
        ['legacy table and an empty per-package table', true],
    ])('R1 %s: status and the apply path list the same pending migration', async (_state, withEmptyTable) =>
    {
        const entries = readMigrationEntries(join(cwd, 'node_modules', '@spfn', 'r357pkg', 'drizzle'), PACKAGE_NAME);
        for (const entry of entries.slice(0, 2))
        {
            await owner`INSERT INTO drizzle."__spfn_fn_migrations" (hash, created_at) VALUES (${entry.hash}, 1)`;
        }
        if (withEmptyTable)
        {
            await owner.unsafe(`CREATE TABLE drizzle."${functionMigrationsTable(PACKAGE_NAME)}" (
                id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
        }

        const status = await collectMigrationStatus(db, cwd);
        const [applyPending] = await pendingFunctionMigrations(db, [{ packageName: PACKAGE_NAME, entries }]);

        expect(status.packages.map(target => [target.name, target.pendingTags]))
            .toEqual([[PACKAGE_NAME, [TAGS[2]]]]);
        expect(applyPending?.entries.map(entry => entry.name)).toEqual([TAGS[2]]);
    });

    it('R4 the package\'s own table wins over a legacy table that records newer entries', async () =>
    {
        const entries = readMigrationEntries(join(cwd, 'node_modules', '@spfn', 'r357pkg', 'drizzle'), PACKAGE_NAME);
        for (const entry of entries)
        {
            await owner`INSERT INTO drizzle."__spfn_fn_migrations" (hash, created_at) VALUES (${entry.hash}, 1)`;
        }
        await createPackageTable(entries.slice(0, 1));

        const status = await collectMigrationStatus(db, cwd);
        const [applyPending] = await pendingFunctionMigrations(db, [{ packageName: PACKAGE_NAME, entries }]);

        expect(status.packages.map(target => [target.name, target.pendingTags]))
            .toEqual([[PACKAGE_NAME, TAGS.slice(1)]]);
        expect(applyPending?.entries.map(entry => entry.name)).toEqual(TAGS.slice(1));
    });

    it('R5 a package with rows of its own reads status without SELECT on the legacy table', async () =>
    {
        const entries = readMigrationEntries(join(cwd, 'node_modules', '@spfn', 'r357pkg', 'drizzle'), PACKAGE_NAME);
        await createPackageTable(entries);
        await owner.unsafe(`REVOKE ALL ON drizzle."__spfn_fn_migrations" FROM CURRENT_USER`);

        const status = await collectMigrationStatus(db, cwd);

        expect(status.packages.map(target => [target.name, target.pending])).toEqual([[PACKAGE_NAME, 0]]);
    });

    it('R6 a legacy read the rule needs and may not make fails the status read', async () =>
    {
        await owner.unsafe(`REVOKE ALL ON drizzle."__spfn_fn_migrations" FROM CURRENT_USER`);

        const failure = await collectMigrationStatus(db, cwd).then(() => undefined, (error: Error) => error);

        expect((failure?.cause as Error | undefined)?.message).toMatch(/permission denied/);
    });

    /** The package's own table, recording `recorded` the way an apply does. */
    async function createPackageTable(recorded: FunctionMigrationEntry[]): Promise<void>
    {
        const table = functionMigrationsTable(PACKAGE_NAME);

        await owner.unsafe(`CREATE TABLE drizzle."${table}" (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
        for (const entry of recorded)
        {
            await owner`INSERT INTO drizzle.${owner(table)} (hash, created_at) VALUES (${entry.hash}, ${entry.millis})`;
        }
    }
});
