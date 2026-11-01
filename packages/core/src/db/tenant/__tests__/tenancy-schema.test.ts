/**
 * Tenancy schema generation — rows G1–G11 of the #158 part 2 design case table
 *
 * The SQL drizzle-kit generates is the contract: every row reads it through the
 * same API `spfn db push` uses (`drizzle-kit/api-postgres`). No database needed.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { alias, bigint, getTableConfig, pgSchema, text, type PgTable } from 'drizzle-orm/pg-core';
import { id, tenantKey, timestamps } from '../../schema';
import { constraintName, defineTenancy } from '../tenancy';
import { TENANCY_TABLE_MARKER, TENANT_COLUMN_MARKER } from '../registry';
import { generatedSql } from './tenancy-db';
import { authors, memos, notes, tenancy, TENANCY_TABLES, workspaces } from './tenancy-fixtures';

const S = '"spfn_tenancy_test"';

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
