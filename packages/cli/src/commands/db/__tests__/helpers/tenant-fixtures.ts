/**
 * Tenant tables for the `spfn db tenant export` / `import` tests (#158 part 3)
 *
 * Built per test file, in a schema of the file's own:
 *
 * | table      | kind                  | of note                                                         |
 * | ---------- | --------------------- | --------------------------------------------------------------- |
 * | workspaces | tenant list           | not exported                                                    |
 * | writers    | `tenancy.table`       | referenced by notes; sorts after notes, so file order ≠ FK order |
 * | notes      | `tenancy.table`       | required and optional reference to writers, `parent_id` to itself, a generated column |
 *
 * `parentOnDelete` sets the delete action of `parent_id` (#160); left out, it is
 * the optional reference's default, `no action`.
 * | memos      | `tenantKey()` only    | no policy; `GENERATED ALWAYS AS IDENTITY` id                    |
 *
 * `members: true` (#162) adds `members`, a `tenancy.table` with
 * `visibleTo: 'userId'`, and declares `workspaces` with `tenantList({ visibleThrough })`
 * over it; `seedMembers` writes its rows.
 *
 * The DDL is what drizzle-kit generates for them, applied by the owner; the app
 * role gets row privileges, as `spfn db migrate` leaves an app.
 */

import { sql as drizzleSql } from 'drizzle-orm';
import { bigint, integer, pgSchema, text, type PgTable } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres';
import { defineTenancy, id, tenantKey, tenantList, type TenancyOnDelete } from '@spfn/core/db';
import type postgres from 'postgres';

export type TenantFixtures = ReturnType<typeof createTenantFixtures>;

export function createTenantFixtures(schemaName: string, options: { parentOnDelete?: TenancyOnDelete; members?: boolean } = {})
{
    const schema = pgSchema(schemaName);
    const workspaceColumns = { id: id(), name: text('name').notNull() };
    const workspaces = options.members
        ? tenantList(schema, 'workspaces', workspaceColumns, {
            visibleThrough: { table: (): PgTable => members!, where: { status: 'active' } },
        })
        : schema.table('workspaces', workspaceColumns);
    const tenancy = defineTenancy({ tenants: workspaces, authorize: () => true });
    const writers = tenancy.table(schema, 'writers', {
        id: id(),
        name: text('name').notNull(),
    });
    const notes = tenancy.table(schema, 'notes', {
        id: id(),
        authorId: tenancy.reference('author', () => writers),
        reviewerId: tenancy.reference('reviewer', () => writers, { optional: true }),
        parentId: tenancy.reference('parent', (): PgTable => notes, { optional: true, onDelete: options.parentOnDelete }),
        title: text('title').notNull(),
        titleLength: integer('title_length').generatedAlwaysAs(drizzleSql`length(title)`),
    });
    const memos = schema.table('memos', {
        id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
        tenantId: tenantKey(),
        body: text('body').notNull(),
    });
    const members = options.members
        ? tenancy.table(schema, 'members', {
            id: id(),
            userId: bigint('user_id', { mode: 'number' }).notNull(),
            status: text('status').notNull(),
        }, { visibleTo: 'userId' })
        : undefined;
    const imports = { schema, workspaces, writers, notes, memos, ...(members ? { members } : {}) };

    return { schemaName, imports };
}

/** Drop the schema, create it from the generated SQL, grant the app role its row privileges. */
export async function createSchema(sql: postgres.Sql, fixtures: TenantFixtures, appRole: string): Promise<void>
{
    const schema = fixtures.schemaName;

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

    for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(fixtures.imports)))
    {
        await sql.unsafe(statement);
    }

    await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${appRole}`);
    await sql.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${appRole}`);
}

/**
 * Rows of tenants 7 and 9, written by the owner (no policy applies), with ids
 * interleaved between the two tenants. Sequences stop at 100.
 *
 * | table   | tenant 7                                         | tenant 9      |
 * | ------- | ------------------------------------------------ | ------------- |
 * | writers | 1 Ann, 3 Cid                                     | 2 Bob         |
 * | notes   | 1 (author 1), 2 (author 1, reviewer 3, parent 1), 4 (author 3, parent 2) | 3 (author 2) |
 * | memos   | 1, 2                                             | 3             |
 */
export async function seed(sql: postgres.Sql, schema: string): Promise<void>
{
    await sql.unsafe(`INSERT INTO ${schema}.workspaces (id, name) VALUES (7, 'seven'), (9, 'nine')`);
    await sql.unsafe(`INSERT INTO ${schema}.writers (id, tenant_id, name) VALUES (1, 7, 'Ann'), (2, 9, 'Bob'), (3, 7, 'Cid')`);
    await sql.unsafe(`INSERT INTO ${schema}.notes (id, tenant_id, author_id, reviewer_id, parent_id, title) VALUES
        (1, 7, 1, NULL, NULL, 'one'),
        (2, 7, 1, 3, 1, 'two'),
        (3, 9, 2, NULL, NULL, 'three'),
        (4, 7, 3, NULL, 2, 'four, with a tab	and a
newline')`);
    await sql.unsafe(`INSERT INTO ${schema}.memos (id, tenant_id, body) OVERRIDING SYSTEM VALUE VALUES (1, 7, 'a'), (2, 7, 'b'), (3, 9, 'c')`);
    await setSequences(sql, schema, 100);
}

/**
 * Workspace 11 and the memberships of `members: true`, written by the owner:
 * (7, user 3, active), (9, user 3, active), (7, user 5, active), (11, user 3, invited).
 */
export async function seedMembers(sql: postgres.Sql, schema: string): Promise<void>
{
    await sql.unsafe(`INSERT INTO ${schema}.workspaces (id, name) VALUES (11, 'eleven')`);
    await sql.unsafe(`INSERT INTO ${schema}.members (id, tenant_id, user_id, status) VALUES
        (1, 7, 3, 'active'), (2, 9, 3, 'active'), (3, 7, 5, 'active'), (4, 11, 3, 'invited')`);
    await sql.unsafe(`SELECT setval(pg_get_serial_sequence('${schema}.members', 'id'), 100)`);
}

export async function setSequences(sql: postgres.Sql, schema: string, value: number): Promise<void>
{
    for (const table of ['workspaces', 'writers', 'notes', 'memos'])
    {
        await sql.unsafe(`SELECT setval(pg_get_serial_sequence('${schema}.${table}', 'id'), ${value})`);
    }
}

/** Per table: its row count and a checksum of every row, to show a table did or did not change. */
export async function snapshot(sql: postgres.Sql, schema: string): Promise<Record<string, { rows: number; checksum: string | null }>>
{
    const entries = await Promise.all(['workspaces', 'writers', 'notes', 'memos'].map(async (table) =>
    {
        const [state] = await sql.unsafe(
            `SELECT count(*)::int AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS checksum FROM ${schema}.${table} t`,
        );

        return [table, { rows: state.rows as number, checksum: state.checksum as string | null }] as const;
    }));

    return Object.fromEntries(entries);
}

/** The same, for one tenant's rows of the tenant tables. */
export async function tenantSnapshot(sql: postgres.Sql, schema: string, tenantId: number): Promise<Record<string, string | null>>
{
    const entries = await Promise.all(['writers', 'notes', 'memos'].map(async (table) =>
    {
        const [state] = await sql.unsafe(
            `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS checksum FROM ${schema}.${table} t WHERE tenant_id = $1`,
            [tenantId],
        );

        return [table, state.checksum as string | null] as const;
    }));

    return Object.fromEntries(entries);
}
