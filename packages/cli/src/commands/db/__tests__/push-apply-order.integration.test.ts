/**
 * `spfn db push` applies function package migrations before the project
 * statements (#378)
 *
 * A scratch app whose project table references a table of the fake function
 * package @spfn/i163fix, pushed to TEST_DATABASE_URL. Without its own answer a
 * row fails at the destructive confirmation instead of waiting on stdin; stdin
 * counts as a terminal unless a row says otherwise.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';

import { OWNER_URL, requireDatabase } from './helpers/test-database.js';
import { writeFunctionPackage } from './helpers/function-package.js';

const prompter = vi.hoisted(() => ({
    /** Answers the destructive confirmation, undefined as an aborted prompt; unset, reaching it fails the row */
    answer: undefined as undefined | (() => Promise<boolean | undefined>),
    /** The question the confirmation asked */
    message: undefined as string | undefined,
}));

vi.mock('prompts', () => ({
    default: async (question: { message: string }) =>
    {
        if (!prompter.answer)
        {
            throw new Error('prompts was called: the push reached the destructive confirmation');
        }

        prompter.message = question.message;
        const confirm = await prompter.answer();

        return confirm === undefined ? {} : { confirm };
    },
}));

const { dbPush } = await import('../push.js');

const MIGRATION_NAME = '20260101000000_things';
const PACKAGE_SQL = 'CREATE SCHEMA spfn_i163fix;\n--> statement-breakpoint\nCREATE TABLE spfn_i163fix.things (id integer PRIMARY KEY);\n';
const FAILING_PACKAGE_SQL = `${PACKAGE_SQL}--> statement-breakpoint\nSELECT 1 / 0;\n`;
const PACKAGE_TABLE = 'drizzle."__spfn_fn_i163fix_migrations"';
const ORDER_LINE = 'Function package migrations are applied first, then the project statements.';
const STAY_APPLIED_LINE = 'Function package migrations applied above stay applied; fix the schema and run spfn db push again.';
/** Two rows of one key: the package's migration fails on its primary key. */
const DUPLICATE_PACKAGE_SQL = `${PACKAGE_SQL}--> statement-breakpoint\nINSERT INTO spfn_i163fix.things (id) VALUES (1), (1);\n`;

/** `accounts` references the package's table: by its key, or by a column the package never creates. */
const ACCOUNTS = {
    byId: "export const accounts = app.table('accounts', { id: integer('id').primaryKey(), thingId: integer('thing_id').references(() => things.id) });\n",
    byMissingColumn: "export const accounts = app.table('accounts', { id: integer('id').primaryKey(), thingCode: text('thing_code').references(() => things.code) });\n",
};

/** A project statement that fails on a row already in i378_app.notes: the rows, the declared notes, what the line names. */
const ROW_FAILURES = [
    {
        name: 'class 22: a text column changed to integer over a row holding text',
        rows: "CREATE TABLE i378_app.notes (id integer PRIMARY KEY, secret text); INSERT INTO i378_app.notes VALUES (1, 'customer-secret-SECRETVALUE')",
        notes: "{ id: integer('id').primaryKey(), secret: integer('secret') }",
        line: 'Invalid input value (22P02)',
    },
    {
        name: 'unique: two rows hold the same value',
        rows: "CREATE TABLE i378_app.notes (id integer PRIMARY KEY, email text); INSERT INTO i378_app.notes VALUES (1, 'SECRETVALUE'), (2, 'SECRETVALUE')",
        notes: "{ id: integer('id').primaryKey(), email: text('email').unique() }",
        line: 'could not create unique index "notes_email_key" (23505, constraint notes_email_key, table i378_app.notes)',
    },
    {
        name: 'not-null: a row holds null',
        rows: 'CREATE TABLE i378_app.notes (id integer PRIMARY KEY, email text); INSERT INTO i378_app.notes VALUES (1, NULL)',
        notes: "{ id: integer('id').primaryKey(), email: text('email').notNull() }",
        line: '(23502, table i378_app.notes, column email)',
    },
    {
        name: 'check: a row breaks the new check',
        rows: "CREATE TABLE i378_app.notes (id integer PRIMARY KEY, email text); INSERT INTO i378_app.notes VALUES (1, 'SECRETVALUE')",
        notes: "{ id: integer('id').primaryKey(), email: text('email') }, (t) => [check('notes_email_short', sql`length(${t.email}) < 3`)]",
        line: '(23514, constraint notes_email_short, table i378_app.notes)',
    },
    {
        name: 'foreign key: a row references a missing package row',
        rows: 'CREATE TABLE i378_app.notes (id integer PRIMARY KEY, thing_id integer); INSERT INTO i378_app.notes VALUES (1, 424242)',
        notes: "{ id: integer('id').primaryKey(), thingId: integer('thing_id').references(() => things.id) }",
        line: 'violates foreign key constraint "notes_thing_id_things_id_fkey" (23503, constraint notes_thing_id_things_id_fkey, table i378_app.notes)',
    },
];

