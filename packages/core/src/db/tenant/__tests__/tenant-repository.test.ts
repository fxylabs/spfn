/**
 * TenantRepository integration tests
 *
 * One test per row of the w-h3adm design case table, rows 1–27
 * (artifacts/tenant-layer-part1-design.md §3). Skips when no test DB is available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import type { InferInsertModel, SQL } from 'drizzle-orm';
import { alias, union } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';
import { BaseRepository } from '../../repository';
import { TenantRepository } from '../tenant-repository';
import { authors, countries, notes, CREATE_TABLES, SEED_ROWS, TEST_SCHEMA } from './fixtures';

type NewNote = InferInsertModel<typeof notes>;

class NoteRepository extends TenantRepository
{
    findOne(tenantId: number, where: Record<string, unknown>)
    {
        return this._findOne(tenantId, notes, where);
    }

    findMany(tenantId: number, where?: Record<string, unknown> | SQL)
    {
        return this._findMany(tenantId, notes, { where, orderBy: asc(notes.id) });
    }

    findCountries(tenantId: number)
    {
        return this._findMany(tenantId, countries);
    }

    page(tenantId: number, after?: number)
    {
        return this._findManyKeyset(tenantId, notes, { cursorColumn: notes.id, after, limit: 50 });
    }

    count(tenantId: number, cap?: number)
    {
        return this._count(tenantId, notes, undefined, cap === undefined ? undefined : { cap });
    }

    create(tenantId: number, data: Partial<NewNote>)
    {
        return this._create(tenantId, notes, data as NewNote);
    }

    createMany(tenantId: number, data: Partial<NewNote>[])
    {
        return this._createMany(tenantId, notes, data as NewNote[]);
    }

    updateOne(tenantId: number, where: Record<string, unknown>, data: Partial<NewNote>)
    {
        return this._updateOne(tenantId, notes, where, data);
    }

    deleteOne(tenantId: number, where: Record<string, unknown>)
    {
        return this._deleteOne(tenantId, notes, where);
    }

    upsert(tenantId: number, data: Partial<NewNote>, target: PgColumn[], set?: Partial<NewNote>)
    {
        return this._upsert(tenantId, notes, data as NewNote, { target, set });
    }

    select(tenantId: number)
    {
        return this._select(tenantId, { id: notes.id, author: authors.name });
    }

    selectAll(tenantId: number)
    {
        return this._select(tenantId);
    }
}

class PlainNoteRepository extends BaseRepository
{
    count(cap: number)
    {
        return this._count(notes, undefined, { cap });
    }
}

/** The plan node that scans `table`, with its detail lines and child nodes. */
function scanBlock(lines: string[], table: string): string
{
    const start = lines.findIndex((line) => new RegExp(`Scan(?: using \\S+)? on ${table}\\b`).test(line));
    const indent = lines[start].search(/\S/);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.search(/\S/) <= indent);

    return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

