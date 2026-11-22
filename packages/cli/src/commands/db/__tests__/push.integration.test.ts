import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { bigint, pgTable, primaryKey } from 'drizzle-orm/pg-core';

import { applyStatements, resolvePushPlan } from '../push.js';
import { planConnectionOn } from './helpers/pglite-plan.js';

const blocks = pgTable('blocks', {
    blockerUserId: bigint('blocker_user_id', { mode: 'number' }).notNull(),
    blockedUserId: bigint('blocked_user_id', { mode: 'number' }).notNull(),
}, table => [
    primaryKey({ columns: [table.blockerUserId, table.blockedUserId] }),
]);

describe('db push', () =>
{
    let client: PGlite;

    beforeEach(async () =>
    {
        client = new PGlite();
        await client.waitReady;
    });

    afterEach(async () =>
    {
        await client.close();
    });

    it('introspects an existing composite primary key without producing a second diff', async () =>
    {
        const db = drizzle({ client });

        const first = await resolvePushPlan({ blocks }, planConnectionOn(client), ['public']);
        expect(first.statements).toHaveLength(1);
        await applyStatements(db, first.statements);

        const second = await resolvePushPlan({ blocks }, planConnectionOn(client), ['public']);
        expect(second.statements).toEqual([]);
        expect(second.hints).toEqual([]);
    });

    it('rolls back the whole DDL plan when one statement fails', async () =>
    {
        const db = drizzle({ client });

        await expect(applyStatements(db, [
            'CREATE TABLE atomic_push_test (id integer PRIMARY KEY);',
            'CREATE TABLE atomic_push_test (id integer PRIMARY KEY);',
        ])).rejects.toThrow();

        const result = await client.query<{ exists: boolean }>(`
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = 'atomic_push_test'
            ) AS "exists"
        `);

        expect(result.rows[0]?.exists).toBe(false);
    });
});
