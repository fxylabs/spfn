/**
 * `spfn db push` applies function package migrations before the project
 * statements (#378)
 *
 * A scratch app whose project table references a table of the fake function
 * package @spfn/i163fix, pushed to TEST_DATABASE_URL. Without its own answer a
 * row fails at the destructive confirmation instead of waiting on stdin.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';

import { OWNER_URL, requireDatabase } from './helpers/test-database.js';
import { writeFunctionPackage } from './helpers/function-package.js';

const prompter = vi.hoisted(() => ({
    /** Answers the destructive confirmation; unset, reaching it fails the row */
    answer: undefined as undefined | (() => Promise<boolean>),
}));

vi.mock('prompts', () => ({
    default: async () =>
    {
        if (!prompter.answer)
        {
            throw new Error('prompts was called: the push reached the destructive confirmation');
        }

        return { confirm: await prompter.answer() };
    },
}));

const { dbPush } = await import('../push.js');

const MIGRATION_NAME = '20260101000000_things';
const PACKAGE_SQL = 'CREATE SCHEMA spfn_i163fix;\n--> statement-breakpoint\nCREATE TABLE spfn_i163fix.things (id integer PRIMARY KEY);\n';
const FAILING_PACKAGE_SQL = `${PACKAGE_SQL}--> statement-breakpoint\nSELECT 1 / 0;\n`;
const PACKAGE_TABLE = 'drizzle."__spfn_fn_i163fix_migrations"';
const ORDER_LINE = 'Function package migrations are applied first, then the project statements.';

/** `accounts` references the package's table: by its key, or by a column the package never creates. */
const ACCOUNTS = {
    byId: "export const accounts = app.table('accounts', { id: integer('id').primaryKey(), thingId: integer('thing_id').references(() => things.id) });\n",
    byMissingColumn: "export const accounts = app.table('accounts', { id: integer('id').primaryKey(), thingCode: text('thing_code').references(() => things.code) });\n",
};

interface FixtureOptions
{
    accounts?: string;
    packageSql?: string;
    schemaFilter?: string[];
}

