/**
 * A rolled-back transaction logs its error without the bound values (#382)
 *
 * The failed statement is a real duplicate insert on PostgreSQL, so the error
 * is the one drizzle and postgres.js actually raise: the values sit in
 * drizzle's `params`, message and stack header, and in the driver's `detail`.
 *
 * | #   | situation                                  | goes unnoticed without the row                         |
 * | --- | ------------------------------------------ | ------------------------------------------------------ |
 * | R14 | describeError of the real 23505            | a drizzle or postgres.js upgrade changing the shape the description reads |
 * | R1  | the runner's rollback line                 | the reported leak returning, or the line going back to error |
 * | R2  | the runner's slow-rollback line            | the slow branch, a warning, losing its level or leaking |
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { Logger } from '@spfn/core/logger';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';
import { describeError } from '../../../logger/error-description';
import { BOUND_VALUES, captureLoggerClass, expectNoValues } from '../../../logger/__tests__/helpers/leak-probe';
import { getTransaction } from '../context';
import { runInTransaction } from '../runner';

const probeUsers = pgTable('test_leak_probe_users', {
    id: serial('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
});

describe('a rolled-back transaction logs its error without the bound values', () =>
{
    const dbFixture = createDbTestFixture();

    const insertDuplicate = (): Promise<unknown> =>
        getTransaction()!.insert(probeUsers).values({ email: BOUND_VALUES[0], passwordHash: BOUND_VALUES[1] });

    beforeAll(async () =>
    {
        await dbFixture.setup();

        if (!dbFixture.isAvailable)
        {
            return;
        }

        await dbFixture.execute('DROP TABLE IF EXISTS test_leak_probe_users');
        await dbFixture.execute(
            'CREATE TABLE test_leak_probe_users (id serial PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL)',
        );
        await dbFixture.db.insert(probeUsers).values({ email: BOUND_VALUES[0], passwordHash: BOUND_VALUES[1] });
    });

    afterAll(async () =>
    {
        if (dbFixture.isAvailable)
        {
            await dbFixture.execute('DROP TABLE IF EXISTS test_leak_probe_users');
        }

        await dbFixture.teardown();
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    it('R14: the real 23505 is described by its code, constraint, table and SQL, without a value', async (ctx) =>
    {
        ctx.skip(!dbFixture.isAvailable, 'no database');

        const error = await dbFixture.db.insert(probeUsers)
            .values({ email: BOUND_VALUES[0], passwordHash: BOUND_VALUES[1] })
            .catch((caught: unknown) => caught);

        const { stack, ...description } = describeError(error);

        expect(description).toEqual({
            kind: 'database',
            name: 'DrizzleQueryError',
            code: '23505',
            severity: 'ERROR',
            constraint: 'test_leak_probe_users_email_key',
            schema: 'public',
            table: 'test_leak_probe_users',
            routine: '_bt_check_unique',
            message: 'duplicate key value violates unique constraint "test_leak_probe_users_email_key"',
            sql: 'insert into "test_leak_probe_users" ("id", "email", "password_hash") values (default, $1, $2)',
            paramCount: 2,
        });
        expectNoValues(String(stack));
    });

    it('R1: the rollback line is debug and carries the description, no value', async (ctx) =>
    {
        ctx.skip(!dbFixture.isAvailable, 'no database');
        const { lines, output } = captureLoggerClass(Logger);

        await expect(runInTransaction(insertDuplicate, { context: 'leak-probe' }))
            .rejects.toMatchObject({ name: 'DrizzleQueryError' });

        const rollbacks = lines.filter(line => line.message.includes('rolled back'));
        expect(rollbacks.map(line => [line.level, line.message])).toEqual([['debug', 'Transaction rolled back']]);
        expect(rollbacks[0].error).toMatchObject({ kind: 'database', code: '23505', table: 'test_leak_probe_users' });
        expectNoValues(output());
    });

    it('R2: the slow-rollback line stays a warning and carries the description, no value', async (ctx) =>
    {
        ctx.skip(!dbFixture.isAvailable, 'no database');
        const { lines, output } = captureLoggerClass(Logger);

        await expect(runInTransaction(insertDuplicate, { context: 'leak-probe', slowThreshold: 0 }))
            .rejects.toMatchObject({ name: 'DrizzleQueryError' });

        const rollbacks = lines.filter(line => line.message.includes('rolled back'));
        expect(rollbacks.map(line => [line.level, line.message])).toEqual([['warn', 'Slow transaction rolled back']]);
        expect(rollbacks[0].error).toMatchObject({ kind: 'database', code: '23505' });
        expectNoValues(output());
    });
});
