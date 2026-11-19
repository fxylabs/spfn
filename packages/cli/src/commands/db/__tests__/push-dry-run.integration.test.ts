/**
 * `spfn db push --dry-run` writes nothing (spfn/spfn#163)
 *
 * A scratch app with one project table and one installed function package
 * that ships one migration, pushed to TEST_DATABASE_URL. Each dry run is
 * checked against a catalog snapshot taken before it: every relation in every
 * non-system schema, `drizzle` included, and the row count of each migration
 * bookkeeping table.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { OWNER_URL, requireDatabase } from './helpers/test-database.js';

const writeAttempts = vi.hoisted(() => ({ enabled: false, results: [] as string[] }));

vi.mock('../utils/drizzle.js', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('../utils/drizzle.js')>();

    return {
        ...actual,
        createPushConnection: async (options?: { readOnly?: boolean }) =>
        {
            const connection = await actual.createPushConnection(options);

            if (writeAttempts.enabled)
            {
                writeAttempts.results.push(await connection.db.execute(sql.raw('CREATE TABLE i163_app.write_probe (id integer)'))
                    .then(() => 'written', (error: Error & { cause?: Error }) => error.cause?.message ?? error.message));
            }

            return connection;
        },
    };
});

const { dbPush } = await import('../push.js');

const MIGRATION_NAME = '20260101000000_things';
const MIGRATION_SQL = 'CREATE SCHEMA i163_fix;\n--> statement-breakpoint\nCREATE TABLE i163_fix.things (id integer PRIMARY KEY);\n';
const MIGRATION_MILLIS = Date.UTC(2026, 0, 1);
const PACKAGE_TABLE = '__spfn_fn_i163fix_migrations';

describe('db push --dry-run', () =>
{
    const db = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    let available = false;
    let root: string;
    let previousCwd: string;
    let printed: string[];

    beforeAll(async () =>
    {
        available = await requireDatabase(db, 'db push dry-run integration tests');
        root = mkdtempSync(join(__dirname, 'tmp-push-dry-run-'));
        writeFixtureApp(root);
    });

    afterAll(async () =>
    {
        if (available)
        {
            await resetDatabase();
        }
        await db.end();
        rmSync(root, { recursive: true, force: true });
    });

    beforeEach(async (context) =>
    {
        if (!available)
        {
            context.skip();
        }

        await resetDatabase();
        previousCwd = process.cwd();
        process.chdir(root);
        process.env.DATABASE_URL = OWNER_URL;
        printed = [];
        writeAttempts.enabled = false;
        writeAttempts.results = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        delete process.env.DATABASE_URL;
        vi.restoreAllMocks();
    });

    async function resetDatabase(): Promise<void>
    {
        await db.unsafe('DROP SCHEMA IF EXISTS i163_app CASCADE');
        await db.unsafe('DROP SCHEMA IF EXISTS i163_fix CASCADE');
        await db.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
    }

    /** Every schema and relation outside the system ones, and each bookkeeping table's row count. */
    async function snapshot(): Promise<string[]>
    {
        const schemas = await db<{ name: string }[]>`
            SELECT nspname AS name FROM pg_catalog.pg_namespace
            WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
            ORDER BY 1`;
        const relations = await db<{ name: string; kind: string }[]>`
            SELECT n.nspname || '.' || c.relname AS name, c.relkind AS kind
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'
            ORDER BY 1`;
        const counts = await Promise.all(relations
            .filter(relation => relation.kind === 'r' && relation.name.startsWith('drizzle.'))
            .map(async ({ name }) =>
            {
                const [{ count }] = await db.unsafe(`SELECT count(*)::int AS count FROM ${name.replace('drizzle.', 'drizzle."')}"`);

                return `${name} rows=${count}`;
            }));

        return [
            ...schemas.map(schema => `schema ${schema.name}`),
            ...relations.map(relation => `${relation.name} (${relation.kind})`),
            ...counts,
        ];
    }

    async function createProjectTable(): Promise<void>
    {
        await db.unsafe('CREATE SCHEMA i163_app; CREATE TABLE i163_app.notes (id integer PRIMARY KEY)');
    }

    const output = () => printed.join('\n');
    const push = (dryRun: boolean) => dbPush({ dryRun, schema: './src/server/entities/notes.entity.ts' });

    it('D1 schema in sync, one package migration pending: lists it and changes nothing', async () =>
    {
        await createProjectTable();
        const before = await snapshot();

        await push(true);

        expect(output()).toContain('No changes detected');
        expect(output()).toMatch(new RegExp(`@spfn/i163fix \\(1\\):\\n\\s+- ${MIGRATION_NAME}`));
        expect(output()).toContain('Dry run: nothing was applied');
        expect(await snapshot()).toEqual(before);
    });

    it('D2 project change and package migration pending: shows both and changes nothing', async () =>
    {
        const before = await snapshot();

        await push(true);

        expect(output()).toMatch(/Dry-run: \d+ statement\(s\) detected/);
        expect(output()).toContain('CREATE TABLE "i163_app"."notes"');
        expect(output()).toContain(`- ${MIGRATION_NAME}`);
        expect(await snapshot()).toEqual(before);
    });

    it('D3 a real push applies exactly what the dry run listed, and the next dry run lists none', async () =>
    {
        await createProjectTable();
        await push(true);
        expect(output()).toContain(`- ${MIGRATION_NAME}`);

        await push(false);

        expect(await db.unsafe(`SELECT hash, created_at::bigint AS millis FROM drizzle."${PACKAGE_TABLE}"`))
            .toEqual([{ hash: sha256(MIGRATION_SQL), millis: String(MIGRATION_MILLIS) }]);
        expect(await db`SELECT to_regclass('i163_fix.things') IS NOT NULL AS "exists"`).toEqual([{ exists: true }]);

        printed = [];
        await push(true);

        expect(output()).toContain('No function package migrations pending');
        expect(output()).not.toContain(MIGRATION_NAME);
    });

    it('D4 legacy shared table holding the hash: dry run lists none and writes nothing; push copies the row', async () =>
    {
        await createProjectTable();
        await db.unsafe(`CREATE SCHEMA drizzle;
            CREATE TABLE drizzle."__spfn_fn_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
        await db`INSERT INTO drizzle."__spfn_fn_migrations" (hash, created_at) VALUES (${sha256(MIGRATION_SQL)}, 1)`;
        const before = await snapshot();

        await push(true);

        expect(output()).toContain('No function package migrations pending');
        expect(await snapshot()).toEqual(before);

        await push(false);

        expect(await db.unsafe(`SELECT hash, created_at::bigint AS millis FROM drizzle."${PACKAGE_TABLE}"`))
            .toEqual([{ hash: sha256(MIGRATION_SQL), millis: String(MIGRATION_MILLIS) }]);
        expect(await db`SELECT to_regclass('drizzle."__spfn_fn_migrations"') IS NULL AS "gone"`).toEqual([{ gone: true }]);
        expect(await db`SELECT to_regclass('i163_fix.things') IS NULL AS "skipped"`).toEqual([{ skipped: true }]);
    });

    it('R1 a write attempted on the dry run\'s connection is refused by PostgreSQL', async () =>
    {
        await createProjectTable();
        writeAttempts.enabled = true;

        await push(true);

        expect(writeAttempts.results).toEqual([expect.stringMatching(/read-only transaction/)]);
        expect(await db`SELECT to_regclass('i163_app.write_probe') IS NULL AS "absent"`).toEqual([{ absent: true }]);
    });
});

function sha256(content: string): string
{
    return createHash('sha256').update(content).digest('hex');
}

/** A project table in schema i163_app, and @spfn/i163fix shipping one migration. */
function writeFixtureApp(root: string): void
{
    const entities = join(root, 'src', 'server', 'entities');
    const migration = join(root, 'node_modules', '@spfn', 'i163fix', 'migrations', MIGRATION_NAME);

    mkdirSync(entities, { recursive: true });
    mkdirSync(migration, { recursive: true });
    writeFileSync(join(entities, 'notes.entity.ts'),
        "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
        + "export const app = pgSchema('i163_app');\n"
        + "export const notes = app.table('notes', { id: integer('id').primaryKey() });\n");
    writeFileSync(join(migration, 'migration.sql'), MIGRATION_SQL);
    writeFileSync(join(root, 'node_modules', '@spfn', 'i163fix', 'package.json'),
        JSON.stringify({ name: '@spfn/i163fix', version: '1.0.0', spfn: { migrations: { dir: './migrations' } } }));
}
