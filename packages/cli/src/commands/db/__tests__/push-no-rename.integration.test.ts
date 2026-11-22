/**
 * `spfn db push` does not rename: a kind with objects both removed and added
 * is dropped, then created (spfn/spfn#173)
 *
 * drizzle-kit's pushSchema asks whether such objects are one renamed, and push
 * can give it no answer: the push ended in `resolver(<kind>) was called
 * without a HintsHandler`. Each row seeds the database as it was with SQL,
 * then pushes a scratch app declaring it as it is now, to TEST_DATABASE_URL;
 * drizzle.config.ts limits the push to the row's schemas. stdin is no terminal,
 * so a push that reaches the destructive confirmation without --force exits 1.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';
import postgres from 'postgres';

import { OWNER_URL, requireDatabase } from './helpers/test-database.js';

vi.mock('prompts', () => ({
    default: async () =>
    {
        throw new Error('prompts was called: stdin is no terminal in these rows');
    },
}));

const { dbPush } = await import('../push.js');

const SCHEMAS = ['i173_app', 'i173_old', 'i173_new'];

/** Each preserved kind push splits while another of the same table keeps its database name (R11) */
const LEGACY_NAMED = [
    {
        kind: 'unique constraint',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text CONSTRAINT u_legacy UNIQUE, a text CONSTRAINT u_old UNIQUE)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep').unique(), a: text('a') }, (t) => [unique('u_new').on(t.a)]);\n",
        legacy: 'u_legacy',
        gone: 'u_old',
        added: 'u_new',
    },
    {
        kind: 'index',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, a text); '
            + 'CREATE INDEX idx_legacy ON i173_app.t (keep); CREATE INDEX idx_old ON i173_app.t (a)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), a: text('a') }, (t) => [index().on(t.keep), index('idx_new').on(t.a)]);\n",
        legacy: 'idx_legacy',
        gone: 'idx_old',
        added: 'idx_new',
    },
    {
        kind: 'foreign key',
        before: 'CREATE TABLE i173_app.r (id integer PRIMARY KEY); CREATE TABLE i173_app.t (id integer PRIMARY KEY, '
            + 'a integer CONSTRAINT fk_legacy REFERENCES i173_app.r (id), b integer CONSTRAINT fk_old REFERENCES i173_app.r (id))',
        after: "export const r = app.table('r', { id: integer('id').primaryKey() });\n"
            + "export const t = app.table('t', { id: integer('id').primaryKey(), a: integer('a').references(() => r.id), b: integer('b') }, "
            + "(t) => [foreignKey({ name: 'fk_new', columns: [t.b], foreignColumns: [r.id] })]);\n",
        legacy: 'fk_legacy',
        gone: 'fk_old',
        added: 'fk_new',
    },
];

/** A column replaced whose new column a constraint or an index is declared on (R14) */
const ON_ADDED_COLUMN = [
    {
        dependent: 'a unique constraint',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh').unique('u_fresh') });\n",
        created: 'u_fresh',
    },
    {
        dependent: 'an index',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, (t) => [index('idx_fresh').on(t.fresh)]);\n",
        created: 'idx_fresh',
    },
    {
        dependent: 'an expression index',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, (t) => [index('idx_lower').on(sql`lower(${t.fresh})`)]);\n",
        created: 'idx_lower',
    },
    {
        dependent: 'a foreign key of another table',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text); CREATE TABLE i173_app.r (id integer PRIMARY KEY, ref text)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh').unique('u_fresh') });\n"
            + "export const r = app.table('r', { id: integer('id').primaryKey(), ref: text('ref') }, "
            + "(r) => [foreignKey({ name: 'fk_fresh', columns: [r.ref], foreignColumns: [t.fresh] })]);\n",
        created: 'fk_fresh',
    },
    {
        dependent: 'a check, on a table with rows',
        before: "CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text); INSERT INTO i173_app.t VALUES (1, 'k', 'o')",
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, "
            + "(t) => [check('ck_fresh', sql`${t.fresh} IS NULL OR ${t.keep} IS NOT NULL`)]);\n",
        created: 'ck_fresh',
    },
    {
        dependent: 'a policy',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, "
            + "(t) => [pgPolicy('p_fresh', { for: 'select', using: sql`${t.fresh} IS NOT NULL` })]).enableRLS();\n",
        created: 'p_fresh',
    },
];

