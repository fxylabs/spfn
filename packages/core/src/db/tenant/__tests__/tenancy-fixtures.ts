/**
 * Tables for the tenancy tests (#158 part 2, #162)
 *
 * `workspaces` lists the tenants, with policies that let a member see it
 * through `members` (#162); `authors`, `notes` and `revisions` are tenancy
 * tables — `notes` references `authors` twice, once optional, and `revisions`
 * references `notes` with `onDelete: 'restrict'` (#160) — `members` is a
 * tenancy table with a second key, `visibleTo: 'userId'` (#162), and `memos` is
 * a `tenantKey()`-only table, as part 1 makes one. All live in one schema the
 * tests drop whole. The DDL is what drizzle-kit generates for them, so the
 * database tests run against the migration an app would get.
 */

import { bigint, index, pgSchema, text, type PgTable } from 'drizzle-orm/pg-core';
import { id, tenantKey } from '../../schema';
import { defineTenancy, tenantList } from '../tenancy';

export const TENANCY_SCHEMA = 'spfn_tenancy_test';

export const schema = pgSchema(TENANCY_SCHEMA);

export const workspaces = tenantList(schema, 'workspaces', {
    id: id(),
    name: text('name').notNull(),
}, {
    visibleThrough: { table: (): PgTable => members, where: { status: 'active' } },
});

/** authorize is replaced per test through `setAuthorize`. */
let authorizeImpl: (tenantId: number) => boolean | Promise<boolean> = () => true;

export function setAuthorize(authorize: (tenantId: number) => boolean | Promise<boolean>): void
{
    authorizeImpl = authorize;
}

export const tenancy = defineTenancy({
    tenants: workspaces,
    authorize: (_c, tenantId) => authorizeImpl(tenantId),
});

export const authors = tenancy.table(schema, 'authors', {
    id: id(),
    name: text('name').notNull(),
});

export const notes = tenancy.table(schema, 'notes', {
    id: id(),
    authorId: tenancy.reference('author', () => authors),
    reviewerId: tenancy.reference('reviewer', () => authors, { optional: true }),
    title: text('title').notNull(),
}, (t) => [index('notes_tenant_title_idx').on(t.tenantId, t.title)]);

export const revisions = tenancy.table(schema, 'revisions', {
    id: id(),
    noteId: tenancy.reference('note', () => notes, { onDelete: 'restrict' }),
    body: text('body').notNull(),
});

export const members = tenancy.table(schema, 'members', {
    id: id(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
}, { visibleTo: 'userId' });

export const memos = schema.table('memos', {
    id: id(),
    tenantId: tenantKey(),
    body: text('body').notNull(),
});

export const TENANCY_TABLES = { schema, workspaces, authors, notes, revisions, memos, members };

/**
 * Rows every database test starts from, written by the owner (no policy applies).
 *
 * | table     | id | tenant | other                        |
 * | --------- | -- | ------ | ---------------------------- |
 * | authors   | 1  | 7      | Ann                          |
 * | authors   | 2  | 9      | Bob                          |
 * | authors   | 3  | 7      | Cid                          |
 * | notes     | 1  | 7      | author 1                     |
 * | notes     | 2  | 7      | author 1, reviewer 3         |
 * | notes     | 3  | 9      | author 2                     |
 * | revisions | 1  | 9      | note 3                       |
 * | memos     | 1  | 7      |                              |
 * | memos     | 2  | 7      |                              |
 * | memos     | 3  | 9      |                              |
 * | members   | 1  | 7      | user 3, active               |
 * | members   | 2  | 9      | user 3, active               |
 * | members   | 3  | 7      | user 5, active               |
 * | members   | 4  | 11     | user 3, invited              |
 *
 * Workspaces 7, 9 and 11; every membership's role is `member`.
 */
export const SEED_ROWS = [
    `TRUNCATE ${TENANCY_SCHEMA}.revisions, ${TENANCY_SCHEMA}.notes, ${TENANCY_SCHEMA}.authors, ${TENANCY_SCHEMA}.memos, ${TENANCY_SCHEMA}.members, ${TENANCY_SCHEMA}.workspaces RESTART IDENTITY`,
    `INSERT INTO ${TENANCY_SCHEMA}.workspaces (id, name) VALUES (7, 'seven'), (9, 'nine'), (11, 'eleven')`,
    `INSERT INTO ${TENANCY_SCHEMA}.authors (id, tenant_id, name) VALUES (1, 7, 'Ann'), (2, 9, 'Bob'), (3, 7, 'Cid')`,
    `INSERT INTO ${TENANCY_SCHEMA}.notes (id, tenant_id, author_id, reviewer_id, title) VALUES
        (1, 7, 1, NULL, 'one'),
        (2, 7, 1, 3, 'two'),
        (3, 9, 2, NULL, 'three')`,
    `INSERT INTO ${TENANCY_SCHEMA}.revisions (id, tenant_id, note_id, body) VALUES (1, 9, 3, 'first draft')`,
    `INSERT INTO ${TENANCY_SCHEMA}.memos (id, tenant_id, body) VALUES (1, 7, 'a'), (2, 7, 'b'), (3, 9, 'c')`,
    `INSERT INTO ${TENANCY_SCHEMA}.members (id, tenant_id, user_id, role, status) VALUES
        (1, 7, 3, 'member', 'active'),
        (2, 9, 3, 'member', 'active'),
        (3, 7, 5, 'member', 'active'),
        (4, 11, 3, 'member', 'invited')`,
    `SELECT setval(pg_get_serial_sequence('${TENANCY_SCHEMA}.workspaces', 'id'), 100)`,
    `SELECT setval(pg_get_serial_sequence('${TENANCY_SCHEMA}.authors', 'id'), 100)`,
    `SELECT setval(pg_get_serial_sequence('${TENANCY_SCHEMA}.notes', 'id'), 100)`,
    `SELECT setval(pg_get_serial_sequence('${TENANCY_SCHEMA}.revisions', 'id'), 100)`,
    `SELECT setval(pg_get_serial_sequence('${TENANCY_SCHEMA}.memos', 'id'), 100)`,
    `SELECT setval(pg_get_serial_sequence('${TENANCY_SCHEMA}.members', 'id'), 100)`,
];
