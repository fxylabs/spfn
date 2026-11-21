/**
 * `spfn db push --dry-run` writes nothing (spfn/spfn#163)
 *
 * A scratch app with one project table and one installed function package
 * that ships one migration, pushed to TEST_DATABASE_URL. Each dry run is
 * checked against a catalog snapshot taken before it (see snapshot()), and the
 * L rows check that it holds no lock between its statements.
 * `prompts` answers by failing the row: a dry run that reached the destructive
 * confirmation would otherwise wait on stdin until the row times out.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { connect, createServer, type AddressInfo } from 'net';
import { join } from 'path';
import pg from 'pg';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { OWNER_URL, requireDatabase } from './helpers/test-database.js';
import { writeFunctionPackage } from './helpers/function-package.js';

vi.mock('prompts', () => ({
    default: async () =>
    {
        throw new Error('prompts was called: the push reached the destructive confirmation');
    },
}));

const writeAttempts = vi.hoisted(() => ({
    enabled: false,
    results: [] as string[],
    /** Runs when the push is about to close its connection */
    beforeClose: undefined as undefined | (() => Promise<void>),
}));

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

            return {
                ...connection,
                close: async () =>
                {
                    await writeAttempts.beforeClose?.();
                    await connection.close();
                },
            };
        },
    };
});

const { dbPush } = await import('../push.js');

const MIGRATION_NAME = '20260101000000_things';
const MIGRATION_SQL = 'CREATE SCHEMA i163_fix;\n--> statement-breakpoint\nCREATE TABLE i163_fix.things (id integer PRIMARY KEY);\n';
const MIGRATION_MILLIS = Date.UTC(2026, 0, 1);
const PACKAGE_TABLE = '__spfn_fn_i163fix_migrations';

/** One `line` per catalog object; each query is filtered to USER_SCHEMAS. */
const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'`;

