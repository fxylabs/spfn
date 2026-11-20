/**
 * The legacy shared migration table is read, never dropped (#357)
 *
 * Two packages recorded only in `drizzle.__spfn_fn_migrations` (B's own table
 * exists but is empty, as a failed earlier apply leaves it), then what
 * `spfn add` runs for A alone, then a package C installed later and what
 * `spfn db migrate` runs for all of them. Status is read through
 * `getMigrationStatus`, which is `spfn db status`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';

import { OWNER_URL, requireDatabase } from '../../commands/db/__tests__/helpers/test-database.js';
import {
    discoverFunctionMigrations,
    executeFunctionMigrations,
    loadFunctionMigrationPlans,
} from '../function-migrations.js';
import { functionMigrationsTable, getMigrationStatus } from '../migration-status.js';

const MIGRATIONS: Record<string, Record<string, string>> = {
    r357a: {
        '20260101000000_init': 'CREATE SCHEMA r357_a;\n--> statement-breakpoint\nCREATE TABLE r357_a.one (id integer);',
        '20260201000000_two': 'CREATE TABLE r357_a.two (id integer);',
    },
    r357b: {
        '20260101000000_init': 'CREATE SCHEMA r357_b;\n--> statement-breakpoint\nCREATE TABLE r357_b.one (id integer);',
    },
    r357c: {
        '20260101000000_init': 'CREATE SCHEMA r357_c;\n--> statement-breakpoint\nCREATE TABLE r357_c.one (id integer);',
    },
};

function installPackage(root: string, name: string): void
{
    const dir = join(root, 'node_modules', '@spfn', name);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@spfn/${name}`, spfn: { migrations: { dir: 'drizzle' } } }));

    for (const [tag, text] of Object.entries(MIGRATIONS[name]!))
    {
        mkdirSync(join(dir, 'drizzle', tag), { recursive: true });
        writeFileSync(join(dir, 'drizzle', tag, 'migration.sql'), text);
    }
}

describe('function package migrations on a legacy-recorded database', () =>
{
    const db = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    let available = false;
    let root: string;

    beforeAll(async () =>
    {
        available = await requireDatabase(db, 'legacy function migration integration tests');
    });

    afterAll(async () =>
    {
        await db.end();
    });

    beforeEach(async (context) =>
    {
        if (!available)
        {
            context.skip();
        }

        root = mkdtempSync(join(tmpdir(), 'spfn-legacy-fn-'));
        await resetDatabase();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(async () =>
    {
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
        await resetDatabase();
    });

    async function resetDatabase(): Promise<void>
    {
        await db.unsafe('DROP SCHEMA IF EXISTS r357_a, r357_b, r357_c, drizzle CASCADE');
    }

    /** Apply A's and B's first migration by hand and record them only in the legacy table. */
    async function seedLegacyOnly(): Promise<void>
    {
        const plans = loadFunctionMigrationPlans(discoverFunctionMigrations(root));

        await db.unsafe(`CREATE SCHEMA drizzle;
            CREATE TABLE drizzle."__spfn_fn_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
            CREATE TABLE drizzle."${functionMigrationsTable('@spfn/r357b')}" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
        for (const plan of plans)
        {
            const [first] = plan.entries;
            await db.unsafe(first!.statements.join(';\n'));
            await db`INSERT INTO drizzle."__spfn_fn_migrations" (hash, created_at) VALUES (${first!.hash}, ${first!.millis})`;
        }
    }

    async function pendingByPackage(): Promise<Record<string, number>>
    {
        const status = await getMigrationStatus(root, OWNER_URL);

        return Object.fromEntries(status.packages.map(target => [target.name, target.pending]));
    }

    it('R2 `spfn add` of one package keeps the other\'s legacy records; later installs and `db migrate` apply only what is new', async () =>
    {
        installPackage(root, 'r357a');
        installPackage(root, 'r357b');
        await seedLegacyOnly();
        expect(await pendingByPackage()).toEqual({ '@spfn/r357a': 1, '@spfn/r357b': 0 });

        const target = discoverFunctionMigrations(root).find(func => func.packageName === '@spfn/r357a')!;
        expect(await executeFunctionMigrations(loadFunctionMigrationPlans([target]), OWNER_URL)).toBe(1);

        expect(await pendingByPackage()).toEqual({ '@spfn/r357a': 0, '@spfn/r357b': 0 });
        expect(await db`SELECT count(*)::int AS rows FROM drizzle."__spfn_fn_migrations"`).toEqual([{ rows: 2 }]);

        installPackage(root, 'r357c');
        expect(await pendingByPackage()).toEqual({ '@spfn/r357a': 0, '@spfn/r357b': 0, '@spfn/r357c': 1 });

        expect(await executeFunctionMigrations(loadFunctionMigrationPlans(discoverFunctionMigrations(root)), OWNER_URL)).toBe(1);

        expect(await pendingByPackage()).toEqual({ '@spfn/r357a': 0, '@spfn/r357b': 0, '@spfn/r357c': 0 });
        expect(await db`SELECT count(*)::int AS rows FROM drizzle."__spfn_fn_migrations"`).toEqual([{ rows: 2 }]);
    });
});
