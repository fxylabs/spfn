/**
 * Migration status read through an app role that owns nothing
 *
 * With split roles the owner (`DATABASE_OWNER_URL`) runs migrations and owns the
 * `drizzle` bookkeeping tables; the server reads their status through the app
 * role (`DATABASE_URL`). An app role without rights on schema `drizzle` must
 * never be told that applied migrations are pending.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { closeDatabase, collectMigrationStatus, setDatabase, type MigrationStatusDb } from '../../db';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';
import { appDatabaseUrl } from '../../db/tenant/__tests__/tenancy-db';
import { serverLogger } from '../logger';
import { PendingMigrationsError, resetMigrationSnapshot, runMigrationBootGate } from '../migration-gate';

const APPLIED_TAG = '20260101000000_init';
const PENDING_TAG = '20260102000000_orders';

/** A project with two migrations of its own: the first applied, the second not. */
function makeProject(): string
{
    const cwd = mkdtempSync(join(tmpdir(), 'spfn-migration-roles-'));

    for (const tag of [APPLIED_TAG, PENDING_TAG])
    {
        const dir = join(cwd, 'src', 'server', 'drizzle', tag);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'migration.sql'), `CREATE TABLE "t_${tag}" ("id" serial PRIMARY KEY);`);
    }

    return cwd;
}

/** As the owner, create drizzle's bookkeeping table the way its migrator does and record the first migration. */
async function recordAppliedMigration(owner: postgres.Sql): Promise<void>
{
    await owner.unsafe(`CREATE SCHEMA drizzle`);
    await owner.unsafe(`CREATE TABLE drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint,
        name text,
        applied_at timestamp with time zone DEFAULT now()
    )`);
    await owner.unsafe(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ('hash', $1, $2)`,
        [Date.UTC(2026, 0, 1), APPLIED_TAG],
    );
}

describe('migration status through an app role that owns nothing', () =>
{
    const appUrl = appDatabaseUrl();
    const appRole = decodeURIComponent(new URL(appUrl).username);
    const owner = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    const appDb = drizzle({ client: app }) as unknown as MigrationStatusDb;
    let available = false;
    let cwd: string;

    beforeAll(async () =>
    {
        available = await owner`select 1`.then(() => app`select 1`).then(() => true, () => false);

        if (!available)
        {
            console.log('\n⚠️  PostgreSQL not available - skipping migration role tests\n');
        }
    });

    afterAll(async () =>
    {
        await Promise.all([owner.end(), app.end()]);
    });

    beforeEach(async () =>
    {
        cwd = makeProject();
        resetMigrationSnapshot();
        delete process.env.SPFN_ALLOW_PENDING_MIGRATIONS;

        if (available)
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
        }
    });

    afterEach(async () =>
    {
        rmSync(cwd, { recursive: true, force: true });
        await closeDatabase();
        resetMigrationSnapshot();
        vi.restoreAllMocks();

        if (available)
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
        }
    });

    it('MG1 an app role with no privilege on drizzle is not told the applied migration is pending', async () =>
    {
        if (!available) return;

        await recordAppliedMigration(owner);

        await expect(collectMigrationStatus(appDb, cwd)).rejects.toMatchObject({
            cause: { message: 'permission denied for schema drizzle' },
        });
    });

    it('MG1 the boot gate reports "could not check" and boots, without a connection string in the warning', async () =>
    {
        if (!available) return;

        await recordAppliedMigration(owner);
        setDatabase(appDb as never);
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        const snapshot = await runMigrationBootGate(undefined, cwd).catch((error: unknown) => error);

        expect(snapshot).not.toBeInstanceOf(PendingMigrationsError);
        expect(snapshot).toMatchObject({ state: 'unavailable' });
        expect(warn).toHaveBeenCalledTimes(1);

        const warned = String(warn.mock.calls[0][0]);
        expect(warned).toMatch(/Could not verify migration status: permission denied for schema drizzle/);
        expect(warned).not.toMatch(/postgres(ql)?:\/\//);
        expect(warned).not.toContain(new URL(appUrl).password);
    });

    it('MG2 an app role with USAGE and SELECT on drizzle sees what the owner sees', async () =>
    {
        if (!available) return;

        await recordAppliedMigration(owner);
        await owner.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${appRole}`);
        await owner.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${appRole}`);

        const ownerStatus = await collectMigrationStatus(drizzle({ client: owner }) as unknown as MigrationStatusDb, cwd);
        const appStatus = await collectMigrationStatus(appDb, cwd);

        expect(appStatus.project).toMatchObject({ total: 2, applied: 1, pending: 1, pendingTags: [PENDING_TAG] });
        expect(appStatus).toEqual(ownerStatus);
    });

    it('MG3 a fresh database with no bookkeeping table reports every migration pending', async () =>
    {
        if (!available) return;

        const status = await collectMigrationStatus(appDb, cwd);

        expect(status.project).toMatchObject({ total: 2, applied: 0, pending: 2, pendingTags: [APPLIED_TAG, PENDING_TAG] });
    });
});