const CATALOG_QUERIES = [
    `SELECT 'schema ' || n.nspname AS line FROM pg_catalog.pg_namespace n WHERE ${USER_SCHEMAS} ORDER BY 1`,
    `SELECT format('relation %s.%s (%s)', n.nspname, c.relname, c.relkind) AS line
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE ${USER_SCHEMAS} ORDER BY 1`,
    `SELECT format('column %s.%s.%s %s notnull=%s default=%s', n.nspname, c.relname, a.attname,
            format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)) AS line
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE ${USER_SCHEMAS} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
    `SELECT format('constraint %s.%s %s', n.nspname, con.conname, pg_get_constraintdef(con.oid)) AS line
        FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
        WHERE ${USER_SCHEMAS} ORDER BY 1`,
    `SELECT 'index ' || indexdef AS line FROM pg_catalog.pg_indexes n
        WHERE ${USER_SCHEMAS.replaceAll('n.nspname', 'n.schemaname')} ORDER BY 1`,
    `SELECT format('sequence %s.%s %s start=%s step=%s last=%s', n.schemaname, n.sequencename, n.data_type,
            n.start_value, n.increment_by, n.last_value) AS line
        FROM pg_catalog.pg_sequences n WHERE ${USER_SCHEMAS.replaceAll('n.nspname', 'n.schemaname')} ORDER BY 1`,
    `SELECT format('type %s.%s (%s) %s', n.nspname, t.typname, t.typtype,
            (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid)) AS line
        FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE ${USER_SCHEMAS} ORDER BY 1`,
    `SELECT format('function %s.%s(%s) %s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc)) AS line
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE ${USER_SCHEMAS} ORDER BY 1`,
    `SELECT format('extension %s %s', extname, extversion) AS line FROM pg_catalog.pg_extension ORDER BY 1`,
];

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
        writeAttempts.beforeClose = undefined;
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

    /**
     * What a migration can write and the catalog shows cheaply, in every schema
     * but the system ones (`drizzle` included): schemas; relations with their
     * kind (tables, views, indexes, sequences…); columns with type, NOT NULL and
     * default; constraints with their definition; index definitions; sequence
     * parameters and last value; types with enum labels; functions and
     * procedures with their arguments and body hash; installed extensions
     * (database-wide) with version; and each `drizzle` table's row count.
     * Not covered: grants, policies, triggers, comments, row data elsewhere.
     */
    async function snapshot(): Promise<string[]>
    {
        const lines = await Promise.all(CATALOG_QUERIES.map(async query =>
            (await db.unsafe<{ line: string }[]>(query)).map(row => row.line)));
        const tables = await db<{ name: string }[]>`
            SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'drizzle' ORDER BY 1`;
        const counts = await Promise.all(tables.map(async ({ name }) =>
        {
            const [{ count }] = await db.unsafe(`SELECT count(*)::int AS count FROM drizzle."${name}"`);

            return `drizzle.${name} rows=${count}`;
        }));

        return [...lines.flat(), ...counts];
    }

    async function createProjectTable(): Promise<void>
    {
        await db.unsafe('CREATE SCHEMA i163_app; CREATE TABLE i163_app.notes (id integer PRIMARY KEY)');
    }

    /** `text` in its own session, given 1.5 s to get its locks: 'ok', or the error message */
    async function tryDdl(text: string): Promise<string>
    {
        const session = await connectClient();

        try
        {
            await session.query(`SET lock_timeout = '1500ms'`);
            await session.query('BEGIN');
            await session.query(text);
            await session.query('ROLLBACK');

            return 'ok';
        }
        catch (error)
        {
            return (error as Error).message;
        }
        finally
        {
            await session.end();
        }
    }

    /** Two project tables with a row and a column the schema drops, and the legacy shared table. */
    async function seedTwoTables(): Promise<void>
    {
        await createProjectTable();
        await db.unsafe(`ALTER TABLE i163_app.notes ADD COLUMN extra text;
            CREATE TABLE i163_app.other (id integer PRIMARY KEY, extra text);
            INSERT INTO i163_app.notes VALUES (1, 'a'); INSERT INTO i163_app.other VALUES (1, 'a');
            CREATE SCHEMA drizzle;
            CREATE TABLE drizzle."__spfn_fn_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    }

    /** Whether, within 5 s, a session waits for a lock on i163_app.notes. */
    async function waitsOnNotes(): Promise<boolean>
    {
        for (let i = 0; i < 50; i++)
        {
            await new Promise(resolve => setTimeout(resolve, 100));
            const waiters = await db`SELECT pid FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%i163_app%notes%'`;
            if (waiters.length > 0) return true;
        }

        return false;
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

        expect(output()).toContain('📦 Applying function package migrations:\n  - @spfn/i163fix');

        printed = [];
        await push(true);

        expect(output()).toContain('No function package migrations pending');
        expect(output()).not.toContain(MIGRATION_NAME);
    });

    it('C1 a check whose values changed: dry run and push name it with the remedy and leave it as it is (spfn/spfn#167)', async () =>
    {
        await db.unsafe(`CREATE SCHEMA i163_app; CREATE TABLE i163_app.checked (state text NOT NULL,
            CONSTRAINT checked_state_check CHECK (state in ('a', 'b')))`);
        const before = await snapshot();
        const notice = 'Check "checked_state_check" on "i163_app"."checked" differs from the one in the database: '
            + 'PostgreSQL reads the two expressions differently; db push does not change an existing check.\n'
            + '   Run spfn db generate and spfn db migrate, or drop it and push again:\n'
            + '   ALTER TABLE "i163_app"."checked" DROP CONSTRAINT "checked_state_check";';

        await dbPush({ dryRun: true, schema: './src/server/entities/checked.entity.ts' });

        expect(output()).toContain(notice);
        expect(output()).toContain('No statements to apply; the checks above stay as they are');
        expect(await snapshot()).toEqual(before);

        printed = [];
        await dbPush({ schema: './src/server/entities/checked.entity.ts' });

        expect(output()).toContain(notice);
        expect(await db`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'checked_state_check'`)
            .toEqual([{ def: 'CHECK ((state = ANY (ARRAY[\'a\'::text, \'b\'::text])))' }]);
    });

    it('N1 an app with no function package prints no function package line, dry run or push', async () =>
    {
        const bare = mkdtempSync(join(__dirname, 'tmp-push-dry-run-bare-'));
        writeFixtureApp(bare, { withPackage: false });
        process.chdir(bare);

        try
        {
            await push(true);
            await push(false);
        }
        finally
        {
            process.chdir(root);
            rmSync(bare, { recursive: true, force: true });
        }

        expect(output()).toContain('CREATE TABLE "i163_app"."notes"');
        expect(output()).not.toMatch(/function package/i);
    });

    it('D4 legacy shared table holding the hash: dry run lists none and writes nothing; push leaves the legacy row and applies nothing', async () =>
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

        expect(await db`SELECT hash FROM drizzle."__spfn_fn_migrations"`).toEqual([{ hash: sha256(MIGRATION_SQL) }]);
        expect(await db`SELECT to_regclass(${`drizzle."${PACKAGE_TABLE}"`}) IS NULL AS "absent"`).toEqual([{ absent: true }]);
        expect(await db`SELECT to_regclass('i163_fix.things') IS NULL AS "skipped"`).toEqual([{ skipped: true }]);
    });

    it('S1 a pending destructive change: the dry run lists it and alters nothing', async () =>
    {
        await createProjectTable();
        await db.unsafe(`
            CREATE TYPE i163_app.mood AS ENUM ('ok', 'not');
            CREATE SEQUENCE i163_app.counter START 7;
            ALTER TABLE i163_app.notes ADD COLUMN extra text NOT NULL DEFAULT 'x' CHECK (extra <> ''),
                ADD COLUMN mood i163_app.mood;
            CREATE INDEX notes_extra ON i163_app.notes (extra);
            CREATE FUNCTION i163_app.answer() RETURNS integer LANGUAGE sql AS 'SELECT 42';`);
        const before = await snapshot();

        await push(true);

        expect(output()).toMatch(/DROP COLUMN "extra"/);
        expect(output()).toContain('Dry run: nothing was applied');
        expect(await snapshot()).toEqual(before);
    });

    it('R1 a write attempted on the dry run\'s connection is refused by PostgreSQL', async () =>
    {
        await createProjectTable();
        writeAttempts.enabled = true;

        await push(true);

        expect(writeAttempts.results).toEqual([expect.stringMatching(/read-only transaction/)]);
        expect(output()).toContain('Dry run: nothing was applied');
        expect(await db`SELECT to_regclass('i163_app.write_probe') IS NULL AS "absent"`).toEqual([{ absent: true }]);
    });

    it('R2 every query of the dry run runs on one client inside a read-only transaction of its own', async () =>
    {
        await createProjectTable();
        const sent: { client: unknown; text: string }[] = [];
        const query = pg.Client.prototype.query;
        vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: unknown, ...args: any[])
        {
            sent.push({ client: this, text: typeof args[0] === 'string' ? args[0] : args[0].text });

            return (query as (...a: unknown[]) => unknown).apply(this, args);
        } as never);

        await push(true);

        const texts = sent.map(entry => entry.text.trim());
        const transactions = Array.from({ length: Math.ceil(texts.length / 3) }, (_, i) => texts.slice(i * 3, i * 3 + 3));
        expect(new Set(sent.map(entry => entry.client)).size).toBe(1);
        expect(transactions.length).toBeGreaterThan(10);
        for (const [begin, statement, end] of transactions)
        {
            expect([begin, end]).toEqual(['BEGIN READ ONLY', 'ROLLBACK']);
            expect(statement).not.toMatch(/^(BEGIN|START|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET)\b/i);
        }
    });

    it('L1 a dry run paused before it closes holds no lock: DDL on a table it read, and DROP of the legacy table, go through', async () =>
    {
        await seedTwoTables();
        const seen: Record<string, string> = {};
        writeAttempts.beforeClose = async () =>
        {
            seen.alterNotes = await tryDdl('ALTER TABLE i163_app.notes ADD COLUMN z integer');
            seen.dropLegacy = await tryDdl('DROP TABLE drizzle."__spfn_fn_migrations"');
        };

        await push(true);

        expect(output()).toMatch(/DROP COLUMN "extra"/);
        expect(output()).toContain('Dry run: nothing was applied');
        expect(seen).toEqual({ alterNotes: 'ok', dropLegacy: 'ok' });
    });

    it('L2 a dry run waiting on a table a migration locked holds no other lock: DDL on a table it already read goes through', async () =>
    {
        await seedTwoTables();
        const migration = await connectClient();
        await migration.query('BEGIN');
        await migration.query('LOCK TABLE i163_app.notes IN ACCESS EXCLUSIVE MODE');
        const settled = push(true).then(() => 'done', (error: Error) => error.message);

        const waiting = await waitsOnNotes();
        const alterOther = await tryDdl('ALTER TABLE i163_app.other ADD COLUMN z integer');
        await migration.query('ROLLBACK');
        await migration.end();

        expect(waiting).toBe(true);
        expect(alterOther).toBe('ok');
        expect(await settled).toBe('done');
        expect(output()).toContain('Dry run: nothing was applied');
    });

    it('RO1 behind a pooler that drops the `options` startup parameter, the dry run is still read-only', async () =>
    {
        await createProjectTable();
        const proxy = await startProxy((message, startup) => startup ? withoutStartupOption(message, 'options') : message);
        process.env.DATABASE_URL = proxy.url;
        writeAttempts.enabled = true;

        try
        {
            await push(true);
        }
        finally
        {
            await proxy.close();
        }

        expect(proxy.forwarded()).toBeGreaterThan(0);
        expect(writeAttempts.results).toEqual([expect.stringMatching(/read-only transaction/)]);
        expect(output()).toContain('Dry run: nothing was applied');
    });

    it('RO2 a dry run whose transaction is not read-only stops with exit 1 before planning', async () =>
    {
        await createProjectTable();
        const before = await snapshot();
        const errors: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
        const proxy = await startProxy((message, startup) => startup ? message : withQueryText(message, 'BEGIN READ ONLY', 'BEGIN'));
        process.env.DATABASE_URL = proxy.url;

        try
        {
            await expect(push(true)).rejects.toThrow('exit 1');
        }
        finally
        {
            await proxy.close();
        }

        expect(errors.join('\n')).toMatch(/--dry-run.*transaction_read_only=off/);
        expect(output()).not.toContain('Dry run: nothing was applied');
        expect(output()).not.toContain(MIGRATION_NAME);
        expect(await snapshot()).toEqual(before);
    });
});

