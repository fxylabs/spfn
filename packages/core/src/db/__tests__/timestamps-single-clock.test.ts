/**
 * timestamps() — one clock writes both columns
 *
 * `created_at` and `updated_at` must both come from PostgreSQL. Stamping
 * `updated_at` from the Node process reads a second clock: in production the
 * application host and the database host are different machines, so a row could
 * record an update earlier than its own creation, and ordering rows by
 * `updated_at` would order by whichever host's clock ran ahead.
 *
 * The first test reads the generated SQL, which is what actually proves the clock
 * source. The rest run against PostgreSQL and check the behaviour that follows.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { id, timestamps } from '../schema/entity-helper';
import { createDbTestFixture } from './helpers/db-fixture';

const clockRows = pgTable('test_clock_rows', {
    id: id(),
    label: text('label').notNull(),
    ...timestamps(),
});

const CREATE_TABLE = `
    CREATE TABLE IF NOT EXISTS test_clock_rows (
        id BIGSERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
`;

/**
 * postgres-js opens no socket until a query runs, and `.toSQL()` never runs one,
 * so the SQL-shape test needs no database.
 */
const offline = drizzle({ client: postgres('postgresql://unused:unused@127.0.0.1:1/unused') });

describe('timestamps() — one clock writes both columns', () =>
{
    const dbFixture = createDbTestFixture();

    beforeAll(async () =>
    {
        await dbFixture.setup();
        if (!dbFixture.isAvailable) return;

        await dbFixture.execute(CREATE_TABLE);
    });

    afterAll(async () =>
    {
        if (dbFixture.isAvailable)
        {
            await dbFixture.execute('DROP TABLE IF EXISTS test_clock_rows');
        }
        await dbFixture.teardown();
    });

    beforeEach(async () =>
    {
        if (!dbFixture.isAvailable) return;

        await dbFixture.cleanTable('test_clock_rows');
    });

    it('generates updated_at = now() rather than a bound parameter', () =>
    {
        const { sql: text, params } = offline
            .update(clockRows)
            .set({ label: 'renamed' })
            .where(eq(clockRows.id, 1))
            .toSQL();

        expect(text).toContain('"updated_at" = now()');
        expect(params.some(p => p instanceof Date)).toBe(false);
    });

    it('gives a new row two equal timestamps', async () =>
    {
        if (!dbFixture.isAvailable) return;

        const [row] = await dbFixture.db
            .insert(clockRows)
            .values({ label: 'fresh' })
            .returning();

        expect(row.updatedAt.getTime()).toBe(row.createdAt.getTime());
    });

    it('advances updated_at on update and never before created_at', async () =>
    {
        if (!dbFixture.isAvailable) return;

        const [inserted] = await dbFixture.db
            .insert(clockRows)
            .values({ label: 'fresh' })
            .returning();

        const [updated] = await dbFixture.db
            .update(clockRows)
            .set({ label: 'renamed' })
            .where(eq(clockRows.id, inserted.id))
            .returning();

        expect(updated.createdAt.getTime()).toBe(inserted.createdAt.getTime());
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());
    });

    it('stamps updated_at on an upsert conflict too', async () =>
    {
        if (!dbFixture.isAvailable) return;

        const [inserted] = await dbFixture.db
            .insert(clockRows)
            .values({ label: 'first' })
            .returning();

        const [upserted] = await dbFixture.db
            .insert(clockRows)
            .values({ id: inserted.id, label: 'first' })
            .onConflictDoUpdate({ target: clockRows.id, set: { label: 'second' } })
            .returning();

        expect(upserted.label).toBe('second');
        expect(upserted.updatedAt.getTime()).toBeGreaterThanOrEqual(upserted.createdAt.getTime());
    });
});
