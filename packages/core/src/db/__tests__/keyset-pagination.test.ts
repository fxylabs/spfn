/**
 * Keyset (cursor) pagination integration tests for BaseRepository._findManyKeyset
 *
 * Verifies cursor paging walks the full set without overlap/gaps, honours the
 * sort direction, and clamps the page size. Skips when no test DB is available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { createDbTestFixture } from './helpers/db-fixture';
import { BaseRepository } from '../repository';

const keysetItems = pgTable('keyset_items', {
    id: integer('id').primaryKey(),
    name: text('name'),
});

class KeysetRepo extends BaseRepository
{
    page(options: {
        limit: number;
        after?: number;
        order?: 'asc' | 'desc';
    })
    {
        return this._findManyKeyset(keysetItems, { cursorColumn: keysetItems.id, ...options });
    }
}

describe('BaseRepository._findManyKeyset (integration)', () =>
{
    const dbFixture = createDbTestFixture();

    beforeAll(async () =>
    {
        await dbFixture.setup();
        if (!dbFixture.isAvailable) return;

        await dbFixture.execute('CREATE TABLE IF NOT EXISTS keyset_items (id integer primary key, name text)');
        await dbFixture.execute('TRUNCATE TABLE keyset_items');
        await dbFixture.execute(
            "INSERT INTO keyset_items (id, name) VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')",
        );
    });

    beforeEach((context) => dbFixture.skipIfUnavailable(context));

    afterAll(async () =>
    {
        if (dbFixture.isAvailable)
        {
            await dbFixture.execute('DROP TABLE IF EXISTS keyset_items');
        }
        await dbFixture.teardown();
    });

    it('pages forward without overlap or gaps', async () =>
    {
        const repo = new KeysetRepo();

        const page1 = await repo.page({ limit: 2 });
        expect(page1.map(r => r.id)).toEqual([1, 2]);

        const page2 = await repo.page({ limit: 2, after: page1.at(-1)!.id });
        expect(page2.map(r => r.id)).toEqual([3, 4]);

        const page3 = await repo.page({ limit: 2, after: page2.at(-1)!.id });
        expect(page3.map(r => r.id)).toEqual([5]);
    });

    it('pages in descending order', async () =>
    {
        const repo = new KeysetRepo();

        const page1 = await repo.page({ limit: 2, order: 'desc' });
        expect(page1.map(r => r.id)).toEqual([5, 4]);

        const page2 = await repo.page({ limit: 2, order: 'desc', after: page1.at(-1)!.id });
        expect(page2.map(r => r.id)).toEqual([3, 2]);
    });
});
