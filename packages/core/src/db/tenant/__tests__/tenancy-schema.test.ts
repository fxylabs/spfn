/**
 * Tenancy schema generation — rows G1–G11 of the #158 part 2 design case table,
 * and V1–V11 of the #162 one (`visibleTo`, `tenantList`)
 *
 * The SQL drizzle-kit generates is the contract: every row reads it through the
 * same API `spfn db push` uses (`drizzle-kit/api-postgres`). No database needed.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { alias, bigint, getTableConfig, index, integer, pgSchema, text, type PgTable } from 'drizzle-orm/pg-core';
import { id, tenantKey, timestamps } from '../../schema';
import type { RunInTransactionOptions } from '../../transaction';
import { constraintName, defineTenancy, tenantList, type TenancyTableOptions } from '../tenancy';
import { findUserColumn, TENANCY_TABLE_MARKER, TENANT_COLUMN_MARKER } from '../registry';
import { TenantRepository } from '../tenant-repository';
import { generatedSql } from './tenancy-db';
import { authors, members, memos, notes, revisions, schema as fixtureSchema, tenancy, TENANCY_TABLES, workspaces } from './tenancy-fixtures';

const S = '"spfn_tenancy_test"';

/** The setting reads of design §3, as the policies must spell them. */
const TENANT_STRICT = 'current_setting(\'app.tenant_id\')::bigint';
const USER_LENIENT = 'nullif(current_setting(\'app.user_id\', true), \'\')::bigint';
const TENANT_GUARDED = '(case when nullif(current_setting(\'app.user_id\', true), \'\') is null '
    + 'then current_setting(\'app.tenant_id\') else nullif(current_setting(\'app.tenant_id\', true), \'\') end)::bigint';

/** The four policies design §3-1 gives a `visibleTo` table. */
function visibleToPolicies(schema: string, table: string, tenant: string, user: string): string[]
{
    const on = `ON "${schema}"."${table}" AS PERMISSIVE`;
    const strict = `("${tenant}" = ${TENANT_STRICT})`;

    return [
        `CREATE POLICY "${table}_tenant_isolation" ${on} FOR SELECT TO public USING ("${tenant}" = ${TENANT_GUARDED} OR "${user}" = ${USER_LENIENT});`,
        `CREATE POLICY "${table}_tenant_insert" ${on} FOR INSERT TO public WITH CHECK ${strict};`,
        `CREATE POLICY "${table}_tenant_update" ${on} FOR UPDATE TO public USING ${strict} WITH CHECK ${strict};`,
        `CREATE POLICY "${table}_tenant_delete" ${on} FOR DELETE TO public USING ${strict};`,
    ];
}

/** The four policies design §3-2 gives a tenant list, with the membership's `where` already rendered. */
function tenantListPolicies(schema: string, table: string, membership: string, tenant: string, user: string, where: string): string[]
{
    const on = `ON "${schema}"."${table}" AS PERMISSIVE`;
    const strict = `("id" = ${TENANT_STRICT})`;
    const exists = `EXISTS (SELECT 1 FROM "${schema}"."${membership}" "m" WHERE "m"."${tenant}" = "${table}"."id" `
        + `AND "m"."${user}" = ${USER_LENIENT}${where})`;

    return [
        `CREATE POLICY "${table}_tenant_visibility" ${on} FOR SELECT TO public USING ("id" = ${TENANT_GUARDED} OR ${exists});`,
        `CREATE POLICY "${table}_tenant_insert" ${on} FOR INSERT TO public WITH CHECK (true);`,
        `CREATE POLICY "${table}_tenant_update" ${on} FOR UPDATE TO public USING ${strict} WITH CHECK ${strict};`,
        `CREATE POLICY "${table}_tenant_delete" ${on} FOR DELETE TO public USING ${strict};`,
    ];
}

