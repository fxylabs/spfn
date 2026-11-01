/**
 * Development tenant query warning
 *
 * Rows 28–35 of the w-h3adm design case table. The SQL comes from drizzle
 * itself (a mock driver's toSQL()), so the matcher is tested against the text
 * drizzle 1.0.0-rc.4 really emits. The last block runs real queries through a
 * logged drizzle instance: TenantRepository's own queries pass the check, and a
 * subquery a caller hands it is checked like any other SQL.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { alias, pgTable, bigint, text } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { tenantKey } from '../../schema';
import { setDatabase, getDatabase } from '../../manager';
import { TEST_DATABASE_URL } from '../../__tests__/helpers/db-fixture';
import { createDevelopmentQueryLogger, createTenantQueryLogger, findUnscopedTenantTables } from '../query-warning';
import { listTenantTables } from '../registry';
import { TenantRepository } from '../tenant-repository';
import { authors, countries, notes, CREATE_TABLES, SEED_ROWS, TEST_SCHEMA } from './fixtures';

const plainNotes = pgTable('plain_tenant_notes', {
    id: bigint('id', { mode: 'number' }),
    tenantId: tenantKey('workspace_id'),
    title: text('title'),
});

const mock = drizzle.mock();

function sqlOf(query: { toSQL: () => { sql: string } }): string
{
    return query.toSQL().sql;
}

function unscoped(query: { toSQL: () => { sql: string } }): string[]
{
    return findUnscopedTenantTables(sqlOf(query), listTenantTables());
}

describe('findUnscopedTenantTables', () =>
{
    it('row 28: a select without the tenant condition is reported', () =>
    {
        expect(unscoped(mock.select().from(notes))).toEqual(['notes']);
    });

    it('row 30: a select with the tenant condition is not', () =>
    {
        expect(unscoped(mock.select().from(notes).where(eq(notes.tenantId, 1)))).toEqual([]);
        expect(unscoped(mock.select().from(notes).where(inArray(notes.tenantId, [1, 2])))).toEqual([]);
    });

    it('row 31: in a join, the table missing its condition is reported', () =>
    {
        const query = mock.select().from(notes)
            .innerJoin(authors, eq(notes.authorId, authors.id))
            .where(eq(notes.tenantId, 1));

        expect(unscoped(query)).toEqual(['authors']);
    });

    it('row 31: an alias is reported by its alias name', () =>
    {
        const writer = alias(authors, 'writer');
        const query = mock.select().from(notes)
            .innerJoin(writer, eq(notes.authorId, writer.id))
            .where(eq(notes.tenantId, 1));

        expect(unscoped(query)).toEqual(['writer']);
    });

    it('row 33: a query on ordinary tables only is not reported', () =>
    {
        expect(unscoped(mock.select().from(countries))).toEqual([]);
    });

    it('row 35: an insert is not reported', () =>
    {
        expect(unscoped(mock.insert(notes).values({ tenantId: 1, title: 'x' }))).toEqual([]);
    });

    it('an update whose SET names the tenant column but whose WHERE does not is reported', () =>
    {
        expect(unscoped(mock.update(notes).set({ tenantId: 1 }).where(eq(notes.id, 5)))).toEqual(['notes']);
        expect(unscoped(mock.update(notes).set({ title: 'x' }).where(eq(notes.tenantId, 1)))).toEqual([]);
    });

    it('a delete is checked like a select', () =>
    {
        expect(unscoped(mock.delete(notes).where(eq(notes.id, 5)))).toEqual(['notes']);
        expect(unscoped(mock.delete(notes).where(eq(notes.tenantId, 1)))).toEqual([]);
    });

    it('a table outside a schema and a custom column name are matched', () =>
    {
        expect(unscoped(mock.select().from(plainNotes))).toEqual(['plain_tenant_notes']);
        expect(unscoped(mock.select().from(plainNotes).where(eq(plainNotes.tenantId, 1)))).toEqual([]);
    });

    it('a subquery inside a where condition is checked on its own', () =>
    {
        const authorIds = mock.select({ id: authors.id }).from(authors);
        const query = mock.select().from(notes).where(and(eq(notes.tenantId, 1), inArray(notes.authorId, authorIds)));

        expect(unscoped(query)).toEqual(['authors']);
    });

    it('a subquery is checked inside the outer query', () =>
    {
        const inner = mock.select().from(notes).as('sq');

        expect(unscoped(mock.select().from(inner))).toEqual(['notes']);
    });
});

describe('createTenantQueryLogger', () =>
{
    it('row 28: warns once with the SQL and the table', () =>
    {
        const warn = vi.fn();
        const text = sqlOf(mock.select().from(notes));

        createTenantQueryLogger({ warn }).logQuery(text, []);

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a tenant condition'), { tables: ['notes'], sql: text });
    });

    it('row 29: the same SQL a second time is not warned again', () =>
    {
        const warn = vi.fn();
        const logger = createTenantQueryLogger({ warn });
        const text = sqlOf(mock.select().from(notes));

        logger.logQuery(text, []);
        logger.logQuery(text, []);

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('row 41: a warn callback that throws does not escape logQuery', () =>
    {
        const warn = vi.fn(() =>
        {
            throw new Error('broken warning sink');
        });
        const text = sqlOf(mock.select().from(notes));

        expect(() => createTenantQueryLogger({ warn }).logQuery(text, [])).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('row 41: a table list that throws does not escape logQuery', () =>
    {
        const tables = () =>
        {
            throw new Error('broken registry');
        };

        expect(() => createTenantQueryLogger({ warn: vi.fn(), tables }).logQuery('select 1', [])).not.toThrow();
    });
});

describe('createDevelopmentQueryLogger', () =>
{
    it.each(['local', 'development'])('attaches in %s', (nodeEnv) =>
    {
        expect(createDevelopmentQueryLogger(nodeEnv, vi.fn())).toBeDefined();
    });

    it.each(['production', 'staging', 'test', undefined])('row 34: does not attach in %s', (nodeEnv) =>
    {
        expect(createDevelopmentQueryLogger(nodeEnv, vi.fn())).toBeUndefined();
    });
});

describe('tenant query warning on a live database (integration)', () =>
{
    class NoteRepository extends TenantRepository
    {
        async exercise(tenantId: number)
        {
            await this._findMany(tenantId, notes);
            await this._findOne(tenantId, notes, { id: 1 });
            await this._findManyKeyset(tenantId, notes, { cursorColumn: notes.id, limit: 10 });
            await this._count(tenantId, notes, undefined, { cap: 10 });
            await this._updateOne(tenantId, notes, { id: 1 }, { title: 'A' });
            await this._select(tenantId).from(notes).leftJoin(authors, eq(notes.authorId, authors.id));
            const writer = alias(authors, 'writer');

            await this._select(tenantId).from(notes).innerJoin(writer, eq(notes.authorId, writer.id));
            await this._deleteOne(tenantId, notes, { id: 999 });
        }

        withSubquery(tenantId: number)
        {
            const authorIds = this.readDb.select({ id: authors.id }).from(authors);

            return this._findMany(tenantId, notes, { where: inArray(notes.authorId, authorIds) });
        }

        handWritten()
        {
            return this.readDb.select().from(notes);
        }
    }

    const warn = vi.fn();
    let client: postgres.Sql | undefined;

    beforeAll(async () =>
    {
        try
        {
            client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
            await client`select 1`;
        }
        catch
        {
            await client?.end();
            client = undefined;

            return;
        }

        const db = drizzle({ client, logger: createTenantQueryLogger({ warn }) });

        setDatabase(db as any, db as any);

        for (const statement of [...CREATE_TABLES, ...SEED_ROWS])
        {
            await client.unsafe(statement);
        }
    });

    afterAll(async () =>
    {
        if (!client) return;

        await client.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
        setDatabase(undefined);
        await client.end();
    });

    it('row 32: TenantRepository methods and _select run silently', async () =>
    {
        if (!client) return;

        await new NoteRepository().exercise(1);

        expect(warn.mock.calls).toEqual([]);
    });

    it('row 28: a hand-written query on this.readDb is warned', async () =>
    {
        if (!client) return;

        await new NoteRepository().handWritten();
        await getDatabase().select().from(notes);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1].tables).toEqual(['notes']);
    });

    it('a subquery handed to a TenantRepository method is checked', async () =>
    {
        if (!client) return;

        warn.mockClear();
        await new NoteRepository().withSubquery(1);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1].tables).toEqual(['authors']);
    });

    it('row 41: a warn callback that throws does not fail the query', async () =>
    {
        if (!client) return;

        const failingWarn = () =>
        {
            throw new Error('broken warning sink');
        };
        const db = drizzle({ client, logger: createTenantQueryLogger({ warn: failingWarn }) });
        const rows = await db.select().from(notes);

        expect(rows.length).toBeGreaterThan(0);
    });
});
