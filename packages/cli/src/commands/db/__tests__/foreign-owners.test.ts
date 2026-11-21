/**
 * What the ownership remedy of `db push` lists and prints (#405, rv421b Q1,
 * rv421c)
 *
 * REASSIGN OWNED cannot move an extension's members, which belong to the
 * extension, and PostgreSQL refuses it outright for the bootstrap superuser:
 * extension members are left out by the catalog query, and the bootstrap
 * superuser's objects get one ALTER … OWNER TO each (B1–B3). Neither can be
 * built with the one role the VM's runs have (a foreign-owned extension member
 * or a bootstrap-owned relation in a schema the row creates takes a superuser
 * or a second role). So these rows pin the query's predicates on its SQL text,
 * and what the remedy prints for a faked catalog answer: first the relation the
 * failed statement acts on — its target, not any quoted name in it (P2, P3),
 * the planning read's table too (P4), in the forms drizzle-kit writes (P5); the
 * catalog itself answers in push-owner.integration.test.ts (Q1 on
 * information_schema here, A4b/A4d in CI's two-role block).
 */

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { ownershipRemedy, statementTarget } from '../utils/foreign-owners.js';
import type { PushConnection } from '../utils/drizzle.js';

interface Row
{
    connectedRole: string;
    owner: string;
    bootstrap: boolean;
    kind: string;
    object: string;
    schema: string | null;
    name: string;
}

/** A connection whose catalog answers `rows`, recording the SQL it was asked. */
function fakeConnection(rows: Row[]): { db: PushConnection['db']; asked: string[] }
{
    const asked: string[] = [];
    const db = {
        execute: async (query: SQL) =>
        {
            asked.push(new PgDialect().sqlToQuery(query).sql);

            return { rows };
        },
    } as unknown as PushConnection['db'];

    return { db, asked };
}

const row = (name: string, owner = 'app_user', schema = 'notes_app'): Row =>
    ({ connectedRole: 'app_owner', owner, bootstrap: false, kind: 'TABLE', object: `${schema}.${name}`, schema, name });

/** An object the bootstrap superuser (`postgres`) owns, as the catalog query answers it. */
const bootstrapOwned = (kind: string, object: string, name: string): Row =>
    ({ connectedRole: 'app_owner', owner: 'postgres', bootstrap: true, kind, object, schema: kind === 'SCHEMA' ? null : 'notes_app', name });