/** What push must create before the drops, named as an object it drops, in each of PostgreSQL's namespaces shared by two kinds (R19) */
const HELD_NAMES = [
    {
        created: 'index "idx_x" on "i173_app"."t"',
        holder: 'index "idx_x" on "i173_app"."u"',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, old text); '
            + 'CREATE TABLE i173_app.u (id integer PRIMARY KEY, keep text); CREATE INDEX idx_x ON i173_app.u (keep)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), fresh: text('fresh') }, (t) => [index('idx_x').on(t.fresh)]);\n"
            + "export const u = app.table('u', { id: integer('id').primaryKey(), keep: text('keep') });\n",
    },
    {
        created: 'check "c_x" on "i173_app"."t"',
        holder: 'unique constraint "c_x" on "i173_app"."t"',
        before: 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text CONSTRAINT c_x UNIQUE, old text)',
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, "
            + "(t) => [check('c_x', sql`${t.fresh} <> ''`)]);\n",
    },
    {
        created: 'table "i173_app"."mood"',
        holder: 'enum "i173_app"."mood"',
        before: "CREATE TABLE i173_app.t (id integer PRIMARY KEY, old text); CREATE TYPE i173_app.mood AS ENUM ('a')",
        after: "export const t = app.table('t', { id: integer('id').primaryKey(), fresh: text('fresh') });\n"
            + "export const mood = app.table('mood', { id: integer('id') });\n",
    },
];

/** A column replaced in `o` whose new column references `c.code`, made unique in the same push on `c`, which gains no column (R18, R20) */
const referencesAddedKey = (key: string) => ({
    before: 'CREATE TABLE i173_app.c (id integer PRIMARY KEY, code text); CREATE TABLE i173_app.o (id integer PRIMARY KEY, old text)',
    after: `export const c = app.table('c', { id: integer('id').primaryKey(), code: text('code') }, (c) => [${key}]);\n`
        + "export const o = app.table('o', { id: integer('id').primaryKey(), fresh: text('fresh') }, "
        + "(o) => [foreignKey({ name: 'fk_code', columns: [o.fresh], foreignColumns: [c.code] })]);\n",
});

const REFERENCES_ADDED_UNIQUE = referencesAddedKey("unique('u_code').on(c.code)");

const REFERENCED_KEYS = [
    { key: 'a unique constraint', ...REFERENCES_ADDED_UNIQUE },
    { key: 'a unique index', ...referencesAddedKey("uniqueIndex('u_code').on(c.code)") },
];

/** A literal holding a quote that a reader knowing only ''-escaped literals ends early, reading the new column after it as text (R23) */
const QUOTING_LITERALS = [
    { literal: 'an E-string with a backslash-escaped quote', text: "E'\\\\''" },
    { literal: 'a dollar-quoted string holding a quote', text: "$$it's$$" },
];

const IMPORTS = "import { sql } from 'drizzle-orm';\n"
    + "import { check, foreignKey, index, integer, pgPolicy, pgSchema, primaryKey, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';\n"
    + "export const app = pgSchema('i173_app');\n";

/** `t` as each row declares it, with `columns` and `extra` added */
const table = (columns = '', extra = '') =>
    `export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep')${columns} }${extra});\n`;

const TABLE_SQL = 'CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text)';