interface FixtureOptions
{
    accounts?: string;
    notes?: string;
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
    let stdinIsTTY: PropertyDescriptor | undefined;

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
        prompter.message = undefined;
        stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        setStdinTTY(true);
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
        if (stdinIsTTY)
        {
            Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
        }
        else
        {
            delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    function setStdinTTY(value: boolean): void
    {
        Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
    }

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
    function writeFixture({ accounts, notes = "{ id: integer('id').primaryKey() }", packageSql = PACKAGE_SQL, schemaFilter }: FixtureOptions = {}): void
    {
        const entities = join(root, 'src', 'server', 'entities');
        mkdirSync(entities, { recursive: true });
        writeFileSync(join(entities, 'app.entity.ts'),
            "import { sql } from 'drizzle-orm';\n"
            + "import { check, pgSchema, integer, text } from 'drizzle-orm/pg-core';\n"
            + "const things = pgSchema('spfn_i163fix').table('things', { id: integer('id').primaryKey(), code: text('code').unique() });\n"
            + "export const app = pgSchema('i378_app');\n"
            + `export const notes = app.table('notes', ${notes});\n`
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

        expect(errors.join('\n')).toContain('❌ The project statements were rolled back: Invalid query (42703)');
        expect(errors.join('\n')).toMatch(/ {3}Failed statement: ALTER TABLE "i378_app"."accounts" ADD CONSTRAINT .*REFERENCES "spfn_i163fix"."things"\("code"\)/);
        expect(errors.join('\n')).toContain(STAY_APPLIED_LINE);
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
        expect(prompter.message).toBe(
            'Apply these destructive changes? No skips them; the other project statements and the function package migrations are still applied.');
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
    it('T3b a package migration fails on a constraint: the message is the server\'s, read as the project failure\'s is', async () =>
    {
        writeFixture({ packageSql: DUPLICATE_PACKAGE_SQL });

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain(
            'duplicate key value violates unique constraint "things_pkey" (23505, constraint things_pkey, table spfn_i163fix.things)');
        expect(errors.join('\n')).not.toMatch(/Failed statement|Key \(/);
        expect(await exists('spfn_i163fix.things')).toBe(false);
    });

    it('T4b a project statement fails with every package already up to date: no line about package migrations this run applied', async () =>
    {
        writeFixture({ accounts: ACCOUNTS.byMissingColumn });
        // A first push of a schema without accounts applies the package
        writeFileSync(join(root, 'src', 'server', 'entities', 'base.entity.ts'),
            "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
            + "export const app = pgSchema('i378_app');\n"
            + "export const notes = app.table('notes', { id: integer('id').primaryKey() });\n");
        await dbPush({ force: true, schema: './src/server/entities/base.entity.ts' });
        expect(await exists('spfn_i163fix.things')).toBe(true);

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain('❌ The project statements were rolled back: Invalid query (42703)');
        expect(errors.join('\n')).not.toContain('stay applied');
        expect(await exists('i378_app.accounts')).toBe(false);
    });

    it.each(ROW_FAILURES)('T11 a project statement fails on a row ($name): the line names code, constraint, table, column and the statement, never the row\'s value', async ({ rows, notes, line }) =>
    {
        await db.unsafe(`CREATE SCHEMA i378_app; ${rows}`);
        writeFixture({ notes });

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        const printedErrors = errors.join('\n');
        expect(printedErrors).toContain('❌ The project statements were rolled back: ');
        expect(printedErrors).toContain(line);
        expect(printedErrors).toMatch(/ {3}Failed statement: ALTER TABLE "i378_app"."notes" /);
        expect(printedErrors).not.toMatch(/SECRETVALUE|customer-secret|424242|Key \(|Failed query|params:/);
    });

    it('T9 the confirmation is aborted (Ctrl-C, EOF): exit 1, nothing written — no package migration, no project statement', async () =>
    {
        await db.unsafe('CREATE SCHEMA i378_app; CREATE TABLE i378_app.notes (id integer PRIMARY KEY, extra text)');
        writeFixture({ accounts: ACCOUNTS.byId });
        prompter.answer = async () => undefined;

        await expect(push()).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain('❌ The confirmation was aborted — nothing was applied');
        expect(await exists(PACKAGE_TABLE)).toBe(false);
        expect(await exists('spfn_i163fix.things')).toBe(false);
        expect(await exists('i378_app.accounts')).toBe(false);
        expect(await columnExists('notes', 'extra')).toBe(true);
    });

    it('T10 stdin is not a terminal and a destructive statement is pending: exit 1 before any prompt or write, naming --force', async () =>
    {
        await db.unsafe('CREATE SCHEMA i378_app; CREATE TABLE i378_app.notes (id integer PRIMARY KEY, extra text)');
        writeFixture({ accounts: ACCOUNTS.byId });
        setStdinTTY(false);

        await expect(push()).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain(
            '❌ Destructive changes need a confirmation and stdin is not a terminal — nothing was applied');
        expect(output()).toContain('Pass --force to apply them');
        expect(await exists(PACKAGE_TABLE)).toBe(false);
        expect(await exists('i378_app.accounts')).toBe(false);
        expect(await columnExists('notes', 'extra')).toBe(true);
    });
});