describe('db push applies function package migrations first', () =>
{
    const db = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    let available = false;
    let root: string;
    let previousCwd: string;
    let printed: string[];
    let errors: string[];

    beforeAll(async () =>
    {
        available = await requireDatabase(db, 'db push apply-order integration tests');
    });

    afterAll(async () =>
    {
        if (available)
        {
            await resetDatabase();
        }
        await db.end();
    });

    beforeEach(async (context) =>
    {
        if (!available)
        {
            context.skip();
        }

        await resetDatabase();
        root = mkdtempSync(join(__dirname, 'tmp-push-apply-order-'));
        previousCwd = process.cwd();
        process.chdir(root);
        process.env.DATABASE_URL = OWNER_URL;
        printed = [];
        errors = [];
        prompter.answer = undefined;
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
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
        rmSync(root, { recursive: true, force: true });
    });

    async function resetDatabase(): Promise<void>
    {
        await db.unsafe('DROP SCHEMA IF EXISTS i378_app CASCADE');
        await db.unsafe('DROP SCHEMA IF EXISTS spfn_i163fix CASCADE');
        await db.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
    }

    async function exists(relation: string): Promise<boolean>
    {
        const [{ found }] = await db`SELECT to_regclass(${relation}) IS NOT NULL AS found`;

        return found;
    }

    async function columnExists(table: string, column: string): Promise<boolean>
    {
        const [{ found }] = await db`SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'i378_app' AND table_name = ${table} AND column_name = ${column}) AS found`;

        return found;
    }

    /** The app: i378_app.notes, optionally i378_app.accounts, and @spfn/i163fix. */
    function writeFixture({ accounts, packageSql = PACKAGE_SQL, schemaFilter }: FixtureOptions = {}): void
    {
        const entities = join(root, 'src', 'server', 'entities');
        mkdirSync(entities, { recursive: true });
        writeFileSync(join(entities, 'app.entity.ts'),
            "import { pgSchema, integer, text } from 'drizzle-orm/pg-core';\n"
            + "const things = pgSchema('spfn_i163fix').table('things', { id: integer('id').primaryKey(), code: text('code').unique() });\n"
            + "export const app = pgSchema('i378_app');\n"
            + "export const notes = app.table('notes', { id: integer('id').primaryKey() });\n"
            + (accounts ?? ''));
        writeFunctionPackage(root, MIGRATION_NAME, packageSql);

        if (schemaFilter)
        {
            writeFileSync(join(root, 'drizzle.config.ts'),
                `export default { schema: './src/server/entities/app.entity.ts', schemaFilter: ${JSON.stringify(schemaFilter)} };\n`);
        }
    }

    const output = () => printed.join('\n');
    const push = (options: { dryRun?: boolean; force?: boolean } = {}) =>
        dbPush({ ...options, schema: './src/server/entities/app.entity.ts' });

    it('T1 empty database, a project table referencing a package table: the dry run lists the package first, --force applies both, the next dry run lists nothing', async () =>
    {
        writeFixture({ accounts: ACCOUNTS.byId });

        await push({ dryRun: true });

        const pendingAt = output().indexOf('📦 Function package migrations pending');
        expect(pendingAt).toBeGreaterThanOrEqual(0);
        expect(output().indexOf(ORDER_LINE)).toBeGreaterThan(pendingAt);
        expect(output().indexOf('CREATE TABLE "i378_app"."accounts"')).toBeGreaterThan(output().indexOf(ORDER_LINE));

        await push({ force: true });

        expect(await exists('i378_app.accounts')).toBe(true);
        expect(await exists('spfn_i163fix.things')).toBe(true);

        printed = [];
        await push({ dryRun: true });

        expect(output()).toContain('No changes detected');
        expect(output()).toContain('No function package migrations pending');
    });

    it('T3 a package migration fails: exit 1, no project statement applied, the message says so', async () =>
    {
        writeFixture({ packageSql: FAILING_PACKAGE_SQL });

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain('❌ Failed to apply function package migrations — nothing of the project schema was applied');
        expect(errors.join('\n')).not.toMatch(/already applied/);
        expect(await exists('i378_app.notes')).toBe(false);
        expect(await exists('spfn_i163fix.things')).toBe(false);
    });

    it('T4 a project statement fails after the package migrations: exit 1 with the server\'s message; the package stays applied, no project statement does', async () =>
    {
        writeFixture({ accounts: ACCOUNTS.byMissingColumn });

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain(
            '❌ The project statements were rolled back: column "code" referenced in foreign key constraint does not exist');
        expect(errors.join('\n')).toContain(
            'Function package migrations applied above stay applied; fix the schema and run spfn db push again.');
        expect(errors.join('\n')).not.toMatch(/Failed query|params:/);
        expect(await db.unsafe(`SELECT count(*)::int AS count FROM ${PACKAGE_TABLE}`)).toEqual([{ count: 1 }]);
        expect(await exists('spfn_i163fix.things')).toBe(true);
        expect(await exists('i378_app.notes')).toBe(false);
        expect(await exists('i378_app.accounts')).toBe(false);
    });

    it('T5 a destructive change pending: the confirmation comes before any package write; declining still applies the package and the rest', async () =>
    {
        await db.unsafe('CREATE SCHEMA i378_app; CREATE TABLE i378_app.notes (id integer PRIMARY KEY, extra text)');
        writeFixture({ accounts: ACCOUNTS.byId });
        let packageAtPrompt: boolean | undefined;
        prompter.answer = async () =>
        {
            packageAtPrompt = await exists(PACKAGE_TABLE) || await exists('spfn_i163fix.things');

            return false;
        };

        await push();

        expect(packageAtPrompt).toBe(false);
        expect(await exists('spfn_i163fix.things')).toBe(true);
        expect(await exists('i378_app.accounts')).toBe(true);
        expect(await columnExists('notes', 'extra')).toBe(true);
        expect(output()).toContain('Skipped 1 destructive statement(s)');
    });

    it('T8 a declared schemaFilter naming the package schema: the first push drops nothing of it; the next lists its table as destructive', async () =>
    {
        writeFixture({ schemaFilter: ['i378_app', 'spfn_i163fix'] });

        await push({ force: true });

        expect(output()).not.toMatch(/DROP/);
        expect(await exists('spfn_i163fix.things')).toBe(true);
        expect(await exists('i378_app.notes')).toBe(true);

        printed = [];
        await push({ dryRun: true });

        expect(output()).toMatch(/Destructive changes \(2\):\n\s+DROP TABLE "spfn_i163fix"."things"/);
    });
});
