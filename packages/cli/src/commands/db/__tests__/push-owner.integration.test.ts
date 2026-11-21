/**
 * `spfn db push` connects as the table owner (#405)
 *
 * A4 (two roles): a scratch app — schema i405_owner and the fake function
 * package @spfn/i163fix — pushed with DATABASE_OWNER_URL the owner
 * (TEST_DATABASE_URL) and DATABASE_URL the app role (TEST_APP_DATABASE_URL, or
 * the other role scripts/test-services.sh creates), which may not create a
 * schema in the database. Without its own row, a push still running as the app
 * passes every single-role test. A4b, A4c: the app role owns a table push
 * alters, so PostgreSQL refuses the owner (SQLSTATE 42501) while push plans:
 * with an owner URL of its own push names both roles and the table in the
 * REASSIGN OWNED remedy (A4b), the table its failed statement names first
 * (A4d); with one connection it adds nothing (A4c).
 * Skipped, with the reason, where the app role cannot connect; a failure under
 * CI.
 *
 * R1–R3 (one role): a 42501 that no change of ownership cures adds no remedy —
 * the owner's own CREATE on its own schema revoked (R1), an extension only a
 * superuser may create (R2), and any 42501 when DATABASE_OWNER_URL is unset
 * (R3): one-role output is what it was before #405. R4 (one role): a 42501
 * while push plans — drizzle-kit's data-loss read of a table the owner may not
 * read — ends as a failed write does, with no ownership advice when nothing is
 * foreign-owned; R5 (one role): so does a failed read of a package's pending
 * migrations, the plan's other half. A4b–A4d fail at the same stage in CI: the app role's table is
 * read for the column push drops. Q1 (one role): the catalog query runs, and
 * lists none of initdb's objects, on information_schema, which the bootstrap
 * superuser owns in every cluster (a schema the row creates cannot hold a
 * superuser's object without a superuser: what the remedy prints for one is
 * foreign-owners.test.ts's B1–B4). PX (one role): what the catalog query lists
 * of partitioned tables, partitions, enum types and column-owned sequences,
 * its pg_has_role predicate replaced by true on the rendered SQL.
 *
 * Each row works in its own schemas and drops them; no role is created and no
 * default privilege is changed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { appUrl, OWNER_URL, requireDatabase, twoRoleUnavailability } from './helpers/test-database.js';
import { writeFunctionPackage } from './helpers/function-package.js';
import { functionMigrationsTable } from '@spfn/core/db';

const { dbPush } = await import('../push.js');
const { createPushConnection } = await import('../utils/drizzle.js');
const { ownershipRemedy } = await import('../utils/foreign-owners.js');

const PACKAGE_SQL = 'CREATE SCHEMA spfn_i163fix;\n--> statement-breakpoint\nCREATE TABLE spfn_i163fix.things (id integer PRIMARY KEY);\n';
const SCHEMAS = ['i405_owner', 'spfn_i163fix'];

describe('db push connects as the owner', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    let reachable = false;
    let twoRoles: string | undefined = 'beforeAll has not run';
    let root: string;
    let previousCwd: string;
    let errors: string[];

    beforeAll(async () =>
    {
        reachable = await requireDatabase(owner, 'db push owner integration tests');
        twoRoles = reachable ? await twoRoleUnavailability(owner, app) : 'PostgreSQL not available';
    });

    afterAll(async () =>
    {
        if (reachable)
        {
            await dropSchemas();
        }
        await Promise.all([owner.end(), app.end()]);
    });

    beforeEach(async ({ skip }) =>
    {
        skip(!reachable, 'PostgreSQL not available');

        await dropSchemas();
        root = mkdtempSync(join(__dirname, 'tmp-push-owner-'));
        previousCwd = process.cwd();
        process.chdir(root);
        errors = [];
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(() =>
    {
        if (!reachable)
        {
            return;
        }

        process.chdir(previousCwd);
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    async function dropSchemas(): Promise<void>
    {
        for (const schema of [...SCHEMAS, 'drizzle'])
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
    }

    function writeEntity(): void
    {
        const entities = join(root, 'src', 'server', 'entities');

        mkdirSync(entities, { recursive: true });
        writeFileSync(join(entities, 'app.entity.ts'),
            "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
            + "export const app = pgSchema('i405_owner');\n"
            + "export const notes = app.table('notes', { id: integer('id').primaryKey() });\n");
    }

    const push = () => dbPush({ force: true, schema: './src/server/entities/app.entity.ts' });

    it('A4 two roles: the push succeeds through DATABASE_OWNER_URL, where the app role may not create, and the owner owns every schema and table it created', async ({ skip }) =>
    {
        skip(twoRoles !== undefined, twoRoles);

        const [{ ownerRole }] = await owner`SELECT current_user AS "ownerRole"`;
        const [{ appRole }] = await app`SELECT current_user AS "appRole"`;
        const [{ appMayCreate }] = await owner`SELECT has_database_privilege(${appRole}::name, current_database(), 'CREATE') AS "appMayCreate"`;

        expect(appRole).not.toBe(ownerRole);
        expect(appMayCreate).toBe(false);

        writeEntity();
        writeFunctionPackage(root, '20260101000000_things', PACKAGE_SQL);
        process.env.DATABASE_URL = appUrl();
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await push();

        const created = await owner`
            SELECT n.nspname || '.' || c.relname AS relation, pg_get_userbyid(c.relowner) AS "relationOwner",
                   pg_get_userbyid(n.nspowner) AS "schemaOwner"
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND (n.nspname::text = ANY(${SCHEMAS}::text[]) OR c.relname = '__spfn_fn_i163fix_migrations')
            ORDER BY 1`;

        expect(created.map((row) => row.relation)).toEqual(['drizzle.__spfn_fn_i163fix_migrations', 'i405_owner.notes', 'spfn_i163fix.things']);
        expect(created.filter((row) => row.relationOwner !== ownerRole || row.schemaOwner !== ownerRole)).toEqual([]);
    });

    /** The owner creates schema i405_owner and lets the app role create in it; the app role creates notes with a column push drops. */
    async function appOwnsNotes(appRole: string): Promise<void>
    {
        await owner.unsafe('CREATE SCHEMA i405_owner');
        await owner`GRANT USAGE, CREATE ON SCHEMA i405_owner TO ${owner(appRole)}`;
        await app.unsafe('CREATE TABLE i405_owner.notes (id integer PRIMARY KEY, legacy text)');
        writeEntity();
    }

    it('A4b two roles, the app role owns a table push alters: exit 1 on the 42501, then the remedy with the catalog\'s role names and the table', async ({ skip }) =>
    {
        skip(twoRoles !== undefined, twoRoles);

        const [{ ownerRole }] = await owner`SELECT current_user AS "ownerRole"`;
        const [{ appRole }] = await app`SELECT current_user AS "appRole"`;

        await appOwnsNotes(appRole);
        process.env.DATABASE_URL = appUrl();
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await expect(push()).rejects.toThrow('exit 1');

        const output = errors.join('\n');

        expect(output).toContain('❌ Planning failed — nothing was applied: Invalid query (42501)');
        expect(output).not.toMatch(/Failed query|params:/);
        expect(output).toContain(`i405_owner.notes (owner ${appRole})`);
        expect(output).toContain(`REASSIGN OWNED BY ${appRole} TO ${ownerRole};`);
        expect(output).not.toContain('schema i405_owner');
    });

    it('A4d two roles, the app role owns two tables and push fails on the later one: the remedy lists that one first', async ({ skip }) =>
    {
        // Without this row the table push failed on can sit behind the others,
        // past the five the remedy names.
        skip(twoRoles !== undefined, twoRoles);

        const [{ appRole }] = await app`SELECT current_user AS "appRole"`;

        await appOwnsNotes(appRole);
        await app.unsafe('CREATE TABLE i405_owner.aaa_ledger (id integer PRIMARY KEY)');
        writeFileSync(join(root, 'src', 'server', 'entities', 'app.entity.ts'),
            "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
            + "export const app = pgSchema('i405_owner');\n"
            + "export const ledger = app.table('aaa_ledger', { id: integer('id').primaryKey() });\n"
            + "export const notes = app.table('notes', { id: integer('id').primaryKey() });\n");
        process.env.DATABASE_URL = appUrl();
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await expect(push()).rejects.toThrow('exit 1');

        const output = errors.join('\n');

        expect(output).toContain('Failed statement: select 1 from "i405_owner"."notes"');
        expect(output).toContain(`belong to another role: i405_owner.notes (owner ${appRole}), i405_owner.aaa_ledger (owner ${appRole})`);
    });

    it('A4c two roles, the same refusal through one connection (no DATABASE_OWNER_URL, or the same URL twice): no remedy', async ({ skip }) =>
    {
        skip(twoRoles !== undefined, twoRoles);

        const [{ appRole }] = await app`SELECT current_user AS "appRole"`;

        await appOwnsNotes(appRole);
        process.env.DATABASE_URL = OWNER_URL;

        for (const ownerUrl of [undefined, OWNER_URL])
        {
            errors.splice(0);
            if (ownerUrl) process.env.DATABASE_OWNER_URL = ownerUrl;

            await expect(push()).rejects.toThrow('exit 1');

            expect(errors.join('\n')).toContain('❌ Planning failed — nothing was applied: Invalid query (42501)');
            expect(errors.join('\n')).not.toMatch(/Failed query|params:|REASSIGN OWNED/);
        }
    });

    it('R1 the owner\'s own CREATE on its own schema revoked (42501): exit 1, the failed line, no remedy', async () =>
    {
        await owner.unsafe('CREATE SCHEMA i405_owner');
        await owner.unsafe('REVOKE CREATE ON SCHEMA i405_owner FROM CURRENT_USER');
        writeEntity();
        process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await expect(push()).rejects.toThrow('exit 1');

        const output = errors.join('\n');
        const password = decodeURIComponent(new URL(OWNER_URL).password);

        expect(output).toContain('❌ The project statements were rolled back: Invalid query (42501)');
        expect(output).toContain('Failed statement: CREATE TABLE "i405_owner"."notes"');
        expect(output).not.toContain('REASSIGN OWNED');
        expect(password === '' || !output.includes(password)).toBe(true);
    });

    it('R4 a table the owner owns but may not read, which push drops a column of (42501 while planning): exit 1, the stage, no driver text, no remedy', async () =>
    {
        // Without this row drizzle-kit's data-loss read (select 1 from …) throws
        // past push's failure path: no exit code, and the driver's
        // "Failed query: … params:" line raw.
        await owner.unsafe('CREATE SCHEMA i405_owner');
        await owner.unsafe('CREATE TABLE i405_owner.notes (id integer PRIMARY KEY, legacy text)');
        await owner.unsafe('REVOKE SELECT ON i405_owner.notes FROM CURRENT_USER');
        writeEntity();
        process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await expect(push()).rejects.toThrow('exit 1');

        const output = errors.join('\n');

        expect(output).toContain('❌ Planning failed — nothing was applied: Invalid query (42501)');
        expect(output).toContain('Failed statement: select 1 from "i405_owner"."notes" limit 1');
        expect(output).not.toMatch(/Failed query|params:|REASSIGN OWNED|OWNER TO/);
    });

    it('R5 reading a package\'s pending migrations fails (its record table the owner may not read): exit 1, the plan stage\'s line', async () =>
    {
        // Without this row pendingFunctionMigrations(...) could move out of
        // planOrExit's try and every row would still pass: its failure would
        // reach the top-level handler raw, with no stage and no exit 1 of push's.
        await owner.unsafe('CREATE SCHEMA drizzle');
        await owner.unsafe(`CREATE TABLE drizzle."${functionMigrationsTable('@spfn/i163fix')}" (id serial PRIMARY KEY, hash text, created_at bigint)`);
        await owner.unsafe(`REVOKE SELECT ON drizzle."${functionMigrationsTable('@spfn/i163fix')}" FROM CURRENT_USER`);
        writeEntity();
        writeFunctionPackage(root, '20260101000000_things', PACKAGE_SQL);
        process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await expect(push()).rejects.toThrow('exit 1');

        const output = errors.join('\n');

        expect(output).toContain('❌ Planning failed — nothing was applied: Invalid query (42501)');
        expect(output).toContain(`Failed statement: \n        SELECT max(created_at) AS "last" FROM drizzle."${functionMigrationsTable('@spfn/i163fix')}"`);
    });

    it('R2 a package migration\'s CREATE EXTENSION only a superuser may run (42501): exit 1, the migration named, no remedy', async () =>
    {
        writeEntity();
        writeFunctionPackage(root, '20260101000000_ext', 'CREATE EXTENSION IF NOT EXISTS file_fdw;\n');
        process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await expect(push()).rejects.toThrow('exit 1');

        const output = errors.join('\n');

        expect(output).toContain('❌ Failed to apply function package migrations — nothing of the project schema was applied: '
            + 'Invalid query (42501)\n   In: @spfn/i163fix migration 20260101000000_ext');
        expect(output).not.toContain('REASSIGN OWNED');
    });

    it('R3 one role (DATABASE_OWNER_URL unset): a 42501 prints the failed line and nothing about the owner', async () =>
    {
        await owner.unsafe('CREATE SCHEMA i405_owner');
        await owner.unsafe('REVOKE CREATE ON SCHEMA i405_owner FROM CURRENT_USER');
        writeEntity();
        process.env.DATABASE_URL = OWNER_URL;

        await expect(push()).rejects.toThrow('exit 1');

        const output = errors.join('\n');

        expect(output).toContain('Invalid query (42501)');
        expect(output).not.toContain('DATABASE_OWNER_URL');
        expect(output).not.toContain('REASSIGN OWNED');
    });

    it('Q1 one role: initdb\'s objects (information_schema\'s views, the bootstrap superuser\'s) are never listed, and the catalog query runs', async () =>
    {
        // Without this row the remedy prints ALTER VIEW information_schema.…
        // OWNER TO for objects of the system; and a query PostgreSQL rejects
        // reads as "nothing foreign-owned", since the remedy prints nothing
        // when the catalog cannot be read.
        const connection = await createPushConnection(OWNER_URL);
        const rejected: unknown[] = [];
        const db = {
            execute: (query: Parameters<typeof connection.db.execute>[0]) => connection.db.execute(query)
                .catch((error: unknown) => Promise.reject(rejected.push(error) && error)),
        } as typeof connection.db;

        try
        {
            const [{ owners, systemOnly }] = await owner`
                SELECT array_agg(DISTINCT c.relowner)::text AS owners, bool_and(c.oid < 16384) AS "systemOnly"
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'information_schema' AND c.relkind = 'v'`;

            expect(owners).toBe('{10}');
            expect(systemOnly).toBe(true);
            expect(await ownershipRemedy(db, ['information_schema'])).toBeUndefined();
            expect(rejected).toEqual([]);
        }
        finally
        {
            await connection.close();
        }
    });

    it('PX one role, the catalog itself: a partitioned table, its partition and an enum type are listed; a serial\'s and an identity\'s sequence are not', async () =>
    {
        // Without this row the sequence rule (a dependency on a relation) left
        // out partitioned tables and partitions too, and enum types were never
        // listed. One role owns everything here, so the connection answers the
        // query with its pg_has_role predicate replaced by true, as rv421d's
        // probe did; the rest of the query runs as push sends it.
        await owner.unsafe('CREATE SCHEMA i405_owner');
        await owner.unsafe('CREATE TYPE i405_owner.mood AS ENUM (\'calm\')');
        await owner.unsafe('CREATE TABLE i405_owner.events (id integer, at date) PARTITION BY RANGE (at)');
        await owner.unsafe('CREATE TABLE i405_owner.events_2026 PARTITION OF i405_owner.events FOR VALUES FROM (\'2026-01-01\') TO (\'2027-01-01\')');
        await owner.unsafe('CREATE TABLE i405_owner.notes (id serial PRIMARY KEY, mood i405_owner.mood)');
        await owner.unsafe('CREATE TABLE i405_owner.things (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY)');

        const connection = await createPushConnection(OWNER_URL);
        const predicate = 'NOT pg_catalog.pg_has_role(o.owner, \'USAGE\')';
        const replaced: boolean[] = [];
        const db = {
            execute: (query: SQL) =>
            {
                const { sql: text, params } = new PgDialect().sqlToQuery(query);

                replaced.push(text.includes(predicate));

                return connection.query(text.replace(predicate, 'true'), params).then((rows) => ({ rows }));
            },
        } as unknown as typeof connection.db;

        try
        {
            const remedy = await ownershipRemedy(db, ['i405_owner'], 'ALTER TYPE "i405_owner"."mood" ADD VALUE \'tense\';');
            const [{ ownerRole }] = await owner`SELECT quote_ident(current_user) AS "ownerRole"`;

            expect(replaced).toEqual([true]);
            expect(remedy).toContain(`belong to another role: type i405_owner.mood (owner ${ownerRole}), i405_owner.events (owner ${ownerRole}), `
                + `i405_owner.events_2026 (owner ${ownerRole}), i405_owner.notes (owner ${ownerRole}), i405_owner.things (owner ${ownerRole}).`);
            expect(remedy).not.toContain('_seq');
        }
        finally
        {
            await connection.close();
        }
    });
});