describe('TenantRepository (integration)', () =>
{
    const dbFixture = createDbTestFixture();
    const repo = new NoteRepository();

    const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
    const tenantOf = async (id: number) =>
    {
        const rows = await dbFixture.db.execute(sql`select tenant_id from ${notes} where id = ${id}`);

        return Number((rows as unknown as { tenant_id: string }[])[0]?.tenant_id);
    };

    beforeAll(async () =>
    {
        await dbFixture.setup();
        if (!dbFixture.isAvailable) return;

        for (const statement of CREATE_TABLES)
        {
            await dbFixture.execute(statement);
        }
    });

    beforeEach(async () =>
    {
        if (!dbFixture.isAvailable) return;

        for (const statement of SEED_ROWS)
        {
            await dbFixture.execute(statement);
        }
    });

    afterAll(async () =>
    {
        await dbFixture.execute(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
        await dbFixture.teardown();
    });

    describe('reads', () =>
    {
        it('row 1: _findOne returns the tenant\'s own row', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect((await repo.findOne(1, { id: 5 }))?.title).toBe('E');
        });

        it('row 2: _findOne does not return another tenant\'s row', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(await repo.findOne(1, { id: 6 })).toBeNull();
        });

        it('row 3: _findMany returns only the tenant\'s rows', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(ids(await repo.findMany(1))).toEqual([1, 2, 3, 5, 11]);
            expect(ids(await repo.findMany(2))).toEqual([6, 12]);
        });

        it('row 3: a caller condition is ANDed with the tenant, not ORed', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(ids(await repo.findMany(1, { slug: 'x' }))).toEqual([]);
            expect(ids(await repo.findMany(1, sql`${notes.id} = 1 or ${notes.id} = 6`))).toEqual([1]);
        });

        it('row 4: _findManyKeyset pages through the tenant\'s rows after the cursor', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(ids(await repo.page(1, 3))).toEqual([5, 11]);
            expect(ids(await repo.page(1, 10))).toEqual([11]);
            expect(ids(await repo.page(2))).toEqual([6, 12]);
        });

        it('row 5: an ordinary table is refused', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.findCountries(1)).rejects.toThrow(/has no tenantKey\(\) column/);
        });

        it.each([0, -1, 1.5, Number.NaN, undefined, '1'])('row 6: tenant id %s is refused', async (tenantId) =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.findMany(tenantId as number)).rejects.toThrow(/positive safe integer/);
            await expect(repo.create(tenantId as number, { title: 'Z' })).rejects.toThrow(/positive safe integer/);
            expect(() => repo.selectAll(tenantId as number)).toThrow(/positive safe integer/);
        });
    });

    describe('counts', () =>
    {
        const fill = async (tenantId: number, rows: number) =>
        {
            await dbFixture.execute(
                `INSERT INTO ${TEST_SCHEMA}.notes (tenant_id, title) SELECT ${tenantId}, 'n' FROM generate_series(1, ${rows})`,
            );
        };

        it('row 7: a capped count stops at cap + 1', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await dbFixture.execute(`DELETE FROM ${TEST_SCHEMA}.notes`);
            await fill(1, 5000);

            expect(await repo.count(1, 1000)).toBe(1001);
        });

        it('row 8: a capped count counts only the tenant\'s rows', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await dbFixture.execute(`DELETE FROM ${TEST_SCHEMA}.notes`);
            await fill(1, 10);
            await fill(2, 5000);

            expect(await repo.count(1, 1000)).toBe(10);
        });

        it('row 9: without cap the count is exact', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await dbFixture.execute(`DELETE FROM ${TEST_SCHEMA}.notes`);
            await fill(1, 5000);

            expect(await repo.count(1)).toBe(5000);
        });

        it('row 10: BaseRepository._count takes the same cap', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await dbFixture.execute(`DELETE FROM ${TEST_SCHEMA}.notes`);
            await fill(1, 5000);

            const plain = new PlainNoteRepository();

            expect(await plain.count(1000)).toBe(1001);
            expect(await plain.count(10000)).toBe(5000);
        });

        it.each([0, -1, 1.5])('row 10: cap %s is refused', async (cap) =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.count(1, cap)).rejects.toThrow(RangeError);
            await expect(new PlainNoteRepository().count(cap)).rejects.toThrow(RangeError);
        });
    });

    describe('writes', () =>
    {
        it('row 11: _create stores the tenant id', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const created = await repo.create(1, { title: 'New' });

            expect(created.tenantId).toBe(1);
            expect(await tenantOf(created.id)).toBe(1);
        });

        it('row 12: _create refuses another tenant\'s id in data', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.create(1, { tenantId: 2, title: 'New' })).rejects.toThrow(/does not match the tenant 1/);
            expect(ids(await repo.findMany(2))).toEqual([6, 12]);
        });

        it('row 13: _create accepts the same tenant id in data', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect((await repo.create(1, { tenantId: 1, title: 'New' })).tenantId).toBe(1);
        });

        it('row 14: _createMany writes nothing when one row names another tenant', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.createMany(1, [{ title: 'P' }, { tenantId: 2, title: 'Q' }])).rejects.toThrow(/does not match/);
            expect(ids(await repo.findMany(1))).toEqual([1, 2, 3, 5, 11]);
            expect(ids(await repo.findMany(2))).toEqual([6, 12]);
        });

        it('row 15: _updateOne changes the tenant\'s own row', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect((await repo.updateOne(1, { id: 5 }, { title: 'E2' }))?.title).toBe('E2');
        });

        it('row 16: _updateOne leaves another tenant\'s row untouched', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(await repo.updateOne(1, { id: 6 }, { title: 'hijack' })).toBeNull();
            expect((await repo.findOne(2, { id: 6 }))?.title).toBe('X');
        });

        it('row 17: _updateOne refuses to change the tenant column', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.updateOne(1, { id: 5 }, { tenantId: 2 })).rejects.toThrow(/cannot be changed/);
            await expect(repo.updateOne(1, { id: 5 }, { tenantId: 1 })).rejects.toThrow(/cannot be changed/);
            expect(await tenantOf(5)).toBe(1);
        });

        it('row 18: _deleteOne leaves another tenant\'s row in place', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(await repo.deleteOne(1, { id: 6 })).toBeNull();
            expect(await tenantOf(6)).toBe(2);
            expect((await repo.deleteOne(1, { id: 5 }))?.id).toBe(5);
        });

        it('rows 15–18: a where that filters on nothing besides the tenant is refused', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.updateOne(1, {}, { title: 'all' })).rejects.toThrow(/requires at least one where condition/);
            await expect(repo.deleteOne(1, {})).rejects.toThrow(/requires at least one where condition/);
            await expect(repo.findOne(1, {})).rejects.toThrow(/requires at least one where condition/);
        });

        it('row 19: _upsert refuses a conflict target without the tenant column', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.upsert(1, { id: 6, title: 'hijack' }, [notes.id])).rejects.toThrow(/must include the tenant column/);
            expect((await repo.findOne(2, { id: 6 }))?.title).toBe('X');
        });

        it('row 20: _upsert inserts for the tenant when the same key exists only in another tenant', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const row = await repo.upsert(1, { slug: 'x', title: 'Mine' }, [notes.tenantId, notes.slug], { title: 'Mine' });

            expect(row.tenantId).toBe(1);
            expect(row.id).not.toBe(6);
            expect((await repo.findOne(2, { id: 6 }))?.title).toBe('X');
        });

        it('row 20: _upsert updates the tenant\'s own row on conflict', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const row = await repo.upsert(1, { slug: 'a', title: 'A2' }, [notes.tenantId, notes.slug], { title: 'A2' });

            expect(row.id).toBe(1);
            expect(row.title).toBe('A2');
        });

        it('row 20: _upsert refuses a set that changes the tenant column', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await expect(repo.upsert(1, { slug: 'a', title: 'A' }, [notes.tenantId, notes.slug], { tenantId: 2 }))
                .rejects.toThrow(/cannot be changed/);
        });
    });

    describe('joins', () =>
    {
        it('row 21: innerJoin puts the joined table\'s tenant in ON and the from table\'s in WHERE', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const query = repo.select(1).from(notes).innerJoin(authors, eq(notes.authorId, authors.id));
            const text = query.toSQL().sql;

            expect(text).toMatch(/inner join "spfn_tenant_test"\."authors" on \(.*"spfn_tenant_test"\."authors"\."tenant_id" = \$\d+\)/);
            expect(text).toMatch(/where "spfn_tenant_test"\."notes"\."tenant_id" = \$\d+$/);

            const plan = await dbFixture.db.execute(sql`explain ${query.getSQL()}`);
            const planLines = (plan as unknown as { 'QUERY PLAN': string }[]).map((line) => line['QUERY PLAN']);

            expect(scanBlock(planLines, 'notes')).toContain("tenant_id = '1'::bigint");
            expect(scanBlock(planLines, 'authors')).toContain("tenant_id = '1'::bigint");
        });

        it('row 22: a note linked to another tenant\'s author does not come back', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const rows = await repo.select(1).from(notes).innerJoin(authors, eq(notes.authorId, authors.id)).orderBy(notes.id);

            expect(rows).toEqual([{ id: 1, author: 'Ann' }, { id: 5, author: 'Ann' }]);
        });

        it('row 23: leftJoin keeps notes with no author in this tenant', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const rows = await repo.select(1).from(notes).leftJoin(authors, eq(notes.authorId, authors.id)).orderBy(notes.id);

            expect(rows).toEqual([
                { id: 1, author: 'Ann' },
                { id: 2, author: null },
                { id: 3, author: null },
                { id: 5, author: 'Ann' },
                { id: 11, author: null },
            ]);
        });

        it('row 23: a join callback condition still gets the tenant', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const rows = await repo.select(1).from(notes).innerJoin(authors, () => eq(notes.authorId, authors.id)).orderBy(notes.id);

            expect(ids(rows)).toEqual([1, 5]);
        });

        it('row 24: an ordinary joined table gets no tenant condition', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const query = repo.selectAll(1).from(notes).innerJoin(countries, eq(notes.countryId, countries.id));

            expect(query.toSQL().sql).not.toMatch(/"countries"\."tenant_id"/);
            expect((await query).map((row) => [row.notes.id, row.countries.code])).toEqual([[1, 'KR']]);
        });

        it('row 24: a joined alias of a tenant table gets its tenant condition', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const writer = alias(authors, 'writer');
            const query = repo.selectAll(1).from(notes).innerJoin(writer, eq(notes.authorId, writer.id));

            expect(query.toSQL().sql).toMatch(/"writer"\."tenant_id" = \$\d+/);
            expect((await query).map((row) => row.notes.id).sort()).toEqual([1, 5]);
        });

        it.each(['rightJoin', 'fullJoin', 'crossJoin', 'leftJoinLateral', 'union'])('row 25: %s is refused', (method) =>
        {
            if (!dbFixture.isAvailable) return;

            const query = repo.selectAll(1).from(notes) as unknown as Record<string, () => unknown>;

            expect(() => query[method]()).toThrow(/is not supported on a TenantRepository _select/);
        });

        it('row 25: the standalone union() function is refused too', () =>
        {
            if (!dbFixture.isAvailable) return;

            const scoped = repo.selectAll(1).from(notes);
            const other = dbFixture.db.select().from(notes);

            expect(() => union(scoped, other)).toThrow(/addSetOperators\(\) is not supported/);
        });

        it('row 26: without where() the from table is still scoped', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const rows = await repo.selectAll(1).from(notes).orderBy(notes.id);

            expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 5, 11]);
        });

        it('row 27: where(cond) is ANDed with the tenant condition', async () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(await repo.selectAll(1).from(notes).where(eq(notes.slug, 'a'))).toHaveLength(1);
            expect(await repo.selectAll(1).from(notes).where(eq(notes.slug, 'x'))).toEqual([]);
            expect(await repo.selectAll(1).from(notes).where(() => eq(notes.slug, 'x'))).toEqual([]);
        });

        it('row 27: an ordinary from table is refused', () =>
        {
            if (!dbFixture.isAvailable) return;

            expect(() => repo.selectAll(1).from(countries)).toThrow(/has no tenantKey\(\) column/);
        });
    });
});
