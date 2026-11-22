/**
 * `spfn db push` replaces a check whose expression changed (#442)
 *
 * drizzle-kit's push never alters an existing check; push compares each one
 * with PostgreSQL's own normalisation (changed-checks.ts). A scratch app with
 * one entity file per row, pushed to TEST_DATABASE_URL through dbPush.
 * `prompts` answers by failing the row: a replacement is not destructive, and a
 * push that reached the confirmation would wait on stdin.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';

import { OWNER_URL, requireDatabase } from './helpers/test-database.js';

vi.mock('prompts', () => ({
    default: async () =>
    {
        throw new Error('prompts was called: the push reached the destructive confirmation');
    },
}));

const { dbPush } = await import('../push.js');

const SCHEMA = 'i442_app';
const REPLACEMENT = 'ALTER TABLE "i442_app"."records" DROP CONSTRAINT IF EXISTS "records_operation_check", '
    + 'ADD CONSTRAINT "records_operation_check" CHECK ("operation" in (\'a\', \'b\', \'c\'));';

/** An entity file declaring `body` in schema i442_app, with the drizzle-orm helpers it uses */
function entityFile(body: string): string
{
    return "import { pgSchema, text, integer, index, check } from 'drizzle-orm/pg-core';\n"
        + "import { sql } from 'drizzle-orm';\n"
        + `export const app = pgSchema('${SCHEMA}');\n`
        + body;
}

/** The records table, its check listing `values` */
function records(values: string, extraColumns = ''): string
{
    return entityFile(`export const records = app.table('records', { operation: text('operation')${extraColumns} },
        (t) => [check('records_operation_check', sql\`\${t.operation} in (${values})\`)]);\n`);
}