describe('the ownership remedy', () =>
{
    it('Q1 the catalog query leaves out extension members, sequences a column owns and initdb\'s objects, and marks the bootstrap superuser\'s', async () =>
    {
        // Without this row the remedy names spatial_ref_sys, a serial column's
        // sequence (which ALTER SEQUENCE … OWNER TO refuses alone) or a system
        // object, and the statement it prints fails.
        const { db, asked } = fakeConnection([]);

        expect(await ownershipRemedy(db, ['notes_app'])).toBeUndefined();

        const query = asked[0].replace(/\s+/g, ' ');

        expect(query).toContain('o.owner = 10 AS bootstrap');
        expect(query).toContain('o.objid >= 16384');
        expect(query).toContain('NOT EXISTS ( SELECT FROM pg_catalog.pg_depend d WHERE d.classid = o.classid AND d.objid = o.objid '
            + 'AND (d.deptype = \'e\' OR (o.kind = \'SEQUENCE\' AND d.deptype IN (\'a\', \'i\') AND d.refclassid = \'pg_catalog.pg_class\'::regclass))');
        expect(query).toContain('FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ANY($3) AND t.typtype = \'e\'');
        expect(query).toContain('NOT pg_catalog.pg_has_role(o.owner, \'USAGE\')');
        expect(query).not.toContain('o.owner <> 10');
    });

    it('B1 objects the bootstrap superuser owns: one ALTER … OWNER TO each, in the same block, and no REASSIGN OWNED BY it', async () =>
    {
        // Without this row tables created through a superuser's URL make push
        // fail with 42501 and say nothing, or print REASSIGN OWNED BY postgres,
        // which PostgreSQL refuses as a whole.
        const rows = [
            bootstrapOwned('SCHEMA', 'notes_app', 'notes_app'),
            bootstrapOwned('TABLE', 'notes_app.notes', 'notes'),
            bootstrapOwned('SEQUENCE', 'notes_app.ticket_seq', 'ticket_seq'),
            bootstrapOwned('MATERIALIZED VIEW', 'notes_app."Daily"', 'Daily'),
        ];

        const remedy = await ownershipRemedy(fakeConnection(rows).db, ['notes_app'], 'ALTER TABLE "notes_app"."notes" DROP COLUMN "legacy";');

        expect(remedy).toBe([
            '💡 spfn db push connects as app_owner (DATABASE_OWNER_URL), and objects it manages belong to another role: '
                + 'notes_app.notes (owner postgres), schema notes_app (owner postgres), notes_app.ticket_seq (owner postgres), '
                + 'notes_app."Daily" (owner postgres).',
            'PostgreSQL refuses REASSIGN OWNED BY postgres, the bootstrap superuser; as a superuser, give each of its objects to app_owner:',
            '   ALTER TABLE notes_app.notes OWNER TO app_owner;',
            '   ALTER SCHEMA notes_app OWNER TO app_owner;',
            '   ALTER SEQUENCE notes_app.ticket_seq OWNER TO app_owner;',
            '   ALTER MATERIALIZED VIEW notes_app."Daily" OWNER TO app_owner;',
            'Then run spfn db push again (@spfn/core db README, "Database roles").',
        ].join('\n'));
    });

    it('B2 the bootstrap superuser\'s objects past the listed five still get their statement', async () =>
    {
        const rows = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((name) => bootstrapOwned('TABLE', `notes_app.${name}`, name));

        const remedy = await ownershipRemedy(fakeConnection(rows).db, ['notes_app']);

        expect(remedy).toContain(', and 1 more.');
        expect(remedy).toContain('   ALTER TABLE notes_app.a6 OWNER TO app_owner;');
    });

    it('B3 another role\'s objects and the bootstrap superuser\'s together: REASSIGN OWNED for the one, ALTER … OWNER TO for the other', async () =>
    {
        const rows = [row('notes'), bootstrapOwned('TABLE', 'notes_app.legacy', 'legacy')];

        const remedy = await ownershipRemedy(fakeConnection(rows).db, ['notes_app']);

        expect(remedy).toContain('\nMove what app_user owns to app_owner once, as a superuser or a role that is a member of both: '
            + 'REASSIGN OWNED BY app_user TO app_owner;\n');
        expect(remedy).toContain('\n   ALTER TABLE notes_app.legacy OWNER TO app_owner;\n');
        expect(remedy).not.toMatch(/REASSIGN OWNED BY [^;]*postgres[^;]* TO/);
        expect(remedy).not.toContain('ALTER TABLE notes_app.notes');
    });

    it('B4 enum types: listed as types, the one ALTER TYPE failed on first, REASSIGN OWNED for a role\'s, ALTER TYPE … OWNER TO for the bootstrap superuser\'s', async () =>
    {
        // Without this row a pgEnum created through a superuser's URL got no
        // line at all, and push failed on ALTER TYPE … ADD VALUE with no remedy.
        const rows = [
            row('notes'),
            { ...row('a_kind'), kind: 'TYPE' },
            { ...bootstrapOwned('TYPE', 'notes_app.mood', 'mood') },
        ];

        const remedy = await ownershipRemedy(fakeConnection(rows).db, ['notes_app'], 'ALTER TYPE "notes_app"."mood" ADD VALUE \'calm\';');

        expect(remedy).toBe([
            '💡 spfn db push connects as app_owner (DATABASE_OWNER_URL), and objects it manages belong to another role: '
                + 'type notes_app.mood (owner postgres), notes_app.notes (owner app_user), type notes_app.a_kind (owner app_user).',
            'Move what app_user owns to app_owner once, as a superuser or a role that is a member of both: REASSIGN OWNED BY app_user TO app_owner;',
            'PostgreSQL refuses REASSIGN OWNED BY postgres, the bootstrap superuser; as a superuser, give each of its objects to app_owner:',
            '   ALTER TYPE notes_app.mood OWNER TO app_owner;',
            'Then run spfn db push again (@spfn/core db README, "Database roles").',
        ].join('\n'));
        expect(statementTarget('DROP TYPE IF EXISTS "notes_app"."mood";')).toEqual({ schema: 'notes_app', name: 'mood' });
    });

    it('Q2 the relation the failed statement acts on is listed first', async () =>
    {
        // Without this row the object push failed on can sit past the first five
        // under "and N more", and the remedy names only its neighbours.
        const rows = ['a1', 'a2', 'a3', 'a4', 'a5', 'notes'].map((name) => row(name));
        const { db } = fakeConnection(rows);

        const remedy = await ownershipRemedy(db, ['notes_app'], 'ALTER TABLE "notes_app"."notes" DROP COLUMN "legacy";');

        expect(remedy).toContain('belong to another role: notes_app.notes (owner app_user), notes_app.a1 (owner app_user)');
        expect(remedy).toContain(', and 1 more.');
    });

    it('Q2 without a failed statement, one acting on none of them (another schema\'s table of the same name, an index), the catalog\'s order stands', async () =>
    {
        const rows = ['a1', 'notes'].map((name) => row(name));

        for (const statement of [
            undefined,
            'ALTER TABLE "notes_app"."notes_archive" ADD COLUMN "x" integer;',
            'ALTER TABLE "other_app"."notes" ADD COLUMN "x" integer;',
            'DROP INDEX "notes_app"."notes_idx";',
        ])
        {
            const remedy = await ownershipRemedy(fakeConnection(rows).db, ['notes_app'], statement);

            expect(remedy).toContain('belong to another role: notes_app.a1 (owner app_user), notes_app.notes (owner app_user).');
        }
    });

    it('P2 a column named like another foreign-owned table does not put that table first', async () =>
    {
        // Without this row any quoted occurrence of a name counted: the column
        // "tags" put the table tags before the posts push failed on.
        const remedy = await ownershipRemedy(fakeConnection([row('tags', 'a_old', 'app'), row('posts', 'z_old', 'app')]).db, ['app'],
            'ALTER TABLE "app"."posts" ADD COLUMN "tags" jsonb;');

        expect(remedy).toContain('belong to another role: app.posts (owner z_old), app.tags (owner a_old)');
    });

    it('P3 ADD CONSTRAINT … REFERENCES another table: the altered table first, not the referenced one', async () =>
    {
        // PostgreSQL's "must be owner" is about the table being altered.
        const remedy = await ownershipRemedy(fakeConnection([row('alpha', 'app_user', 'app'), row('zeta', 'app_user', 'app')]).db, ['app'],
            'ALTER TABLE "app"."zeta" ADD CONSTRAINT "zeta_alpha_id_alpha_id_fk" FOREIGN KEY ("alpha_id") REFERENCES "app"."alpha"("id");');

        expect(remedy).toContain('belong to another role: app.zeta (owner app_user), app.alpha (owner app_user)');
    });

    it('P4 the data-loss read push fails on while planning names its table', async () =>
    {
        const remedy = await ownershipRemedy(fakeConnection(['a1', 'notes'].map((name) => row(name))).db, ['notes_app'],
            'select 1 from "notes_app"."notes" limit 1');

        expect(remedy).toContain('belong to another role: notes_app.notes (owner app_user), notes_app.a1 (owner app_user)');
    });

    it('P5 the target of each statement drizzle-kit generates for a push, read from its own output', async () =>
    {
        // Without this row the grammar is a guess at drizzle-kit's text: these
        // statements are what its generator writes for this diff.
        const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api-postgres');
        const { pgSchema, pgTable, integer, text, index, pgPolicy } = await import('drizzle-orm/pg-core');
        const { sql } = await import('drizzle-orm');
        const app = pgSchema('notes_app');
        const other = app.table('other', { id: integer('id').primaryKey() });
        const before = {
            app,
            other,
            notes: app.table('notes', { id: integer('id').primaryKey(), legacy: text('legacy'), other: integer('other') }),
            gone: app.table('gone', { id: integer('id').primaryKey() }),
            seq: app.sequence('seq', { startWith: 1 }),
            pub: pgTable('pub', { id: integer('id').primaryKey(), n: text('n') }, (table) => [index('pub_n').on(table.n)]),
        };
        const after = {
            app,
            other,
            notes: app.table('notes', { id: integer('id').primaryKey(), other: integer('other').references(() => other.id) },
                (table) => [index('notes_other_idx').on(table.other), pgPolicy('own', { using: sql`true` })]),
            seq: app.sequence('seq', { startWith: 5 }),
            pub: pgTable('pub', { id: integer('id').primaryKey() }),
        };
        const previous = await generateDrizzleJson(before, undefined, ['notes_app', 'public']);
        const statements = await generateMigration(previous, await generateDrizzleJson(after, previous.id, ['notes_app', 'public']));
        const target = (statement: string) => [statementTarget(statement)].map((relation) => relation && `${relation.schema}.${relation.name}`)[0];

        expect(statements.map((statement) => [statement.replace(/\s+/g, ' ').split(' ').slice(0, 4).join(' '), target(statement)])).toEqual([
            ['ALTER SEQUENCE "notes_app"."seq" INCREMENT', 'notes_app.seq'],
            ['DROP TABLE "notes_app"."gone";', 'notes_app.gone'],
            ['ALTER TABLE "notes_app"."notes" ENABLE', 'notes_app.notes'],
            ['DROP INDEX "pub_n";', undefined],
            ['ALTER TABLE "notes_app"."notes" DROP', 'notes_app.notes'],
            ['ALTER TABLE "pub" DROP', 'public.pub'],
            ['CREATE INDEX "notes_other_idx" ON', 'notes_app.notes'],
            ['ALTER TABLE "notes_app"."notes" ADD', 'notes_app.notes'],
            ['CREATE POLICY "own" ON', 'notes_app.notes'],
        ]);
    });

    it.each([
        ['T1', 'DROP TABLE IF EXISTS "notes_app"."notes";', 'notes_app.notes'],
        ['T2', 'ALTER TABLE ONLY "notes_app"."notes" ADD CONSTRAINT "notes_pk" PRIMARY KEY ("id");', 'notes_app.notes'],
        ['T3', 'ALTER TABLE IF EXISTS ONLY "notes_app"."notes" DROP COLUMN "legacy";', 'notes_app.notes'],
        ['T4', 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "notes_idx" ON ONLY "notes_app"."notes" ("id");', 'notes_app.notes'],
        ['T5', 'DROP POLICY IF EXISTS "own" ON "notes_app"."notes";', 'notes_app.notes'],
        ['T6', 'DROP MATERIALIZED VIEW IF EXISTS "notes_app"."totals";', 'notes_app.totals'],
        ['T7', 'ALTER SEQUENCE IF EXISTS "notes_app"."seq" RESTART;', 'notes_app.seq'],
        ['T8', 'CREATE TABLE IF NOT EXISTS "notes_app"."notes" ("id" integer);', undefined],
    ])('%s the optional words PostgreSQL allows before the name: %s → %s', (_row, statement, expected) =>
    {
        // Without this row IF EXISTS, ONLY or IF NOT EXISTS read as no target,
        // and the relation the statement failed on was not listed first.
        const relation = statementTarget(statement);

        expect(relation && `${relation.schema}.${relation.name}`).toBe(expected);
    });
});
