import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { closeDatabase, functionMigrationsTable, setDatabase } from '../../db';
import { serverLogger } from '../logger';
import {
    getMigrationSnapshot,
    PendingMigrationsError,
    resetMigrationSnapshot,
    runMigrationBootGate,
} from '../migration-gate';

function makeProject(): string
{
    const cwd = mkdtempSync(join(tmpdir(), 'spfn-migration-gate-'));
    const pkgDir = join(cwd, 'node_modules', '@spfn', 'testfn');

    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@spfn/testfn',
        spfn: { migrations: { dir: 'drizzle' } },
    }));

    const migrationDir = join(pkgDir, 'drizzle', '20260101000000_init');
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(join(migrationDir, 'migration.sql'), 'CREATE TABLE "widgets" ("id" serial PRIMARY KEY);');

    return cwd;
}

describe('migration boot gate', () =>
{
    let client: PGlite | undefined;
    let cwd: string | undefined;

    beforeEach(() =>
    {
        resetMigrationSnapshot();
        delete process.env.SPFN_ALLOW_PENDING_MIGRATIONS;
    });

    afterEach(async () =>
    {
        await closeDatabase();
        await client?.close();
        client = undefined;

        if (cwd)
        {
            rmSync(cwd, { recursive: true, force: true });
            cwd = undefined;
        }

        resetMigrationSnapshot();
        delete process.env.SPFN_ALLOW_PENDING_MIGRATIONS;
        vi.restoreAllMocks();
    });

    async function connect(): Promise<void>
    {
        client = new PGlite();
        setDatabase(drizzle({ client }) as never);
    }

    it('skips the check when the project ships no migrations', async () =>
    {
        cwd = mkdtempSync(join(tmpdir(), 'spfn-no-migrations-'));
        await connect();

        const snapshot = await runMigrationBootGate(undefined, cwd);

        expect(snapshot.state).toBe('skipped');
    });

    it('skips the check when no database was initialized', async () =>
    {
        cwd = makeProject();

        const snapshot = await runMigrationBootGate(undefined, cwd);

        expect(snapshot).toMatchObject({ state: 'skipped', reason: 'no database initialized' });
    });

    it('refuses to start when a function package has pending migrations', async () =>
    {
        cwd = makeProject();
        await connect();

        await expect(runMigrationBootGate(undefined, cwd)).rejects.toBeInstanceOf(PendingMigrationsError);
    });

    it('names the pending package and the fix in the error', async () =>
    {
        cwd = makeProject();
        await connect();

        const error = await runMigrationBootGate(undefined, cwd).catch((e: unknown) => e as PendingMigrationsError);

        expect(error).toBeInstanceOf(PendingMigrationsError);
        expect((error as PendingMigrationsError).targets).toEqual(['@spfn/testfn']);
        expect((error as PendingMigrationsError).message).toContain('spfn db migrate');
    });

    it('starts anyway when the server config allows pending migrations, and says so loudly', async () =>
    {
        cwd = makeProject();
        await connect();

        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() =>
        {});

        const snapshot = await runMigrationBootGate({ migrations: { allowPending: true } }, cwd);

        expect(snapshot).toMatchObject({ state: 'ok', pending: 1 });

        // The opt-out is never silent: the pending migration is named.
        const warned = warn.mock.calls.map(call => String(call[0])).join('\n');
        expect(warned).toContain('@spfn/testfn');
        expect(warned).toContain('20260101000000_init');
        expect(warned).toContain('spfn db migrate');
    });

    it('starts anyway when SPFN_ALLOW_PENDING_MIGRATIONS is set (containers cannot pass a flag)', async () =>
    {
        cwd = makeProject();
        await connect();
        process.env.SPFN_ALLOW_PENDING_MIGRATIONS = 'true';

        const snapshot = await runMigrationBootGate(undefined, cwd);

        expect(snapshot).toMatchObject({ state: 'ok', pending: 1 });
    });

    it('starts when the database is up to date', async () =>
    {
        cwd = makeProject();
        await connect();

        const table = functionMigrationsTable('@spfn/testfn');
        await client!.exec(`CREATE SCHEMA IF NOT EXISTS drizzle`);
        await client!.exec(`CREATE TABLE drizzle."${table}" (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
        await client!.query(
            `INSERT INTO drizzle."${table}" (hash, created_at) VALUES ($1, $2)`,
            ['hash', Date.UTC(2026, 0, 1)],
        );

        const snapshot = await runMigrationBootGate(undefined, cwd);

        expect(snapshot).toMatchObject({ state: 'ok', pending: 0 });
    });

    it('does not block a boot when the status query itself fails', async () =>
    {
        cwd = makeProject();
        client = new PGlite();
        setDatabase({
            execute: () => Promise.reject(new Error('connection terminated')),
        } as never);

        const snapshot = await runMigrationBootGate(undefined, cwd);

        expect(snapshot).toMatchObject({ state: 'unavailable' });
        expect((snapshot as { reason: string }).reason).toContain('connection terminated');
    });

    it('S4 refuses to start when the project bookkeeping matches no local migration (migrate would refuse)', async () =>
    {
        cwd = makeProject();
        mkdirSync(join(cwd, 'src', 'server', 'drizzle', '20260102000000_app'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'server', 'drizzle', '20260102000000_app', 'migration.sql'), 'SELECT 1;');
        await connect();

        // Written before drizzle-orm 1.0 (no `name` column), by a migration no longer in the folder.
        await client!.exec(`CREATE SCHEMA drizzle;
            CREATE TABLE drizzle."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
            INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ('gone', 1700000000000);`);

        const error = await runMigrationBootGate({ migrations: { allowPending: false } }, cwd)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(PendingMigrationsError);
        expect((error as PendingMigrationsError).message).toContain('bookkeeping does not match local migrations');
    });

    it('reuses the cached snapshot within the TTL and re-reads after it', async () =>
    {
        cwd = makeProject();
        client = new PGlite();

        const execute = vi.fn(() => Promise.resolve([]));
        setDatabase({ execute } as never);

        await getMigrationSnapshot({ cwd });
        const callsAfterFirst = execute.mock.calls.length;

        await getMigrationSnapshot({ cwd });
        expect(execute.mock.calls.length).toBe(callsAfterFirst);

        await getMigrationSnapshot({ cwd, ttlMs: 0 });
        expect(execute.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
});