/** The SQL 0.3.0-beta.36 generated for the fixtures without #162, captured before the change. */
const BETA_36_SQL = [
    'CREATE SCHEMA "spfn_tenancy_test";\n',
    'CREATE TABLE "spfn_tenancy_test"."workspaces" (\n\t"id" bigserial PRIMARY KEY,\n\t"name" text NOT NULL\n);\n',
    'CREATE TABLE "spfn_tenancy_test"."authors" (\n\t"id" bigserial PRIMARY KEY,\n\t"tenant_id" bigint NOT NULL,\n\t"name" text NOT NULL,\n\tCONSTRAINT "authors_tenant_id_id_key" UNIQUE("tenant_id","id")\n);\n',
    'ALTER TABLE "spfn_tenancy_test"."authors" ENABLE ROW LEVEL SECURITY;',
    'CREATE TABLE "spfn_tenancy_test"."notes" (\n\t"id" bigserial PRIMARY KEY,\n\t"tenant_id" bigint NOT NULL,\n\t"author_id" bigint NOT NULL,\n\t"reviewer_id" bigint,\n\t"title" text NOT NULL,\n\tCONSTRAINT "notes_tenant_id_id_key" UNIQUE("tenant_id","id")\n);\n',
    'ALTER TABLE "spfn_tenancy_test"."notes" ENABLE ROW LEVEL SECURITY;',
    'CREATE TABLE "spfn_tenancy_test"."revisions" (\n\t"id" bigserial PRIMARY KEY,\n\t"tenant_id" bigint NOT NULL,\n\t"note_id" bigint NOT NULL,\n\t"body" text NOT NULL,\n\tCONSTRAINT "revisions_tenant_id_id_key" UNIQUE("tenant_id","id")\n);\n',
    'ALTER TABLE "spfn_tenancy_test"."revisions" ENABLE ROW LEVEL SECURITY;',
    'CREATE TABLE "spfn_tenancy_test"."memos" (\n\t"id" bigserial PRIMARY KEY,\n\t"tenant_id" bigint NOT NULL,\n\t"body" text NOT NULL\n);\n',
    'CREATE INDEX "notes_tenant_title_idx" ON "spfn_tenancy_test"."notes" ("tenant_id","title");',
    'ALTER TABLE "spfn_tenancy_test"."authors" ADD CONSTRAINT "authors_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "spfn_tenancy_test"."workspaces"("id");',
    'ALTER TABLE "spfn_tenancy_test"."notes" ADD CONSTRAINT "notes_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "spfn_tenancy_test"."workspaces"("id");',
    'ALTER TABLE "spfn_tenancy_test"."notes" ADD CONSTRAINT "notes_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "spfn_tenancy_test"."authors"("tenant_id","id") ON DELETE CASCADE;',
    'ALTER TABLE "spfn_tenancy_test"."notes" ADD CONSTRAINT "notes_reviewer_fk" FOREIGN KEY ("tenant_id","reviewer_id") REFERENCES "spfn_tenancy_test"."authors"("tenant_id","id");',
    'ALTER TABLE "spfn_tenancy_test"."revisions" ADD CONSTRAINT "revisions_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "spfn_tenancy_test"."workspaces"("id");',
    'ALTER TABLE "spfn_tenancy_test"."revisions" ADD CONSTRAINT "revisions_note_fk" FOREIGN KEY ("tenant_id","note_id") REFERENCES "spfn_tenancy_test"."notes"("tenant_id","id") ON DELETE RESTRICT;',
    'CREATE POLICY "authors_tenant_isolation" ON "spfn_tenancy_test"."authors" AS PERMISSIVE FOR ALL TO public USING ("tenant_id" = current_setting(\'app.tenant_id\')::bigint) WITH CHECK ("tenant_id" = current_setting(\'app.tenant_id\')::bigint);',
    'CREATE POLICY "notes_tenant_isolation" ON "spfn_tenancy_test"."notes" AS PERMISSIVE FOR ALL TO public USING ("tenant_id" = current_setting(\'app.tenant_id\')::bigint) WITH CHECK ("tenant_id" = current_setting(\'app.tenant_id\')::bigint);',
    'CREATE POLICY "revisions_tenant_isolation" ON "spfn_tenancy_test"."revisions" AS PERMISSIVE FOR ALL TO public USING ("tenant_id" = current_setting(\'app.tenant_id\')::bigint) WITH CHECK ("tenant_id" = current_setting(\'app.tenant_id\')::bigint);',
];

/** The statements of `sql` that mention `needle`. */
function statementsWith(sql: string[], needle: string): string[]
{
    return sql.filter((statement) => statement.includes(needle));
}

function createTable(sql: string[], table: string): string
{
    return sql.find((statement) => statement.startsWith(`CREATE TABLE ${table} (`)) ?? '';
}

