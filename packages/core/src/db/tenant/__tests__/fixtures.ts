/**
 * Shared tables for the tenant-layer tests
 *
 * `notes` and `authors` are tenant-aware; `countries` is an ordinary table that
 * tenant queries may join. All three live in their own schema so the tests can
 * drop it whole.
 */

import { pgSchema, bigint, bigserial, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenantKey } from '../../schema';

export const TEST_SCHEMA = 'spfn_tenant_test';

const schema = pgSchema(TEST_SCHEMA);

export const authors = schema.table('authors', {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantKey(),
    name: text('name').notNull(),
});

export const notes = schema.table('notes', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantKey(),
    authorId: bigint('author_id', { mode: 'number' }),
    countryId: bigint('country_id', { mode: 'number' }),
    slug: text('slug'),
    title: text('title').notNull(),
}, (t) => [uniqueIndex('notes_tenant_slug_idx').on(t.tenantId, t.slug)]);

export const countries = schema.table('countries', {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    code: text('code').notNull(),
});

export const CREATE_TABLES = [
    `DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`,
    `CREATE SCHEMA ${TEST_SCHEMA}`,
    `CREATE TABLE ${TEST_SCHEMA}.authors (id bigint PRIMARY KEY, tenant_id bigint NOT NULL, name text NOT NULL)`,
    `CREATE TABLE ${TEST_SCHEMA}.notes (
        id bigserial PRIMARY KEY,
        tenant_id bigint NOT NULL,
        author_id bigint,
        country_id bigint,
        slug text,
        title text NOT NULL
    )`,
    `CREATE UNIQUE INDEX notes_tenant_slug_idx ON ${TEST_SCHEMA}.notes (tenant_id, slug)`,
    `CREATE TABLE ${TEST_SCHEMA}.countries (id bigint PRIMARY KEY, code text NOT NULL)`,
];

/**
 * Rows every test starts from.
 *
 * | note | tenant | author          | country | slug |
 * | ---- | ------ | --------------- | ------- | ---- |
 * | 1    | 1      | 1 (tenant 1)    | 1 (KR)  | a    |
 * | 2    | 1      | 2 (tenant 2!)   | —       | b    |
 * | 3    | 1      | —               | —       | c    |
 * | 5    | 1      | 1               | —       | e    |
 * | 6    | 2      | 2               | —       | x    |
 * | 11   | 1      | —               | —       | k    |
 * | 12   | 2      | —               | —       | m    |
 */
export const SEED_ROWS = [
    `TRUNCATE ${TEST_SCHEMA}.notes, ${TEST_SCHEMA}.authors, ${TEST_SCHEMA}.countries`,
    `INSERT INTO ${TEST_SCHEMA}.authors (id, tenant_id, name) VALUES (1, 1, 'Ann'), (2, 2, 'Bob')`,
    `INSERT INTO ${TEST_SCHEMA}.countries (id, code) VALUES (1, 'KR')`,
    `INSERT INTO ${TEST_SCHEMA}.notes (id, tenant_id, author_id, country_id, slug, title) VALUES
        (1, 1, 1, 1, 'a', 'A'),
        (2, 1, 2, NULL, 'b', 'B'),
        (3, 1, NULL, NULL, 'c', 'C'),
        (5, 1, 1, NULL, 'e', 'E'),
        (6, 2, 2, NULL, 'x', 'X'),
        (11, 1, NULL, NULL, 'k', 'K'),
        (12, 2, NULL, NULL, 'm', 'M')`,
    `SELECT setval(pg_get_serial_sequence('${TEST_SCHEMA}.notes', 'id'), 100)`,
];