describe('db push and changed checks', () =>
{
    const db = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    let available = false;
    let root: string;
    let previousCwd: string;
    let printed: string[];
    /** The entity file dbPush reads: a new one per write, as a module once imported is cached */
    let entity = '';
    let written = 0;

    beforeAll(async () =>
    {
        available = await requireDatabase(db, 'db push changed-check integration tests');
        root = mkdtempSync(join(__dirname, 'tmp-push-checks-'));
        mkdirSync(join(root, 'src', 'server', 'entities'), { recursive: true });
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
        const record = (...args: unknown[]) => void printed.push(args.map(String).join(' '));
        vi.spyOn(console, 'log').mockImplementation(record);
        vi.spyOn(console, 'error').mockImplementation(record);
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
        await db.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        await db.unsafe('DROP SCHEMA IF EXISTS i442_part CASCADE');
    }

    function writeEntity(content: string): void
    {
        entity = `./src/server/entities/records-${++written}.entity.ts`;
        writeFileSync(join(root, entity), content);
    }

    /** dbPush on the entity file: 'done', or the error it ended with (`exit 1`) */
    async function push(options: { dryRun?: boolean; force?: boolean } = {}): Promise<string>
    {
        return dbPush({ ...options, schema: entity }).then(() => 'done', (error: Error) => error.message);
    }

    /** Every constraint of the schema with its definition, and whether it is validated */
    async function constraints(): Promise<string[]>
    {
        return (await db<{ line: string }[]>`
            SELECT format('%s.%s %s validated=%s', c.relname, con.conname, pg_get_constraintdef(con.oid), con.convalidated::text) AS line
            FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN (${SCHEMA}, 'i442_part') ORDER BY 1`).map(row => row.line);
    }

    async function seedRecords(values: string): Promise<void>
    {
        await db.unsafe(`CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.records (operation text,
            CONSTRAINT records_operation_check CHECK (operation in (${values})))`);
    }

    const output = () => printed.join('\n');

    /** The locks on the records table a session waits for, polled until one does or `running` settles */
    async function locksWaitedForUntil(running: Promise<unknown>): Promise<string[]>
    {
        let settled = false;
        void running.finally(() =>
        {
            settled = true;
        });

        for (let polls = 0; polls < 100 && !settled; polls++)
        {
            const waiting = await db<{ mode: string }[]>`
                SELECT mode FROM pg_locks WHERE relation = ${`${SCHEMA}.records`}::regclass AND NOT granted`;

            if (waiting.length > 0)
            {
                return waiting.map(lock => lock.mode);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return [];
    }

    it('K1 the issue: a value added to the list — the dry run lists the replacement and writes nothing; push replaces it and the value inserts', async () =>
    {
        await seedRecords(`'a', 'b'`);
        await db.unsafe(`INSERT INTO ${SCHEMA}.records VALUES ('a'), ('b')`);
        writeEntity(records(`'a', 'b', 'c'`));
        const before = await constraints();

        expect(await push({ dryRun: true })).toBe('done');
        expect(output()).toContain(REPLACEMENT);
        expect(output()).not.toContain('No changes detected');
        expect(await constraints()).toEqual(before);

        printed = [];
        expect(await push()).toBe('done');
        expect(output()).toContain('Replaces a check');
        expect(await constraints()).toEqual([
            'records.records_operation_check CHECK ((operation = ANY (ARRAY[\'a\'::text, \'b\'::text, \'c\'::text]))) validated=true',
        ]);
        await db.unsafe(`INSERT INTO ${SCHEMA}.records VALUES ('c')`);

        printed = [];
        expect(await push({ dryRun: true })).toBe('done');
        expect(output()).toContain('No changes detected — project schema is up to date');
    });

    it('K2 unchanged checks PostgreSQL stores rewritten — IN list, enum cast, quoted names, other columns, a partitioned table: no changes, up to date', async () =>
    {
        writeEntity(entityFile(`export const mood = app.enum('Mood', ['ok', 'sad']);
            export const rows = app.table('Rows', { op: text('Op'), feeling: mood('feeling'), lo: integer('lo'), hi: integer('hi') }, (t) => [
                check('rows_op_check', sql\`\${t.op} in ('a', 'b')\`),
                check('rows_feeling_check', sql\`\${t.feeling} in ('ok'::"${SCHEMA}"."Mood")\`),
                check('rows_range_check', sql\`\${t.lo} <= \${t.hi} and \${t.op} is not null\`),
            ]);
            export const parted = app.table('parted', { k: integer('k'), s: text('s') }, (t) => [check('parted_s_check', sql\`\${t.s} in ('x', 'y')\`)]);\n`));
        expect(await push()).toBe('done');
        await db.unsafe(`DROP TABLE ${SCHEMA}.parted;
            CREATE TABLE ${SCHEMA}.parted (k integer, s text, CONSTRAINT parted_s_check CHECK (s in ('x', 'y'))) PARTITION BY RANGE (k);
            CREATE SCHEMA i442_part; CREATE TABLE i442_part.parted_1 PARTITION OF ${SCHEMA}.parted FOR VALUES FROM (0) TO (10)`);
        const before = await constraints();

        printed = [];
        expect(await push()).toBe('done');

        expect(output()).toContain('No changes detected — project schema is up to date');
        expect(output()).not.toContain('Not compared by db push');
        expect(output()).not.toContain('was not compared');
        expect(await constraints()).toEqual(before);
    });

    it('K3 rows the new check refuses: push fails with PostgreSQL\'s message and the statement; the old check stays', async () =>
    {
        await seedRecords(`'a', 'b', 'c', 'd'`);
        await db.unsafe(`INSERT INTO ${SCHEMA}.records VALUES ('d')`);
        writeEntity(records(`'a', 'b', 'c'`));
        const before = await constraints();

        expect(await push()).toBe('exit 1');

        expect(output()).toContain('The project statements were rolled back');
        expect(output()).toContain('Integrity constraint violated (23514, constraint records_operation_check, table i442_app.records)');
        expect(output()).toContain(`Failed statement: ${REPLACEMENT}`);
        expect(await constraints()).toEqual(before);
    });

    it('K4 a declared expression PostgreSQL refuses — a type error, a column no one declares — ends the plan, nothing written', async () =>
    {
        await seedRecords(`'a', 'b'`);
        const before = await constraints();

        for (const [expression, code] of [['${t.operation} > 1', '42883'], ['nosuch in (1)', '42703']])
        {
            writeEntity(entityFile(`export const records = app.table('records', { operation: text('operation') },
                (t) => [check('records_operation_check', sql\`${expression}\`)]);\n`));
            printed = [];

            expect(await push()).toBe('exit 1');
            expect(output()).toContain(`Planning failed — nothing was applied: Invalid query (${code})`);
            expect(output()).toContain('In: check "records_operation_check" on "i442_app"."records", as declared');
            expect(await constraints()).toEqual(before);
        }
    });

    it('K5 a check naming a column this push adds: the column is added, then the check replaced', async () =>
    {
        await seedRecords(`'a', 'b'`);
        writeEntity(entityFile(`export const records = app.table('records', { operation: text('operation'), kind: text('kind') },
            (t) => [check('records_operation_check', sql\`\${t.operation} in ('a', 'b') and \${t.kind} <> ''\`)]);\n`));

        expect(await push()).toBe('done');

        expect(await constraints()).toEqual([
            'records.records_operation_check CHECK (((operation = ANY (ARRAY[\'a\'::text, \'b\'::text])) AND (kind <> \'\'::text))) validated=true',
        ]);
    });

    it('K6 an index and a generated column declared: push names what it does not compare, and still says up to date', async () =>
    {
        writeEntity(entityFile(`export const records = app.table('records', {
                operation: text('operation'),
                size: integer('size').generatedAlwaysAs(sql\`1\`),
            }, (t) => [index('records_operation_idx').on(t.operation)]);\n`));
        expect(await push()).toBe('done');

        printed = [];
        expect(await push({ dryRun: true })).toBe('done');

        expect(output()).toContain('Not compared by db push: index columns and WHERE (1), generated column expressions (1)');
        expect(output()).toContain('No changes detected — project schema is up to date');
    });

    it('T1 an enum value this push adds, used by the check on a column of that enum: not compared, the value added; the next push replaces the check', async () =>
    {
        const declare = (values: string) => entityFile(`export const kind = app.enum('kind', [${values}]);
            export const records = app.table('records', { k: kind('k') }, (t) => [check('records_k_check', sql\`\${t.k} in (${values})\`)]);\n`);
        writeEntity(declare(`'a', 'b'`));
        expect(await push()).toBe('done');
        writeEntity(declare(`'a', 'b', 'c'`));

        printed = [];
        expect(await push()).toBe('done');
        expect(output()).toContain('Check "records_k_check" on "i442_app"."records" was not compared, and stays as it is: '
            + 'PostgreSQL refused it as declared: Invalid input value (22P02); this push creates or changes "i442_app"."kind"');

        printed = [];
        expect(await push()).toBe('done');
        expect(output()).toContain('DROP CONSTRAINT IF EXISTS "records_k_check"');
        expect(await constraints()).toEqual([
            'records.records_k_check CHECK ((k = ANY (ARRAY[\'a\'::i442_app.kind, \'b\'::i442_app.kind, \'c\'::i442_app.kind]))) validated=true',
        ]);

        printed = [];
        expect(await push({ dryRun: true })).toBe('done');
        expect(output()).toContain('No changes detected — project schema is up to date');
    });

    it('T2 a text column whose check casts to an enum, a value this push adds and the check uses: plans, the check not compared', async () =>
    {
        const declare = (values: string) => entityFile(`export const kind = app.enum('kind', [${values}]);
            export const other = app.table('other', { k: kind('k') });
            export const records = app.table('records', { s: text('s') }, (t) => [check('records_s_check', sql\`\${t.s}::${SCHEMA}.kind in (${values})\`)]);\n`);
        writeEntity(declare(`'a', 'b'`));
        expect(await push()).toBe('done');
        writeEntity(declare(`'a', 'b', 'c'`));

        printed = [];
        expect(await push({ dryRun: true })).toBe('done');
        expect(output()).toContain('ALTER TYPE "i442_app"."kind" ADD VALUE \'c\'');
        expect(output()).toContain('Check "records_s_check" on "i442_app"."records" was not compared, and stays as it is: '
            + 'PostgreSQL refused it as declared: Invalid input value (22P02)');
    });

    it('T3 a text column whose check casts to an enum this push creates: plans, the check not compared', async () =>
    {
        await seedRecords(`'a', 'b'`);
        writeEntity(entityFile(`export const kind = app.enum('kind', ['a', 'b']);
            export const records = app.table('records', { operation: text('operation') },
                (t) => [check('records_operation_check', sql\`\${t.operation}::${SCHEMA}.kind in ('a', 'b')\`)]);\n`));

        expect(await push({ dryRun: true })).toBe('done');
        expect(output()).toContain('CREATE TYPE "i442_app"."kind"');
        expect(output()).toContain('Check "records_operation_check" on "i442_app"."records" was not compared, and stays as it is: '
            + 'PostgreSQL refused it as declared: ');
        expect(output()).toContain('(42704); this push creates or changes "i442_app"."kind"');
    });

    it('P1 a dry run while another session holds the table: it waits for no lock on it, and a reader is not queued', async () =>
    {
        await seedRecords(`'a', 'b'`);
        writeEntity(records(`'a', 'b', 'c'`));
        const holder = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
        const reader = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
        const held = await holder.reserve();
        await held.unsafe(`BEGIN; SELECT * FROM ${SCHEMA}.records`);

        const dryRun = push({ dryRun: true });
        const waiting = await locksWaitedForUntil(dryRun);
        const read = await reader.unsafe(`SET statement_timeout = 2000; SELECT count(*) FROM ${SCHEMA}.records`)
            .then(() => 'read', (error: Error) => error.message);
        await held.unsafe('COMMIT');
        held.release();
        await Promise.all([holder.end(), reader.end()]);

        expect(await dryRun).toBe('done');
        expect(waiting).toEqual([]);
        expect(read).toBe('read');
        expect(output()).toContain(REPLACEMENT);
    });

    it('P2 a column type change with a check that needs the new type, --force: both change, and a second push is a no-op', async () =>
    {
        await db.unsafe(`CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.records (n text, CONSTRAINT records_n_check CHECK (n is not null));
            INSERT INTO ${SCHEMA}.records VALUES ('5')`);
        writeEntity(entityFile(`export const records = app.table('records', { n: integer('n') },
            (t) => [check('records_n_check', sql\`\${t.n} > 0\`)]);\n`));

        expect(await push({ force: true })).toBe('done');
        expect(await constraints()).toEqual(['records.records_n_check CHECK ((n > 0)) validated=true']);

        printed = [];
        expect(await push({ dryRun: true })).toBe('done');
        expect(output()).toContain('No changes detected — project schema is up to date');
    });

    it('P3 a changed check under the name the comparison used to add its own (spfn_push_compared_check): replaced', async () =>
    {
        await db.unsafe(`CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.records (operation text,
            CONSTRAINT spfn_push_compared_check CHECK (operation in ('a', 'b')))`);
        writeEntity(entityFile(`export const records = app.table('records', { operation: text('operation') },
            (t) => [check('spfn_push_compared_check', sql\`\${t.operation} in ('a', 'b', 'c')\`)]);\n`));

        expect(await push()).toBe('done');
        expect(await constraints()).toEqual([
            'records.spfn_push_compared_check CHECK ((operation = ANY (ARRAY[\'a\'::text, \'b\'::text, \'c\'::text]))) validated=true',
        ]);
    });

    it('P4 a dry run on a database whose transactions are read-only by default (as a standby): plans, and names the check not compared', async () =>
    {
        await seedRecords(`'a', 'b'`);
        writeEntity(records(`'a', 'b', 'c'`));
        const [{ name }] = await db<{ name: string }[]>`SELECT current_database() AS name`;
        await db.unsafe(`ALTER DATABASE "${name}" SET default_transaction_read_only = on`);

        const dryRun = await push({ dryRun: true }).finally(() => db.unsafe(`ALTER DATABASE "${name}" RESET default_transaction_read_only`));

        expect(dryRun).toBe('done');
        expect(output()).toContain('Check "records_operation_check" on "i442_app"."records" was not compared, and stays as it is: '
            + 'the comparison table could not be created: ');
        expect(output()).toContain('(25006)');
        expect(output()).not.toContain(REPLACEMENT);
        expect(output()).toContain('No statements to apply; the checks above stay as they are');
        expect(output()).not.toContain('up to date');
    });

    it('P5 a column the old check names is dropped and the check declared without it, --force: the column goes, the new check stays, a second push is a no-op', async () =>
    {
        await db.unsafe(`CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.records (a integer, b integer,
            CONSTRAINT records_ab_check CHECK (a > 0 and b > 0))`);
        writeEntity(entityFile(`export const records = app.table('records', { a: integer('a') },
            (t) => [check('records_ab_check', sql\`\${t.a} > 0\`)]);\n`));

        expect(await push({ force: true })).toBe('done');
        expect(await constraints()).toEqual(['records.records_ab_check CHECK ((a > 0)) validated=true']);

        printed = [];
        expect(await push({ dryRun: true })).toBe('done');
        expect(output()).toContain('No changes detected — project schema is up to date');
    });
});