/** One kind push splits besides tables and columns: the database before, the declaration after, the object gone and the one new. */
const KINDS = [
    {
        kind: 'index',
        before: `${TABLE_SQL}; CREATE INDEX idx_old ON i173_app.t (keep)`,
        after: table('', ", (t) => [index('idx_new').on(t.keep)]"),
        gone: 'idx_old',
        added: 'idx_new',
    },
    {
        kind: 'unique constraint',
        before: `${TABLE_SQL}; ALTER TABLE i173_app.t ADD CONSTRAINT u_old UNIQUE (keep)`,
        after: table('', ", (t) => [unique('u_new').on(t.keep)]"),
        gone: 'u_old',
        added: 'u_new',
    },
    {
        kind: 'check',
        before: `${TABLE_SQL}; ALTER TABLE i173_app.t ADD CONSTRAINT c_old CHECK (keep <> '')`,
        after: table('', ", (t) => [check('c_new', sql`${t.keep} <> 'x'`)]"),
        gone: 'c_old',
        added: 'c_new',
    },
    {
        kind: 'foreign key',
        before: 'CREATE TABLE i173_app.r (id integer PRIMARY KEY); '
            + `${TABLE_SQL}; ALTER TABLE i173_app.t ADD COLUMN rid integer CONSTRAINT fk_old REFERENCES i173_app.r (id)`,
        after: "export const r = app.table('r', { id: integer('id').primaryKey() });\n"
            + table(", rid: integer('rid')", ", (t) => [foreignKey({ name: 'fk_new', columns: [t.rid], foreignColumns: [r.id] })]"),
        gone: 'fk_old',
        added: 'fk_new',
    },
    {
        kind: 'policy',
        before: `${TABLE_SQL}; ALTER TABLE i173_app.t ENABLE ROW LEVEL SECURITY; CREATE POLICY p_old ON i173_app.t FOR SELECT USING (true)`,
        after: table('', ", () => [pgPolicy('p_new', { for: 'select', using: sql`true` })]"),
        gone: 'p_old',
        added: 'p_new',
    },
    {
        kind: 'enum',
        before: "CREATE TYPE i173_app.e_old AS ENUM ('a')",
        after: "export const e = app.enum('e_new', ['a']);\n",
        gone: 'e_old',
        added: 'e_new',
    },
    {
        kind: 'sequence',
        before: 'CREATE SEQUENCE i173_app.q_old',
        after: "export const q = app.sequence('q_new');\n",
        gone: 'q_old',
        added: 'q_new',
    },
    {
        kind: 'view',
        before: `${TABLE_SQL}; CREATE VIEW i173_app.v_old AS SELECT id FROM i173_app.t`,
        after: table() + "export const v = app.view('v_new', { id: integer('id') }).as(sql`select \"id\" from \"i173_app\".\"t\"`);\n",
        gone: 'v_old',
        added: 'v_new',
    },
    {
        kind: 'view',
        before: `${TABLE_SQL}; CREATE MATERIALIZED VIEW i173_app.mv_old AS SELECT id FROM i173_app.t`,
        after: table() + "export const v = app.materializedView('mv_new', { id: integer('id') }).as(sql`select \"id\" from \"i173_app\".\"t\"`);\n",
        gone: 'mv_old',
        added: 'mv_new',
    },
    {
        kind: 'schema',
        before: 'CREATE SCHEMA i173_old; CREATE TABLE i173_old.t (id integer)',
        after: "export const fresh = pgSchema('i173_new');\nexport const t = fresh.table('t', { id: integer('id') });\n",
        gone: 'i173_old',
        added: 'i173_new',
    },
];

