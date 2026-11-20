import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    collectMigrationStatus,
    countPendingMigrations,
    functionMigrationsTable,
    hasMigrationTargets,
    pendingMigrationTargets,
    type MigrationStatusDb,
} from '../index';

/**
 * A project fixture: a temp cwd carrying an installed function package that
 * ships one migration, plus optionally the project's own migrations folder.
 */
function makeProject(options: { withProjectMigrations?: boolean } = {}): string
{
    const cwd = mkdtempSync(join(tmpdir(), 'spfn-migration-status-'));
    const pkgDir = join(cwd, 'node_modules', '@spfn', 'testfn');

    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@spfn/testfn',
        spfn: { migrations: { dir: 'drizzle' } },
    }));

    const migrationDir = join(pkgDir, 'drizzle', '20260101000000_init');
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(join(migrationDir, 'migration.sql'), 'CREATE TABLE "widgets" ("id" serial PRIMARY KEY);');

    if (options.withProjectMigrations)
    {
        const projectDir = join(cwd, 'src', 'server', 'drizzle', '20260102000000_app');
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, 'migration.sql'), 'CREATE TABLE "orders" ("id" serial PRIMARY KEY);');
    }

    return cwd;
}

describe('collectMigrationStatus', () =>
{
    let client: PGlite;
    let db: MigrationStatusDb;
    let cwd: string | undefined;

    beforeEach(async () =>
    {
        client = new PGlite();
        db = drizzle({ client }) as unknown as MigrationStatusDb;
    });

    afterEach(async () =>
    {
        if (cwd)
        {
            rmSync(cwd, { recursive: true, force: true });
            cwd = undefined;
        }

        await client.close();
    });

    it('reports every migration pending on a database that has no bookkeeping table yet', async () =>
    {
        cwd = makeProject();

        const status = await collectMigrationStatus(db, cwd);

        expect(status.packages).toHaveLength(1);
        expect(status.packages[0]).toMatchObject({
            name: '@spfn/testfn',
            total: 1,
            applied: 0,
            pending: 1,
            pendingTags: ['20260101000000_init'],
        });
        expect(countPendingMigrations(status)).toBe(1);
    });

    it('reports nothing pending once the migration is recorded', async () =>
    {
        cwd = makeProject();
        const table = functionMigrationsTable('@spfn/testfn');

        await client.exec(`CREATE SCHEMA IF NOT EXISTS drizzle`);
        await client.exec(`CREATE TABLE drizzle."${table}" (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
        await client.query(
            `INSERT INTO drizzle."${table}" (hash, created_at) VALUES ($1, $2)`,
            ['hash', Date.UTC(2026, 0, 1)],
        );

        const status = await collectMigrationStatus(db, cwd);

        expect(status.packages[0]).toMatchObject({ applied: 1, pending: 0, pendingTags: [] });
        expect(pendingMigrationTargets(status)).toEqual([]);
    });

    it('R3 ignores a `name` column on a package table: only the timestamp counts', async () =>
    {
        cwd = makeProject();
        const table = functionMigrationsTable('@spfn/testfn');

        await client.exec(`CREATE SCHEMA IF NOT EXISTS drizzle`);
        await client.exec(`CREATE TABLE drizzle."${table}" (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text)`);
        await client.query(
            `INSERT INTO drizzle."${table}" (hash, created_at, name) VALUES ($1, $2, $3)`,
            ['hash', 0, '20260101000000_init'],
        );

        const status = await collectMigrationStatus(db, cwd);

        expect(status.packages[0]).toMatchObject({ applied: 0, pending: 1 });
    });

    it('treats a project migration recorded by name as applied (drizzle-orm 1.0 projects)', async () =>
    {
        cwd = makeProject({ withProjectMigrations: true });

        await client.exec(`CREATE SCHEMA IF NOT EXISTS drizzle`);
        await client.exec(`CREATE TABLE drizzle."__drizzle_migrations" (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text)`);
        await client.query(
            `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at, name) VALUES ($1, $2, $3)`,
            ['hash', 0, '20260102000000_app'],
        );

        const status = await collectMigrationStatus(db, cwd);

        expect(status.project).toMatchObject({ applied: 1, pending: 0 });
    });

    it('includes the project migrations folder when it exists', async () =>
    {
        cwd = makeProject({ withProjectMigrations: true });

        const status = await collectMigrationStatus(db, cwd);

        expect(status.project).toMatchObject({ total: 1, pending: 1, pendingTags: ['20260102000000_app'] });
        expect(countPendingMigrations(status)).toBe(2);
    });

    it('leaves the project target out when the folder is absent (a built server image)', async () =>
    {
        cwd = makeProject();

        const status = await collectMigrationStatus(db, cwd);

        expect(status.project).toBeNull();
    });
});

describe('hasMigrationTargets', () =>
{
    it('is false for a project with no function package migrations and no project folder', () =>
    {
        const cwd = mkdtempSync(join(tmpdir(), 'spfn-no-migrations-'));

        try
        {
            expect(hasMigrationTargets(cwd)).toBe(false);
        }
        finally
        {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('is true once a function package ships migrations', () =>
    {
        const cwd = makeProject();

        try
        {
            expect(hasMigrationTargets(cwd)).toBe(true);
        }
        finally
        {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});

describe('functionMigrationsTable', () =>
{
    it('matches the per-package table naming of the migration runner', () =>
    {
        expect(functionMigrationsTable('@spfn/cms')).toBe('__spfn_fn_cms_migrations');
    });
});