async function connectClient(): Promise<pg.Client>
{
    const client = new pg.Client(OWNER_URL);
    await client.connect();

    return client;
}

/**
 * A TCP proxy to OWNER_URL's server that passes each frontend message through
 * `rewrite`: the startup message (no type byte) and then every typed message.
 * `url` is OWNER_URL pointed at the proxy; it is never printed.
 */
async function startProxy(rewrite: (message: Buffer, startup: boolean) => Buffer): Promise<{
    url: string;
    forwarded: () => number;
    close: () => Promise<void>;
}>
{
    const target = new URL(OWNER_URL);
    let forwarded = 0;
    const server = createServer(client =>
    {
        const upstream = connect(Number(target.port || 5432), target.hostname);
        const frames = frontendFrames(message =>
        {
            forwarded++;
            upstream.write(rewrite(message, frames.startup));
        });
        client.on('data', frames.push);
        upstream.on('data', data => client.write(data));
        client.on('close', () => upstream.end());
        upstream.on('close', () => client.end());
        client.on('error', () => undefined);
        upstream.on('error', () => undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = new URL(OWNER_URL);
    url.hostname = 'localhost';
    url.port = String((server.address() as AddressInfo).port);

    return {
        url: url.toString(),
        forwarded: () => forwarded,
        close: () => new Promise(resolve => server.close(() => resolve())),
    };
}

/** Split a frontend byte stream into whole messages; `startup` holds until the startup message has passed. */
function frontendFrames(onMessage: (message: Buffer) => void): { push: (chunk: Buffer) => void; startup: boolean }
{
    let pending = Buffer.alloc(0);
    const frames = {
        startup: true,
        push: (chunk: Buffer) =>
        {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 5)
            {
                const length = frames.startup ? pending.readInt32BE(0) : 1 + pending.readInt32BE(1);
                if (pending.length < length) return;
                const message = pending.subarray(0, length);
                pending = pending.subarray(length);
                onMessage(message);
                // An SSLRequest (code 80877103) is followed by the real startup message
                frames.startup = frames.startup && message.length === 8 && message.readInt32BE(4) === 80877103;
            }
        },
    };

    return frames;
}

/** The startup message without one parameter. */
function withoutStartupOption(message: Buffer, name: string): Buffer
{
    const parts = message.subarray(8).toString('utf8').split('\0');
    const kept: string[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2)
    {
        if (parts[i] && parts[i] !== name) kept.push(parts[i], parts[i + 1]);
    }
    const body = Buffer.from(kept.join('\0') + '\0\0', 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32BE(body.length + 8, 0);
    header.writeInt32BE(message.readInt32BE(4), 4);

    return Buffer.concat([header, body]);
}

/** A simple-query message whose text is `from`, sent as `to`; any other message unchanged. */
function withQueryText(message: Buffer, from: string, to: string): Buffer
{
    if (message[0] !== 0x51 || message.subarray(5, -1).toString('utf8') !== from)
    {
        return message;
    }
    const text = Buffer.from(to + '\0', 'utf8');
    const header = Buffer.alloc(5);
    header[0] = 0x51;
    header.writeInt32BE(text.length + 4, 1);

    return Buffer.concat([header, text]);
}

function sha256(content: string): string
{
    return createHash('sha256').update(content).digest('hex');
}

/** A project table in schema i163_app, and unless told otherwise @spfn/i163fix shipping one migration. */
function writeFixtureApp(root: string, { withPackage = true } = {}): void
{
    const entities = join(root, 'src', 'server', 'entities');

    mkdirSync(entities, { recursive: true });
    writeFileSync(join(entities, 'notes.entity.ts'),
        "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
        + "export const app = pgSchema('i163_app');\n"
        + "export const notes = app.table('notes', { id: integer('id').primaryKey() });\n");
    writeFileSync(join(entities, 'checked.entity.ts'),
        "import { pgSchema } from 'drizzle-orm/pg-core';\n"
        + "import { enumCheck, enumText } from '@spfn/core/db';\n"
        + "export const app = pgSchema('i163_app');\n"
        + "const STATES = ['a', 'b', 'c'] as const;\n"
        + "export const checked = app.table('checked', { state: enumText('state', STATES).notNull() }, (t) => [enumCheck(t.state, STATES)]);\n");

    if (withPackage)
    {
        writeFunctionPackage(root, MIGRATION_NAME, MIGRATION_SQL);
    }
}