describe('tenancy schema (generated SQL)', () =>
{
    it('G1 tenancy.table gets the tenant column, its foreign key, unique (tenant_id, id), RLS and the isolation policy', async () =>
    {
        const sql = await generatedSql(TENANCY_TABLES);

        expect(createTable(sql, `${S}."notes"`)).toContain('"tenant_id" bigint NOT NULL');
        expect(createTable(sql, `${S}."notes"`)).toContain('CONSTRAINT "notes_tenant_id_id_key" UNIQUE("tenant_id","id")');
        expect(sql).toContain(`ALTER TABLE ${S}."notes" ENABLE ROW LEVEL SECURITY;`);
        expect(sql).toContain(
            `ALTER TABLE ${S}."notes" ADD CONSTRAINT "notes_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES ${S}."workspaces"("id");`,
        );
        expect(sql).toContain(
            `CREATE POLICY "notes_tenant_isolation" ON ${S}."notes" AS PERMISSIVE FOR ALL TO public `
            + 'USING ("tenant_id" = current_setting(\'app.tenant_id\')::bigint) '
            + 'WITH CHECK ("tenant_id" = current_setting(\'app.tenant_id\')::bigint);',
        );
        expect(sql).toContain(`ALTER TABLE ${S}."authors" ENABLE ROW LEVEL SECURITY;`);
    });

    it('G2 tenancy.reference is a not-null column with a composite foreign key and no single-column one', async () =>
    {
        const sql = await generatedSql(TENANCY_TABLES);

        expect(createTable(sql, `${S}."notes"`)).toContain('"author_id" bigint NOT NULL');
        expect(sql).toContain(
            `ALTER TABLE ${S}."notes" ADD CONSTRAINT "notes_author_fk" FOREIGN KEY ("tenant_id","author_id") `
            + `REFERENCES ${S}."authors"("tenant_id","id") ON DELETE CASCADE;`,
        );
        expect(statementsWith(sql, 'FOREIGN KEY ("author_id")')).toEqual([]);
    });

    it('G3 an optional reference is nullable and its composite foreign key is NO ACTION', async () =>
    {
        const sql = await generatedSql(TENANCY_TABLES);

        expect(createTable(sql, `${S}."notes"`)).toMatch(/"reviewer_id" bigint,/);
        expect(sql).toContain(
            `ALTER TABLE ${S}."notes" ADD CONSTRAINT "notes_reviewer_fk" FOREIGN KEY ("tenant_id","reviewer_id") `
            + `REFERENCES ${S}."authors"("tenant_id","id");`,
        );
    });

    it('G4 the app\'s own extra config is added after the tenancy constraints', async () =>
    {
        const config = getTableConfig(notes);
        const sql = await generatedSql(TENANCY_TABLES);

        expect(config.indexes.map((index) => index.config.name)).toEqual(['notes_tenant_title_idx']);
        expect(config.uniqueConstraints.map((unique) => unique.name)).toEqual(['notes_tenant_id_id_key']);
        expect(config.policies.map((policy) => policy.name)).toEqual(['notes_tenant_isolation']);
        expect(sql).toContain(`CREATE INDEX "notes_tenant_title_idx" ON ${S}."notes" ("tenant_id","title");`);
    });

    it('G5 a reference to a table outside the tenancy throws when drizzle reads the table', async () =>
    {
        const schema = pgSchema('spfn_tenancy_g5');
        const plain = schema.table('countries', { id: id() });
        const keyed = schema.table('tags', { id: id(), tenantId: tenantKey() });
        const otherTenancy = defineTenancy({ tenants: plain, authorize: () => true });
        const foreign = otherTenancy.table(schema, 'foreign_rows', { id: id() });
        const toPlain = tenancy.table(schema, 'to_plain', { id: id(), countryId: tenancy.reference('country', () => plain) });
        const toKeyed = tenancy.table(schema, 'to_keyed', { id: id(), tagId: tenancy.reference('tag', () => keyed) });
        const toForeign = tenancy.table(schema, 'to_foreign', { id: id(), rowId: tenancy.reference('row', () => foreign) });

        expect(() => getTableConfig(toPlain)).toThrow('points at "countries", which is not a tenancy.table of the same tenancy');
        expect(() => getTableConfig(toKeyed)).toThrow('points at "tags", which is not a tenancy.table of the same tenancy');
        expect(() => getTableConfig(toForeign)).toThrow('points at "foreign_rows", which is not a tenancy.table of the same tenancy');
        await expect(generatedSql({ schema, plain, toPlain })).rejects.toThrow('not a tenancy.table');
    });

    it('G6 declaring the tenant column yourself throws', () =>
    {
        const schema = pgSchema('spfn_tenancy_g6');

        expect(() => tenancy.table(schema, 'a', { id: id(), tenantId: bigint('x', { mode: 'number' }) }))
            .toThrow('declares "tenantId"; the tenant column "tenant_id" is added by tenancy.table');
        expect(() => tenancy.table(schema, 'b', { id: id(), owner: bigint('tenant_id', { mode: 'number' }) }))
            .toThrow('declares "owner"; the tenant column "tenant_id" is added by tenancy.table');
        expect(() => tenancy.table(schema, 'c', { id: id(), tenant_id: bigint({ mode: 'number' }) }))
            .toThrow('declares "tenant_id"');
        expect(() => tenancy.table(schema, 'd', { name: text('name') } as never)).toThrow('has no id column');
    });

    it('G7 a reference may point at a table defined later, or at its own table', async () =>
    {
        const schema = pgSchema('spfn_tenancy_g7');
        const pages = tenancy.table(schema, 'pages', {
            id: id(),
            bookId: tenancy.reference('book', () => books),
            nextId: tenancy.reference('next', (): PgTable => pages, { optional: true }),
        });
        const books = tenancy.table(schema, 'books', { id: id() });
        const sql = await generatedSql({ schema, workspaces, pages, books });

        expect(sql).toContain(
            'ALTER TABLE "spfn_tenancy_g7"."pages" ADD CONSTRAINT "pages_book_fk" FOREIGN KEY ("tenant_id","book_id") '
            + 'REFERENCES "spfn_tenancy_g7"."books"("tenant_id","id") ON DELETE CASCADE;',
        );
        expect(sql).toContain(
            'ALTER TABLE "spfn_tenancy_g7"."pages" ADD CONSTRAINT "pages_next_fk" FOREIGN KEY ("tenant_id","next_id") '
            + 'REFERENCES "spfn_tenancy_g7"."pages"("tenant_id","id");',
        );
    });

    it('G8 defineTenancy({ column }) names the column, the policy, the unique key and every foreign key', async () =>
    {
        const schema = pgSchema('spfn_tenancy_g8');
        const custom = defineTenancy({ tenants: workspaces, authorize: () => true, column: 'workspace_id' });
        const folders = custom.table(schema, 'folders', { id: id() });
        const files = custom.table(schema, 'files', { id: id(), folderId: custom.reference('folder', () => folders) });
        const sql = await generatedSql({ schema, workspaces, folders, files });
        const filesTable = createTable(sql, '"spfn_tenancy_g8"."files"');

        expect(filesTable).toContain('"workspace_id" bigint NOT NULL');
        expect(filesTable).toContain('CONSTRAINT "files_workspace_id_id_key" UNIQUE("workspace_id","id")');
        expect(filesTable).not.toContain('"tenant_id"');
        expect(sql).toContain(
            'ALTER TABLE "spfn_tenancy_g8"."files" ADD CONSTRAINT "files_workspace_id_fk" FOREIGN KEY ("workspace_id") '
            + `REFERENCES ${S}."workspaces"("id");`,
        );
        expect(sql).toContain(
            'ALTER TABLE "spfn_tenancy_g8"."files" ADD CONSTRAINT "files_folder_fk" FOREIGN KEY ("workspace_id","folder_id") '
            + 'REFERENCES "spfn_tenancy_g8"."folders"("workspace_id","id") ON DELETE CASCADE;',
        );
        expect(statementsWith(sql, 'CREATE POLICY "files_tenant_isolation"')[0])
            .toContain('USING ("workspace_id" = current_setting(\'app.tenant_id\')::bigint) WITH CHECK ("workspace_id" = current_setting(\'app.tenant_id\')::bigint)');
    });

    it('G9 a package that uses no tenancy generates the same SQL as before (0.3.0-beta.34)', async () =>
    {
        const schema = pgSchema('spfn_plain_g9');
        const labels = schema.table('labels', {
            id: id(),
            name: text('name').notNull(),
            ...timestamps(),
        });
        const sql = await generatedSql({ schema, labels });

        expect(sql).toEqual([
            'CREATE SCHEMA "spfn_plain_g9";\n',
            'CREATE TABLE "spfn_plain_g9"."labels" (\n'
            + '\t"id" bigserial PRIMARY KEY,\n'
            + '\t"name" text NOT NULL,\n'
            + '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n'
            + '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL\n'
            + ');\n',
        ]);
    });

    it('G10 a tenantKey()-only table gets neither a policy nor a foreign key, as in part 1', async () =>
    {
        const sql = await generatedSql(TENANCY_TABLES);

        expect(createTable(sql, `${S}."memos"`)).toBe(
            `CREATE TABLE ${S}."memos" (\n\t"id" bigserial PRIMARY KEY,\n\t"tenant_id" bigint NOT NULL,\n\t"body" text NOT NULL\n);\n`,
        );
        expect(statementsWith(sql, `${S}."memos"`)).toHaveLength(1);
        expect(getTableConfig(memos).policies).toEqual([]);
    });

    it('G11 a tenant list table in another schema is what the tenant foreign key references', async () =>
    {
        const auth = pgSchema('spfn_auth');
        const users = auth.table('users', { id: id() });
        const personal = defineTenancy({ tenants: users, authorize: () => true });
        const schema = pgSchema('spfn_tenancy_g11');
        const diaries = personal.table(schema, 'diaries', { id: id(), body: text('body') });
        const sql = await generatedSql({ schema, diaries });

        expect(sql).toContain(
            'ALTER TABLE "spfn_tenancy_g11"."diaries" ADD CONSTRAINT "diaries_tenant_id_fk" FOREIGN KEY ("tenant_id") '
            + 'REFERENCES "spfn_auth"."users"("id");',
        );
    });

    it('G-names a long table name keeps every constraint name within 63 bytes and distinct', async () =>
    {
        const schema = pgSchema('spfn_tenancy_long');
        const long = 'a_table_name_long_enough_that_postgres_would_cut_its_constraint_names';
        const first = tenancy.table(schema, `${long}_one`, { id: id() });
        const second = tenancy.table(schema, `${long}_two`, { id: id(), firstId: tenancy.reference('first', () => first) });
        const names = [first, second].flatMap((table) =>
        {
            const config = getTableConfig(table);

            return [
                ...config.uniqueConstraints.map((unique) => unique.name!),
                ...config.foreignKeys.map((key) => key.getName()),
                ...config.policies.map((policy) => policy.name),
            ];
        });

        expect(names).toHaveLength(7);
        expect(names.every((name) => Buffer.byteLength(name) <= 63)).toBe(true);
        expect(new Set(names.map((name) => name.slice(0, 63))).size).toBe(7);
        expect(constraintName('notes', 'tenant_isolation')).toBe('notes_tenant_isolation');
        expect(constraintName(long, 'tenant_isolation')).toBe(`${long.slice(0, 54)}_${constraintName(long, 'tenant_isolation').slice(-8)}`);
        expect(constraintName(long, 'tenant_isolation')).toMatch(/_[0-9a-f]{8}$/);
        expect(constraintName(long, 'tenant_isolation')).not.toBe(constraintName(long, 'tenant_id_fk'));
        await expect(generatedSql({ schema, workspaces, first, second })).resolves.toBeDefined();
    });

    it('G-markers the tenant column and tenancy tables carry Symbol.for markers, through alias() too', () =>
    {
        const marker = { columnName: 'tenant_id', tenants: { schema: 'spfn_tenancy_test', name: 'workspaces' } };

        expect((notes as any)[Symbol.for('spfn.tenancy.table')]).toEqual(marker);
        expect((alias(notes, 'n') as any)[TENANCY_TABLE_MARKER]).toEqual(marker);
        expect((memos as any)[TENANCY_TABLE_MARKER]).toBeUndefined();
        expect((notes.tenantId as any)[Symbol.for('spfn.tenant.column')]).toBe(true);
        expect((memos.tenantId as any)[TENANT_COLUMN_MARKER]).toBe(true);
    });

    it('V1 visibleTo gives a table four policies, the user column index, and the tenancy constraints of G1', async () =>
    {
        const sql = await generatedSql(TENANCY_TABLES);
        const marker = (members as any)[Symbol.for('spfn.tenancy.table')];

        expect(statementsWith(sql, `CREATE POLICY "members_`)).toEqual(visibleToPolicies('spfn_tenancy_test', 'members', 'tenant_id', 'user_id'));
        expect(sql).toContain(`CREATE INDEX "members_user_id_idx" ON ${S}."members" ("user_id");`);
        expect(createTable(sql, `${S}."members"`)).toContain('"tenant_id" bigint NOT NULL');
        expect(createTable(sql, `${S}."members"`)).toContain('CONSTRAINT "members_tenant_id_id_key" UNIQUE("tenant_id","id")');
        expect(sql).toContain(`ALTER TABLE ${S}."members" ENABLE ROW LEVEL SECURITY;`);
        expect(sql).toContain(
            `ALTER TABLE ${S}."members" ADD CONSTRAINT "members_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES ${S}."workspaces"("id");`,
        );
        expect(marker).toEqual({ columnName: 'tenant_id', tenants: { schema: 'spfn_tenancy_test', name: 'workspaces' }, visibleTo: 'user_id' });
        expect(findUserColumn(alias(members, 'm'))?.key).toBe('userId');
        expect(findUserColumn(notes)).toBeUndefined();
    });

    it('V2 visibleTo naming no declared column throws with the key and the table', () =>
    {
        const schema = pgSchema('spfn_tenancy_v2');

        expect(() => tenancy.table(schema, 'crew', { id: id() }, { visibleTo: 'userId' } as never))
            .toThrow('tenancy.table "crew" { visibleTo: "userId" } names no column of the table');
    });

    it('V3 visibleTo naming id or the tenant property throws', () =>
    {
        const schema = pgSchema('spfn_tenancy_v3');
        const columns = { id: id(), userId: bigint('user_id', { mode: 'number' }) };

        expect(() => tenancy.table(schema, 'by_id', columns, { visibleTo: 'id' } as never))
            .toThrow('tenancy.table "by_id" { visibleTo: "id" } takes the property of a user column, not "id" or the tenant column');
        expect(() => tenancy.table(schema, 'by_tenant', columns, { visibleTo: 'tenantId' } as never))
            .toThrow('tenancy.table "by_tenant" { visibleTo: "tenantId" } takes the property of a user column');
    });

    it('V4 visibleTo naming a text column throws; bigint and integer columns are taken', () =>
    {
        const schema = pgSchema('spfn_tenancy_v4');

        expect(() => tenancy.table(schema, 'by_text', { id: id(), userId: text('user_id') }, { visibleTo: 'userId' }))
            .toThrow('tenancy.table "by_text" { visibleTo: "userId" } is not an integer column');
        expect(() => tenancy.table(schema, 'by_integer', { id: id(), userId: integer('user_id') }, { visibleTo: 'userId' })).not.toThrow();
        expect(() => tenancy.table(schema, 'by_bigint', { id: id(), userId: bigint('user_id', { mode: 'bigint' }) }, { visibleTo: 'userId' }))
            .not.toThrow();
    });

    it('V5 { visibleTo } in fourth place, without extra config, gives the policies of the fifth-place form', async () =>
    {
        const columns = () => ({ id: id(), userId: bigint('user_id', { mode: 'number' }).notNull() });
        const fourthSchema = pgSchema('spfn_tenancy_v5a');
        const fifthSchema = pgSchema('spfn_tenancy_v5b');
        const fourth = tenancy.table(fourthSchema, 'crew', columns(), { visibleTo: 'userId' });
        const fifth = tenancy.table(fifthSchema, 'crew', columns(), (t) => [index('crew_v5_idx').on(t.id)], { visibleTo: 'userId' });
        const fourthSql = await generatedSql({ fourthSchema, fourth });
        const fifthSql = await generatedSql({ fifthSchema, fifth });

        expect(statementsWith(fourthSql, 'CREATE POLICY')).toEqual(visibleToPolicies('spfn_tenancy_v5a', 'crew', 'tenant_id', 'user_id'));
        expect(statementsWith(fifthSql, 'CREATE POLICY')).toEqual(visibleToPolicies('spfn_tenancy_v5b', 'crew', 'tenant_id', 'user_id'));
        expect(fifthSql).toContain('CREATE INDEX "crew_v5_idx" ON "spfn_tenancy_v5b"."crew" ("id");');
        expect(() => tenancy.table(fourthSchema, 'twice', columns(), { visibleTo: 'userId' } as never, { visibleTo: 'userId' } as never))
            .toThrow('takes the extra config as a function and the options as an object, in that order');
    });

    it('V6 tenantList({ visibleThrough }) gives the tenant list four policies, the where rendered as literals', async () =>
    {
        const sql = await generatedSql(TENANCY_TABLES);

        expect(statementsWith(sql, 'CREATE POLICY "workspaces_')).toEqual(
            tenantListPolicies('spfn_tenancy_test', 'workspaces', 'members', 'tenant_id', 'user_id', ' AND "m"."status" = \'active\''),
        );
        expect(createTable(sql, `${S}."workspaces"`)).toBe(
            `CREATE TABLE ${S}."workspaces" (\n\t"id" bigserial PRIMARY KEY,\n\t"name" text NOT NULL\n);\n`,
        );
        expect(sql).toContain(`ALTER TABLE ${S}."workspaces" ENABLE ROW LEVEL SECURITY;`);
    });

    it('V6 a tenancy with column workspace_id and property workspaceId names those columns in both tables\' policies', async () =>
    {
        const schema = pgSchema('spfn_tenancy_v6');
        const teams = tenantList(schema, 'teams', { id: id() }, {
            visibleThrough: { table: (): PgTable => seats, where: { active: true, seat: 2, revokedAt: null } },
        });
        const teamTenancy = defineTenancy({ tenants: teams, authorize: () => true, column: 'workspace_id', property: 'workspaceId' });
        const seats = teamTenancy.table(schema, 'seats', {
            id: id(),
            personId: bigint('person_id', { mode: 'number' }).notNull(),
            active: text('is_active'),
            seat: integer('seat_no'),
            revokedAt: text('revoked_at'),
        }, { visibleTo: 'personId' });
        const sql = await generatedSql({ schema, teams, seats });

        expect(statementsWith(sql, 'CREATE POLICY "teams_')).toEqual(tenantListPolicies(
            'spfn_tenancy_v6', 'teams', 'seats', 'workspace_id', 'person_id',
            ' AND "m"."is_active" = true AND "m"."seat_no" = 2 AND "m"."revoked_at" is null',
        ));
        expect(statementsWith(sql, 'CREATE POLICY "seats_')).toEqual(visibleToPolicies('spfn_tenancy_v6', 'seats', 'workspace_id', 'person_id'));
        expect(sql).toContain('CREATE INDEX "seats_person_id_idx" ON "spfn_tenancy_v6"."seats" ("person_id");');
    });

    it('V7 visibleThrough.table() that is no tenancy table, of another tenancy, or without visibleTo throws at getTableConfig', () =>
    {
        const schema = pgSchema('spfn_tenancy_v7');
        const plainMembers = schema.table('plain_members', { id: id() });
        const toPlain = tenantList(schema, 'to_plain', { id: id() }, { visibleThrough: { table: () => plainMembers } });
        const toOther = tenantList(schema, 'to_other', { id: id() }, { visibleThrough: { table: () => members } });
        const toNotes = tenantList(fixtureSchema, 'workspaces_v7', { id: id() }, { visibleThrough: { table: () => notes } });
        const ownTenancy = defineTenancy({ tenants: toNotes, authorize: () => true });
        const withoutVisibleTo = ownTenancy.table(schema, 'v7_rows', { id: id() });
        const toRows = tenantList(schema, 'to_rows', { id: id() }, { visibleThrough: { table: () => withoutVisibleTo } });

        expect(() => getTableConfig(toPlain)).toThrow('tenantList "to_plain" visibleThrough.table() returned "plain_members", which is not a tenancy.table');
        expect(() => getTableConfig(toOther)).toThrow('tenantList "to_other" visibleThrough.table() returned "members", whose tenancy lists its tenants in "workspaces", not in "to_other"');
        expect(() => getTableConfig(toNotes)).toThrow('tenantList "workspaces_v7" visibleThrough.table() returned "notes", whose tenancy lists its tenants in "workspaces"');
        expect(() => getTableConfig(toRows)).toThrow('returned "v7_rows", whose tenancy lists its tenants in "workspaces_v7", not in "to_rows"');

        const rowsList = tenantList(schema, 'rows_list', { id: id() }, { visibleThrough: { table: (): PgTable => rowsWithout } });
        const rowsTenancy = defineTenancy({ tenants: rowsList, authorize: () => true });
        const rowsWithout = rowsTenancy.table(schema, 'rows_without', { id: id() });

        expect(() => getTableConfig(rowsList)).toThrow('tenantList "rows_list" visibleThrough.table() returned "rows_without", which declares no visibleTo');
    });

    it('V8 a where key that is no membership column throws at getTableConfig; an object value throws at once', () =>
    {
        const schema = pgSchema('spfn_tenancy_v8');
        const list = tenantList(schema, 'v8_list', { id: id() }, { visibleThrough: { table: (): PgTable => crew, where: { state: 'active' } } });
        const crewTenancy = defineTenancy({ tenants: list, authorize: () => true });
        const crew = crewTenancy.table(schema, 'v8_crew', { id: id(), userId: bigint('user_id', { mode: 'number' }) }, { visibleTo: 'userId' });

        expect(() => getTableConfig(list)).toThrow('tenantList "v8_list" visibleThrough.where "state" is not a column of "v8_crew"');
        expect(() => tenantList(schema, 'v8_object', { id: id() }, { visibleThrough: { table: (): PgTable => crew, where: { status: { not: 'x' } as never } } }))
            .toThrow('tenantList "v8_object" visibleThrough.where "status" takes a string, a finite number, a boolean or null');
        expect(() => tenantList(schema, 'v8_none', { id: id() }, {} as never)).toThrow('takes { visibleThrough: { table: (): PgTable => membershipTable } }');
    });

    it('V9 a string in where is quoted with its quote doubled', async () =>
    {
        const schema = pgSchema('spfn_tenancy_v9');
        const list = tenantList(schema, 'v9_list', { id: id() }, { visibleThrough: { table: (): PgTable => crew, where: { note: 'it\'s' } } });
        const crewTenancy = defineTenancy({ tenants: list, authorize: () => true });
        const crew = crewTenancy.table(schema, 'v9_crew', {
            id: id(),
            userId: bigint('user_id', { mode: 'number' }),
            note: text('note'),
        }, { visibleTo: 'userId' });
        const sql = await generatedSql({ schema, list, crew });

        expect(statementsWith(sql, 'CREATE POLICY "v9_list_tenant_visibility"')[0]).toContain('AND "m"."note" = \'it\'\'s\')');
    });

    it('V10 tables without visibleTo and a plain tenant list generate the beta.36 SQL byte for byte, one policy each', async () =>
    {
        const plainWorkspaces = fixtureSchema.table('workspaces', { id: id(), name: text('name').notNull() });
        const sql = await generatedSql({ schema: fixtureSchema, workspaces: plainWorkspaces, authors, notes, revisions, memos });

        expect(sql).toEqual(BETA_36_SQL);
        expect(getTableConfig(notes).policies.map((policy) => policy.name)).toEqual(['notes_tenant_isolation']);
        expect(getTableConfig(notes).indexes.map((index) => index.config.name)).toEqual(['notes_tenant_title_idx']);
    });

    it('V11 _selectOfUser returns the drizzle builder type _select returns; RunInTransactionOptions.user is a number', () =>
    {
        class Probe extends TenantRepository
        {
            byTenant(tenantId: number)
            {
                return this._select(tenantId, { id: members.id });
            }

            byUser(userId: number)
            {
                return this._selectOfUser(userId, { id: members.id });
            }

            allOfUser(userId: number)
            {
                return this._selectOfUser(userId);
            }

            allOfTenant(tenantId: number)
            {
                return this._select(tenantId);
            }
        }

        expectTypeOf<ReturnType<Probe['byUser']>>().toEqualTypeOf<ReturnType<Probe['byTenant']>>();
        expectTypeOf<ReturnType<Probe['allOfUser']>>().toEqualTypeOf<ReturnType<Probe['allOfTenant']>>();
        expectTypeOf<RunInTransactionOptions['user']>().toEqualTypeOf<number | undefined>();
        expectTypeOf<TenancyTableOptions<{ id: ReturnType<typeof id>; userId: ReturnType<typeof id> }>['visibleTo']>()
            .toEqualTypeOf<'userId' | undefined>();
        expectTypeOf<typeof members.$inferSelect>().toEqualTypeOf<{
            id: number;
            tenantId: number;
            userId: number;
            role: string;
            status: string;
        }>();
    });

    it('G-types tenancy tables infer the tenant column and reference nullability', () =>
    {
        expectTypeOf<typeof notes.$inferSelect>().toEqualTypeOf<{
            id: number;
            tenantId: number;
            authorId: number;
            reviewerId: number | null;
            title: string;
        }>();
        expectTypeOf<typeof authors.$inferInsert>().toHaveProperty('tenantId');
        expectTypeOf<typeof authors.$inferInsert>().not.toHaveProperty('authorId');
    });
});