describe('db push drops, then creates, what is removed and added', () =>
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
        available = await requireDatabase(db, 'db push no-rename integration tests');
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
        await db.unsafe('CREATE SCHEMA i173_app');
        root = mkdtempSync(join(__dirname, 'tmp-push-no-rename-'));
        previousCwd = process.cwd();
        process.chdir(root);
        process.env.DATABASE_URL = OWNER_URL;
        printed = [];
        errors = [];
        stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
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

    async function resetDatabase(): Promise<void>
    {
        for (const schema of SCHEMAS)
        {
            await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
    }

    /** Every schema, relation, column, constraint, type and policy of SCHEMAS, one line each. */
    async function catalog(): Promise<string[]>
    {
        const rows = await db<{ line: string }[]>`
            SELECT 'schema ' || nspname AS line FROM pg_namespace WHERE nspname = ANY(${SCHEMAS})
            UNION ALL SELECT format('relation %s.%s %s', n.nspname, c.relname, c.relkind)
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY(${SCHEMAS})
            UNION ALL SELECT format('column %s.%s.%s', n.nspname, c.relname, a.attname)
                FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = ANY(${SCHEMAS}) AND a.attnum > 0 AND NOT a.attisdropped
            UNION ALL SELECT format('constraint %s.%s %s', n.nspname, k.conname, pg_get_constraintdef(k.oid))
                FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = ANY(${SCHEMAS})
            UNION ALL SELECT format('type %s.%s', n.nspname, t.typname)
                FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ANY(${SCHEMAS}) AND t.typtype = 'e'
            UNION ALL SELECT format('policy %s.%s', c.relname, p.polname)
                FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = ANY(${SCHEMAS})
            ORDER BY 1`;

        return rows.map(row => row.line);
    }

    /** The names in catalog() lines: the object a row looks for, whatever its kind. */
    async function names(): Promise<string[]>
    {
        return (await catalog()).map(line => line.split(' ')[1].split('.').at(-1)!);
    }

    /** Declare the app as it is now, limited to `schemaFilter` */
    function declareApp(source: string, schemaFilter: string[] = SCHEMAS): void
    {
        const entities = join(root, 'src', 'server', 'entities');
        mkdirSync(entities, { recursive: true });
        writeFileSync(join(entities, 'app.entity.ts'), IMPORTS + source);
        writeFileSync(join(root, 'drizzle.config.ts'),
            `export default { schema: './src/server/entities/app.entity.ts', schemaFilter: ${JSON.stringify(schemaFilter)} };\n`);
    }

    const output = () => printed.join('\n');
    const push = (options: { dryRun?: boolean; force?: boolean } = {}) => dbPush(options);

    it('R1 table a removed, table b added (the issue): without --force nothing is written, the drop and the create are listed', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.a (id integer); INSERT INTO i173_app.a VALUES (1)');
        declareApp("export const b = app.table('b', { id: integer('id') });\n");
        const before = await catalog();

        await expect(push()).rejects.toThrow('exit 1');

        expect(output()).toContain('table: "i173_app"."a" removed, "i173_app"."b" added');
        expect(output()).toContain('DROP TABLE "i173_app"."a"');
        expect(output()).toContain('CREATE TABLE "i173_app"."b"');
        expect(errors.join('\n')).toContain('Destructive changes need a confirmation and stdin is not a terminal — nothing was applied');
        expect(await catalog()).toEqual(before);
    });

    it('R2 table a removed, table b added, --force: a is dropped, then b created', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.a (id integer)');
        declareApp("export const b = app.table('b', { id: integer('id') });\n");

        await push({ force: true });

        expect(output().indexOf('DROP TABLE "i173_app"."a"')).toBeGreaterThanOrEqual(0);
        expect(await names()).toContain('b');
        expect(await names()).not.toContain('a');
    });

    it('R3 table a removed, table b added, --dry-run: both listed, the catalog unchanged afterwards', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.a (id integer)');
        declareApp("export const b = app.table('b', { id: integer('id') });\n");
        const before = await catalog();

        await push({ dryRun: true });

        expect(output()).toContain('DROP TABLE "i173_app"."a"');
        expect(output()).toContain('CREATE TABLE "i173_app"."b"');
        expect(output()).toContain('Dry run: nothing was applied');
        expect(await catalog()).toEqual(before);
    });

    it('R4 a column removed and a column added in one table: listed without --force, applied with it, the other columns and rows untouched', async () =>
    {
        await db.unsafe("CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text); INSERT INTO i173_app.t VALUES (1, 'kept', 'gone'), (2, 'also', NULL)");
        declareApp(table(", fresh: text('fresh')"));
        const before = await catalog();

        await expect(push()).rejects.toThrow('exit 1');

        expect(output()).toContain('column on "i173_app"."t": "old" removed, "fresh" added');
        expect(await catalog()).toEqual(before);

        await push({ force: true });

        expect(await db`SELECT * FROM i173_app.t ORDER BY id`).toEqual([{ id: 1, keep: 'kept', fresh: null }, { id: 2, keep: 'also', fresh: null }]);
    });

    it.each(KINDS)('R5 $kind $gone removed, $added added, --force: dropped, then created', async ({ kind, before, after, gone, added }) =>
    {
        await db.unsafe(before);
        declareApp(after);

        await push({ force: true });

        expect(output()).toMatch(new RegExp(`${kind}[^:]*: [^\\n]*"${gone}" removed, [^\\n]*"${added}" added`));
        expect(await names()).toContain(added);
        expect(await names()).not.toContain(gone);
    });

    it('R6 a primary key removed and another added: push stops at the plan stage, names both, changes nothing', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer NOT NULL, CONSTRAINT pk_old PRIMARY KEY (id))');
        declareApp("export const t = app.table('t', { id: integer('id').notNull() }, (t) => [primaryKey({ name: 'pk_new', columns: [t.id] })]);\n");
        const before = await catalog();

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain('Planning stopped — nothing was applied: drizzle-kit finds a primary key removed and another added, and db push does not rename');
        expect(errors.join('\n')).toContain('primary key on "i173_app"."t": "pk_old" removed, "pk_new" added');
        expect(output()).toContain('spfn db generate');
        expect(await catalog()).toEqual(before);
    });

    it('R8 a primary key named apart from drizzle-kit\'s default, nothing else changed: no changes, as before #173', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer CONSTRAINT legacy_pk PRIMARY KEY, keep text)');
        declareApp(table());

        await push({ force: true });

        expect(output()).toContain('No changes detected');
        expect(errors).toEqual([]);
    });

    it('R9 a unique constraint named apart from drizzle-kit\'s default, nothing else changed: no changes, as before #173', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text CONSTRAINT u_legacy UNIQUE)');
        declareApp("export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep').unique() });\n");

        await push();

        expect(output()).toContain('No changes detected');
        expect(errors).toEqual([]);
    });

    it('R10 a schema replaced, admitted by a schemaFilter glob: dropped, then created', async () =>
    {
        await db.unsafe('CREATE SCHEMA i173_old; CREATE TABLE i173_old.t (id integer)');
        declareApp("export const fresh = pgSchema('i173_new');\nexport const t = fresh.table('t', { id: integer('id') });\n", ['i173_*']);

        await push({ force: true });

        expect(output()).toContain('schema: "i173_old" removed, "i173_new" added');
        expect(await names()).toContain('i173_new');
        expect(await names()).not.toContain('i173_old');
    });

    it.each(LEGACY_NAMED)('R11 $kind $gone removed, $added added, beside an unnamed one the database names $legacy: $legacy stays', async ({ kind, before, after, legacy, gone, added }) =>
    {
        await db.unsafe(before);
        declareApp(after);

        await push({ force: true });

        expect(output()).toMatch(new RegExp(`${kind} on "i173_app"."t": "${gone}" removed, "${added}" added`));
        expect(output()).not.toContain(`"${legacy}"`);
        expect(await names()).toEqual(expect.arrayContaining([legacy, added]));
        expect(await names()).not.toContain(gone);
    });

    it('R12 a partition removed and a table added: the partition is dropped, then the table created', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.p (id integer NOT NULL) PARTITION BY RANGE (id); '
            + 'CREATE TABLE i173_app.p1 PARTITION OF i173_app.p FOR VALUES FROM (0) TO (10)');
        declareApp("export const p = app.table('p', { id: integer('id').notNull() });\nexport const b = app.table('b', { id: integer('id') });\n");

        await push({ force: true });

        expect(output()).toContain('table: "i173_app"."p1" removed, "i173_app"."b" added');
        expect(await names()).toEqual(expect.arrayContaining(['p', 'b']));
        expect(await names()).not.toContain('p1');
    });

    it('R13 a column replaced in one table, an index in another: drizzle-kit reports the column, then the index; both are split', async () =>
    {
        await db.unsafe(`${TABLE_SQL}; ALTER TABLE i173_app.t ADD COLUMN old text; `
            + 'CREATE TABLE i173_app.u (id integer PRIMARY KEY, keep text); CREATE INDEX idx_old ON i173_app.u (keep)');
        declareApp(table(", fresh: text('fresh')")
            + "export const u = app.table('u', { id: integer('id').primaryKey(), keep: text('keep') }, (u) => [index('idx_new').on(u.keep)]);\n");

        await push({ force: true });

        expect(output()).toContain('column on "i173_app"."t": "old" removed, "fresh" added');
        expect(output()).toContain('index on "i173_app"."u": "idx_old" removed, "idx_new" added');
        expect(await names()).toEqual(expect.arrayContaining(['fresh', 'idx_new']));
        expect(await names()).not.toEqual(expect.arrayContaining(['old']));
        expect(await names()).not.toContain('idx_old');
    });

    it.each(ON_ADDED_COLUMN)('R14 a column replaced, $dependent on the new one: dropped, then created with it', async ({ before, after, created }) =>
    {
        await db.unsafe(before);
        declareApp(after);

        await push({ force: true });

        expect(output()).toContain('column on "i173_app"."t": "old" removed, "fresh" added');
        expect(await names()).toEqual(expect.arrayContaining(['fresh', created]));
        expect(await names()).not.toContain('old');
    });

    it('R15 a column and an index both replaced in one table: both listed, both dropped, then created', async () =>
    {
        await db.unsafe(`${TABLE_SQL}; ALTER TABLE i173_app.t ADD COLUMN old text; CREATE INDEX idx_old ON i173_app.t (keep)`);
        declareApp(table(", fresh: text('fresh')", ", (t) => [index('idx_new').on(t.keep)]"));

        await push({ force: true });

        expect(output()).toContain('column on "i173_app"."t": "old" removed, "fresh" added');
        expect(output()).toContain('index on "i173_app"."t": "idx_old" removed, "idx_new" added');
        expect(await names()).toEqual(expect.arrayContaining(['fresh', 'idx_new']));
        expect(await names()).not.toContain('old');
        expect(await names()).not.toContain('idx_old');
    });

    it('R16 a column and the primary key both replaced in one table: push stops, naming the primary key, changes nothing', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer NOT NULL, old text, CONSTRAINT pk_old PRIMARY KEY (id))');
        declareApp("export const t = app.table('t', { id: integer('id').notNull(), fresh: text('fresh') }, (t) => [primaryKey({ name: 'pk_new', columns: [t.id] })]);\n");
        const before = await catalog();

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain('drizzle-kit finds a primary key removed and another added');
        expect(await catalog()).toEqual(before);
    });

    it('R17 a column replaced in t, and index idx_x moved from u onto t: idx_x is dropped from u, then created on t', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text); '
            + 'CREATE TABLE i173_app.u (id integer PRIMARY KEY, keep text); CREATE INDEX idx_x ON i173_app.u (keep)');
        declareApp("export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, (t) => [index('idx_x').on(t.keep)]);\n"
            + "export const u = app.table('u', { id: integer('id').primaryKey(), keep: text('keep') });\n");

        await push({ force: true });

        expect(await db`SELECT indrelid::regclass::text AS "table" FROM pg_index WHERE indexrelid = 'i173_app.idx_x'::regclass`)
            .toEqual([{ table: 'i173_app.t' }]);
        expect(await names()).toContain('fresh');
        expect(await names()).not.toContain('old');
    });

    it.each(REFERENCED_KEYS)('R18 a column replaced whose new column references $key added on a table gaining no column: both created', async ({ before, after }) =>
    {
        await db.unsafe(before);
        declareApp(after);

        await push({ force: true });

        expect(await names()).toEqual(expect.arrayContaining(['fresh', 'u_code', 'fk_code']));
        expect(await names()).not.toContain('old');
    });

    it.each(HELD_NAMES)('R19 a column replaced, and $created takes the name of $holder: push stops, naming both, changes nothing', async ({ before: seed, after, created, holder }) =>
    {
        await db.unsafe(seed);
        declareApp(after);
        const before = await catalog();

        await expect(push({ force: true })).rejects.toThrow('exit 1');

        expect(errors.join('\n')).toContain('Planning stopped — nothing was applied: db push does not rename');
        expect(errors.join('\n')).toContain(`${created}: the name is held by ${holder}, which this push drops`);
        expect(errors.join('\n')).not.toMatch(/42P07|42710/);
        expect(output()).toContain('spfn db generate');
        expect(await catalog()).toEqual(before);
    });

    it('R20 R18: what a dry run lists, by kind of change, is what --force sends to the database, the drops step first', async () =>
    {
        await db.unsafe(REFERENCES_ADDED_UNIQUE.before);
        declareApp(REFERENCES_ADDED_UNIQUE.after);
        await push({ dryRun: true });
        const shown = printed.filter(line => /^ {3}(CREATE|ALTER|DROP) /.test(line)).map(line => line.trim());
        const sent: string[] = [];
        const query = pg.Client.prototype.query;
        vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: unknown, ...args: any[])
        {
            sent.push(typeof args[0] === 'string' ? args[0] : args[0].text);

            return (query as (...a: unknown[]) => unknown).apply(this, args);
        } as never);

        await push({ force: true });

        const applied = sent.slice(sent.length - [...sent].reverse().findIndex(text => /^rollback/i.test(text.trim())))
            .map(text => text.replace(/\s+/g, ' ').trim()).filter(text => /^(CREATE|ALTER|DROP) /.test(text));
        expect(shown).toContain('ALTER TABLE "i173_app"."c" ADD CONSTRAINT "u_code" UNIQUE("code");');
        expect([...applied].sort()).toEqual([...shown].sort());
        expect(applied[0]).toBe('ALTER TABLE "i173_app"."o" DROP COLUMN "old";');
        expect(await names()).toEqual(expect.arrayContaining(['fresh', 'u_code', 'fk_code']));
    });

    it('R21 a unique constraint replaced, and a foreign key added that references the new one: dropped, then created', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.c (id integer PRIMARY KEY, a text CONSTRAINT u_old UNIQUE, code text); '
            + 'CREATE TABLE i173_app.o (id integer PRIMARY KEY, ref text)');
        declareApp("export const c = app.table('c', { id: integer('id').primaryKey(), a: text('a'), code: text('code') }, (c) => [unique('u_new').on(c.code)]);\n"
            + "export const o = app.table('o', { id: integer('id').primaryKey(), ref: text('ref') }, "
            + "(o) => [foreignKey({ name: 'fk_new', columns: [o.ref], foreignColumns: [c.code] })]);\n");

        await push({ force: true });

        expect(output()).toContain('unique constraint on "i173_app"."c": "u_old" removed, "u_new" added');
        expect(await names()).toEqual(expect.arrayContaining(['u_new', 'fk_new']));
        expect(await names()).not.toContain('u_old');
    });

    it('R22 a column replaced, and a check on a kept column naming an enum added with it: dropped, then created', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text)');
        declareApp("export const mood = app.enum('mood', ['a']);\n"
            + "export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, "
            + "(t) => [check('ck_mood', sql`${t.keep}::\"i173_app\".\"mood\" IS NOT NULL`)]);\n");

        await push({ force: true });

        expect(await names()).toEqual(expect.arrayContaining(['fresh', 'mood', 'ck_mood']));
        expect(await names()).not.toContain('old');
    });

    it.each(QUOTING_LITERALS)('R23 a column replaced, and a check naming the new column after $literal: dropped, then created', async ({ text }) =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text)');
        declareApp("export const t = app.table('t', { id: integer('id').primaryKey(), keep: text('keep'), fresh: text('fresh') }, "
            + `(t) => [check('ck_q', sql\`\${t.keep} <> ${text} AND \${t.fresh} <> 'x'\`)]);\n`);

        await push({ force: true });

        expect(await names()).toEqual(expect.arrayContaining(['fresh', 'ck_q']));
        expect(await names()).not.toContain('old');
    });

    it('R24 a column replaced in t, and two checks on untouched u changed, one to name an enum added with it: the dry run lists their replacements, --force applies them', async () =>
    {
        await db.unsafe('CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text); '
            + "CREATE TABLE i173_app.u (id integer PRIMARY KEY CONSTRAINT ck_id CHECK (id > 0), label text CONSTRAINT ck_label CHECK (label <> ''))");
        declareApp(table(", fresh: text('fresh')") + "export const grade = app.enum('grade', ['a', 'b']);\n"
            + "export const u = app.table('u', { id: integer('id').primaryKey(), label: text('label') }, "
            + "(u) => [check('ck_id', sql`${u.id} > 1`), check('ck_label', sql`${u.label}::\"i173_app\".\"grade\" IS NOT NULL`)]);\n");
        const replacement = (name: string) => `ALTER TABLE "i173_app"."u" DROP CONSTRAINT IF EXISTS "${name}", ADD CONSTRAINT "${name}" CHECK `;

        await push({ dryRun: true });

        expect(output()).toContain('column on "i173_app"."t": "old" removed, "fresh" added');
        expect(output()).toContain(replacement('ck_id'));
        expect(output()).toContain(replacement('ck_label'));
        expect(output()).not.toContain('was not compared');

        await push({ force: true });

        expect(await catalog()).toEqual(expect.arrayContaining(['constraint i173_app.ck_id CHECK ((id > 1))',
            'constraint i173_app.ck_label CHECK (((label)::i173_app.grade IS NOT NULL))']));
    });

    it('R25 a column replaced, and the check on it changed to name the new column: the steps drop and create it, and no replacement follows', async () =>
    {
        await db.unsafe("CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text CONSTRAINT ck_t CHECK (old <> ''))");
        declareApp(table(", fresh: text('fresh')", ", (t) => [check('ck_t', sql`${t.fresh} <> ''`)]"));

        await push({ force: true });

        expect(output()).not.toContain('DROP CONSTRAINT IF EXISTS "ck_t"');
        expect(await catalog()).toContain("constraint i173_app.ck_t CHECK ((fresh <> ''::text))");
        expect(await names()).not.toContain('old');
    });

    it('R26 a column replaced in t, and an existing enum gaining a value a check on untouched u names: the check is not compared, and the push applies', async () =>
    {
        await db.unsafe("CREATE TYPE i173_app.grade AS ENUM ('a'); CREATE TABLE i173_app.t (id integer PRIMARY KEY, keep text, old text); "
            + "CREATE TABLE i173_app.u (id integer PRIMARY KEY, label text CONSTRAINT ck_label CHECK (label <> 'b'))");
        declareApp(table(", fresh: text('fresh')") + "export const grade = app.enum('grade', ['a', 'b']);\n"
            + "export const u = app.table('u', { id: integer('id').primaryKey(), label: text('label') }, "
            + "(u) => [check('ck_label', sql`${u.label}::\"i173_app\".\"grade\" <> 'b'`)]);\n");

        await push({ force: true });

        expect(output()).toContain('"ck_label" on "i173_app"."u" was not compared');
        expect(await names()).toContain('fresh');
        expect(await catalog()).toContain("constraint i173_app.ck_label CHECK ((label <> 'b'::text))");
    });

    it('R7 a view removed: DROP VIEW waits for the confirmation, and without one the view stays', async () =>
    {
        await db.unsafe(`${TABLE_SQL}; CREATE VIEW i173_app.v AS SELECT id FROM i173_app.t`);
        declareApp(table());

        await expect(push()).rejects.toThrow('exit 1');

        expect(output()).toContain('DROP VIEW "i173_app"."v"');
        expect(errors.join('\n')).toContain('Destructive changes need a confirmation');
        expect(await names()).toContain('v');
    });
});
